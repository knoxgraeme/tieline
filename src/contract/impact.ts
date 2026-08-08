import { execFileSync } from "node:child_process";
import type {
  ContractManifest,
  ManifestAcceptanceCriterion,
  ManifestLink,
  ManifestStory,
} from "./manifest.js";
import {
  createArtifactHashResolver,
  type ArtifactHashResolver,
} from "./manifest.js";
import type { LinkProvenance } from "./schema.js";

export type RepositoryPathChange =
  | { status: "modified" | "added" | "deleted"; path: string }
  | { status: "renamed"; old_path: string; path: string };

/**
 * Why a link is structurally broken. These causes require no human judgement:
 * the manifest points somewhere that cannot hold reviewable evidence.
 */
export type BrokenLinkCause =
  | "missing"
  | "not_file"
  | "outside_repository";

export interface AcceptanceCriterionImpact {
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
}

interface LinkFreshness {
  freshness: AcceptanceCriterionImpact["freshness"];
  broken_cause?: BrokenLinkCause;
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

function linkFreshness(
  hashes: ArtifactHashResolver,
  ownerRepository: string,
  link: ManifestLink
): LinkFreshness {
  if (link.target.kind === "help") return { freshness: "not_applicable" };
  if (link.target.repository !== ownerRepository) {
    return { freshness: "unknown" };
  }
  const measured = hashes.measure(link.target.path);
  if (measured.status !== "hashed") {
    return { freshness: "broken", broken_cause: measured.status };
  }
  if (!link.reviewed_content_hash) return { freshness: "stale" };
  return {
    freshness:
      measured.hash === link.reviewed_content_hash ? "current" : "stale",
  };
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
  hashes: ArtifactHashResolver;
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
  const freshness = linkFreshness(
    input.hashes,
    input.manifest.repository.key,
    input.link
  );
  return {
    repository: input.manifest.repository.key,
    story_stable_id: input.story.stable_id,
    story_title: input.story.title,
    acceptance_criterion_stable_id: input.criterion.stable_id,
    acceptance_criterion: input.criterion.criterion,
    relation: input.link.relation,
    provenance: input.link.provenance,
    link_scope: input.scope,
    path: input.link.target.path,
    reason: reason(change),
    freshness: freshness.freshness,
    ...(freshness.broken_cause
      ? { broken_cause: freshness.broken_cause }
      : {}),
  };
}

/**
 * A link can rot without the change under review touching it, so broken links
 * are swept independently of the diff.
 */
function brokenLinkImpact(input: {
  hashes: ArtifactHashResolver;
  manifest: ContractManifest;
  story: ManifestStory;
  criterion: ManifestAcceptanceCriterion;
  link: ManifestLink;
  scope: "direct" | "story_fallback";
}): AcceptanceCriterionImpact | null {
  if (input.link.target.kind === "help") return null;
  const freshness = linkFreshness(
    input.hashes,
    input.manifest.repository.key,
    input.link
  );
  if (freshness.freshness !== "broken" || !freshness.broken_cause) {
    return null;
  }
  return {
    repository: input.manifest.repository.key,
    story_stable_id: input.story.stable_id,
    story_title: input.story.title,
    acceptance_criterion_stable_id: input.criterion.stable_id,
    acceptance_criterion: input.criterion.criterion,
    relation: input.link.relation,
    provenance: input.link.provenance,
    link_scope: input.scope,
    path: input.link.target.path,
    reason: "link_target_broken",
    freshness: "broken",
    broken_cause: freshness.broken_cause,
  };
}

function linkKey(impact: AcceptanceCriterionImpact): string {
  return [
    impact.acceptance_criterion_stable_id,
    impact.path,
    impact.link_scope,
  ].join("\0");
}

export function analyzeContractImpact(input: {
  repositoryRoot: string;
  manifest: ContractManifest;
  changes: RepositoryPathChange[];
  specDirectory?: string;
}): AcceptanceCriterionImpact[] {
  const impacts: AcceptanceCriterionImpact[] = [];
  const broken: AcceptanceCriterionImpact[] = [];
  const hashes = createArtifactHashResolver(input.repositoryRoot);
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
            repository: input.manifest.repository.key,
            story_stable_id: story.stable_id,
            story_title: story.title,
            acceptance_criterion_stable_id: criterion.stable_id,
            acceptance_criterion: criterion.criterion,
            relation: "defines",
            provenance: null,
            link_scope: "contract",
            path: input.specDirectory ?? ".tieline/spec",
            reason: "contract_definition_changed",
            freshness: "not_applicable",
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
            hashes,
            manifest: input.manifest,
            changes: input.changes,
            story,
            criterion,
            link,
            scope,
          });
          if (impact) impacts.push(impact);
          const brokenImpact = brokenLinkImpact({
            hashes,
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
    unique.set(
      [
        impact.acceptance_criterion_stable_id,
        impact.path,
        impact.reason,
        impact.link_scope,
      ].join("\0"),
      impact
    );
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
  return [...unique.values()].sort(
    (left, right) =>
      left.acceptance_criterion_stable_id.localeCompare(
        right.acceptance_criterion_stable_id
      ) || left.path.localeCompare(right.path)
  );
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
