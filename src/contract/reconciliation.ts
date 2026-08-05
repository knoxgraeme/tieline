/**
 * Reconciliation view over a branch diff: which changed repository paths the
 * accepted contract already claims, which changed source files it does not, and
 * which changed paths were considered and deliberately set aside.
 *
 * THIS IS INPUT TO AUTHORING, NEVER A VERDICT. It answers "what did this branch
 * touch, and what does the contract already say about it?" and nothing else:
 *
 * - A claimed change is not a defect. It marks acceptance criteria whose
 *   definitions a human may want to re-read now that their evidence moved.
 * - An unclaimed change is not a missing acceptance criterion. Refactors,
 *   renames, formatting, and internal restructuring change source files without
 *   changing behavior. Authoring an acceptance criterion to drive this list to
 *   zero would put fiction in the contract.
 * - An excluded change is not hidden. Every changed path appears in exactly one
 *   of the three lists, with a reason when it was set aside, so a reader can see
 *   what was considered rather than guess what was dropped.
 *
 * The result is JSON-serializable and deterministically ordered, so an agent can
 * act on it without walking the repository a second time.
 *
 * Deleted paths. A deletion is classified by what the contract says about it,
 * not by the fact that a file is gone:
 *
 * - A deleted path that a link claims stays in `claimed_changes`. The evidence
 *   for an acceptance criterion was removed, which is exactly the case a human
 *   must look at.
 * - A deleted path that nothing claims is set aside with reason `deleted`. There
 *   is no file left to describe, so it cannot be undescribed behavior; treating
 *   it as a candidate for new authoring would invite an acceptance criterion for
 *   code that no longer exists.
 */
import { isAbsolute, relative, sep } from "node:path";
import type { RepositoryPathChange } from "./impact.js";
import type {
  ContractManifest,
  ManifestAcceptanceCriterion,
  ManifestLink,
  ManifestStory,
} from "./manifest.js";

export const RECONCILIATION_DISCLAIMER =
  "This is authoring input, not a verdict. A claimed change means an acceptance criterion may need re-reading; an unclaimed change means a human should consider whether behavior changed at all. Many changes are refactors that need no acceptance criterion, and nothing here should be authored merely to shrink a count.";

export const DEFAULT_SPEC_DIRECTORY = ".tieline/spec";

export type ReconciliationChangeStatus = RepositoryPathChange["status"];

export type ReconciliationLinkScope = "direct" | "story_fallback";
export type ReconciliationRelation = Exclude<
  ManifestLink["relation"],
  "documents"
>;

interface ChangedPathFields {
  /** The path after the change; for a rename, the path it moved to. */
  path: string;
  status: ReconciliationChangeStatus;
  /** Present only for a rename: the path it moved from. */
  old_path?: string;
}

/** An acceptance criterion whose link names a changed path. */
export interface ClaimingCriterion {
  capability_stable_id: string;
  story_stable_id: string;
  /** Story title, so a reader sees the behavior, not only the identifier. */
  story_title: string;
  acceptance_criterion_stable_id: string;
  /** The acceptance criterion sentence exactly as it was accepted. */
  acceptance_criterion: string;
  relation: ReconciliationRelation;
  /**
   * `direct` when the link sits on the acceptance criterion itself,
   * `story_fallback` when it is inherited from the owning Story.
   */
  link_scope: ReconciliationLinkScope;
  /** The path the link names, which for a rename may be the pre-rename path. */
  linked_path: string;
}

/**
 * Repository-relative path -> the acceptance criteria whose contract links
 * name it. This is the shared manifest index behind both diff reconciliation
 * and deterministic path lookup.
 */
export type ContractClaimIndex = ReadonlyMap<
  string,
  readonly ClaimingCriterion[]
>;

/** A changed path at least one link targets. */
export interface ClaimedChange extends ChangedPathFields {
  claimed_by: ClaimingCriterion[];
}

/** A changed, eligible source file no link targets. */
export interface UnclaimedChange extends ChangedPathFields {
  /** The configured source root the path falls under. */
  source_root: string;
}

export type ExclusionReason =
  | "contract_definition"
  | "outside_source_roots"
  | "ignored"
  | "deleted";

/** A changed path that is neither claimed nor an eligible source file. */
export interface ExcludedChange extends ChangedPathFields {
  reason: ExclusionReason;
  /** Present only when `reason` is `ignored`: the configured pattern that matched. */
  matched_ignore_pattern?: string;
}

export interface ReconciliationSummary {
  changed_paths: number;
  claimed: number;
  unclaimed: number;
  excluded: number;
  excluded_by_reason: Record<ExclusionReason, number>;
}

export interface ContractReconciliation {
  repository: string;
  /** Structural reminder: this report informs authoring and gates nothing. */
  advisory: true;
  disclaimer: string;
  source_roots: string[];
  spec_directory: string;
  claimed_changes: ClaimedChange[];
  unclaimed_changes: UnclaimedChange[];
  excluded_changes: ExcludedChange[];
  summary: ReconciliationSummary;
}

export interface ContractReconciliationOptions {
  repositoryRoot: string;
  manifest: ContractManifest;
  changes: RepositoryPathChange[];
  sourceRoots: string[];
  ignore?: string[];
  specDirectory?: string;
}

const EXCLUSION_REASONS: readonly ExclusionReason[] = [
  "contract_definition",
  "outside_source_roots",
  "ignored",
  "deleted",
];

/**
 * Replicated from `coverage.ts`, which owns eligibility for coverage
 * measurement but exports none of its matching helpers. Only the smallest
 * necessary part is copied — separator normalization and the `*`/`**` pattern
 * match — so both modules answer "is this path ignored?" the same way.
 *
 * The one deliberate difference: `coverage.ts` decides eligibility by walking
 * the working tree, which cannot see a path a change deleted. Eligibility here
 * is decided from the path string alone, so a deleted path is still classified.
 */
export function normalizeContractPath(path: string): string {
  return path
    .split(sep)
    .join("/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
}

function wildcardPattern(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\0/g, ".*");
  return new RegExp(`^${escaped}(?:/.*)?$`);
}

/** The first configured pattern that matches, or `null`. */
function matchedIgnorePattern(
  path: string,
  patterns: string[]
): string | null {
  const normalized = normalizeContractPath(path);
  for (const entry of patterns) {
    const pattern = normalizeContractPath(entry.trim());
    if (pattern.length === 0) continue;
    if (wildcardPattern(pattern).test(normalized)) return entry;
  }
  return null;
}

/**
 * Configured source roots as repository-relative, `/`-separated prefixes. An
 * absolute root is re-expressed against the repository root so callers may pass
 * either form.
 */
function normalizeSourceRoots(
  repositoryRoot: string,
  sourceRoots: string[]
): string[] {
  return sourceRoots.map((root) =>
    normalizeContractPath(
      isAbsolute(root) ? relative(repositoryRoot, root) : root
    )
  );
}

/** The configured source root containing `path`, or `null`. */
function sourceRootFor(path: string, sourceRoots: string[]): string | null {
  for (const root of sourceRoots) {
    if (root === "" || root === ".") return root === "" ? "." : root;
    if (path === root || path.startsWith(`${root}/`)) return root;
  }
  return null;
}

function claimKey(claim: ClaimingCriterion): string {
  return [
    claim.acceptance_criterion_stable_id,
    claim.linked_path,
    claim.relation,
    claim.link_scope,
  ].join("\0");
}

function compareClaims(
  left: ClaimingCriterion,
  right: ClaimingCriterion
): number {
  return (
    left.acceptance_criterion_stable_id.localeCompare(
      right.acceptance_criterion_stable_id
    ) ||
    left.linked_path.localeCompare(right.linked_path) ||
    left.relation.localeCompare(right.relation) ||
    left.link_scope.localeCompare(right.link_scope)
  );
}

function scopedLinks(
  story: ManifestStory,
  criterion: ManifestAcceptanceCriterion
): Array<{ link: ManifestLink; scope: ReconciliationLinkScope }> {
  return [
    ...criterion.links.map((link) => ({
      link,
      scope: "direct" as const,
    })),
    ...story.links.map((link) => ({
      link,
      scope: "story_fallback" as const,
    })),
  ];
}

/**
 * Every repository path a link names, mapped to the acceptance criteria that
 * name it. A Story-level link is attributed to each of the Story's criteria as a
 * `story_fallback`, matching how impact analysis reads the same links.
 *
 * Keep this as the single criterion-bearing manifest traversal. Reconciliation
 * consumes it for changed paths; `contract criteria` consumes the same index for
 * paths supplied before a change exists.
 */
export function buildContractClaimIndex(
  manifest: ContractManifest
): ContractClaimIndex {
  const claims = new Map<string, ClaimingCriterion[]>();
  const seen = new Set<string>();
  for (const capability of manifest.capabilities) {
    for (const story of capability.stories) {
      for (const criterion of story.acceptance_criteria) {
        for (const { link, scope } of scopedLinks(story, criterion)) {
          if (link.relation === "documents" || link.target.kind === "help") {
            continue;
          }
          if (link.target.repository !== manifest.repository.key) continue;
          const path = normalizeContractPath(link.target.path);
          const claim: ClaimingCriterion = {
            capability_stable_id: capability.stable_id,
            story_stable_id: story.stable_id,
            story_title: story.title,
            acceptance_criterion_stable_id: criterion.stable_id,
            acceptance_criterion: criterion.criterion,
            relation: link.relation,
            link_scope: scope,
            linked_path: path,
          };
          const key = claimKey(claim);
          if (seen.has(key)) continue;
          seen.add(key);
          const existing = claims.get(path);
          if (existing) existing.push(claim);
          else claims.set(path, [claim]);
        }
      }
    }
  }
  for (const entries of claims.values()) entries.sort(compareClaims);
  return claims;
}

function changedPathFields(change: RepositoryPathChange): ChangedPathFields {
  return change.status === "renamed"
    ? {
        path: normalizeContractPath(change.path),
        status: "renamed",
        old_path: normalizeContractPath(change.old_path),
      }
    : { path: normalizeContractPath(change.path), status: change.status };
}

/**
 * Both sides of a rename are candidates for a claim: a link written before the
 * rename still names the old path, and one written after names the new one.
 */
function candidatePaths(fields: ChangedPathFields): string[] {
  return fields.old_path ? [fields.path, fields.old_path] : [fields.path];
}

function claimsForChange(
  fields: ChangedPathFields,
  claims: ContractClaimIndex
): ClaimingCriterion[] {
  const unique = new Map<string, ClaimingCriterion>();
  for (const path of candidatePaths(fields)) {
    for (const claim of claims.get(path) ?? []) {
      unique.set(claimKey(claim), claim);
    }
  }
  return [...unique.values()].sort(compareClaims);
}

/**
 * Why an unclaimed changed path is not a candidate for authoring, or `null` when
 * it is one. The order is the order a reader asks the questions: is this the
 * contract itself, is it outside the measured source scope, is it ignored, is it
 * gone?
 */
function exclusion(
  fields: ChangedPathFields,
  options: {
    sourceRoots: string[];
    ignore: string[];
    specPrefix: string;
    specDirectory: string;
  }
): { reason: ExclusionReason; matched_ignore_pattern?: string } | null {
  const paths = candidatePaths(fields);
  if (
    paths.some(
      (path) =>
        path === options.specDirectory || path.startsWith(options.specPrefix)
    )
  ) {
    return { reason: "contract_definition" };
  }
  if (!sourceRootFor(fields.path, options.sourceRoots)) {
    return { reason: "outside_source_roots" };
  }
  const pattern = matchedIgnorePattern(fields.path, options.ignore);
  if (pattern) {
    return { reason: "ignored", matched_ignore_pattern: pattern };
  }
  if (fields.status === "deleted") return { reason: "deleted" };
  return null;
}

function comparePaths(
  left: ChangedPathFields,
  right: ChangedPathFields
): number {
  return (
    left.path.localeCompare(right.path) ||
    (left.old_path ?? "").localeCompare(right.old_path ?? "")
  );
}

/**
 * Partitions a diff into the paths the contract claims, the eligible source
 * files it does not, and the paths set aside with a reason.
 */
export function analyzeContractReconciliation(
  options: ContractReconciliationOptions
): ContractReconciliation {
  const specDirectory = normalizeContractPath(
    options.specDirectory ?? DEFAULT_SPEC_DIRECTORY
  );
  const sourceRoots = normalizeSourceRoots(
    options.repositoryRoot,
    options.sourceRoots
  );
  const ignore = options.ignore ?? [];
  const claims = buildContractClaimIndex(options.manifest);

  const claimed: ClaimedChange[] = [];
  const unclaimed: UnclaimedChange[] = [];
  const excluded: ExcludedChange[] = [];
  const seen = new Set<string>();

  for (const change of options.changes) {
    const fields = changedPathFields(change);
    const key = `${fields.status}\0${fields.path}\0${fields.old_path ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const claimedBy = claimsForChange(fields, claims);
    if (claimedBy.length > 0) {
      claimed.push({ ...fields, claimed_by: claimedBy });
      continue;
    }
    const setAside = exclusion(fields, {
      sourceRoots,
      ignore,
      specPrefix: `${specDirectory}/`,
      specDirectory,
    });
    if (setAside) {
      excluded.push({ ...fields, ...setAside });
      continue;
    }
    unclaimed.push({
      ...fields,
      source_root: sourceRootFor(fields.path, sourceRoots) ?? ".",
    });
  }

  claimed.sort(comparePaths);
  unclaimed.sort(comparePaths);
  excluded.sort(
    (left, right) =>
      comparePaths(left, right) || left.reason.localeCompare(right.reason)
  );

  const excluded_by_reason = Object.fromEntries(
    EXCLUSION_REASONS.map((reason) => [
      reason,
      excluded.filter((entry) => entry.reason === reason).length,
    ])
  ) as Record<ExclusionReason, number>;

  return {
    repository: options.manifest.repository.key,
    advisory: true,
    disclaimer: RECONCILIATION_DISCLAIMER,
    source_roots: sourceRoots,
    spec_directory: specDirectory,
    claimed_changes: claimed,
    unclaimed_changes: unclaimed,
    excluded_changes: excluded,
    summary: {
      changed_paths: seen.size,
      claimed: claimed.length,
      unclaimed: unclaimed.length,
      excluded: excluded.length,
      excluded_by_reason,
    },
  };
}
