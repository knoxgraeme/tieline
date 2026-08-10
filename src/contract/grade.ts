/**
 * Deterministic scaffolding for a semantic judgment Tieline does not make.
 *
 * The host agent decides whether an artifact supports an acceptance criterion.
 * Tieline owns the complete scope and the closed citation vocabulary, so a
 * grader may refuse support but cannot silently skip work or invent evidence.
 *
 * A contract link is a claim with two sides, and the scope covers a change to
 * either one. The artifact side comes from the branch diff: a linked file that
 * moved re-opens the claim over it. The claim side comes from comparing the
 * branch manifest against the base ref's manifest: a link the base does not
 * carry verbatim — new, inherited by a new criterion, or belonging to a
 * re-worded criterion — is a judgment nobody has made yet, even when its
 * artifact is untouched. The initial contract is the degenerate case: with no
 * manifest at the base, every link is claim-side scope, so onboarding is
 * graded by the same mechanism as drift.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { z } from "zod";
import type { RepositoryPathChange } from "./impact.js";
import type { ContractManifest } from "./manifest.js";
import { withinRepository } from "./paths.js";
import {
  analyzeContractReconciliation,
  buildContractClaimIndex,
  contractClaimIdentity,
  type ClaimingCriterion,
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

/**
 * Why a link is in the grading scope. A diff status means the artifact side
 * moved. `link_added` means the base manifest does not carry this claim at
 * all; `criterion_changed` means it does, but under a different
 * acceptance-criterion sentence, so the judgment on record was made against
 * prose that no longer exists.
 */
export type GradeScopeReason =
  | ReconciliationChangeStatus
  | "link_added"
  | "criterion_changed";

export interface GradeScopeEntry {
  /** Opaque identity the verdict must echo exactly. */
  id: string;
  capability_stable_id: string;
  story_stable_id: string;
  story_title: string;
  acceptance_criterion_stable_id: string;
  acceptance_criterion: string;
  relation: ReconciliationRelation;
  provenance: ClaimingCriterion["provenance"];
  link_scope: ReconciliationLinkScope;
  target_kind: ClaimingCriterion["target_kind"];
  repository: string;
  /** Repository path named by this contract link. */
  linked_path: string;
  selector: string | null;
  framework_hint: string | null;
  /** Current artifact path; for a rename, the path after the rename. */
  path: string;
  /** The path before a rename, otherwise null. */
  previous_path: string | null;
  reason: GradeScopeReason;
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
  /**
   * The manifest as committed at `base`, or null when that ref carries none —
   * the initial contract, whose every link is then claim-side scope. Required
   * rather than defaulted: a caller must state what the base said, because
   * omitting it would silently drop claim-side work from the scope, and the
   * scope may never be narrowed.
   */
  baseManifest: ContractManifest | null;
  changes: RepositoryPathChange[];
  sourceRoots: string[];
  ignore?: string[];
  specDirectory?: string;
}

/**
 * Uses selector.ts as the sole declaration extractor. File checks mirror its
 * conservative resolver: unreadable or unsupported artifacts have no legal
 * citation rather than producing a guessed vocabulary.
 */
function citableSymbolsForPath(
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
  claim: ClaimingCriterion;
  path: string;
}): string {
  const identity = [contractClaimIdentity(input.claim), input.path].join("\0");
  return `grade:${createHash("sha256").update(identity).digest("hex")}`;
}

type ClaimChangeReason = Extract<
  GradeScopeReason,
  "link_added" | "criterion_changed"
>;

/**
 * Claims the current manifest carries that the base manifest does not carry
 * verbatim. Removal has no entry on purpose: a deleted link leaves no claim to
 * judge, and a deleted criterion takes its links with it.
 */
function changedContractClaims(
  manifest: ContractManifest,
  baseManifest: ContractManifest | null
): Array<{ claim: ClaimingCriterion; reason: ClaimChangeReason }> {
  const baseClaims = new Map<string, ClaimingCriterion>();
  if (baseManifest) {
    for (const claims of buildContractClaimIndex(baseManifest).values()) {
      for (const claim of claims) {
        baseClaims.set(contractClaimIdentity(claim), claim);
      }
    }
  }
  const changed: Array<{
    claim: ClaimingCriterion;
    reason: ClaimChangeReason;
  }> = [];
  for (const claims of buildContractClaimIndex(manifest).values()) {
    for (const claim of claims) {
      const base = baseClaims.get(contractClaimIdentity(claim));
      if (!base) {
        changed.push({ claim, reason: "link_added" });
      } else if (base.acceptance_criterion !== claim.acceptance_criterion) {
        changed.push({ claim, reason: "criterion_changed" });
      }
    }
  }
  return changed;
}

function compareEntries(left: GradeScopeEntry, right: GradeScopeEntry): number {
  return (
    left.acceptance_criterion_stable_id.localeCompare(
      right.acceptance_criterion_stable_id
    ) ||
    left.path.localeCompare(right.path) ||
    left.linked_path.localeCompare(right.linked_path) ||
    left.target_kind.localeCompare(right.target_kind) ||
    left.repository.localeCompare(right.repository) ||
    (left.selector ?? "").localeCompare(right.selector ?? "") ||
    (left.framework_hint ?? "").localeCompare(right.framework_hint ?? "") ||
    left.relation.localeCompare(right.relation) ||
    left.link_scope.localeCompare(right.link_scope)
  );
}

/**
 * Derives the grading work list from reconciliation's shared contract-claim
 * index plus a claim diff against the base manifest. Every changed local claim
 * survives, whichever side of it changed; relevance scores never participate.
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
  const symbolsFor = (path: string): string[] => {
    let symbols = symbolCache.get(path);
    if (!symbols) {
      symbols = citableSymbolsForPath(input.repositoryRoot, path);
      symbolCache.set(path, symbols);
    }
    return symbols;
  };
  const entries = new Map<string, GradeScopeEntry>();
  const diffScopedClaims = new Set<string>();

  for (const change of reconciliation.claimed_changes) {
    const symbols = symbolsFor(change.path);
    for (const claim of change.claimed_by) {
      diffScopedClaims.add(contractClaimIdentity(claim));
      const id = scopeId({
        claim,
        path: change.path,
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
        provenance: claim.provenance,
        link_scope: claim.link_scope,
        target_kind: claim.target_kind,
        repository: claim.repository,
        linked_path: claim.linked_path,
        selector: claim.selector,
        framework_hint: claim.framework_hint,
        path: change.path,
        previous_path: change.old_path ?? null,
        reason: change.status,
        symbols: [...symbols],
      });
    }
  }

  // A claim both diff-scoped and claim-side changed yields the diff entry: it
  // carries the change status and rename lineage a claim-side reason cannot.
  for (const { claim, reason } of changedContractClaims(
    input.manifest,
    input.baseManifest
  )) {
    if (diffScopedClaims.has(contractClaimIdentity(claim))) continue;
    const id = scopeId({
      claim,
      path: claim.linked_path,
    });
    if (entries.has(id)) continue;
    entries.set(id, {
      id,
      capability_stable_id: claim.capability_stable_id,
      story_stable_id: claim.story_stable_id,
      story_title: claim.story_title,
      acceptance_criterion_stable_id: claim.acceptance_criterion_stable_id,
      acceptance_criterion: claim.acceptance_criterion,
      relation: claim.relation,
      provenance: claim.provenance,
      link_scope: claim.link_scope,
      target_kind: claim.target_kind,
      repository: claim.repository,
      linked_path: claim.linked_path,
      selector: claim.selector,
      framework_hint: claim.framework_hint,
      path: claim.linked_path,
      previous_path: null,
      reason,
      symbols: [...symbolsFor(claim.linked_path)],
    });
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
    lines.push(
      "  No contract link changed: no changed path is claimed by an evidence link, and no link or criterion is new or re-worded against the base.\n"
    );
    return lines.join("");
  }
  for (const entry of scope.entries) {
    const target =
      entry.linked_path === entry.path
        ? ""
        : `, contract target ${entry.linked_path}`;
    lines.push(
      `\n  ${entry.id}  ${entry.acceptance_criterion_stable_id} ${entry.relation} ${entry.path} (${entry.provenance}, ${entry.link_scope}, ${entry.reason}${target})\n`
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
