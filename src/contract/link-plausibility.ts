/**
 * Advisory detection of implausible contract links.
 *
 * An acceptance criterion states an observable outcome in prose. Its links name
 * code and test files that a human asserted implement or exercise that outcome.
 * Those assertions drift: files get rewritten, split, or repurposed, and nobody
 * re-reads the link. This module produces a cheap, offline smell signal over the
 * links a repository already has — which of them read as lexically unrelated to
 * the criterion they claim to serve.
 *
 * THIS PRODUCES INFERENCE, NEVER EVIDENCE. Similarity never confirms a
 * relationship, and it never refutes one either. Every value here is a
 * suggestion that a human should re-read a link. Nothing in this module may
 * confirm, remove, rewrite, or fail anything, and no caller may treat a result
 * as a verdict:
 *
 * - A weak link is a `review_candidate`, never "invalid", "wrong", or "broken".
 * - A strong link produces no output at all. A high measurement is not an
 *   endorsement, so the report deliberately refuses to publish per-link scores
 *   for links it is not asking anyone to look at.
 * - An empty `review_candidates` list never means "every link is fine". It means
 *   this heuristic found nothing worth a reviewer's attention, which is a
 *   statement about the heuristic, not about the contract.
 *
 * Low recall is acceptable; low precision is not. The flagging rule is
 * deliberately conservative on both axes (bottom-percentile AND an absolute
 * floor), so it reports few links, each with a rationale naming the concrete
 * terms that did and did not overlap, so a reviewer can judge the suggestion
 * instead of trusting a number.
 *
 * Broken links — a link whose file no longer exists — are NOT this module's
 * business. Those are reported in `skipped` and never scored, so this signal
 * cannot duplicate or contradict the mechanism that owns missing artifacts.
 */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ContractManifest,
  ManifestAcceptanceCriterion,
  ManifestLink,
  ManifestStory,
} from "./manifest.js";

export const LINK_PLAUSIBILITY_METHOD = "lexical_token_overlap_v1";

export const LINK_PLAUSIBILITY_DISCLAIMER =
  "Lexical overlap is inference, never evidence. These are candidates for human review; nothing here confirms, invalidates, or removes a contract link.";

/** Fraction of the repository's own score distribution eligible for review. */
export const DEFAULT_REVIEW_PERCENTILE = 0.15;

/** A link scoring at or above this is never flagged, whatever its rank. */
export const DEFAULT_ABSOLUTE_SCORE_FLOOR = 0.15;

/** Below this many scored links a percentile is not meaningful. */
export const DEFAULT_MINIMUM_SAMPLE_SIZE = 8;

export const DEFAULT_MAX_SOURCE_BYTES = 512_000;

const MIN_TOKEN_LENGTH = 3;
const MIN_STRING_LITERAL_LENGTH = 4;
const MAX_STRING_LITERAL_LENGTH = 200;
const BINARY_SNIFF_BYTES = 8_000;
const RATIONALE_TERM_LIMIT = 4;

/**
 * Tokens that carry no signal about *what behavior* a file or criterion is
 * about: language keywords, English function words, and a short list of
 * universally content-free code nouns.
 *
 * This list is deliberately small. Terms that are ubiquitous in one repository
 * but meaningful in another ("index", "error", "config", "path") are handled by
 * document-frequency damping instead, which measures ubiquity against the
 * repository's own linked files rather than against a hardcoded opinion.
 */
export const LINK_PLAUSIBILITY_STOPWORDS: ReadonlySet<string> = new Set([
  // Language keywords and pervasive type names.
  "abstract", "any", "args", "arguments", "as", "async", "await", "bigint",
  "boolean", "break", "case", "catch", "class", "const", "constructor",
  "continue", "declare", "default", "delete", "else", "enum", "export",
  "extends", "false", "finally", "for", "from", "function", "get",
  "implements", "import", "infer", "instanceof", "interface", "keyof", "let",
  "module", "namespace", "never", "new", "null", "number", "object", "package",
  "private", "protected", "prototype", "public", "readonly", "require",
  "return", "satisfies", "set", "static", "string", "super", "switch",
  "symbol", "this", "throw", "true", "try", "type", "typeof", "undefined",
  "unknown", "var", "void", "while", "yield",
  // English function words that survive the minimum token length.
  "all", "and", "any", "are", "been", "being", "but", "can", "cannot", "could",
  "did", "does", "done", "each", "either", "every", "for", "from", "had",
  "has", "have", "here", "how", "into", "its", "may", "might", "more", "most",
  "must", "neither", "non", "nor", "not", "off", "once", "one", "only", "onto",
  "other", "our", "out", "over", "own", "per", "same", "shall", "should",
  "since", "some", "such", "than", "that", "the", "their", "them", "then",
  "there", "these", "they", "this", "those", "thus", "too", "under", "until",
  "upon", "use", "used", "using", "very", "was", "were", "what", "when",
  "where", "which", "while", "who", "whom", "whose", "why", "will", "with",
  "within", "without", "would", "you", "your",
  // Content-free code nouns.
  "bar", "baz", "callback", "foo", "impl", "lorem", "qux", "self", "temp",
  "tmp", "todo", "val", "value", "values",
]);

export interface SourceTokenSurface {
  /** Sorted, de-duplicated, lowercase tokens. */
  tokens: string[];
  declared_names: number;
  string_literals: number;
  comment_blocks: number;
}

export interface DocumentFrequencyIndex {
  documents: number;
  frequency: ReadonlyMap<string, number>;
}

export interface LexicalPlausibility {
  /** 0..1. Higher means more of the criterion's distinctive vocabulary appears in the file. */
  score: number;
  /** Distinctive terms present in both, strongest first. */
  shared_terms: string[];
  /** Distinctive criterion terms absent from the file, strongest first. */
  absent_terms: string[];
}

export type LinkPlausibilitySkipReason =
  | "help_target"
  | "other_repository"
  | "file_missing"
  | "not_a_file"
  | "unreadable"
  | "binary_content"
  | "file_too_large"
  | "no_extractable_text";

export interface LinkPlausibilitySkip {
  repository: string;
  story_stable_id: string;
  acceptance_criterion_stable_id: string;
  relation: string;
  path: string | null;
  reason: LinkPlausibilitySkipReason;
}

export interface LinkPlausibilityReviewCandidate {
  repository: string;
  story_stable_id: string;
  acceptance_criterion_stable_id: string;
  relation: string;
  path: string;
  score: number;
  /** 1 is the weakest link in the repository's own distribution. */
  rank: number;
  /** Fraction of scored links scoring at or below this one, 0..1. */
  percentile: number;
  shared_terms: string[];
  absent_terms: string[];
  /** Human-readable, names the terms behind the number. */
  rationale: string;
}

export interface LinkPlausibilityDistribution {
  sample_size: number;
  minimum: number;
  median: number;
  maximum: number;
  review_percentile: number;
  /** Highest score inside the bottom-percentile window, or null if the window is empty. */
  percentile_cut_score: number | null;
  absolute_score_floor: number;
}

export interface LinkPlausibilityReport {
  method: string;
  /** Structural reminder: this report is never a verdict. */
  advisory: true;
  disclaimer: string;
  status: "reviewed" | "insufficient_distribution";
  scored_links: number;
  distribution: LinkPlausibilityDistribution | null;
  /**
   * Links a human should re-read. Emptiness never means the remaining links are
   * correct — only that this heuristic is not asking for attention.
   */
  review_candidates: LinkPlausibilityReviewCandidate[];
  skipped: LinkPlausibilitySkip[];
  notes: string[];
}

export interface LinkPlausibilityOptions {
  repositoryRoot: string;
  manifest: ContractManifest;
  /** Bottom fraction of the distribution eligible for review. */
  reviewPercentile?: number;
  /** A link must score below this to be eligible, whatever its rank. */
  absoluteScoreFloor?: number;
  minimumSampleSize?: number;
  maxSourceBytes?: number;
}

/**
 * Shape accepted by `AttributionSuggestionStore.saveAttributionSuggestion`.
 * Declared structurally so this module stays free of any store or database
 * import; it performs no writes and never produces state "confirmed".
 */
export interface LinkReviewSuggestionInput {
  source_kind: "acceptance_criterion";
  source_id: string;
  target_kind: "acceptance_criterion";
  target_id: string;
  state: "suggested";
  method: string;
  score: number;
  rationale: Record<string, unknown>;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Splits an identifier on camelCase, PascalCase, snake_case, kebab-case and
 * punctuation boundaries into lowercase parts. Applied to prose too: prose is
 * just an identifier stream with spaces in it.
 */
export function splitIdentifier(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length > 0);
}

/** Splits, lowercases, drops short/numeric/stopword tokens, sorts, de-duplicates. */
export function meaningfulTokens(values: Iterable<string>): string[] {
  const tokens = new Set<string>();
  for (const value of values) {
    for (const token of splitIdentifier(value)) {
      if (token.length < MIN_TOKEN_LENGTH) continue;
      if (/^\d+$/.test(token)) continue;
      if (LINK_PLAUSIBILITY_STOPWORDS.has(token)) continue;
      tokens.add(token);
    }
  }
  return [...tokens].sort();
}

interface ScannedSource {
  /** Source with comments and string bodies removed, so name patterns cannot match inside them. */
  code: string;
  comments: string[];
  strings: string[];
}

function readLiteral(
  content: string,
  start: number,
  quote: string
): { literal: string; next: number } {
  let index = start + 1;
  let literal = "";
  while (index < content.length) {
    const char = content[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) return { literal, next: index + 1 };
    // An unterminated quote must not swallow the rest of the file. Template
    // literals legitimately span lines; the other two do not.
    if (char === "\n" && quote !== "`") return { literal, next: index };
    literal += char;
    index += 1;
  }
  return { literal, next: content.length };
}

/**
 * A single left-to-right character scan that separates comments, string
 * literals, and remaining code. Deliberately not a parser: template
 * interpolations are treated as opaque string bodies and regex literals are
 * left in the code stream. Both are acceptable for a lexical smell signal.
 */
function scanSource(content: string): ScannedSource {
  const comments: string[] = [];
  const strings: string[] = [];
  let code = "";
  let index = 0;
  while (index < content.length) {
    const char = content[index];
    const next = content[index + 1];
    if (char === "/" && next === "/") {
      const end = content.indexOf("\n", index);
      const stop = end === -1 ? content.length : end;
      comments.push(content.slice(index + 2, stop));
      index = stop;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = content.indexOf("*/", index + 2);
      const stop = end === -1 ? content.length : end;
      comments.push(content.slice(index + 2, stop));
      index = end === -1 ? stop : stop + 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const literal = readLiteral(content, index, char);
      strings.push(literal.literal);
      code += " ";
      index = literal.next;
      continue;
    }
    code += char;
    index += 1;
  }
  return { code, comments, strings };
}

const DECLARATION_PATTERNS: readonly RegExp[] = [
  // Declared names: function/class/interface/type/enum/namespace/const/let/var.
  /\b(?:function|class|interface|type|enum|namespace|const|let|var)\s+\*?\s*([A-Za-z_$][\w$]*)/g,
  // Class and interface members, and object literal keys.
  /^[ \t]*(?:readonly\s+|private\s+|public\s+|protected\s+|static\s+|async\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*[(:<?]/gm,
  // Arrow-function bindings.
  /\b([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
];

/**
 * Extracts the identifier-ish and prose-ish surface of a source file without
 * parsing it: declared and member names, string literals of reasonable length,
 * and comment text. Heuristic by design, and deterministic.
 */
export function extractSourceTokenSurface(content: string): SourceTokenSurface {
  const scanned = scanSource(content);
  const names: string[] = [];
  for (const pattern of DECLARATION_PATTERNS) {
    for (const match of scanned.code.matchAll(pattern)) {
      if (match[1]) names.push(match[1]);
    }
  }
  const literals = scanned.strings.filter((literal) => {
    const trimmed = literal.trim();
    return (
      trimmed.length >= MIN_STRING_LITERAL_LENGTH &&
      trimmed.length <= MAX_STRING_LITERAL_LENGTH
    );
  });
  return {
    tokens: meaningfulTokens([...names, ...literals, ...scanned.comments]),
    declared_names: names.length,
    string_literals: literals.length,
    comment_blocks: scanned.comments.length,
  };
}

/**
 * The comparable surface of an acceptance criterion: its own prose plus the
 * context a reader would use to judge it — rationale, aliases, scenario
 * Given/When/Then text, and the owning story's title, actor, goal and benefit.
 */
export function acceptanceCriterionTokenSurface(
  story: ManifestStory,
  criterion: ManifestAcceptanceCriterion
): string[] {
  return meaningfulTokens([
    criterion.criterion,
    criterion.rationale ?? "",
    ...criterion.aliases,
    ...criterion.scenarios.flatMap((scenario) => [
      scenario.name ?? "",
      scenario.given,
      scenario.when,
      scenario.then,
    ]),
    story.title,
    story.actor,
    story.goal,
    story.benefit,
    ...story.aliases,
  ]);
}

/**
 * Document frequency over the repository's own linked files, one document per
 * distinct path. Ubiquity is measured locally so a token that happens to be
 * everywhere in this codebase is damped here without being blacklisted globally.
 */
export function buildDocumentFrequencyIndex(
  surfaces: Iterable<readonly string[]>
): DocumentFrequencyIndex {
  const frequency = new Map<string, number>();
  let documents = 0;
  for (const tokens of surfaces) {
    documents += 1;
    for (const token of new Set(tokens)) {
      frequency.set(token, (frequency.get(token) ?? 0) + 1);
    }
  }
  return { documents, frequency };
}

/**
 * Smoothed inverse document frequency, ln((N + 1) / (df + 1)).
 *
 * A token present in every linked file scores exactly 0, so ubiquitous terms
 * cannot inflate any link's score. A token present in no linked file scores the
 * maximum, so a criterion's distinctive vocabulary dominates the denominator.
 */
export function inverseDocumentFrequency(
  index: DocumentFrequencyIndex,
  token: string
): number {
  const df = index.frequency.get(token) ?? 0;
  return Math.log((index.documents + 1) / (df + 1));
}

function strongestTerms(
  weighted: Array<{ token: string; weight: number }>
): string[] {
  return weighted
    .filter((entry) => entry.weight > 0)
    .sort(
      (left, right) =>
        right.weight - left.weight || left.token.localeCompare(right.token)
    )
    .slice(0, RATIONALE_TERM_LIMIT)
    .map((entry) => entry.token);
}

/**
 * IDF-weighted containment of the criterion's vocabulary in the file's surface:
 *
 *   score = sum(idf(t) for t in criterion ∩ file) / sum(idf(t) for t in criterion)
 *
 * Containment rather than Jaccard or Dice, on purpose. A source file's
 * vocabulary is an order of magnitude larger than a criterion's, so a symmetric
 * measure would push every score toward zero and would mostly rank file length.
 * Containment asks the question a reviewer actually asks — "does this file talk
 * about what the criterion talks about?" — and its known bias is that a large
 * grab-bag file scores generously. That bias produces false negatives rather
 * than false positives, which is the direction this module must err in.
 *
 * An embedding-based scorer would slot in behind this same signature, taking
 * the two surfaces and returning a 0..1 score plus explanatory terms; nothing
 * downstream of here depends on the score being lexical.
 */
export function scoreLexicalPlausibility(
  criterionTokens: readonly string[],
  fileTokens: readonly string[],
  index: DocumentFrequencyIndex
): LexicalPlausibility {
  const file = new Set(fileTokens);
  const shared: Array<{ token: string; weight: number }> = [];
  const absent: Array<{ token: string; weight: number }> = [];
  let sharedWeight = 0;
  let totalWeight = 0;
  for (const token of criterionTokens) {
    const weight = inverseDocumentFrequency(index, token);
    totalWeight += weight;
    if (file.has(token)) {
      sharedWeight += weight;
      shared.push({ token, weight });
    } else {
      absent.push({ token, weight });
    }
  }
  return {
    score: totalWeight > 0 ? round(sharedWeight / totalWeight) : 0,
    shared_terms: strongestTerms(shared),
    absent_terms: strongestTerms(absent),
  };
}

type SourceReadResult =
  | { status: "read"; surface: SourceTokenSurface }
  | { status: "skipped"; reason: LinkPlausibilitySkipReason };

function readSourceTokenSurface(
  repositoryRoot: string,
  path: string,
  maxSourceBytes: number
): SourceReadResult {
  const absolute = resolve(repositoryRoot, path);
  let stat;
  try {
    stat = statSync(absolute);
  } catch {
    // A link whose file is gone is a different mechanism's finding, not ours.
    return { status: "skipped", reason: "file_missing" };
  }
  if (!stat.isFile()) return { status: "skipped", reason: "not_a_file" };
  if (stat.size > maxSourceBytes) {
    return { status: "skipped", reason: "file_too_large" };
  }
  let content: Buffer;
  try {
    content = readFileSync(absolute);
  } catch {
    return { status: "skipped", reason: "unreadable" };
  }
  if (content.subarray(0, BINARY_SNIFF_BYTES).indexOf(0) !== -1) {
    return { status: "skipped", reason: "binary_content" };
  }
  const surface = extractSourceTokenSurface(content.toString("utf8"));
  if (surface.tokens.length === 0) {
    return { status: "skipped", reason: "no_extractable_text" };
  }
  return { status: "read", surface };
}

function skipReasonForTarget(
  link: ManifestLink,
  repositoryKey: string
): LinkPlausibilitySkipReason | null {
  if (link.target.kind === "help") return "help_target";
  if (link.target.repository !== repositoryKey) return "other_repository";
  return null;
}

interface ScoredLink {
  story_stable_id: string;
  acceptance_criterion_stable_id: string;
  relation: string;
  path: string;
  measurement: LexicalPlausibility;
}

function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : round((sorted[middle - 1] + sorted[middle]) / 2);
}

function reviewRationale(
  candidate: Omit<LinkPlausibilityReviewCandidate, "rationale">,
  sampleSize: number,
  reviewPercentile: number
): string {
  const shared =
    candidate.shared_terms.length > 0
      ? `Shares ${candidate.shared_terms.join(", ")}`
      : "Shares no distinctive term";
  const absent =
    candidate.absent_terms.length > 0
      ? `; the criterion's ${candidate.absent_terms.join(", ")} appear nowhere in the file`
      : "";
  return (
    `Lexical overlap ${candidate.score.toFixed(2)} places this link in the weakest ` +
    `${Math.round(reviewPercentile * 100)}% of ${sampleSize} scored links in this repository ` +
    `(rank ${candidate.rank}). ${shared}${absent}. ` +
    `Suggestion for human review only — it does not mean the link is wrong.`
  );
}

/**
 * Scores every criterion-level code and test link against its own acceptance
 * criterion and returns the weakest ones as candidates for human review.
 *
 * Story-level fallback links are intentionally out of scope: they are a claim
 * about the story as a whole, not about any single criterion, so scoring them
 * against one criterion would manufacture a finding the contract never asserted.
 */
export function analyzeLinkPlausibility(
  options: LinkPlausibilityOptions
): LinkPlausibilityReport {
  const repositoryKey = options.manifest.repository.key;
  const reviewPercentile = options.reviewPercentile ?? DEFAULT_REVIEW_PERCENTILE;
  const absoluteScoreFloor =
    options.absoluteScoreFloor ?? DEFAULT_ABSOLUTE_SCORE_FLOOR;
  const minimumSampleSize =
    options.minimumSampleSize ?? DEFAULT_MINIMUM_SAMPLE_SIZE;
  const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;

  const skipped: LinkPlausibilitySkip[] = [];
  const notes: string[] = [];
  const surfaces = new Map<string, SourceTokenSurface>();
  const readSkips = new Map<string, LinkPlausibilitySkipReason>();
  const pending: Array<{
    story: ManifestStory;
    criterion: ManifestAcceptanceCriterion;
    relation: string;
    path: string;
  }> = [];

  for (const capability of options.manifest.capabilities) {
    for (const story of capability.stories) {
      for (const criterion of story.acceptance_criteria) {
        for (const link of criterion.links) {
          const targetSkip = skipReasonForTarget(link, repositoryKey);
          if (targetSkip) {
            skipped.push({
              repository: repositoryKey,
              story_stable_id: story.stable_id,
              acceptance_criterion_stable_id: criterion.stable_id,
              relation: link.relation,
              path: link.target.kind === "help" ? null : link.target.path,
              reason: targetSkip,
            });
            continue;
          }
          if (link.target.kind === "help") continue;
          const path = link.target.path;
          if (!surfaces.has(path) && !readSkips.has(path)) {
            const read = readSourceTokenSurface(
              options.repositoryRoot,
              path,
              maxSourceBytes
            );
            if (read.status === "read") surfaces.set(path, read.surface);
            else readSkips.set(path, read.reason);
          }
          const readSkip = readSkips.get(path);
          if (readSkip) {
            skipped.push({
              repository: repositoryKey,
              story_stable_id: story.stable_id,
              acceptance_criterion_stable_id: criterion.stable_id,
              relation: link.relation,
              path,
              reason: readSkip,
            });
            continue;
          }
          pending.push({
            story,
            criterion,
            relation: link.relation,
            path,
          });
        }
      }
    }
  }

  const index = buildDocumentFrequencyIndex(
    [...surfaces.values()].map((surface) => surface.tokens)
  );
  const scored: ScoredLink[] = pending
    .map((entry) => ({
      story_stable_id: entry.story.stable_id,
      acceptance_criterion_stable_id: entry.criterion.stable_id,
      relation: entry.relation,
      path: entry.path,
      measurement: scoreLexicalPlausibility(
        acceptanceCriterionTokenSurface(entry.story, entry.criterion),
        surfaces.get(entry.path)?.tokens ?? [],
        index
      ),
    }))
    .sort(
      (left, right) =>
        left.measurement.score - right.measurement.score ||
        left.acceptance_criterion_stable_id.localeCompare(
          right.acceptance_criterion_stable_id
        ) ||
        left.path.localeCompare(right.path)
    );

  skipped.sort(
    (left, right) =>
      left.acceptance_criterion_stable_id.localeCompare(
        right.acceptance_criterion_stable_id
      ) || (left.path ?? "").localeCompare(right.path ?? "")
  );

  const base = {
    method: LINK_PLAUSIBILITY_METHOD,
    advisory: true as const,
    disclaimer: LINK_PLAUSIBILITY_DISCLAIMER,
    scored_links: scored.length,
    skipped,
  };

  if (scored.length < minimumSampleSize) {
    notes.push(
      `Scored ${scored.length} link(s); at least ${minimumSampleSize} are needed to place a link ` +
        `in this repository's own score distribution. No review candidates were emitted because ` +
        `the distribution was insufficient, not because the links looked plausible.`
    );
    return {
      ...base,
      status: "insufficient_distribution",
      distribution: null,
      review_candidates: [],
      notes,
    };
  }

  const ordered = scored.map((entry) => entry.measurement.score);
  const cutIndex = Math.floor(scored.length * reviewPercentile);
  const cutScore = cutIndex >= 1 ? ordered[cutIndex - 1] : null;
  if (cutScore === null) {
    notes.push(
      `A review percentile of ${reviewPercentile} over ${scored.length} scored link(s) selects ` +
        `no links at all, so nothing was flagged.`
    );
  }

  const atOrBelow = (score: number): number =>
    ordered.filter((entry) => entry <= score).length;

  const review_candidates = scored
    .map((entry, position) => ({ entry, rank: position + 1 }))
    .filter(
      ({ entry }) =>
        cutScore !== null &&
        entry.measurement.score <= cutScore &&
        entry.measurement.score < absoluteScoreFloor
    )
    .map(({ entry, rank }) => {
      const candidate = {
        repository: repositoryKey,
        story_stable_id: entry.story_stable_id,
        acceptance_criterion_stable_id: entry.acceptance_criterion_stable_id,
        relation: entry.relation,
        path: entry.path,
        score: entry.measurement.score,
        rank,
        percentile: round(atOrBelow(entry.measurement.score) / scored.length),
        shared_terms: entry.measurement.shared_terms,
        absent_terms: entry.measurement.absent_terms,
      };
      return {
        ...candidate,
        rationale: reviewRationale(candidate, scored.length, reviewPercentile),
      };
    });

  if (review_candidates.length === 0 && cutScore !== null) {
    notes.push(
      `No link scored below the absolute floor of ${absoluteScoreFloor}. That is the absence of a ` +
        `smell signal, not a statement that the links are correct.`
    );
  }

  return {
    ...base,
    status: "reviewed",
    distribution: {
      sample_size: scored.length,
      minimum: ordered[0],
      median: median(ordered),
      maximum: ordered[ordered.length - 1],
      review_percentile: reviewPercentile,
      percentile_cut_score: cutScore,
      absolute_score_floor: absoluteScoreFloor,
    },
    review_candidates,
    notes,
  };
}

/**
 * Reshapes a review candidate into the input accepted by
 * `AttributionSuggestionStore.saveAttributionSuggestion`. It always produces
 * state "suggested"; there is no path from this module to "confirmed".
 *
 * The store's entity kinds have no member for a source file, so both ends
 * address the acceptance criterion under review and the linked path travels in
 * the rationale. The suggestion therefore reads as "re-read this criterion's
 * link to this path", which is exactly what it is.
 */
export function toLinkReviewSuggestion(input: {
  candidate: LinkPlausibilityReviewCandidate;
  acceptanceCriterionId: string;
}): LinkReviewSuggestionInput {
  return {
    source_kind: "acceptance_criterion",
    source_id: input.acceptanceCriterionId,
    target_kind: "acceptance_criterion",
    target_id: input.acceptanceCriterionId,
    state: "suggested",
    method: LINK_PLAUSIBILITY_METHOD,
    score: input.candidate.score,
    rationale: {
      signal: "lexical_link_plausibility",
      advisory: true,
      disclaimer: LINK_PLAUSIBILITY_DISCLAIMER,
      repository: input.candidate.repository,
      story_stable_id: input.candidate.story_stable_id,
      acceptance_criterion_stable_id:
        input.candidate.acceptance_criterion_stable_id,
      relation: input.candidate.relation,
      path: input.candidate.path,
      rank: input.candidate.rank,
      percentile: input.candidate.percentile,
      shared_terms: input.candidate.shared_terms,
      absent_terms: input.candidate.absent_terms,
      explanation: input.candidate.rationale,
    },
  };
}
