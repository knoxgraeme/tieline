export interface SemanticDocumentCandidate {
  document_id: string;
  entity_kind:
    | "story"
    | "acceptance_criterion"
    | "scenario"
    | "backlog_item"
    | "observation";
  entity_id: string;
  canonical_text: string;
  matched_level: SemanticDocumentCandidate["entity_kind"];
  story_id?: string;
  story_stable_id?: string;
  acceptance_criterion_id?: string;
  acceptance_criterion_stable_id?: string;
  vector_score: number;
  lexical_score: number;
  alias_match?: boolean;
  artifact_overlap?: number;
  graph_proximity?: number;
  applicable?: boolean;
  metadata: Record<string, unknown>;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

type RankingSignal =
  | "vector"
  | "lexical"
  | "alias"
  | "artifact"
  | "graph";

const SIGNAL_WEIGHTS: Record<RankingSignal, number> = {
  vector: 0.58,
  lexical: 0.2,
  alias: 0.08,
  artifact: 0.07,
  graph: 0.07,
};

export interface SemanticRankingFeatures
  extends Record<RankingSignal, number> {
  applicability: number;
  rrf: number;
}

export interface RankedSemanticDocument extends SemanticDocumentCandidate {
  score: number;
  features: SemanticRankingFeatures;
  why: string[];
}

function reciprocalRankFusion(
  rows: Array<Record<RankingSignal, number>>,
  k = 60
): number[] {
  const scores = rows.map(() => 0);
  for (const signal of Object.keys(SIGNAL_WEIGHTS) as RankingSignal[]) {
    const ordered = rows
      .map((row, index) => ({ index, value: row[signal] }))
      .filter((entry) => entry.value > 0)
      .sort(
        (left, right) =>
          right.value - left.value || left.index - right.index
      );
    ordered.forEach((entry, rank) => {
      scores[entry.index] +=
        SIGNAL_WEIGHTS[signal] / (k + rank + 1);
    });
  }
  const maximum = 1 / (k + 1);
  return scores.map((score) => clamp01(score / maximum));
}

function rankingWhy(
  features: Omit<SemanticRankingFeatures, "rrf">
): string[] {
  const why: string[] = [];
  if (features.vector > 0) why.push("vector similarity");
  if (features.lexical > 0) why.push("lexical or identifier match");
  if (features.alias > 0) why.push("exact alias match");
  if (features.artifact > 0) why.push("shared artifact context");
  if (features.graph > 0) why.push("confirmed graph proximity");
  if (features.applicability === 0) why.push("applicability mismatch penalty");
  return why;
}

export function rankSemanticDocuments(
  candidates: SemanticDocumentCandidate[]
): RankedSemanticDocument[] {
  const raw = candidates.map((candidate) => {
    const features = {
      vector: clamp01(candidate.vector_score),
      lexical: clamp01(candidate.lexical_score),
      alias: candidate.alias_match ? 1 : 0,
      artifact: clamp01(candidate.artifact_overlap ?? 0),
      graph: clamp01(candidate.graph_proximity ?? 0),
      applicability: candidate.applicable === false ? 0 : 1,
    };
    return { candidate, features };
  });
  const rrf = reciprocalRankFusion(
    raw.map(({ features }) => ({
      vector: features.vector,
      lexical: features.lexical,
      alias: features.alias,
      artifact: features.artifact,
      graph: features.graph,
    }))
  );
  return raw
    .map(({ candidate, features }, index) => {
      const absolute =
        features.vector * SIGNAL_WEIGHTS.vector +
        features.lexical * SIGNAL_WEIGHTS.lexical +
        features.alias * SIGNAL_WEIGHTS.alias +
        features.artifact * SIGNAL_WEIGHTS.artifact +
        features.graph * SIGNAL_WEIGHTS.graph;
      const applicabilityPenalty =
        candidate.applicable === false ? 0.85 : 1;
      return {
        ...candidate,
        score: clamp01(
          (rrf[index] * 0.65 + absolute * 0.35) *
            applicabilityPenalty
        ),
        features: {
          ...features,
          rrf: rrf[index],
        },
        why: rankingWhy(features),
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        Number(right.applicable !== false) -
          Number(left.applicable !== false) ||
        left.document_id.localeCompare(right.document_id)
    );
}

/**
 * Minimum RAW signal strength a candidate must reach before it can be presented
 * as a match.
 *
 * `rankSemanticDocuments` blends reciprocal rank fusion (0.65) with the weighted
 * absolute signals (0.35). RRF is the right tool for FUSING signals whose scales
 * are not comparable, and the blended score is correct for ORDERING. It is not a
 * quality measure: RRF awards `weight / (k + rank + 1)`, so it reports where a
 * candidate sits inside the returned set, not how well it actually matches. The
 * top of a uniformly terrible set scores nearly what the top of an excellent set
 * scores, and the gap between rank 1 and rank 4 is a rounding error.
 *
 * Measured against this implementation, a candidate with 0.30 vector and 0.20
 * lexical similarity blends to 0.582 alone and 0.558 when it is plainly the
 * fourth-best option — 0.024 apart, both comfortably above any cutoff tuned to
 * admit real matches. So no threshold on the blended score can distinguish "this
 * is good" from "this was the least wrong thing available".
 *
 * These features are absolute similarities on a fixed 0..1 scale, so unlike the
 * blended score they mean the same thing in every result set. Gating on them is
 * what keeps a weak candidate from reaching a caller as a suggestion.
 */
export const SEMANTIC_MAGNITUDE_FLOOR = {
  /** Embedding similarity that reads as "the same behavior", not "same topic". */
  vector: 0.5,
  /** ts_rank_cd or identifier word-similarity strong enough to stand alone. */
  lexical: 0.5,
} as const;

export type SemanticAdmissionSignal =
  | "exact_alias"
  | "vector"
  | "lexical";

export function semanticAdmissionSignals(
  features: Pick<SemanticRankingFeatures, "vector" | "lexical" | "alias">
): SemanticAdmissionSignal[] {
  const signals: SemanticAdmissionSignal[] = [];
  if (features.alias === 1) signals.push("exact_alias");
  if (features.vector >= SEMANTIC_MAGNITUDE_FLOOR.vector) {
    signals.push("vector");
  }
  if (features.lexical >= SEMANTIC_MAGNITUDE_FLOOR.lexical) {
    signals.push("lexical");
  }
  return signals;
}

/**
 * True when a ranked candidate is strong enough on its own terms, independent of
 * how the rest of the result set happened to score.
 *
 * Deliberately conservative: today this filter is the only thing between a weak
 * match and an agent acting on it, and one strong signal is required rather than
 * an average, because averaging lets two mediocre signals impersonate one good
 * one.
 */
export function clearsSemanticMagnitudeFloor(
  features: Pick<SemanticRankingFeatures, "vector" | "lexical" | "alias">
): boolean {
  return semanticAdmissionSignals(features).length > 0;
}

export function groupSemanticHitsAroundAcceptanceCriteria(
  ranked: RankedSemanticDocument[]
): RankedSemanticDocument[] {
  const grouped = new Map<string, RankedSemanticDocument>();
  const ungrouped: RankedSemanticDocument[] = [];
  for (const hit of ranked) {
    const anchor =
      hit.acceptance_criterion_id ??
      (hit.entity_kind === "acceptance_criterion"
        ? hit.entity_id
        : undefined);
    if (!anchor) {
      ungrouped.push(hit);
      continue;
    }
    const current = grouped.get(anchor);
    if (!current || hit.score > current.score) grouped.set(anchor, hit);
  }
  return [...ungrouped, ...grouped.values()].sort(
    (left, right) =>
      right.score - left.score ||
      left.document_id.localeCompare(right.document_id)
  );
}
