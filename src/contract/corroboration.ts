/**
 * Execution corroboration for contract links.
 *
 * A contract link (`implements` / `enforces` / `tests`) is a human assertion.
 * Test-execution data is the only cheap observation that can be held against
 * it, and the relationship is asymmetric:
 *
 * - Coverage is a STRONG FALSIFIER. If the linked tests demonstrably ran and
 *   the linked implementation file was never entered, the claim "these tests
 *   exercise this code" has no execution support.
 * - Coverage is a WEAK CONFIRMER. Executing a file says the file was entered,
 *   not that the acceptance criterion holds. Nothing in this module ever
 *   concludes that a link is verified, validated, or correct. The strongest
 *   positive statement available here is "corroborated by execution", and it
 *   is only ever reported as a count in the summary.
 *
 * The precedence rule follows from that asymmetry: if the acceptance
 * criterion's own linked tests did not run, absence of coverage is not
 * evidence against the implementation link, it is the absence of evidence
 * either way. In that case every `unsupported_implementation` conclusion for
 * that acceptance criterion is suppressed and the `uncovered_by_linked_tests`
 * state is reported instead. The two are never collapsed into one finding
 * kind, because "we looked and found nothing" and "we could not look" call for
 * completely different responses from a reviewer.
 *
 * Candidate links are suggestions only. This module never mutates the
 * contract and never asserts that a suggested relationship exists.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ContractManifest, ManifestLink } from "./manifest.js";

export type CoverageFormat = "lcov" | "istanbul_json" | "istanbul_json_summary";

export interface ExecutedLineRange {
  start: number;
  end: number;
}

export interface CoverageFileRecord {
  /** Repository-relative POSIX path. */
  path: string;
  /** True when the run entered the file at least once. */
  executed: boolean;
  executed_line_count: number;
  /**
   * Executed line ranges when the report carries line detail, `null` when the
   * format only reports totals. Retained so a later change can compare a link
   * selector against executed spans; no selector matching happens here.
   */
  executed_line_ranges: ExecutedLineRange[] | null;
}

export interface NormalizedCoverage {
  format: CoverageFormat;
  /** Sorted by path. Includes files that were reported but never entered. */
  files: CoverageFileRecord[];
  /** Reported paths that resolve outside the repository root, sorted. */
  dropped_paths: string[];
}

/**
 * Coverage attributed to a single test file, used only to suggest candidate
 * links. Produce one per test-file run; a merged whole-suite report cannot
 * attribute an executed file to any particular acceptance criterion.
 */
export interface TestExecutionAttribution {
  /** Repository-relative POSIX path of the test file this run belongs to. */
  test_path: string;
  coverage: NormalizedCoverage;
}

export type CorroborationFindingKind =
  | "unsupported_implementation"
  | "uncovered_by_linked_tests"
  | "candidate_link";

/** `unlinked` marks a finding about a path the acceptance criterion does not link. */
export type CorroborationRelation =
  | "implements"
  | "enforces"
  | "tests"
  | "unlinked";

export type CorroborationReason =
  | "linked_code_absent_from_run"
  | "linked_code_present_but_not_executed"
  | "no_linked_tests"
  | "linked_test_absent_from_run"
  | "linked_test_present_but_not_executed"
  | "linked_test_outside_repository"
  | "executed_by_linked_tests_but_unlinked";

export interface CorroborationFinding {
  repository: string;
  story_stable_id: string;
  acceptance_criterion_stable_id: string;
  /** `null` when the finding is about the absence of a linked artifact. */
  path: string | null;
  relation: CorroborationRelation;
  kind: CorroborationFindingKind;
  reason: CorroborationReason;
  executed_line_count: number | null;
  executed_line_ranges: ExecutedLineRange[] | null;
}

export interface ExecutionCorroborationSummary {
  coverage_format: CoverageFormat;
  /** False when the run entered no repository file at all, so it falsifies nothing. */
  coverage_usable: boolean;
  reported_files: number;
  executed_files: number;
  dropped_paths_outside_repository: number;
  attributed_test_runs: number;
  candidate_links_evaluated: boolean;
  acceptance_criteria_examined: number;
  /**
   * Acceptance criteria whose own linked tests ran, so this run can say
   * something about them at all. Says nothing about whether their
   * implementation links held up.
   */
  acceptance_criteria_with_test_evidence: number;
  /**
   * Acceptance criteria whose linked tests ran and whose linked implementation
   * was executed by them. Corroboration only, never a verification claim: the
   * code ran, which is not the same as the code satisfying the criterion.
   */
  acceptance_criteria_corroborated_by_execution: number;
  findings_by_kind: Record<CorroborationFindingKind, number>;
}

export interface ExecutionCorroborationReport {
  summary: ExecutionCorroborationSummary;
  findings: CorroborationFinding[];
}

export interface ExecutionCorroborationOptions {
  manifest: ContractManifest;
  /** Whole-run coverage, normally the merged report for the whole suite. */
  coverage: NormalizedCoverage;
  /** Per-test-file coverage. Without it no candidate links are suggested. */
  attributions?: TestExecutionAttribution[];
  /** Minimum executed lines before an unlinked file is worth suggesting. */
  candidateLinkMinimumExecutedLines?: number;
}

export const DEFAULT_CANDIDATE_LINK_MINIMUM_EXECUTED_LINES = 5;

export class CoverageParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoverageParseError";
  }
}

const SUPPORTED_FORMATS =
  "LCOV (SF:/DA:/end_of_record), Istanbul JSON detail (statementMap + s), Istanbul JSON summary (lines.covered)";

function repositoryRelativePath(root: string, raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const path = relative(resolve(root), resolve(root, trimmed));
  if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    return null;
  }
  return path.split(sep).join("/");
}

function toRanges(lines: Set<number>): ExecutedLineRange[] {
  const ranges: ExecutedLineRange[] = [];
  for (const line of [...lines].sort((left, right) => left - right)) {
    const last = ranges[ranges.length - 1];
    if (last && line <= last.end + 1) {
      last.end = Math.max(last.end, line);
      continue;
    }
    ranges.push({ start: line, end: line });
  }
  return ranges;
}

function finalizeCoverage(input: {
  format: CoverageFormat;
  lines: Map<string, Set<number>>;
  totals: Map<string, number>;
  dropped: Set<string>;
  lineDetail: boolean;
}): NormalizedCoverage {
  const paths = new Set([...input.lines.keys(), ...input.totals.keys()]);
  const files = [...paths].sort().map((path) => {
    const executedLines = input.lines.get(path);
    const count = input.lineDetail
      ? (executedLines?.size ?? 0)
      : (input.totals.get(path) ?? 0);
    return {
      path,
      executed: count > 0,
      executed_line_count: count,
      executed_line_ranges: input.lineDetail
        ? toRanges(executedLines ?? new Set())
        : null,
    };
  });
  return {
    format: input.format,
    files,
    dropped_paths: [...input.dropped].sort(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Detects the report format from its content. Returns `null` when the input
 * matches none of the supported shapes; callers must fail loudly rather than
 * guess, because an unread report silently produces "no evidence" everywhere.
 */
export function detectCoverageFormat(content: string): CoverageFormat | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) return "istanbul_json";
  return /^SF:/m.test(trimmed) ? "lcov" : null;
}

function parseLcov(
  content: string,
  repositoryRoot: string,
  label: string
): NormalizedCoverage {
  const lines = new Map<string, Set<number>>();
  const dropped = new Set<string>();
  let current: Set<number> | null = null;
  let skipping = false;
  let records = 0;

  content.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    if (line.startsWith("SF:")) {
      records += 1;
      const raw = line.slice(3).trim();
      const path = repositoryRelativePath(repositoryRoot, raw);
      if (!path) {
        dropped.add(raw);
        current = null;
        skipping = true;
        return;
      }
      skipping = false;
      current = lines.get(path) ?? new Set<number>();
      lines.set(path, current);
      return;
    }
    if (line === "end_of_record") {
      current = null;
      skipping = false;
      return;
    }
    if (!line.startsWith("DA:")) return;
    const fields = line.slice(3).split(",");
    const lineNumber = Number(fields[0]);
    const hits = Number(fields[1]);
    if (
      fields.length < 2 ||
      !Number.isInteger(lineNumber) ||
      lineNumber <= 0 ||
      !Number.isFinite(hits)
    ) {
      throw new CoverageParseError(
        `Unreadable LCOV 'DA:' entry in ${label} at line ${index + 1}: ${line}`
      );
    }
    if (skipping) return;
    if (!current) {
      throw new CoverageParseError(
        `LCOV 'DA:' entry in ${label} at line ${index + 1} appears before any 'SF:' record.`
      );
    }
    if (hits > 0) current.add(lineNumber);
  });

  if (records === 0) {
    throw new CoverageParseError(
      `${label} contains no LCOV 'SF:' records. Supported formats: ${SUPPORTED_FORMATS}.`
    );
  }
  return finalizeCoverage({
    format: "lcov",
    lines,
    totals: new Map(),
    dropped,
    lineDetail: true,
  });
}

function istanbulEntries(
  value: Record<string, unknown>
): [string, Record<string, unknown>][] {
  return Object.entries(value)
    .filter(([key]) => key !== "total")
    .map(([key, entry]) => [key, isRecord(entry) ? entry : {}] as [string, Record<string, unknown>]);
}

function isDetailEntry(entry: Record<string, unknown>): boolean {
  return isRecord(entry.statementMap) && isRecord(entry.s);
}

function isSummaryEntry(entry: Record<string, unknown>): boolean {
  return isRecord(entry.lines) && typeof entry.lines.covered === "number";
}

function statementLines(
  entry: Record<string, unknown>,
  key: string,
  label: string
): Set<number> {
  const statementMap = entry.statementMap as Record<string, unknown>;
  const counts = entry.s as Record<string, unknown>;
  const executed = new Set<number>();
  for (const [statementId, location] of Object.entries(statementMap)) {
    const hits = counts[statementId];
    if (typeof hits !== "number" || !Number.isFinite(hits)) {
      throw new CoverageParseError(
        `Istanbul JSON entry '${key}' in ${label} has no usable execution count for statement '${statementId}'.`
      );
    }
    if (hits <= 0) continue;
    if (!isRecord(location) || !isRecord(location.start) || !isRecord(location.end)) {
      throw new CoverageParseError(
        `Istanbul JSON entry '${key}' in ${label} has an unreadable statement location for '${statementId}'.`
      );
    }
    const start = location.start.line;
    const end = location.end.line;
    if (typeof start !== "number" || !Number.isInteger(start) || start <= 0) {
      throw new CoverageParseError(
        `Istanbul JSON entry '${key}' in ${label} has an unreadable start line for statement '${statementId}'.`
      );
    }
    const last =
      typeof end === "number" && Number.isInteger(end) && end >= start ? end : start;
    for (let line = start; line <= last; line += 1) executed.add(line);
  }
  return executed;
}

function parseIstanbulJson(
  content: string,
  repositoryRoot: string,
  label: string
): NormalizedCoverage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new CoverageParseError(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!isRecord(parsed)) {
    throw new CoverageParseError(
      `${label} must be a JSON object keyed by file path. Supported formats: ${SUPPORTED_FORMATS}.`
    );
  }
  const entries = istanbulEntries(parsed);
  if (entries.length === 0) {
    throw new CoverageParseError(
      `${label} contains no file entries. Supported formats: ${SUPPORTED_FORMATS}.`
    );
  }
  const detail = entries.every(([, entry]) => isDetailEntry(entry));
  const summary = !detail && entries.every(([, entry]) => isSummaryEntry(entry));
  if (!detail && !summary) {
    throw new CoverageParseError(
      `${label} is a JSON object but matches no supported coverage shape. Supported formats: ${SUPPORTED_FORMATS}.`
    );
  }

  const lines = new Map<string, Set<number>>();
  const totals = new Map<string, number>();
  const dropped = new Set<string>();
  for (const [key, entry] of entries) {
    const raw = typeof entry.path === "string" && entry.path.trim() ? entry.path : key;
    const path = repositoryRelativePath(repositoryRoot, raw);
    if (!path) {
      dropped.add(raw.trim());
      continue;
    }
    if (detail) {
      const executed = lines.get(path) ?? new Set<number>();
      for (const line of statementLines(entry, key, label)) executed.add(line);
      lines.set(path, executed);
      continue;
    }
    const covered = (entry.lines as Record<string, unknown>).covered;
    totals.set(path, (totals.get(path) ?? 0) + (typeof covered === "number" ? covered : 0));
  }

  return finalizeCoverage({
    format: detail ? "istanbul_json" : "istanbul_json_summary",
    lines,
    totals,
    dropped,
    lineDetail: detail,
  });
}

/**
 * Parses a coverage report into repository-relative executed files. Unknown
 * or malformed input throws `CoverageParseError` rather than yielding an empty
 * result, because an empty result would read as "nothing is covered".
 */
export function parseCoverageReport(input: {
  content: string;
  repositoryRoot: string;
  sourceLabel?: string;
}): NormalizedCoverage {
  const label = input.sourceLabel ?? "coverage report";
  const format = detectCoverageFormat(input.content);
  if (!format) {
    throw new CoverageParseError(
      `${label} is empty or is not a recognized coverage report. Supported formats: ${SUPPORTED_FORMATS}.`
    );
  }
  return format === "lcov"
    ? parseLcov(input.content, input.repositoryRoot, label)
    : parseIstanbulJson(input.content, input.repositoryRoot, label);
}

/** Reads and parses a coverage report from disk. */
export function readCoverageReport(input: {
  path: string;
  repositoryRoot: string;
}): NormalizedCoverage {
  let content: string;
  try {
    content = readFileSync(input.path, "utf8");
  } catch (error) {
    throw new CoverageParseError(
      `Cannot read coverage report '${input.path}': ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  return parseCoverageReport({
    content,
    repositoryRoot: input.repositoryRoot,
    sourceLabel: `coverage report '${input.path}'`,
  });
}

function coverageIndex(coverage: NormalizedCoverage): Map<string, CoverageFileRecord> {
  return new Map(coverage.files.map((file) => [file.path, file]));
}

function localTargetPath(link: ManifestLink, repositoryKey: string): string | null {
  if (link.target.kind === "help") return null;
  return link.target.repository === repositoryKey ? link.target.path : null;
}

interface TestEvidence {
  established: boolean;
  findings: Omit<CorroborationFinding, "repository" | "story_stable_id" | "acceptance_criterion_stable_id">[];
}

/**
 * Decides whether the acceptance criterion's own linked tests ran. When they
 * did not, no conclusion about its implementation links is safe.
 */
function testEvidence(
  links: ManifestLink[],
  repositoryKey: string,
  files: Map<string, CoverageFileRecord>
): TestEvidence {
  const testLinks = links.filter((link) => link.relation === "tests");
  if (testLinks.length === 0) {
    return {
      established: false,
      findings: [
        {
          path: null,
          relation: "tests",
          kind: "uncovered_by_linked_tests",
          reason: "no_linked_tests",
          executed_line_count: null,
          executed_line_ranges: null,
        },
      ],
    };
  }

  const findings: TestEvidence["findings"] = [];
  let established = false;
  for (const link of testLinks) {
    const path = localTargetPath(link, repositoryKey);
    if (!path) {
      findings.push({
        path: link.target.kind === "help" ? null : link.target.path,
        relation: "tests",
        kind: "uncovered_by_linked_tests",
        reason: "linked_test_outside_repository",
        executed_line_count: null,
        executed_line_ranges: null,
      });
      continue;
    }
    const file = files.get(path);
    if (file?.executed) {
      established = true;
      continue;
    }
    findings.push({
      path,
      relation: "tests",
      kind: "uncovered_by_linked_tests",
      reason: file
        ? "linked_test_present_but_not_executed"
        : "linked_test_absent_from_run",
      executed_line_count: file?.executed_line_count ?? null,
      executed_line_ranges: file?.executed_line_ranges ?? null,
    });
  }
  return { established, findings: established ? [] : findings };
}

function candidateLinks(input: {
  attributions: TestExecutionAttribution[];
  testPaths: Set<string>;
  linkedPaths: Set<string>;
  minimumExecutedLines: number;
}): TestEvidence["findings"] {
  const merged = new Map<string, { count: number; lines: ExecutedLineRange[] | null }>();
  for (const attribution of input.attributions) {
    if (!input.testPaths.has(attribution.test_path)) continue;
    for (const file of attribution.coverage.files) {
      if (!file.executed) continue;
      if (file.path === attribution.test_path) continue;
      if (input.testPaths.has(file.path) || input.linkedPaths.has(file.path)) continue;
      const existing = merged.get(file.path);
      merged.set(file.path, {
        count: (existing?.count ?? 0) + file.executed_line_count,
        lines:
          file.executed_line_ranges === null
            ? (existing?.lines ?? null)
            : [...(existing?.lines ?? []), ...file.executed_line_ranges],
      });
    }
  }
  return [...merged.entries()]
    .filter(([, entry]) => entry.count >= input.minimumExecutedLines)
    .map(([path, entry]) => ({
      path,
      relation: "unlinked" as const,
      kind: "candidate_link" as const,
      reason: "executed_by_linked_tests_but_unlinked" as const,
      executed_line_count: entry.count,
      executed_line_ranges: entry.lines
        ? toRanges(
            new Set(
              entry.lines.flatMap((range) =>
                Array.from(
                  { length: range.end - range.start + 1 },
                  (_unused, offset) => range.start + offset
                )
              )
            )
          )
        : null,
    }));
}

const FINDING_KINDS: CorroborationFindingKind[] = [
  "candidate_link",
  "uncovered_by_linked_tests",
  "unsupported_implementation",
];

/**
 * Corroborates contract links against observed test execution.
 *
 * Emits `unsupported_implementation` only for acceptance criteria whose own
 * linked tests ran; otherwise emits `uncovered_by_linked_tests`. The two kinds
 * are mutually exclusive per acceptance criterion by construction, so a
 * reader can always tell "evidence against" from "no evidence either way".
 */
export function analyzeExecutionCorroboration(
  options: ExecutionCorroborationOptions
): ExecutionCorroborationReport {
  const repositoryKey = options.manifest.repository.key;
  const files = coverageIndex(options.coverage);
  const attributions = options.attributions ?? [];
  const minimumExecutedLines =
    options.candidateLinkMinimumExecutedLines ??
    DEFAULT_CANDIDATE_LINK_MINIMUM_EXECUTED_LINES;
  const findings: CorroborationFinding[] = [];
  let examined = 0;
  let withTestEvidence = 0;
  let corroborated = 0;

  for (const capability of options.manifest.capabilities) {
    for (const story of capability.stories) {
      for (const criterion of story.acceptance_criteria) {
        examined += 1;
        const evidence = testEvidence(criterion.links, repositoryKey, files);
        const partial = [...evidence.findings];

        if (evidence.established) {
          withTestEvidence += 1;
          let implementationLinks = 0;
          for (const link of criterion.links) {
            if (link.relation !== "implements" && link.relation !== "enforces") {
              continue;
            }
            const path = localTargetPath(link, repositoryKey);
            if (!path) continue;
            implementationLinks += 1;
            const file = files.get(path);
            if (file?.executed) continue;
            partial.push({
              path,
              relation: link.relation,
              kind: "unsupported_implementation",
              reason: file
                ? "linked_code_present_but_not_executed"
                : "linked_code_absent_from_run",
              executed_line_count: file?.executed_line_count ?? null,
              executed_line_ranges: file?.executed_line_ranges ?? null,
            });
          }
          const linkedPaths = new Set<string>();
          for (const link of [...criterion.links, ...story.links]) {
            const path = localTargetPath(link, repositoryKey);
            if (path) linkedPaths.add(path);
          }
          const testPaths = new Set<string>();
          for (const link of criterion.links) {
            if (link.relation !== "tests") continue;
            const path = localTargetPath(link, repositoryKey);
            if (path) testPaths.add(path);
          }
          partial.push(
            ...candidateLinks({
              attributions,
              testPaths,
              linkedPaths,
              minimumExecutedLines,
            })
          );
          // A criterion with no local implementation link has nothing for
          // execution to corroborate, however thoroughly its tests ran.
          if (
            implementationLinks > 0 &&
            !partial.some(
              (finding) => finding.kind === "unsupported_implementation"
            )
          ) {
            corroborated += 1;
          }
        }

        for (const finding of partial) {
          findings.push({
            repository: repositoryKey,
            story_stable_id: story.stable_id,
            acceptance_criterion_stable_id: criterion.stable_id,
            ...finding,
          });
        }
      }
    }
  }

  const unique = new Map<string, CorroborationFinding>();
  for (const finding of findings) {
    unique.set(
      [
        finding.acceptance_criterion_stable_id,
        finding.kind,
        finding.path ?? "",
        finding.relation,
      ].join("\0"),
      finding
    );
  }
  const sorted = [...unique.values()].sort(
    (left, right) =>
      left.acceptance_criterion_stable_id.localeCompare(
        right.acceptance_criterion_stable_id
      ) ||
      left.kind.localeCompare(right.kind) ||
      (left.path ?? "").localeCompare(right.path ?? "") ||
      left.relation.localeCompare(right.relation)
  );

  const findingsByKind = Object.fromEntries(
    FINDING_KINDS.map((kind) => [
      kind,
      sorted.filter((finding) => finding.kind === kind).length,
    ])
  ) as Record<CorroborationFindingKind, number>;

  return {
    summary: {
      coverage_format: options.coverage.format,
      coverage_usable: options.coverage.files.some((file) => file.executed),
      reported_files: options.coverage.files.length,
      executed_files: options.coverage.files.filter((file) => file.executed).length,
      dropped_paths_outside_repository: options.coverage.dropped_paths.length,
      attributed_test_runs: attributions.length,
      candidate_links_evaluated: attributions.length > 0,
      acceptance_criteria_examined: examined,
      acceptance_criteria_with_test_evidence: withTestEvidence,
      acceptance_criteria_corroborated_by_execution: corroborated,
      findings_by_kind: findingsByKind,
    },
    findings: sorted,
  };
}
