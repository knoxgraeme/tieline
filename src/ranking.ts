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

export interface RankedSemanticDocument extends SemanticDocumentCandidate {
  score: number;
  features: {
    vector: number;
    lexical: number;
    alias: number;
    artifact: number;
    graph: number;
    applicability: number;
  };
}

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function rankSemanticDocuments(
  candidates: SemanticDocumentCandidate[]
): RankedSemanticDocument[] {
  return candidates
    .map((candidate) => {
      const features = {
        vector: clamp01(candidate.vector_score),
        lexical: clamp01(candidate.lexical_score),
        alias: candidate.alias_match ? 1 : 0,
        artifact: clamp01(candidate.artifact_overlap ?? 0),
        graph: clamp01(candidate.graph_proximity ?? 0),
        applicability: candidate.applicable === false ? 0 : 1,
      };
      const relevance =
        features.vector * 0.58 +
        features.lexical * 0.2 +
        features.alias * 0.08 +
        features.artifact * 0.07 +
        features.graph * 0.07;
      return {
        ...candidate,
        score: clamp01(
          relevance * (candidate.applicable === false ? 0.85 : 1)
        ),
        features,
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
