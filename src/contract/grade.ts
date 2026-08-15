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
import { z } from "zod";
import { compareCodeTopologyText } from "../domain/code-topology-ordering.js";
import {
  buildStructuralSourceEvidence,
  type StructuralSourceEvidence,
} from "./artifact-assurance.js";
import {
  createStructuralSelectorResolver,
  resolveExactStructuralSelectorFromAnalysis,
} from "./code-analysis/selector-resolution.js";
import type {
  CodeAnalysisCompatibility,
  CodeSymbolFact,
  LanguageAnalysisResult,
  ParserDiagnostic,
} from "./code-analysis/types.js";
import type { SupportedCodeLanguage } from "./code-analysis/languages.js";
import type { RepositoryPathChange } from "./impact.js";
import type { ContractManifest } from "./manifest.js";
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
  CORE_SELECTOR_VOCABULARY,
  DEFAULT_MAX_SELECTOR_SOURCE_BYTES,
  validateSelector,
} from "./selector.js";
import {
  createFilesystemSourceSnapshotReader,
  type SourceSnapshot,
  type SourceSnapshotFailureStatus,
  type SourceSnapshotReadResult,
} from "./source-snapshot.js";

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

export type GradeCodeEvidenceReason =
  | SourceSnapshotFailureStatus
  | "unsupported_language"
  | "analyzer_unavailable"
  | "analysis_failed"
  | "parse_incomplete"
  | "selector_invalid"
  | "selector_unresolved"
  | "selector_ambiguous"
  | "no_citable_symbols";

/** Ephemeral parser evidence. The host still decides semantic AC support. */
export interface GradeCodeEvidence {
  status: "available" | "unavailable";
  reason: GradeCodeEvidenceReason | null;
  detail: string;
  language: SupportedCodeLanguage | null;
  content_hash: string | null;
  parser_compatibility: string | null;
  diagnostics: readonly ParserDiagnostic[];
  symbols: readonly GradeSymbolEvidence[];
}

/** Per-symbol facts; file-wide parser facts live once on `GradeCodeEvidence`. */
export interface GradeSymbolEvidence {
  canonical_selector: string;
  symbol_identity: string;
  native_kind: string;
  syntax_status: CodeSymbolFact["syntaxStatus"];
  name_range: StructuralSourceEvidence["name_range"];
  range: StructuralSourceEvidence["range"];
  snippet: StructuralSourceEvidence["snippet"];
  diagnostics: readonly ParserDiagnostic[];
}

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
  /** Bounded source facts used by the host to make its semantic judgment. */
  code_evidence: GradeCodeEvidence;
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
  /** Test seam; ownership transfers to this request and is always disposed. */
  codeAnalysisSession?: GradeCodeAnalysisSession;
}

export interface GradeCodeAnalysisSession {
  read(path: string): SourceSnapshotReadResult;
  analyze(snapshot: SourceSnapshot): Promise<LanguageAnalysisResult | null>;
  dispose(): Promise<void>;
}

function createGradeCodeAnalysisSession(
  repositoryRoot: string
): GradeCodeAnalysisSession {
  const reader = createFilesystemSourceSnapshotReader({
    repositoryRoot,
    maxSourceBytes: DEFAULT_MAX_SELECTOR_SOURCE_BYTES,
  });
  const resolver = createStructuralSelectorResolver();
  return {
    read(path) {
      return reader.read(path);
    },
    analyze(snapshot) {
      return resolver.analyze(snapshot);
    },
    async dispose() {
      try {
        await resolver.dispose();
      } finally {
        reader.dispose?.();
      }
    },
  };
}

type GradePathAnalysis =
  | { status: "source_unavailable"; read: Exclude<SourceSnapshotReadResult, { status: "read" }> }
  | { status: "unsupported_language"; snapshot: SourceSnapshot }
  | { status: "analyzer_unavailable"; snapshot: SourceSnapshot }
  | { status: "analysis_failed"; snapshot: SourceSnapshot; detail: string }
  | { status: "analyzed"; snapshot: SourceSnapshot; analysis: LanguageAnalysisResult };

function unavailableEvidence(input: {
  reason: GradeCodeEvidenceReason;
  detail: string;
  language?: SupportedCodeLanguage | null;
  contentHash?: string | null;
  compatibility?: CodeAnalysisCompatibility | null;
  diagnostics?: readonly ParserDiagnostic[];
}): GradeCodeEvidence {
  return Object.freeze({
    status: "unavailable",
    reason: input.reason,
    detail: input.detail,
    language: input.language ?? null,
    content_hash: input.contentHash ?? null,
    parser_compatibility: input.compatibility?.identity ?? null,
    diagnostics: Object.freeze([...(input.diagnostics ?? [])]),
    symbols: Object.freeze([]),
  });
}

function gradeSymbolEvidence(
  snapshot: SourceSnapshot,
  analysis: LanguageAnalysisResult,
  fact: CodeSymbolFact,
  selector: string
): GradeSymbolEvidence {
  const evidence = buildStructuralSourceEvidence({
    snapshot,
    symbol: fact,
    canonicalSelector: selector,
    language: analysis.language,
    compatibility: analysis.compatibility,
    diagnostics: analysis.diagnostics,
  });
  return Object.freeze({
    canonical_selector: evidence.canonical_selector,
    symbol_identity: evidence.symbol_identity,
    native_kind: evidence.native_kind,
    syntax_status: evidence.syntax_status,
    name_range: evidence.name_range,
    range: evidence.range,
    snippet: evidence.snippet,
    diagnostics: evidence.diagnostics,
  });
}

function availableEvidence(
  analysis: LanguageAnalysisResult,
  symbols: readonly GradeSymbolEvidence[]
): GradeCodeEvidence {
  return Object.freeze({
    status: "available",
    reason: null,
    detail: `Parser-backed evidence from ${symbols.length} uniquely citable declaration(s).`,
    language: analysis.language,
    content_hash: analysis.sourceHash,
    parser_compatibility: analysis.compatibility.identity,
    diagnostics: Object.freeze([...analysis.diagnostics]),
    symbols: Object.freeze([...symbols]),
  });
}

function rangeIdentity(range: StructuralSourceEvidence["range"] | null) {
  if (range === null) return null;
  return {
    utf16: [range.utf16.start, range.utf16.end],
    utf8_bytes: [range.utf8Bytes.start, range.utf8Bytes.end],
    start: [
      range.start.line,
      range.start.utf16Column,
      range.start.utf8ByteColumn,
    ],
    end: [range.end.line, range.end.utf16Column, range.end.utf8ByteColumn],
  };
}

function diagnosticIdentity(diagnostic: ParserDiagnostic) {
  return {
    kind: diagnostic.kind,
    native_kind: diagnostic.nativeKind,
    range: rangeIdentity(diagnostic.range),
  };
}

function evidenceIdentity(evidence: GradeCodeEvidence): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        status: evidence.status,
        reason: evidence.reason,
        language: evidence.language,
        content_hash: evidence.content_hash,
        parser_compatibility: evidence.parser_compatibility,
        diagnostics: evidence.diagnostics.map(diagnosticIdentity),
        symbols: evidence.symbols.map((symbol) => ({
          canonical_selector: symbol.canonical_selector,
          symbol_identity: symbol.symbol_identity,
          native_kind: symbol.native_kind,
          syntax_status: symbol.syntax_status,
          name_range: rangeIdentity(symbol.name_range),
          range: rangeIdentity(symbol.range),
          snippet_truncated: symbol.snippet.truncated,
          diagnostics: symbol.diagnostics.map(diagnosticIdentity),
        })),
      })
    )
    .digest("hex");
}

function evidenceForClaim(
  analysis: GradePathAnalysis,
  selector: string | null
): GradeCodeEvidence {
  if (analysis.status === "source_unavailable") {
    const detail =
      analysis.read.status === "oversized"
        ? `Source '${analysis.read.path}' is ${analysis.read.observedBytes ?? "an unknown number of"} bytes; the analysis limit is ${analysis.read.maxSourceBytes ?? "unknown"} bytes.`
        : `Source '${analysis.read.path}' is unavailable for parser-backed grading (${analysis.read.status}).`;
    return unavailableEvidence({
      reason: analysis.read.status,
      detail,
      contentHash: analysis.read.sha256 ?? null,
    });
  }
  if (analysis.status === "unsupported_language") {
    return unavailableEvidence({
      reason: "unsupported_language",
      detail: `'${analysis.snapshot.path}' is not a supported parser language.`,
      contentHash: analysis.snapshot.sha256,
    });
  }
  if (analysis.status === "analyzer_unavailable") {
    return unavailableEvidence({
      reason: "analyzer_unavailable",
      detail: `'${analysis.snapshot.path}' has no registered parser analyzer.`,
      language: analysis.snapshot.language,
      contentHash: analysis.snapshot.sha256,
    });
  }
  if (analysis.status === "analysis_failed") {
    return unavailableEvidence({
      reason: "analysis_failed",
      detail: analysis.detail,
      language: analysis.snapshot.language,
      contentHash: analysis.snapshot.sha256,
    });
  }

  const result = analysis.analysis;
  const unavailable = (
    reason: GradeCodeEvidenceReason,
    detail: string
  ): GradeCodeEvidence =>
    unavailableEvidence({
      reason,
      detail,
      language: result.language,
      contentHash: result.sourceHash,
      compatibility: result.compatibility,
      diagnostics: result.diagnostics,
    });
  if (result.truncated.symbols || result.truncated.diagnostics) {
    return unavailable(
      "parse_incomplete",
      `Parser facts for '${analysis.snapshot.path}' were truncated.`
    );
  }
  if (selector !== null) {
    const validated = validateSelector(selector, CORE_SELECTOR_VOCABULARY);
    if (!validated.ok) {
      return unavailable("selector_invalid", validated.error);
    }
    const resolution = resolveExactStructuralSelectorFromAnalysis(
      analysis.snapshot,
      validated.selector,
      result
    );
    if (resolution.status === "not_checked") {
      return unavailable(
        "parse_incomplete",
        resolution.detail
      );
    }
    if (resolution.status === "unresolved") {
      return unavailable(
        "selector_unresolved",
        `Parsed '${analysis.snapshot.path}' but found no unique declaration '${validated.selector.canonical}'.`
      );
    }
    if (resolution.status === "ambiguous") {
      return unavailable(
        "selector_ambiguous",
        `Found ${resolution.matching_symbols?.length ?? 0} declarations for '${validated.selector.canonical}' in '${analysis.snapshot.path}'.`
      );
    }
    const selected = resolution.matching_symbols?.[0];
    if (!selected) {
      return unavailable(
        "parse_incomplete",
        `Parser facts did not include '${validated.selector.canonical}' in '${analysis.snapshot.path}'.`
      );
    }
    const selectedEvidence = gradeSymbolEvidence(
      analysis.snapshot,
      result,
      selected,
      validated.selector.canonical
    );
    if (
      selectedEvidence.syntax_status === "recovered" ||
      selectedEvidence.diagnostics.length > 0
    ) {
      return unavailable(
        "parse_incomplete",
        `Localized parser recovery overlaps '${validated.selector.canonical}' in '${analysis.snapshot.path}'.`
      );
    }
    return availableEvidence(result, [selectedEvidence]);
  }

  if (
    result.diagnostics.length > 0 ||
    result.symbols.some((symbol) => symbol.syntaxStatus === "recovered")
  ) {
    return unavailable(
      "parse_incomplete",
      `Localized parser recovery makes '${analysis.snapshot.path}' incomplete for grading citations.`
    );
  }

  const bySelector = new Map<string, CodeSymbolFact[]>();
  for (const symbol of result.symbols) {
    if (symbol.selector === null) continue;
    const matches = bySelector.get(symbol.selector) ?? [];
    matches.push(symbol);
    bySelector.set(symbol.selector, matches);
  }
  const unique = [...bySelector.entries()]
    .filter(([, matches]) => matches.length === 1)
    .sort(([left], [right]) => compareCodeTopologyText(left, right))
    .map(([canonical, matches]) => ({ fact: matches[0]!, selector: canonical }));
  if (unique.length === 0) {
    return unavailable(
      "no_citable_symbols",
      `Parsed '${analysis.snapshot.path}' but found no unique canonical selectors.`
    );
  }
  return availableEvidence(
    result,
    unique.map(({ fact, selector: canonicalSelector }) =>
      gradeSymbolEvidence(analysis.snapshot, result, fact, canonicalSelector)
    )
  );
}

async function analyzePath(
  session: GradeCodeAnalysisSession,
  path: string
): Promise<GradePathAnalysis> {
  const read = session.read(path);
  if (read.status !== "read") return { status: "source_unavailable", read };
  if (read.snapshot.language === null) {
    return { status: "unsupported_language", snapshot: read.snapshot };
  }
  try {
    const analysis = await session.analyze(read.snapshot);
    return analysis
      ? { status: "analyzed", snapshot: read.snapshot, analysis }
      : { status: "analyzer_unavailable", snapshot: read.snapshot };
  } catch {
    return {
      status: "analysis_failed",
      snapshot: read.snapshot,
      detail: `Parser analysis failed for '${path}'.`,
    };
  }
}

function scopeId(input: {
  claim: ClaimingCriterion;
  path: string;
  previousPath: string | null;
  reason: GradeScopeReason;
  evidenceDigest: string;
}): string {
  const identity = [
    contractClaimIdentity(input.claim),
    input.claim.acceptance_criterion,
    input.path,
    input.previousPath ?? "",
    input.reason,
    input.evidenceDigest,
  ].join("\0");
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
export async function buildGradeScope(
  input: BuildGradeScopeInput
): Promise<GradeScope> {
  const reconciliation = analyzeContractReconciliation({
    repositoryRoot: input.repositoryRoot,
    manifest: input.manifest,
    changes: input.changes,
    sourceRoots: input.sourceRoots,
    ignore: input.ignore,
    specDirectory: input.specDirectory,
  });
  const drafts = new Map<
    string,
    {
      claim: ClaimingCriterion;
      path: string;
      previousPath: string | null;
      reason: GradeScopeReason;
    }
  >();
  const diffScopedClaims = new Set<string>();

  for (const change of reconciliation.claimed_changes) {
    for (const claim of change.claimed_by) {
      const claimIdentity = contractClaimIdentity(claim);
      diffScopedClaims.add(claimIdentity);
      const key = `${claimIdentity}\0${change.path}`;
      if (drafts.has(key)) continue;
      drafts.set(key, {
        claim,
        path: change.path,
        previousPath: change.old_path ?? null,
        reason: change.status,
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
    const key = `${contractClaimIdentity(claim)}\0${claim.linked_path}`;
    if (drafts.has(key)) continue;
    drafts.set(key, {
      claim,
      path: claim.linked_path,
      previousPath: null,
      reason,
    });
  }

  if (drafts.size === 0) {
    await input.codeAnalysisSession?.dispose();
    return {
      base: input.base,
      repository: input.manifest.repository.key,
      scoped_links: 0,
      entries: [],
    };
  }

  const session =
    input.codeAnalysisSession ??
    createGradeCodeAnalysisSession(input.repositoryRoot);
  const analyses = new Map<string, GradePathAnalysis>();
  try {
    const paths = [...new Set([...drafts.values()].map((draft) => draft.path))]
      .sort(compareCodeTopologyText);
    for (const path of paths) {
      analyses.set(path, await analyzePath(session, path));
    }
  } finally {
    await session.dispose();
  }

  const entries: GradeScopeEntry[] = [];
  const evidenceByLocator = new Map<
    string,
    { evidence: GradeCodeEvidence; identityDigest: string }
  >();
  for (const draft of drafts.values()) {
    const pathAnalysis = analyses.get(draft.path);
    if (!pathAnalysis) {
      throw new Error(`Missing request-local code analysis for '${draft.path}'.`);
    }
    const evidenceKey = `${draft.path}\0${draft.claim.selector ?? ""}`;
    let cachedEvidence = evidenceByLocator.get(evidenceKey);
    if (!cachedEvidence) {
      const evidence = evidenceForClaim(pathAnalysis, draft.claim.selector);
      cachedEvidence = {
        evidence,
        identityDigest: evidenceIdentity(evidence),
      };
      evidenceByLocator.set(evidenceKey, cachedEvidence);
    }
    const { evidence, identityDigest } = cachedEvidence;
    const id = scopeId({
      claim: draft.claim,
      path: draft.path,
      previousPath: draft.previousPath,
      reason: draft.reason,
      evidenceDigest: identityDigest,
    });
    entries.push({
      id,
      capability_stable_id: draft.claim.capability_stable_id,
      story_stable_id: draft.claim.story_stable_id,
      story_title: draft.claim.story_title,
      acceptance_criterion_stable_id:
        draft.claim.acceptance_criterion_stable_id,
      acceptance_criterion: draft.claim.acceptance_criterion,
      relation: draft.claim.relation,
      provenance: draft.claim.provenance,
      link_scope: draft.claim.link_scope,
      target_kind: draft.claim.target_kind,
      repository: draft.claim.repository,
      linked_path: draft.claim.linked_path,
      selector: draft.claim.selector,
      framework_hint: draft.claim.framework_hint,
      path: draft.path,
      previous_path: draft.previousPath,
      reason: draft.reason,
      symbols:
        evidence.status === "available"
          ? evidence.symbols.map((symbol) => symbol.canonical_selector)
          : [],
      code_evidence: evidence,
    });
  }

  const ordered = entries.sort(compareEntries);
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
      entry.code_evidence.status === "available"
        ? `    Evidence: ${entry.code_evidence.language}, ${entry.code_evidence.content_hash}, ${entry.code_evidence.parser_compatibility}.\n`
        : `    Evidence unavailable (${entry.code_evidence.reason}): ${entry.code_evidence.detail}\n`
    );
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
