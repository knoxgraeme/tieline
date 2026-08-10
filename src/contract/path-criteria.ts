/**
 * Deterministic path -> Acceptance Criterion lookup over the reviewed manifest.
 *
 * Reconciliation already owns the criterion-bearing manifest traversal. This
 * path-scoped sibling derives its public index from that shared claim index,
 * rather than walking capabilities, Stories, and criteria a third time.
 */

import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  buildContractClaimIndex,
  normalizeContractPath,
  type ClaimingCriterion,
  type ReconciliationLinkScope,
  type ReconciliationRelation,
} from "./reconciliation.js";
import { manifestDigest, type ContractManifest } from "./manifest.js";
import { withinRepository } from "./paths.js";

export interface PathCriterion {
  path: string;
  target_kind: ClaimingCriterion["target_kind"];
  repository: string;
  selector: string | null;
  framework_hint: string | null;
  capability_stable_id: string;
  story_stable_id: string;
  story_title: string;
  acceptance_criterion_stable_id: string;
  criterion: string;
  relation: ReconciliationRelation;
  provenance: ClaimingCriterion["provenance"];
  link_scope: ReconciliationLinkScope;
}

export type PathCriteriaIndex = ReadonlyMap<
  string,
  readonly PathCriterion[]
>;

export type PathCriteriaStatus = "has_criteria" | "no_criteria" | "not_found";

export interface PathCriteriaResult {
  /** Exactly what the caller asked for, so a typo remains visible. */
  requested_path: string;
  /** Normalized repository-relative lookup key. */
  path: string;
  status: PathCriteriaStatus;
  exists: boolean;
  acceptance_criterion_count: number;
  /** A stated result, including for the actionable negative outcomes. */
  answer: string;
  criteria: PathCriterion[];
}

export interface PathCriteriaReport {
  /** Stable repository identity recorded by the reviewed manifest. */
  repository: ContractManifest["repository"];
  /** Content identity of the complete reviewed manifest that answered. */
  manifest_digest: string;
  has_criteria_paths: number;
  no_criteria_paths: number;
  not_found_paths: number;
  results: PathCriteriaResult[];
}

function pathCriterion(claim: ClaimingCriterion): PathCriterion {
  return {
    path: claim.linked_path,
    target_kind: claim.target_kind,
    repository: claim.repository,
    selector: claim.selector,
    framework_hint: claim.framework_hint,
    capability_stable_id: claim.capability_stable_id,
    story_stable_id: claim.story_stable_id,
    story_title: claim.story_title,
    acceptance_criterion_stable_id: claim.acceptance_criterion_stable_id,
    criterion: claim.acceptance_criterion,
    relation: claim.relation,
    provenance: claim.provenance,
    link_scope: claim.link_scope,
  };
}

/**
 * Public path index derived from reconciliation's shared contract-claim index.
 */
export function buildPathCriteriaIndex(
  manifest: ContractManifest
): PathCriteriaIndex {
  return new Map(
    [...buildContractClaimIndex(manifest)].map(([path, claims]) => [
      path,
      claims.map(pathCriterion),
    ])
  );
}

function repositoryRelativePath(
  repositoryRoot: string,
  requested: string
): string {
  const relativePath = isAbsolute(requested)
    ? relative(repositoryRoot, requested)
    : requested;
  const normalized = normalizeContractPath(relativePath);
  return normalized.length > 0 ? normalized : ".";
}

/**
 * Match the exact repository spelling used by the contract index. On a
 * case-insensitive filesystem, `existsSync("src/Foo.ts")` also succeeds for an
 * actual `src/foo.ts`; treating that alias as an existing path with no criteria
 * would hide the criteria that apply to the real file.
 */
function repositoryPathExistsExactly(root: string, target: string): boolean {
  if (!withinRepository(root, target) || !existsSync(target)) return false;
  const path = relative(root, target);
  if (path.length === 0) return true;

  let directory = root;
  for (const segment of path.split(sep)) {
    try {
      if (!readdirSync(directory).includes(segment)) return false;
    } catch {
      return false;
    }
    directory = resolve(directory, segment);
  }
  return true;
}

function answerFor(
  path: string,
  criterionCount: number,
  exists: boolean
): string {
  if (criterionCount === 0) {
    return exists
      ? `No acceptance criteria apply to '${path}'. The path exists in the repository but no contract link targets it.`
      : `No acceptance criteria apply to '${path}', and the path does not exist in the repository.`;
  }
  const subject =
    criterionCount === 1
      ? "1 acceptance criterion applies to"
      : `${criterionCount} acceptance criteria apply to`;
  return exists
    ? `${subject} '${path}'.`
    : `${subject} '${path}' according to the manifest, but the path does not exist in the repository working tree.`;
}

export function lookupPathCriteria(input: {
  manifest: ContractManifest;
  repositoryRoot: string;
  paths: string[];
  index?: PathCriteriaIndex;
}): PathCriteriaReport {
  const index = input.index ?? buildPathCriteriaIndex(input.manifest);
  const root = resolve(input.repositoryRoot);
  const results = input.paths.map((requested): PathCriteriaResult => {
    const path = repositoryRelativePath(root, requested);
    const criteria = [...(index.get(path) ?? [])];
    const target = resolve(root, path);
    const exists = repositoryPathExistsExactly(root, target);
    const acceptanceCriterionCount = new Set(
      criteria.map((entry) => entry.acceptance_criterion_stable_id)
    ).size;
    return {
      requested_path: requested,
      path,
      status:
        criteria.length > 0
          ? "has_criteria"
          : exists
            ? "no_criteria"
            : "not_found",
      exists,
      acceptance_criterion_count: acceptanceCriterionCount,
      answer: answerFor(path, acceptanceCriterionCount, exists),
      criteria,
    };
  });
  return {
    repository: { ...input.manifest.repository },
    manifest_digest: manifestDigest(input.manifest),
    has_criteria_paths: results.filter(
      (result) => result.status === "has_criteria"
    ).length,
    no_criteria_paths: results.filter(
      (result) => result.status === "no_criteria"
    ).length,
    not_found_paths: results.filter((result) => result.status === "not_found")
      .length,
    results,
  };
}

export function renderPathCriteriaText(report: PathCriteriaReport): string {
  const lines = [
    `Contract criteria in repository '${report.repository.key}' from manifest ${report.manifest_digest}: ${report.has_criteria_paths} with criteria, ${report.no_criteria_paths} with no criteria, ${report.not_found_paths} not found of ${report.results.length} path(s).\n`,
  ];
  for (const result of report.results) {
    lines.push(`  ${result.status}  ${result.answer}\n`);
    for (const criterion of result.criteria) {
      lines.push(
        `    applies  ${criterion.acceptance_criterion_stable_id} ${criterion.link_scope} ${criterion.relation} · ${criterion.provenance} (${criterion.story_stable_id} ${criterion.story_title})\n`
      );
      lines.push(`             ${criterion.criterion}\n`);
    }
  }
  return lines.join("");
}
