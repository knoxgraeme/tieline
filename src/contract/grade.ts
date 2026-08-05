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
import { z } from "zod";
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
  /** Repository path named by this contract link. */
  linked_path: string;
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

export const GRADE_VALUES = ["supported", "partial", "unsupported"] as const;
export type GradeValue = (typeof GRADE_VALUES)[number];

export class GradeVerdictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GradeVerdictError";
  }
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
  linkedPath: string;
  path: string;
  linkScope: string;
}): string {
  const identity = [
    input.acceptanceCriterionStableId,
    input.relation,
    input.linkedPath,
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
    left.linked_path.localeCompare(right.linked_path) ||
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
        linkedPath: claim.linked_path,
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
        linked_path: claim.linked_path,
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
    const target =
      entry.linked_path === entry.path
        ? ""
        : `, contract target ${entry.linked_path}`;
    lines.push(
      `\n  ${entry.id}  ${entry.acceptance_criterion_stable_id} ${entry.relation} ${entry.path} (${entry.link_scope}, ${entry.reason}${target})\n`
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

const nonEmptyText = z.string().trim().min(1);
const gradeScopeId = z.string().regex(/^grade:[a-f0-9]{64}$/);

export const gradeVerdictSchema = z.discriminatedUnion("grade", [
  z
    .object({
      id: gradeScopeId,
      grade: z.literal("supported"),
      citation: nonEmptyText.optional(),
      reason: nonEmptyText.optional(),
    })
    .strict(),
  z
    .object({
      id: gradeScopeId,
      grade: z.literal("partial"),
      reason: nonEmptyText,
    })
    .strict(),
  z
    .object({
      id: gradeScopeId,
      grade: z.literal("unsupported"),
      reason: nonEmptyText,
    })
    .strict(),
]);

export const gradeVerdictDocumentSchema = z
  .object({ verdicts: z.array(gradeVerdictSchema) })
  .strict();

export type GradeVerdict = z.infer<typeof gradeVerdictSchema>;

export function parseGradeVerdicts(value: unknown): GradeVerdict[] {
  const parsed = gradeVerdictDocumentSchema.safeParse(value);
  if (!parsed.success) {
    throw new GradeVerdictError(
      `Grade verdicts are malformed:\n${parsed.error.issues
        .map(
          (issue) =>
            `- ${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue.message}`
        )
        .join("\n")}`
    );
  }
  return parsed.data.verdicts;
}

export type GradeVerificationCause =
  | "fabricated_citation"
  | "missing_verdict";

export interface GradeEntryResult extends GradeScopeEntry {
  grade: GradeValue;
  submitted_grade: GradeValue | null;
  citation: string | null;
  judgment_reason: string;
  cause: GradeVerificationCause | null;
  downgraded: boolean;
  missing_verdict: boolean;
}

export interface GradeProposedSelector {
  acceptance_criterion_stable_id: string;
  path: string;
  selector: string;
}

export interface GradeReport {
  base: string;
  repository: string;
  strict: boolean;
  scoped_links: number;
  counts: Record<GradeValue, number>;
  entries: GradeEntryResult[];
  /** Every non-supported result; an honest negative is never hidden. */
  findings: GradeEntryResult[];
  downgrades: GradeEntryResult[];
  missing_verdicts: GradeEntryResult[];
  proposed_selectors: GradeProposedSelector[];
  strict_failure: boolean;
}

/**
 * Applies the deterministic fence to host-agent judgments. Verdicts may narrow
 * neither the work list nor its citation vocabulary.
 */
export function verifyGradeVerdicts(input: {
  scope: GradeScope;
  verdicts: GradeVerdict[];
  strict?: boolean;
}): GradeReport {
  const scoped = new Map(input.scope.entries.map((entry) => [entry.id, entry]));
  const submitted = new Map<string, GradeVerdict>();

  for (const verdict of input.verdicts) {
    if (!scoped.has(verdict.id)) {
      throw new GradeVerdictError(
        `Verdict '${verdict.id}' is outside the derived grading scope for base '${input.scope.base}'. Emit the scope again and grade only its current entries.`
      );
    }
    if (submitted.has(verdict.id)) {
      throw new GradeVerdictError(
        `Duplicate verdict '${verdict.id}'; submit exactly one verdict per scoped link.`
      );
    }
    submitted.set(verdict.id, verdict);
  }

  const entries = input.scope.entries.map((entry): GradeEntryResult => {
    const verdict = submitted.get(entry.id);
    if (!verdict) {
      return {
        ...entry,
        grade: "unsupported",
        submitted_grade: null,
        citation: null,
        judgment_reason: "No verdict was submitted for this scoped link.",
        cause: "missing_verdict",
        downgraded: false,
        missing_verdict: true,
      };
    }
    if (verdict.grade !== "supported") {
      return {
        ...entry,
        grade: verdict.grade,
        submitted_grade: verdict.grade,
        citation: null,
        judgment_reason: verdict.reason,
        cause: null,
        downgraded: false,
        missing_verdict: false,
      };
    }
    if (!verdict.citation || !entry.symbols.includes(verdict.citation)) {
      const citation = verdict.citation ?? null;
      return {
        ...entry,
        grade: "unsupported",
        submitted_grade: "supported",
        citation,
        judgment_reason: citation
          ? `Cited symbol '${citation}' is not in the emitted vocabulary for '${entry.path}'.`
          : `No symbol was cited from the emitted vocabulary for '${entry.path}'.`,
        cause: "fabricated_citation",
        downgraded: true,
        missing_verdict: false,
      };
    }
    return {
      ...entry,
      grade: "supported",
      submitted_grade: "supported",
      citation: verdict.citation,
      judgment_reason:
        verdict.reason ??
        `Cited symbol '${verdict.citation}' is in the emitted vocabulary for '${entry.path}'.`,
      cause: null,
      downgraded: false,
      missing_verdict: false,
    };
  });

  const counts: Record<GradeValue, number> = {
    supported: 0,
    partial: 0,
    unsupported: 0,
  };
  for (const entry of entries) counts[entry.grade] += 1;
  const strict = input.strict === true;
  return {
    base: input.scope.base,
    repository: input.scope.repository,
    strict,
    scoped_links: input.scope.scoped_links,
    counts,
    entries,
    findings: entries.filter((entry) => entry.grade !== "supported"),
    downgrades: entries.filter((entry) => entry.downgraded),
    missing_verdicts: entries.filter((entry) => entry.missing_verdict),
    proposed_selectors: entries
      .filter(
        (entry): entry is GradeEntryResult & { citation: string } =>
          entry.grade === "supported" && entry.citation !== null
      )
      .map((entry) => ({
        acceptance_criterion_stable_id:
          entry.acceptance_criterion_stable_id,
        path: entry.path,
        selector: entry.citation,
      })),
    strict_failure: strict && counts.unsupported > 0,
  };
}

export function renderGradeReportText(report: GradeReport): string {
  const lines = [
    `Grades: ${report.scoped_links} scoped link(s); supported=${report.counts.supported}, partial=${report.counts.partial}, unsupported=${report.counts.unsupported}.\n`,
  ];
  for (const entry of report.entries) {
    lines.push(
      `  ${entry.grade}  ${entry.id} ${entry.acceptance_criterion_stable_id} ${entry.path}${entry.citation ? ` (${entry.citation})` : ""}\n`
    );
    if (entry.grade !== "supported") {
      lines.push(`    ${entry.judgment_reason}\n`);
    }
    if (entry.cause) lines.push(`    cause: ${entry.cause}\n`);
  }
  for (const proposal of report.proposed_selectors) {
    lines.push(
      `  selector  ${proposal.acceptance_criterion_stable_id} ${proposal.path} proposes '${proposal.selector}' for contract review.\n`
    );
  }
  if (report.strict_failure) {
    lines.push(
      `  Strict mode: ${report.counts.unsupported} unsupported grade(s) remain.\n`
    );
  }
  return lines.join("");
}
