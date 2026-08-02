/**
 * governs — the deterministic answer to "which Acceptance Criteria govern this
 * repository path?".
 *
 * Every other contract query is either whole-contract (`coverage`) or
 * diff-scoped (`check`, `grade`): each one reports a violation that already
 * exists. This one is asked *before* the edit, which is the only moment at
 * which the contract can prevent the violation instead of describing it. An
 * agent does not notice context that is not there, so the pre-change lookup has
 * to be a first-class query rather than a side effect of ranked search.
 *
 * The index is a pure function of the compiled manifest: no database, no
 * network, no model. `coverage` consumes the same structure — a `Map` answers
 * `.has()` exactly as well as a `Set`, and holding on to the criterion instead
 * of discarding it is the entire difference between "is this path mapped?" and
 * "what governs it?". One traversal, two consumers.
 *
 * `link_scope` reuses the vocabulary of `AcceptanceCriterionImpact` in
 * impact.ts. "A specific Acceptance Criterion links this file" and "this file is
 * attached to the Story that owns the criterion" are materially different
 * answers and are never flattened together.
 */

import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ContractManifest, ManifestLink } from "./manifest.js";

/** `documents` is excluded: it always targets help content, never a path. */
export type GoverningRelation = "implements" | "enforces" | "tests";

/** Same vocabulary as `AcceptanceCriterionImpact["link_scope"]`. */
export type GoverningLinkScope = "direct" | "story_fallback";

export interface GoverningCriterion {
  path: string;
  capability_stable_id: string;
  story_stable_id: string;
  story_title: string;
  acceptance_criterion_stable_id: string;
  criterion: string;
  relation: GoverningRelation;
  link_scope: GoverningLinkScope;
}

/** Repository-relative path -> the contract records that link it. */
export type GoverningCriteriaIndex = ReadonlyMap<
  string,
  readonly GoverningCriterion[]
>;

export type PathGovernanceStatus = "governed" | "ungoverned" | "not_found";

export interface PathGovernance {
  /** Exactly what the caller asked for, so a typo is visible in the answer. */
  requested_path: string;
  path: string;
  status: PathGovernanceStatus;
  exists: boolean;
  acceptance_criterion_count: number;
  /**
   * The negative result stated in words. An empty array reads like a failed
   * query; "no acceptance criterion governs this path" is an actual finding.
   */
  answer: string;
  criteria: GoverningCriterion[];
}

export interface GoverningCriteriaReport {
  /** The commit the manifest records, so a caller knows which state answered. */
  repository: { key: string; commit: string };
  governed_paths: number;
  ungoverned_paths: number;
  results: PathGovernance[];
}

export function normalizeRepositoryPath(path: string): string {
  return path.split(sep).join("/");
}

function repositoryArtifact(
  link: ManifestLink,
  repositoryKey: string
): { relation: GoverningRelation; path: string } | null {
  if (link.relation === "documents" || link.target.kind === "help") return null;
  if (link.target.repository !== repositoryKey) return null;
  return {
    relation: link.relation,
    path: normalizeRepositoryPath(link.target.path),
  };
}

/**
 * Walks capabilities -> stories -> criteria once and keeps the association that
 * `mappedPaths` used to throw away on its last line.
 */
export function buildGoverningCriteriaIndex(
  manifest: ContractManifest
): GoverningCriteriaIndex {
  const index = new Map<string, GoverningCriterion[]>();
  const seen = new Set<string>();
  for (const capability of manifest.capabilities) {
    for (const story of capability.stories) {
      for (const criterion of story.acceptance_criteria) {
        const scoped: { link: ManifestLink; scope: GoverningLinkScope }[] = [
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
          const artifact = repositoryArtifact(link, manifest.repository.key);
          if (!artifact) continue;
          const key = [
            artifact.path,
            criterion.stable_id,
            artifact.relation,
            scope,
          ].join("\0");
          if (seen.has(key)) continue;
          seen.add(key);
          const entry: GoverningCriterion = {
            path: artifact.path,
            capability_stable_id: capability.stable_id,
            story_stable_id: story.stable_id,
            story_title: story.title,
            acceptance_criterion_stable_id: criterion.stable_id,
            criterion: criterion.criterion,
            relation: artifact.relation,
            link_scope: scope,
          };
          const bucket = index.get(artifact.path);
          if (bucket) bucket.push(entry);
          else index.set(artifact.path, [entry]);
        }
      }
    }
  }
  for (const entries of index.values()) {
    entries.sort(
      (left, right) =>
        left.acceptance_criterion_stable_id.localeCompare(
          right.acceptance_criterion_stable_id
        ) ||
        // "direct" sorts before "story_fallback"; the specific answer leads.
        left.link_scope.localeCompare(right.link_scope) ||
        left.relation.localeCompare(right.relation)
    );
  }
  return index;
}

function repositoryRelativePath(
  repositoryRoot: string,
  requested: string
): string {
  const relativePath = isAbsolute(requested)
    ? relative(repositoryRoot, requested)
    : requested;
  const normalized = normalizeRepositoryPath(relativePath)
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  return normalized.length > 0 ? normalized : ".";
}

function withinRepository(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function answerFor(
  path: string,
  criterionCount: number,
  exists: boolean
): string {
  if (criterionCount === 0) {
    return exists
      ? `No acceptance criterion governs '${path}'. The path exists in the repository but no contract link targets it.`
      : `No acceptance criterion governs '${path}', and the path does not exist in the repository.`;
  }
  const subject =
    criterionCount === 1
      ? "1 acceptance criterion governs"
      : `${criterionCount} acceptance criteria govern`;
  return exists
    ? `${subject} '${path}'.`
    : `${subject} '${path}', but the path does not exist in the repository working tree.`;
}

export function lookupGoverningCriteria(input: {
  manifest: ContractManifest;
  repositoryRoot: string;
  paths: string[];
  index?: GoverningCriteriaIndex;
}): GoverningCriteriaReport {
  const index = input.index ?? buildGoverningCriteriaIndex(input.manifest);
  const root = resolve(input.repositoryRoot);
  const results = input.paths.map((requested): PathGovernance => {
    const path = repositoryRelativePath(root, requested);
    const criteria = [...(index.get(path) ?? [])];
    const target = resolve(root, path);
    const exists = withinRepository(root, target) && existsSync(target);
    const distinct = new Set(
      criteria.map((entry) => entry.acceptance_criterion_stable_id)
    );
    return {
      requested_path: requested,
      path,
      status:
        criteria.length > 0 ? "governed" : exists ? "ungoverned" : "not_found",
      exists,
      acceptance_criterion_count: distinct.size,
      answer: answerFor(path, distinct.size, exists),
      criteria,
    };
  });
  return {
    repository: { ...input.manifest.repository },
    governed_paths: results.filter((result) => result.status === "governed")
      .length,
    ungoverned_paths: results.filter((result) => result.status !== "governed")
      .length,
    results,
  };
}

export function renderGoverningCriteriaText(
  report: GoverningCriteriaReport
): string {
  const lines = [
    `Contract governance in repository '${report.repository.key}' at manifest commit ${report.repository.commit}: ${report.governed_paths} governed, ${report.ungoverned_paths} ungoverned of ${report.results.length} path(s).\n`,
  ];
  for (const result of report.results) {
    lines.push(`  ${result.status}  ${result.answer}\n`);
    for (const criterion of result.criteria) {
      lines.push(
        `    governs  ${criterion.acceptance_criterion_stable_id} ${criterion.link_scope} ${criterion.relation} (${criterion.story_stable_id} ${criterion.story_title})\n`
      );
      lines.push(`             ${criterion.criterion}\n`);
    }
  }
  return lines.join("");
}
