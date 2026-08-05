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
import type { ContractManifest } from "./manifest.js";

export type GoverningRelation = ReconciliationRelation;
export type GoverningLinkScope = ReconciliationLinkScope;

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

export type GoverningCriteriaIndex = ReadonlyMap<
  string,
  readonly GoverningCriterion[]
>;

export type PathGovernanceStatus = "governed" | "ungoverned" | "not_found";

export interface PathGovernance {
  /** Exactly what the caller asked for, so a typo remains visible. */
  requested_path: string;
  /** Normalized repository-relative lookup key. */
  path: string;
  status: PathGovernanceStatus;
  exists: boolean;
  acceptance_criterion_count: number;
  /** A stated result, including for the actionable negative outcomes. */
  answer: string;
  criteria: GoverningCriterion[];
}

export interface GoverningCriteriaReport {
  /** The manifest state that answered the query. */
  repository: ContractManifest["repository"];
  governed_paths: number;
  /** Includes existing ungoverned paths and requested paths not found. */
  ungoverned_paths: number;
  results: PathGovernance[];
}

function governingCriterion(claim: ClaimingCriterion): GoverningCriterion {
  return {
    path: claim.linked_path,
    capability_stable_id: claim.capability_stable_id,
    story_stable_id: claim.story_stable_id,
    story_title: claim.story_title,
    acceptance_criterion_stable_id: claim.acceptance_criterion_stable_id,
    criterion: claim.acceptance_criterion,
    relation: claim.relation,
    link_scope: claim.link_scope,
  };
}

/**
 * Public path index derived from reconciliation's shared contract-claim index.
 */
export function buildGoverningCriteriaIndex(
  manifest: ContractManifest
): GoverningCriteriaIndex {
  return new Map(
    [...buildContractClaimIndex(manifest)].map(([path, claims]) => [
      path,
      claims.map(governingCriterion),
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

function withinRepository(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/**
 * Match the exact repository spelling used by the contract index. On a
 * case-insensitive filesystem, `existsSync("src/Foo.ts")` also succeeds for an
 * actual `src/foo.ts`; treating that alias as an existing, ungoverned path would
 * hide the criterion that governs the real file.
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
    const exists = repositoryPathExistsExactly(root, target);
    const acceptanceCriterionCount = new Set(
      criteria.map((entry) => entry.acceptance_criterion_stable_id)
    ).size;
    return {
      requested_path: requested,
      path,
      status:
        criteria.length > 0 ? "governed" : exists ? "ungoverned" : "not_found",
      exists,
      acceptance_criterion_count: acceptanceCriterionCount,
      answer: answerFor(path, acceptanceCriterionCount, exists),
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
