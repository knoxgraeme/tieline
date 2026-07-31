import type {
  ContractManifest,
  ManifestLink,
} from "./manifest.js";
import {
  createArtifactHashResolver,
  type ArtifactHashResolver,
} from "./manifest.js";

export type RepositoryPathChange =
  | { status: "modified" | "added" | "deleted"; path: string }
  | { status: "renamed"; old_path: string; path: string };

export interface AcceptanceCriterionImpact {
  repository: string;
  story_stable_id: string;
  acceptance_criterion_stable_id: string;
  relation: string;
  link_scope: "direct" | "story_fallback" | "contract";
  path: string;
  reason:
    | "modified"
    | "added"
    | "deleted"
    | "renamed"
    | "contract_definition_changed";
  freshness: "current" | "stale" | "unknown" | "not_applicable";
}

function linkFreshness(
  hashes: ArtifactHashResolver,
  ownerRepository: string,
  link: ManifestLink
): AcceptanceCriterionImpact["freshness"] {
  if (link.target.kind === "help") return "not_applicable";
  if (link.target.repository !== ownerRepository) return "unknown";
  if (!link.reviewed_content_hash) return "stale";
  const measured = hashes.measure(link.target.path);
  return measured.status === "hashed" &&
    measured.hash === link.reviewed_content_hash
    ? "current"
    : "stale";
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
  storyStableId: string;
  criterionStableId: string;
  link: ManifestLink;
  scope: "direct" | "story_fallback";
}): AcceptanceCriterionImpact | null {
  if (input.link.target.kind === "help") return null;
  const change = changeForPath(
    input.changes,
    input.link.target.path
  );
  if (!change) return null;
  return {
    repository: input.manifest.repository.key,
    story_stable_id: input.storyStableId,
    acceptance_criterion_stable_id: input.criterionStableId,
    relation: input.link.relation,
    link_scope: input.scope,
    path: input.link.target.path,
    reason: reason(change),
    freshness: linkFreshness(
      input.hashes,
      input.manifest.repository.key,
      input.link
    ),
  };
}

export function analyzeContractImpact(input: {
  repositoryRoot: string;
  manifest: ContractManifest;
  changes: RepositoryPathChange[];
  specDirectory?: string;
}): AcceptanceCriterionImpact[] {
  const impacts: AcceptanceCriterionImpact[] = [];
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
            acceptance_criterion_stable_id: criterion.stable_id,
            relation: "defines",
            link_scope: "contract",
            path: input.specDirectory ?? ".tieline/spec",
            reason: "contract_definition_changed",
            freshness: "not_applicable",
          });
        }
        for (const link of criterion.links) {
          const impact = linkedImpact({
            hashes,
            manifest: input.manifest,
            changes: input.changes,
            storyStableId: story.stable_id,
            criterionStableId: criterion.stable_id,
            link,
            scope: "direct",
          });
          if (impact) impacts.push(impact);
        }
        for (const link of story.links) {
          const impact = linkedImpact({
            hashes,
            manifest: input.manifest,
            changes: input.changes,
            storyStableId: story.stable_id,
            criterionStableId: criterion.stable_id,
            link,
            scope: "story_fallback",
          });
          if (impact) impacts.push(impact);
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
