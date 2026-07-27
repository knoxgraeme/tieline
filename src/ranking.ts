/**
 * Pure ranking + fusion logic. No DB, no network — everything here is a pure
 * function of its inputs so it can be unit-tested offline (see scripts/test-ranking.ts).
 *
 * Signals fused by find_related:
 *   vector  — cosine similarity from the pgvector KNN gate (0..1)
 *   lexical — tsvector + trigram relevance from the lexical source (0..1)
 *   entity  — weighted overlap between query entity slugs and a story's slugs
 *   path    — weighted overlap between query code paths and a story's code paths
 *
 * Weighting: shared slugs/paths are weighted by 1/df (rare slugs count more) so
 * hub tags like `settings` (df=35) don't drown out distinctive ones like
 * `tax-rate` (df=5). Overlap sums are saturated to 0..1.
 *
 * Ranking uses Reciprocal Rank Fusion (rrfScores) over the per-signal rankings,
 * so incomparable score scales fuse without normalization and a single-weighted
 * signal reduces to that signal's order. absBlend — the weighted sum of the RAW
 * signals — is the absolute relevance used to gate empty results against
 * min_score; score_breakdown reports the pool-normalized components.
 */

import type {
  Candidate,
  DocFrequencies,
  AreaHit,
  StoryHit,
  Why,
  ScoreBreakdown,
} from "./types.js";
import type { FusionWeights } from "./config.js";

// --- small numeric helpers --------------------------------------------------

export function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** Diminishing-returns squash of an unbounded overlap sum into 0..1. */
export function saturate(x: number): number {
  return x <= 0 ? 0 : x / (x + 1);
}

/**
 * Min-max normalize across the pool. When every value is equal (range 0), fall
 * back to the clamped raw value so a lone candidate keeps its absolute strength
 * instead of being forced to 1.0.
 */
export function minMax(values: number[]): number[] {
  if (values.length === 0) return [];
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const range = hi - lo;
  if (range <= 1e-12) return values.map((v) => clamp01(v));
  return values.map((v) => (v - lo) / range);
}

export function normalizeWeights(w: FusionWeights): Required<FusionWeights> {
  const lexical = w.lexical ?? 0;
  const sum = w.vector + w.entity + w.path + lexical || 1;
  return {
    vector: w.vector / sum,
    entity: w.entity / sum,
    path: w.path / sum,
    lexical: lexical / sum,
  };
}

/**
 * Reciprocal Rank Fusion. Combines heterogeneous per-signal rankings by rank
 * position (1-based) rather than by raw score, so incomparable scales (cosine,
 * saturated ts_rank, 1/df overlap) fuse without normalization. A signal with
 * zero weight does not contribute, so a single-signal weight set reduces to
 * that signal's ordering. Returns one RRF score per input row, index-aligned.
 */
export function rrfScores(
  raws: { vector: number; lexical: number; entity: number; path: number }[],
  w: Required<FusionWeights>,
  k: number
): number[] {
  const rrf = new Array<number>(raws.length).fill(0);
  const signals: [keyof (typeof raws)[number], number][] = [
    ["vector", w.vector],
    ["lexical", w.lexical],
    ["entity", w.entity],
    ["path", w.path],
  ];
  for (const [signal, weight] of signals) {
    if (weight <= 0) continue;
    const order = raws.map((_, i) => i).sort((a, b) => raws[b][signal] - raws[a][signal]);
    order.forEach((idx, pos) => {
      // Standard RRF credits only candidates a ranker actually retrieved. A zero
      // raw signal means "not retrieved here" — crediting it would let array/union
      // order leak into the fused rank. (Zeros sort last, so non-zero ranks are
      // unaffected.)
      if (raws[idx][signal] <= 0) return;
      rrf[idx] += weight * (1 / (k + pos + 1));
    });
  }
  return rrf;
}

// --- overlap ----------------------------------------------------------------

export interface WeightedOverlap {
  shared: string[];
  /** sum of 1/df over shared items (rare items weigh more) */
  score: number;
  /** per-item weights, for the "why" payload */
  weights: { key: string; weight: number }[];
}

export function weightedOverlap(
  target: Set<string>,
  candidate: string[],
  df: Map<string, number>
): WeightedOverlap {
  const shared: string[] = [];
  const weights: { key: string; weight: number }[] = [];
  let score = 0;
  for (const item of candidate) {
    if (target.has(item)) {
      const d = Math.max(df.get(item) ?? 1, 1);
      const w = 1 / d;
      shared.push(item);
      weights.push({ key: item, weight: w });
      score += w;
    }
  }
  weights.sort((a, b) => b.weight - a.weight);
  return { shared, score, weights };
}

// --- query footprint extraction --------------------------------------------

/** Heuristic: does the context look like source code rather than prose? */
export function detectCode(context: string): boolean {
  const signals = [
    /\bimport\s+.+from\s+['"]/, // JS/TS imports
    /\bexport\s+(default|const|function|class)\b/,
    /\bfunction\b\s*\w*\s*\(/,
    /=>\s*[{(]/, // arrow functions
    /\bconst\b\s+\w+\s*=/,
    /<\/?[a-zA-Z][\w-]*[^>]*>/, // tags (Vue/HTML/JSX)
    /[\w./-]+\.(ts|tsx|js|jsx|vue|py|go|rb|java|css|scss)\b/, // file paths/refs
    /[{};]\s*$/m, // braces/semicolons at line ends
  ];
  const hits = signals.reduce((n, re) => n + (re.test(context) ? 1 : 0), 0);
  return hits >= 2;
}

/** Pull file-path-like tokens out of free text or a code/diff blob. */
export function extractQueryPaths(context: string): string[] {
  const re = /(?:[\w@.-]+\/)+[\w@.-]+\.(?:ts|tsx|js|jsx|vue|py|go|rb|java|css|scss)/g;
  const found = context.match(re) || [];
  // also strip a leading diff marker like "a/" or "b/"
  const cleaned = found.map((p) => p.replace(/^[ab]\//, ""));
  return Array.from(new Set(cleaned));
}

/**
 * Lexically detect which known entity slugs appear in the context. A slug's
 * hyphenated form is matched as a word-bounded phrase (so `access-control`
 * matches "access control"). Cheap and good enough; the vector signal carries
 * the rest.
 */
export function extractQueryEntities(context: string, vocab: Iterable<string>): string[] {
  const norm = ` ${context.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  const out: string[] = [];
  for (const slug of vocab) {
    const phrase = ` ${slug.replace(/-/g, " ")} `;
    if (norm.includes(phrase)) out.push(slug);
  }
  return out;
}

// --- core scoring -----------------------------------------------------------

export interface ScoredStory {
  candidate: Candidate;
  absBlend: number; // absolute relevance (for min_score gate + reporting)
  rrf: number; // reciprocal-rank-fusion score — the ranking key
  breakdown: ScoreBreakdown; // normalized components
  why: Why;
  raw: { vector: number; entity: number; path: number; lexical: number };
}

export interface QualificationGate {
  minVector: number;
  minStructural: number;
  // Lexical floor. Optional so legacy callers keep their exact behavior: when
  // absent it defaults to Infinity, so a candidate never qualifies on lexical
  // alone unless a caller opts in with a real floor.
  minLexical?: number;
  allowStructural: boolean;
}

export function qualifiesCandidate(story: ScoredStory, gate: QualificationGate): boolean {
  const minLexical = gate.minLexical ?? Infinity;
  return (
    story.raw.vector >= gate.minVector ||
    story.raw.lexical >= minLexical ||
    (gate.allowStructural &&
      (story.raw.entity >= gate.minStructural || story.raw.path >= gate.minStructural))
  );
}

export interface ScoreInput {
  candidates: Candidate[];
  queryEntities: Set<string>;
  queryPaths: Set<string>;
  df: DocFrequencies;
  weights: FusionWeights; // raw (will be normalized)
  rrfK?: number; // RRF constant; defaults to 60
}

export function scoreCandidates(input: ScoreInput): ScoredStory[] {
  const w = normalizeWeights(input.weights);
  const k = input.rrfK ?? 60;

  // Raw per-signal absolute values.
  const raw = input.candidates.map((c) => {
    const vCos = clamp01(c.similarity);
    const lex = clamp01(c.lexical ?? 0);
    const ent = weightedOverlap(input.queryEntities, c.entity_slugs, input.df.entity);
    const pat = weightedOverlap(input.queryPaths, c.code_paths, input.df.path);
    return { c, vCos, lex, eOv: saturate(ent.score), pOv: saturate(pat.score), ent, pat };
  });

  // Pool-normalized signals (min-max each) for the interpretable blend/display.
  const vN = minMax(raw.map((r) => r.vCos));
  const lN = minMax(raw.map((r) => r.lex));
  const eN = minMax(raw.map((r) => r.eOv));
  const pN = minMax(raw.map((r) => r.pOv));

  // RRF over the RAW per-signal rankings — the ranking key. Computed over the
  // full pool; filtering later (the gate) preserves survivors' relative order.
  const rrf = rrfScores(
    raw.map((r) => ({ vector: r.vCos, lexical: r.lex, entity: r.eOv, path: r.pOv })),
    w,
    k
  );

  return raw.map((r, i) => {
    const breakdown: ScoreBreakdown = { vector: vN[i], entity: eN[i], path: pN[i], lexical: lN[i] };
    const absBlend = w.vector * r.vCos + w.entity * r.eOv + w.path * r.pOv + w.lexical * r.lex;
    return {
      candidate: r.c,
      absBlend,
      rrf: rrf[i],
      breakdown,
      why: { shared_entities: r.ent.shared, shared_code_paths: r.pat.shared },
      raw: { vector: r.vCos, entity: r.eOv, path: r.pOv, lexical: r.lex },
    };
  });
}

// --- shaping into tool results ---------------------------------------------

function dedupeCap<T>(items: T[], cap: number): T[] {
  return Array.from(new Set(items)).slice(0, cap);
}

/** Rank scored stories, gate on min_score (absolute), return as story hits. */
export function toStoryHits(
  scored: ScoredStory[],
  gate: QualificationGate,
  limit: number
): StoryHit[] {
  return scored
    .filter((s) => qualifiesCandidate(s, gate))
    .sort((a, b) => b.rrf - a.rrf || b.absBlend - a.absBlend)
    .slice(0, limit)
    .map((s) => ({
      story_key: s.candidate.story_key,
      title: s.candidate.title,
      story_text: s.candidate.story_text,
      actor: s.candidate.actor,
      status: s.candidate.status,
      section_key: s.candidate.section_key,
      section_name: s.candidate.section_name,
      score: round(s.absBlend),
      score_breakdown: roundBreakdown(s.breakdown),
      code_paths: s.candidate.code_paths,
      help_articles: s.candidate.help_articles,
      help_article_count: s.candidate.help_article_count,
      why: s.why,
    }));
}

/** Group scored stories by section into ranked area hits. */
export function toAreaHits(
  scored: ScoredStory[],
  gate: QualificationGate,
  limit: number,
  storiesPerArea = 3
): AreaHit[] {
  const qualifying = scored.filter((s) => qualifiesCandidate(s, gate));

  const bySection = new Map<string, ScoredStory[]>();
  for (const s of qualifying) {
    const arr = bySection.get(s.candidate.section_key) ?? [];
    arr.push(s);
    bySection.set(s.candidate.section_key, arr);
  }

  // Carry the top member's RRF alongside each area so sections are ORDERED by
  // RRF (consistent with toStoryHits), while the reported `score` stays the
  // interpretable absolute blend.
  const areas: { rrf: number; area: AreaHit }[] = [];
  for (const [, members] of bySection) {
    members.sort((a, b) => b.rrf - a.rrf || b.absBlend - a.absBlend);
    const top = members[0];
    // Area score = best member's absolute score (interpretable + thresholdable).
    const sharedEntities = dedupeCap(members.flatMap((m) => m.why.shared_entities), 12);
    const sharedPaths = dedupeCap(members.flatMap((m) => m.why.shared_code_paths), 12);
    const codePaths = dedupeCap(members.flatMap((m) => m.candidate.code_paths), 20);

    areas.push({
      rrf: top.rrf,
      area: {
        section_key: top.candidate.section_key,
        section_name: top.candidate.section_name,
        score: round(top.absBlend),
        score_breakdown: roundBreakdown(top.breakdown),
        matched_stories: members.slice(0, storiesPerArea).map((m) => ({
          story_key: m.candidate.story_key,
          title: m.candidate.title,
          story_text: m.candidate.story_text,
          actor: m.candidate.actor,
          status: m.candidate.status,
          score: round(m.absBlend),
          help_articles: m.candidate.help_articles,
          help_article_count: m.candidate.help_article_count,
        })),
        code_paths: codePaths,
        why: { shared_entities: sharedEntities, shared_code_paths: sharedPaths },
      },
    });
  }

  return areas
    .sort((a, b) => b.rrf - a.rrf || b.area.score - a.area.score)
    .slice(0, limit)
    .map((a) => a.area);
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function roundBreakdown(b: ScoreBreakdown): ScoreBreakdown {
  return {
    vector: round(b.vector),
    entity: round(b.entity),
    path: round(b.path),
    lexical: round(b.lexical),
  };
}
