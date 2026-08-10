/**
 * Exact manifest-backed intent context for repository assets and Acceptance
 * Criteria. Both reads consume reconciliation's shared intent index and expand
 * at most one Acceptance-Criterion-mediated hop.
 */
import {
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  createArtifactAssuranceInspector,
  type ArtifactAssurance,
  type ArtifactAssuranceInspector,
  type ArtifactTarget,
} from "./artifact-assurance.js";
import { manifestDigest, type ContractManifest } from "./manifest.js";
import { withinRepository } from "./paths.js";
import {
  buildContractIntentIndex,
  type ClaimingCriterion,
  type ContractIntentIndex,
  type IntentAcceptanceCriterionRecord,
} from "./reconciliation.js";
import { parseSelector } from "./selector.js";

export type IntentAssetKind = "code" | "test";

export interface IntentAssetLocatorInput {
  path: string;
  kind?: IntentAssetKind;
  selector?: string;
}

export interface CanonicalIntentAssetLocator {
  repository: string;
  path: string;
  kind: IntentAssetKind | null;
  selector: string | null;
}

export type IntentAssetMatchPrecision =
  | "exact_selector"
  | "file_level"
  | "path_only";

export interface IntentAssetTarget {
  kind: IntentAssetKind;
  repository: string;
  path: string;
  selector: string | null;
  framework_hint: string | null;
}

/** One accepted code/test claim plus separately derived current assurance. */
export interface InspectedIntentClaim {
  relation: ClaimingCriterion["relation"];
  provenance: ClaimingCriterion["provenance"];
  link_scope: ClaimingCriterion["link_scope"];
  target: IntentAssetTarget;
  reviewed_content_hash: string | null;
  assurance: ArtifactAssurance;
}

/** A claim that directly matched the caller's exact locator. */
export interface MatchingIntentClaim extends InspectedIntentClaim {
  capability_stable_id: string;
  story_stable_id: string;
  acceptance_criterion_stable_id: string;
  match_precision: IntentAssetMatchPrecision;
}

export interface AcceptanceCriterionIntentNeighborhood {
  capability: IntentAcceptanceCriterionRecord["capability"];
  story: IntentAcceptanceCriterionRecord["story"];
  acceptance_criterion: IntentAcceptanceCriterionRecord["acceptance_criterion"];
  direct_claims: InspectedIntentClaim[];
  story_fallback_claims: InspectedIntentClaim[];
}

interface IntentContextIdentity {
  repository: ContractManifest["repository"];
  manifest_digest: string;
  /** Explicitly names the authored relationship represented by this result. */
  relationship: "contract_coupling";
}

export type AssetIntentContextStatus =
  | "has_context"
  | "no_criteria"
  | "not_found";

export interface AssetIntentContextResult extends IntentContextIdentity {
  locator: CanonicalIntentAssetLocator;
  status: AssetIntentContextStatus;
  exists: boolean;
  answer: string;
  matching_claims: MatchingIntentClaim[];
  intent_neighborhood: AcceptanceCriterionIntentNeighborhood[];
}

export type AcceptanceCriterionIntentContextResult = IntentContextIdentity & {
  requested_stable_id: string;
  status: "found" | "not_found";
  answer: string;
  intent_neighborhood: AcceptanceCriterionIntentNeighborhood | null;
};

export type IntentContextErrorCode =
  | "invalid_path"
  | "invalid_kind"
  | "malformed_selector"
  | "invalid_stable_id";

export class IntentContextError extends Error {
  constructor(
    public readonly code: IntentContextErrorCode,
    message: string
  ) {
    super(message);
    this.name = "IntentContextError";
  }
}

interface IntentContextInput {
  manifest: ContractManifest;
  repositoryRoot: string;
  /** Reuse a caller-built index when multiple exact reads share one manifest. */
  index?: ContractIntentIndex;
  /** Narrow injection seam for callers that already own a request inspector. */
  inspector?: ArtifactAssuranceInspector;
}

export interface AssetIntentContextInput extends IntentContextInput {
  locator: IntentAssetLocatorInput;
}

export interface AcceptanceCriterionIntentContextInput
  extends IntentContextInput {
  stableId: string;
}

function canonicalPath(path: unknown): string {
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new IntentContextError(
      "invalid_path",
      "Asset path must be a non-empty repository-relative path."
    );
  }
  const portable = path.normalize("NFC").trim().replaceAll("\\", "/");
  if (isAbsolute(portable) || /^[A-Za-z]:\//.test(portable)) {
    throw new IntentContextError(
      "invalid_path",
      `Asset path '${path}' must be repository-relative.`
    );
  }
  const normalized = portable
    .split("/")
    .reduce<string[]>((segments, segment) => {
      if (segment === "" || segment === ".") return segments;
      if (segment === "..") {
        if (segments.length === 0) segments.push("..");
        else if (segments.at(-1) === "..") segments.push("..");
        else segments.pop();
      } else {
        segments.push(segment);
      }
      return segments;
    }, [])
    .join("/");
  if (
    normalized.length === 0 ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new IntentContextError(
      "invalid_path",
      `Asset path '${path}' must name a file inside the repository.`
    );
  }
  return normalized;
}

function canonicalLocator(
  repository: string,
  locator: IntentAssetLocatorInput
): CanonicalIntentAssetLocator {
  const kind = locator.kind ?? null;
  if (kind !== null && kind !== "code" && kind !== "test") {
    throw new IntentContextError(
      "invalid_kind",
      `Asset kind '${String(kind)}' is invalid; expected 'code' or 'test'.`
    );
  }
  let selector: string | null = null;
  if (locator.selector !== undefined) {
    const parsed = parseSelector(locator.selector);
    if (!parsed.ok) {
      throw new IntentContextError(
        "malformed_selector",
        `Malformed asset selector: ${parsed.error}.`
      );
    }
    selector = parsed.selector.canonical;
  }
  return {
    repository,
    path: canonicalPath(locator.path),
    kind,
    selector,
  };
}

/** Case-exact file existence, so filesystem aliases cannot hide linked intent. */
function repositoryFileExistsExactly(root: string, path: string): boolean {
  const target = resolve(root, path);
  if (!withinRepository(root, target) || !existsSync(target)) return false;
  try {
    if (!statSync(target).isFile()) return false;
  } catch {
    return false;
  }
  let directory = root;
  for (const segment of relative(root, target).split(sep)) {
    try {
      if (!readdirSync(directory).includes(segment)) return false;
    } catch {
      return false;
    }
    directory = resolve(directory, segment);
  }
  return true;
}

function targetFor(claim: ClaimingCriterion): IntentAssetTarget {
  return {
    kind: claim.target_kind,
    repository: claim.repository,
    path: claim.linked_path,
    selector: claim.selector,
    framework_hint: claim.framework_hint,
  };
}

function assuranceTarget(claim: ClaimingCriterion): ArtifactTarget {
  return claim.target_kind === "test"
    ? {
        kind: "test",
        repository: claim.repository,
        path: claim.linked_path,
        ...(claim.selector === null ? {} : { selector: claim.selector }),
        ...(claim.framework_hint === null
          ? {}
          : { framework_hint: claim.framework_hint }),
      }
    : {
        kind: "code",
        repository: claim.repository,
        path: claim.linked_path,
        ...(claim.selector === null ? {} : { selector: claim.selector }),
      };
}

function claimSortFields(claim: ClaimingCriterion): string[] {
  return [
    claim.relation,
    claim.link_scope,
    claim.target_kind,
    claim.repository,
    claim.linked_path,
    claim.selector ?? "",
    claim.framework_hint ?? "",
    claim.provenance,
  ];
}

function compareClaimFields(
  left: ClaimingCriterion,
  right: ClaimingCriterion
): number {
  return claimSortFields(left)
    .join("\0")
    .localeCompare(claimSortFields(right).join("\0"));
}

function inspectedClaim(
  claim: ClaimingCriterion,
  inspector: ArtifactAssuranceInspector
): InspectedIntentClaim {
  return {
    relation: claim.relation,
    provenance: claim.provenance,
    link_scope: claim.link_scope,
    target: targetFor(claim),
    reviewed_content_hash: claim.reviewed_content_hash,
    assurance: inspector.inspect({
      target: assuranceTarget(claim),
      reviewed_content_hash: claim.reviewed_content_hash,
    }),
  };
}

function neighborhood(
  record: IntentAcceptanceCriterionRecord,
  inspector: ArtifactAssuranceInspector
): AcceptanceCriterionIntentNeighborhood {
  const ordered = [...record.claims].sort(compareClaimFields);
  return {
    capability: record.capability,
    story: record.story,
    acceptance_criterion: record.acceptance_criterion,
    direct_claims: ordered
      .filter((claim) => claim.link_scope === "direct")
      .map((claim) => inspectedClaim(claim, inspector)),
    story_fallback_claims: ordered
      .filter((claim) => claim.link_scope === "story_fallback")
      .map((claim) => inspectedClaim(claim, inspector)),
  };
}

function contextParts(input: IntentContextInput): {
  identity: IntentContextIdentity;
  index: ContractIntentIndex;
  inspector: ArtifactAssuranceInspector;
} {
  const root = resolve(input.repositoryRoot);
  return {
    identity: {
      repository: { ...input.manifest.repository },
      manifest_digest: manifestDigest(input.manifest),
      relationship: "contract_coupling",
    },
    index: input.index ?? buildContractIntentIndex(input.manifest),
    inspector:
      input.inspector ??
      createArtifactAssuranceInspector({
        repositoryRoot: root,
        repositoryKey: input.manifest.repository.key,
      }),
  };
}

function matchPrecision(
  claim: ClaimingCriterion,
  locator: CanonicalIntentAssetLocator
): IntentAssetMatchPrecision | null {
  if (locator.kind !== null && claim.target_kind !== locator.kind) return null;
  if (locator.selector === null) return "path_only";
  if (claim.selector === locator.selector) return "exact_selector";
  return claim.selector === null ? "file_level" : null;
}

function assetAnswer(
  locator: CanonicalIntentAssetLocator,
  status: AssetIntentContextStatus,
  criterionCount: number
): string {
  const described = `${locator.kind ?? "code/test"} asset '${locator.path}'${
    locator.selector === null ? "" : ` at '${locator.selector}'`
  }`;
  if (status === "not_found") {
    return `The ${described} was not found in the repository and has no accepted contract coupling.`;
  }
  if (status === "no_criteria") {
    return `The ${described} exists, but no acceptance criteria apply to that exact locator.`;
  }
  return `${criterionCount} acceptance ${
    criterionCount === 1 ? "criterion forms" : "criteria form"
  } the bounded intent neighborhood for the ${described}.`;
}

/** Exact asset -> linked Acceptance Criteria -> their direct/fallback claims. */
export function lookupAssetIntentContext(
  input: AssetIntentContextInput
): AssetIntentContextResult {
  const locator = canonicalLocator(
    input.manifest.repository.key,
    input.locator
  );
  const { identity, index, inspector } = contextParts(input);
  const matches = (index.claims_by_path.get(locator.path) ?? [])
    .map((claim) => ({ claim, precision: matchPrecision(claim, locator) }))
    .filter(
      (
        entry
      ): entry is {
        claim: ClaimingCriterion;
        precision: IntentAssetMatchPrecision;
      } => entry.precision !== null
    )
    .sort(
      (left, right) =>
        left.claim.acceptance_criterion_stable_id.localeCompare(
          right.claim.acceptance_criterion_stable_id
        ) || compareClaimFields(left.claim, right.claim)
    );
  const root = resolve(input.repositoryRoot);
  const exists = repositoryFileExistsExactly(root, locator.path);
  const status: AssetIntentContextStatus =
    matches.length > 0
      ? "has_context"
      : exists
        ? "no_criteria"
        : "not_found";
  const criterionIds = [
    ...new Set(
      matches.map((entry) => entry.claim.acceptance_criterion_stable_id)
    ),
  ].sort();
  const intentNeighborhood = criterionIds.map((stableId) => {
    const record = index.acceptance_criteria_by_stable_id.get(stableId);
    if (!record) {
      throw new Error(
        `Shared intent index is inconsistent: Acceptance Criterion '${stableId}' has a path claim but no record.`
      );
    }
    return neighborhood(record, inspector);
  });
  return {
    ...identity,
    locator,
    status,
    exists,
    answer: assetAnswer(locator, status, criterionIds.length),
    matching_claims: matches.map(({ claim, precision }) => ({
      capability_stable_id: claim.capability_stable_id,
      story_stable_id: claim.story_stable_id,
      acceptance_criterion_stable_id:
        claim.acceptance_criterion_stable_id,
      match_precision: precision,
      ...inspectedClaim(claim, inspector),
    })),
    intent_neighborhood: intentNeighborhood,
  };
}

/** Exact Acceptance Criterion -> its direct and Story-fallback asset claims. */
export function lookupAcceptanceCriterionIntentContext(
  input: AcceptanceCriterionIntentContextInput
): AcceptanceCriterionIntentContextResult {
  if (typeof input.stableId !== "string" || input.stableId.trim().length === 0) {
    throw new IntentContextError(
      "invalid_stable_id",
      "Acceptance Criterion stable ID must be a non-empty string."
    );
  }
  const requestedStableId = input.stableId.trim();
  const { identity, index, inspector } = contextParts(input);
  const record = index.acceptance_criteria_by_stable_id.get(requestedStableId);
  if (!record) {
    return {
      ...identity,
      requested_stable_id: requestedStableId,
      status: "not_found",
      answer: `Acceptance Criterion '${requestedStableId}' was not found in the reviewed manifest. Check the stable ID and manifest workspace.`,
      intent_neighborhood: null,
    };
  }
  return {
    ...identity,
    requested_stable_id: requestedStableId,
    status: "found",
    answer: `Acceptance Criterion '${requestedStableId}' and its bounded intent neighborhood were found in the reviewed manifest.`,
    intent_neighborhood: neighborhood(record, inspector),
  };
}
