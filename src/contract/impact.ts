import { execFileSync } from "node:child_process";
import type {
  ContractManifest,
  ManifestAcceptanceCriterion,
  ManifestLink,
  ManifestStory,
} from "./manifest.js";
import {
  createArtifactAssuranceInspector,
  type ArtifactAssuranceInspector,
  type ArtifactLocatorNotCheckedReason,
  type ArtifactLocatorResolution,
  type BrokenLinkCause,
} from "./artifact-assurance.js";
import type { LinkProvenance } from "./schema.js";

export type { BrokenLinkCause } from "./artifact-assurance.js";

export type RepositoryPathChange =
  | { status: "modified" | "added" | "deleted"; path: string }
  | { status: "renamed"; old_path: string; path: string };

export interface AcceptanceCriterionImpact {
  /** Linked target kind; null for a synthetic contract-definition impact. */
  target_kind: "code" | "test" | null;
  /** Repository named by the target, or the manifest repository for contract impacts. */
  repository: string;
  story_stable_id: string;
  /** Story title, so a reviewer sees the behaviour, not only the identifier. */
  story_title: string;
  acceptance_criterion_stable_id: string;
  /** The acceptance criterion sentence exactly as it was accepted. */
  acceptance_criterion: string;
  relation: string;
  /** Null only for a synthetic contract-definition impact with no link. */
  provenance: LinkProvenance | null;
  link_scope: "direct" | "story_fallback" | "contract";
  path: string;
  /** Canonical selector; null for file-level and contract-definition impacts. */
  selector: string | null;
  /** Test framework hint when authored; null for code and contract impacts. */
  framework_hint: string | null;
  reason:
    | "modified"
    | "added"
    | "deleted"
    | "renamed"
    | "contract_definition_changed"
    | "link_target_broken";
  freshness:
    | "current"
    | "stale"
    | "unknown"
    | "not_applicable"
    | "broken";
  /** Present only when `freshness` is `broken`. */
  broken_cause?: BrokenLinkCause;
  locator_resolution: ArtifactLocatorResolution;
  locator_reason: ArtifactLocatorNotCheckedReason | null;
}

export function isBrokenImpact(
  impact: AcceptanceCriterionImpact
): boolean {
  return impact.freshness === "broken";
}

export function describeBrokenCause(cause: BrokenLinkCause): string {
  switch (cause) {
    case "missing":
      return "the linked path does not exist";
    case "not_file":
      return "the linked path is not a file";
    case "outside_repository":
      return "the linked path resolves outside the repository";
  }
}

function changeForPath(
  changes: RepositoryPathChange[],
  path: string
): RepositoryPathChange | undefined {
  return changes.find((change) =>
    change.status === "renamed"
      ? change.old_path === path || change.path === path
      : change.path === path
  );
}

function reason(
  change: RepositoryPathChange
): AcceptanceCriterionImpact["reason"] {
  return change.status;
}

function linkedImpact(input: {
  inspector: ArtifactAssuranceInspector;
  manifest: ContractManifest;
  changes: RepositoryPathChange[];
  story: ManifestStory;
  criterion: ManifestAcceptanceCriterion;
  link: ManifestLink;
  scope: "direct" | "story_fallback";
}): AcceptanceCriterionImpact | null {
  if (input.link.target.kind === "help") return null;
  const change = changeForPath(
    input.changes,
    input.link.target.path
  );
  if (!change) return null;
  const assurance = input.inspector.inspect({
    target: input.link.target,
    reviewed_content_hash: input.link.reviewed_content_hash,
  });
  return {
    target_kind: input.link.target.kind,
    repository: input.link.target.repository,
    story_stable_id: input.story.stable_id,
    story_title: input.story.title,
    acceptance_criterion_stable_id: input.criterion.stable_id,
    acceptance_criterion: input.criterion.criterion,
    relation: input.link.relation,
    provenance: input.link.provenance,
    link_scope: input.scope,
    path: input.link.target.path,
    selector: input.link.target.selector ?? null,
    framework_hint:
      input.link.target.kind === "test"
        ? (input.link.target.framework_hint ?? null)
        : null,
    reason: reason(change),
    freshness: assurance.freshness,
    ...(assurance.broken_cause
      ? { broken_cause: assurance.broken_cause }
      : {}),
    locator_resolution: assurance.locator_resolution,
    locator_reason: assurance.locator_reason,
  };
}

/**
 * A link can rot without the change under review touching it, so broken links
 * are swept independently of the diff.
 */
function brokenLinkImpact(input: {
  inspector: ArtifactAssuranceInspector;
  manifest: ContractManifest;
  story: ManifestStory;
  criterion: ManifestAcceptanceCriterion;
  link: ManifestLink;
  scope: "direct" | "story_fallback";
}): AcceptanceCriterionImpact | null {
  if (input.link.target.kind === "help") return null;
  const assurance = input.inspector.inspect({
    target: input.link.target,
    reviewed_content_hash: input.link.reviewed_content_hash,
  });
  if (assurance.freshness !== "broken" || !assurance.broken_cause) {
    return null;
  }
  return {
    target_kind: input.link.target.kind,
    repository: input.link.target.repository,
    story_stable_id: input.story.stable_id,
    story_title: input.story.title,
    acceptance_criterion_stable_id: input.criterion.stable_id,
    acceptance_criterion: input.criterion.criterion,
    relation: input.link.relation,
    provenance: input.link.provenance,
    link_scope: input.scope,
    path: input.link.target.path,
    selector: input.link.target.selector ?? null,
    framework_hint:
      input.link.target.kind === "test"
        ? (input.link.target.framework_hint ?? null)
        : null,
    reason: "link_target_broken",
    freshness: "broken",
    broken_cause: assurance.broken_cause,
    locator_resolution: assurance.locator_resolution,
    locator_reason: assurance.locator_reason,
  };
}

function linkKey(impact: AcceptanceCriterionImpact): string {
  return [
    impact.acceptance_criterion_stable_id,
    impact.target_kind ?? "",
    impact.repository,
    impact.path,
    impact.selector ?? "",
    impact.framework_hint ?? "",
    impact.relation,
    impact.link_scope,
  ].join("\0");
}

function compareImpacts(
  left: AcceptanceCriterionImpact,
  right: AcceptanceCriterionImpact
): number {
  return (
    left.acceptance_criterion_stable_id.localeCompare(
      right.acceptance_criterion_stable_id
    ) ||
    (left.target_kind ?? "").localeCompare(right.target_kind ?? "") ||
    left.repository.localeCompare(right.repository) ||
    left.path.localeCompare(right.path) ||
    (left.selector ?? "").localeCompare(right.selector ?? "") ||
    (left.framework_hint ?? "").localeCompare(right.framework_hint ?? "") ||
    left.relation.localeCompare(right.relation) ||
    left.link_scope.localeCompare(right.link_scope) ||
    left.reason.localeCompare(right.reason)
  );
}

export function analyzeContractImpact(input: {
  repositoryRoot: string;
  manifest: ContractManifest;
  changes: RepositoryPathChange[];
  specDirectory?: string;
}): AcceptanceCriterionImpact[] {
  const impacts: AcceptanceCriterionImpact[] = [];
  const broken: AcceptanceCriterionImpact[] = [];
  const inspector = createArtifactAssuranceInspector({
    repositoryRoot: input.repositoryRoot,
    repositoryKey: input.manifest.repository.key,
  });
  const specPrefix = `${(input.specDirectory ?? ".tieline/spec").replace(/\/+$/, "")}/`;
  const contractChanged = input.changes.some((change) => {
    const paths =
      change.status === "renamed"
        ? [change.old_path, change.path]
        : [change.path];
    return paths.some((path) => path.startsWith(specPrefix));
  });

  for (const capability of input.manifest.capabilities) {
    for (const story of capability.stories) {
      for (const criterion of story.acceptance_criteria) {
        if (contractChanged) {
          impacts.push({
            target_kind: null,
            repository: input.manifest.repository.key,
            story_stable_id: story.stable_id,
            story_title: story.title,
            acceptance_criterion_stable_id: criterion.stable_id,
            acceptance_criterion: criterion.criterion,
            relation: "defines",
            provenance: null,
            link_scope: "contract",
            path: input.specDirectory ?? ".tieline/spec",
            selector: null,
            framework_hint: null,
            reason: "contract_definition_changed",
            freshness: "not_applicable",
            locator_resolution: "not_applicable",
            locator_reason: null,
          });
        }
        const scoped: Array<{
          link: ManifestLink;
          scope: "direct" | "story_fallback";
        }> = [
          ...criterion.links.map((link) => ({
            link,
            scope: "direct" as const,
          })),
          ...story.links.map((link) => ({
            link,
            scope: "story_fallback" as const,
          })),
        ];
        for (const { link, scope } of scoped) {
          const impact = linkedImpact({
            inspector,
            manifest: input.manifest,
            changes: input.changes,
            story,
            criterion,
            link,
            scope,
          });
          if (impact) impacts.push(impact);
          const brokenImpact = brokenLinkImpact({
            inspector,
            manifest: input.manifest,
            story,
            criterion,
            link,
            scope,
          });
          if (brokenImpact) broken.push(brokenImpact);
        }
      }
    }
  }
  const unique = new Map<string, AcceptanceCriterionImpact>();
  for (const impact of impacts) {
    unique.set(`${linkKey(impact)}\0${impact.reason}`, impact);
  }
  // A diff-driven finding for the same link already carries `freshness:
  // "broken"`, so the sweep only adds links the diff never touched.
  const diffDrivenLinks = new Set(
    [...unique.values()]
      .filter((impact) => impact.link_scope !== "contract")
      .map(linkKey)
  );
  const brokenUnique = new Map<string, AcceptanceCriterionImpact>();
  for (const impact of broken) {
    const key = linkKey(impact);
    if (diffDrivenLinks.has(key)) continue;
    brokenUnique.set(key, impact);
  }
  for (const [key, impact] of brokenUnique) {
    unique.set(`${key}\0link_target_broken`, impact);
  }
  return [...unique.values()].sort(compareImpacts);
}

export function parseNameStatus(
  output: string
): RepositoryPathChange[] {
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [rawStatus, first, second] = line.split("\t");
      const code = rawStatus?.[0];
      if (code === "R" && first && second) {
        return {
          status: "renamed" as const,
          old_path: first,
          path: second,
        };
      }
      if (!first) {
        throw new Error(`Unreadable git name-status line: ${line}`);
      }
      const status =
        code === "A"
          ? "added"
          : code === "D"
            ? "deleted"
            : "modified";
      return { status, path: first };
    });
}

/** The working tree's changes since `base`, rename detection included. */
export function changesSince(
  repositoryRoot: string,
  base: string
): RepositoryPathChange[] {
  return parseNameStatus(
    execFileSync("git", ["diff", "--name-status", "--find-renames", base], {
      cwd: repositoryRoot,
      encoding: "utf8",
    })
  );
}
