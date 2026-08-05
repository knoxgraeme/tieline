/**
 * Deterministic scaffolding for a semantic judgment Tieline does not make.
 *
 * The host agent decides whether an artifact supports an acceptance criterion.
 * Tieline owns the complete diff scope and the closed citation vocabulary, so a
 * grader may refuse support but cannot silently skip work or invent evidence.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import type { RepositoryPathChange } from "./impact.js";
import type { ContractManifest } from "./manifest.js";
import {
  analyzeContractReconciliation,
  type ReconciliationChangeStatus,
  type ReconciliationLinkScope,
  type ReconciliationRelation,
} from "./reconciliation.js";
import {
  CORE_SELECTOR_KINDS,
  DEFAULT_MAX_SELECTOR_SOURCE_BYTES,
  RESOLVABLE_SOURCE_EXTENSIONS,
  indexSourceSymbols,
} from "./selector.js";

const BINARY_SNIFF_BYTES = 8_000;

export interface GradeScopeEntry {
  /** Opaque identity the verdict must echo exactly. */
  id: string;
  capability_stable_id: string;
  story_stable_id: string;
  story_title: string;
  acceptance_criterion_stable_id: string;
  acceptance_criterion: string;
  relation: ReconciliationRelation;
  link_scope: ReconciliationLinkScope;
  /** Current artifact path; for a rename, the path after the rename. */
  path: string;
  /** The path before a rename, otherwise null. */
  previous_path: string | null;
  reason: ReconciliationChangeStatus;
  /** Complete, sorted allow-list for a supported verdict's citation. */
  symbols: string[];
}

export interface GradeScope {
  base: string;
  repository: string;
  scoped_links: number;
  entries: GradeScopeEntry[];
}

export interface BuildGradeScopeInput {
  repositoryRoot: string;
  base: string;
  manifest: ContractManifest;
  changes: RepositoryPathChange[];
  sourceRoots: string[];
  ignore?: string[];
  specDirectory?: string;
}

function withinRepository(repositoryRoot: string, target: string): boolean {
  const path = relative(repositoryRoot, target);
  return path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path);
}

/**
 * Uses selector.ts as the sole declaration extractor. File checks mirror its
 * conservative resolver: unreadable or unsupported artifacts have no legal
 * citation rather than producing a guessed vocabulary.
 */
export function citableSymbolsForPath(
  repositoryRoot: string,
  path: string
): string[] {
  if (!RESOLVABLE_SOURCE_EXTENSIONS.has(extname(path).toLowerCase())) return [];
  const root = resolve(repositoryRoot);
  const absolute = resolve(root, path);
  if (!withinRepository(root, absolute)) return [];

  let stat;
  try {
    stat = statSync(absolute);
  } catch {
    return [];
  }
  if (!stat.isFile() || stat.size > DEFAULT_MAX_SELECTOR_SOURCE_BYTES) return [];

  let content: Buffer;
  try {
    content = readFileSync(absolute);
  } catch {
    return [];
  }
  if (content.subarray(0, BINARY_SNIFF_BYTES).indexOf(0) !== -1) return [];

  const index = indexSourceSymbols(content.toString("utf8"));
  return CORE_SELECTOR_KINDS.flatMap((kind) =>
    index.kinds[kind].map((name) => `${kind}:${name}`)
  ).sort();
}

function scopeId(input: {
  acceptanceCriterionStableId: string;
  relation: string;
  path: string;
  linkScope: string;
}): string {
  const identity = [
    input.acceptanceCriterionStableId,
    input.relation,
    input.path,
    input.linkScope,
  ].join("\0");
  return `grade:${createHash("sha256").update(identity).digest("hex")}`;
}

function compareEntries(left: GradeScopeEntry, right: GradeScopeEntry): number {
  return (
    left.acceptance_criterion_stable_id.localeCompare(
      right.acceptance_criterion_stable_id
    ) ||
    left.path.localeCompare(right.path) ||
    left.link_scope.localeCompare(right.link_scope) ||
    left.relation.localeCompare(right.relation)
  );
}

/**
 * Derives the grading work list from reconciliation's shared contract-claim
 * index. Every changed local claim survives; relevance scores never participate.
 */
export function buildGradeScope(input: BuildGradeScopeInput): GradeScope {
  const reconciliation = analyzeContractReconciliation({
    repositoryRoot: input.repositoryRoot,
    manifest: input.manifest,
    changes: input.changes,
    sourceRoots: input.sourceRoots,
    ignore: input.ignore,
    specDirectory: input.specDirectory,
  });
  const symbolCache = new Map<string, string[]>();
  const entries = new Map<string, GradeScopeEntry>();

  for (const change of reconciliation.claimed_changes) {
    let symbols = symbolCache.get(change.path);
    if (!symbols) {
      symbols = citableSymbolsForPath(input.repositoryRoot, change.path);
      symbolCache.set(change.path, symbols);
    }
    for (const claim of change.claimed_by) {
      const id = scopeId({
        acceptanceCriterionStableId: claim.acceptance_criterion_stable_id,
        relation: claim.relation,
        path: change.path,
        linkScope: claim.link_scope,
      });
      if (entries.has(id)) continue;
      entries.set(id, {
        id,
        capability_stable_id: claim.capability_stable_id,
        story_stable_id: claim.story_stable_id,
        story_title: claim.story_title,
        acceptance_criterion_stable_id:
          claim.acceptance_criterion_stable_id,
        acceptance_criterion: claim.acceptance_criterion,
        relation: claim.relation,
        link_scope: claim.link_scope,
        path: change.path,
        previous_path: change.old_path ?? null,
        reason: change.status,
        symbols: [...symbols],
      });
    }
  }

  const ordered = [...entries.values()].sort(compareEntries);
  return {
    base: input.base,
    repository: input.manifest.repository.key,
    scoped_links: ordered.length,
    entries: ordered,
  };
}

export function renderGradeScopeText(scope: GradeScope): string {
  const lines = [
    `Grading scope: ${scope.scoped_links} changed contract link(s) against ${scope.base}.\n`,
  ];
  if (scope.entries.length === 0) {
    lines.push("  No changed path is claimed by a contract evidence link.\n");
    return lines.join("");
  }
  for (const entry of scope.entries) {
    lines.push(
      `\n  ${entry.id}  ${entry.acceptance_criterion_stable_id} ${entry.relation} ${entry.path} (${entry.link_scope}, ${entry.reason})\n`
    );
    lines.push(`    ${entry.acceptance_criterion}\n`);
    lines.push(
      entry.symbols.length > 0
        ? `    Legal citations: ${entry.symbols.join(", ")}\n`
        : "    Legal citations: none extracted; this link cannot be graded supported.\n"
    );
  }
  return lines.join("");
}
