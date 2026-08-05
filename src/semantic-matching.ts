import { PostgresSemanticRepository } from "./adapters/postgres/semantic-repository.js";
import { getWriteSql } from "./adapters/postgres/connections.js";
import { setBacklogCreateAdvisor } from "./backlog-advisor.js";
import {
  backlogEmbeddingDocument,
  contractEmbeddingDocuments,
  observationEmbeddingDocument,
  type EmbeddingDocumentKind,
} from "./derived/embedding-documents.js";
import type {
  BacklogItemRecord,
  ObservationRecord,
} from "./domain/evidence-write-store.js";
import type { ContractStoryRecord } from "./domain/contract-read-store.js";
import type {
  AttributionSuggestionRecord,
  AttributionSuggestionStore,
  DerivedDocumentStore,
  SemanticSearchStore,
  SemanticSearchFilters,
} from "./domain/semantic-search-store.js";
import {
  getEmbedder,
  optionalQueryEmbedding,
} from "./embeddings.js";
import {
  clearsSemanticMagnitudeFloor,
  groupSemanticHitsAroundAcceptanceCriteria,
  rankSemanticDocuments,
  semanticAdmissionSignals,
  type RankedSemanticDocument,
  type SemanticAdmissionSignal,
  type SemanticRankingFeatures,
} from "./ranking.js";

export interface MatchCandidate {
  suggestion_id: string;
  target_kind: EmbeddingDocumentKind;
  target_id: string;
  target_stable_id?: string;
  repository?: string;
  matched_level: EmbeddingDocumentKind;
  story_stable_id?: string;
  acceptance_criterion_stable_id?: string;
  score: number;
  method: string;
  features: SemanticRankingFeatures;
  admitted_by: SemanticAdmissionSignal[];
}

export interface SemanticMatcher {
  matchObservation(
    observation: ObservationRecord
  ): Promise<MatchCandidate[]>;
  advisePlanningCreate(input: {
    title: string;
    summary: string;
  }): Promise<MatchCandidate[]>;
  indexBacklogItem(item: BacklogItemRecord): Promise<void>;
  indexPlanningStory(story: ContractStoryRecord): Promise<void>;
}

export interface SemanticMatcherRepository
  extends SemanticSearchStore,
    DerivedDocumentStore {
  saveAttributionSuggestion: AttributionSuggestionStore["saveAttributionSuggestion"];
}

function candidateStableId(
  metadata: Record<string, unknown>,
  kind: EmbeddingDocumentKind
): string | undefined {
  const key =
    kind === "story"
      ? "story_stable_id"
      : kind === "acceptance_criterion" || kind === "scenario"
        ? "acceptance_criterion_stable_id"
        : kind === "backlog_item"
          ? "backlog_stable_id"
          : undefined;
  return key && typeof metadata[key] === "string"
    ? (metadata[key] as string)
    : undefined;
}

/**
 * Admission is based only on absolute signal magnitude. The blended score is a
 * reciprocal-rank-fusion ordering signal, so applying a fixed cutoff to it would
 * suppress strong lexical-only candidates while still admitting the top member
 * of some weak result sets.
 */
export function isPresentableSemanticMatch(
  hit: RankedSemanticDocument
): boolean {
  return clearsSemanticMagnitudeFloor(hit.features);
}

export class DefaultSemanticMatcher implements SemanticMatcher {
  constructor(
    private readonly repository: SemanticMatcherRepository = new PostgresSemanticRepository(
      getWriteSql,
      getEmbedder
    )
  ) {}

  private async candidates(
    query: string,
    filters?: SemanticSearchFilters
  ): Promise<ReturnType<typeof rankSemanticDocuments>> {
    const profile =
      await this.repository.resolveRetrievalProfile("discovery");
    const embedding = await optionalQueryEmbedding(query);
    const rows = await this.repository.searchSemantic({
      query,
      embedding,
      profile,
      filters,
      limit: 10,
    });
    // Shared by matchObservation and advisePlanningCreate so both paths apply the
    // same admission rule.
    return groupSemanticHitsAroundAcceptanceCriteria(
      rankSemanticDocuments(rows).filter(isPresentableSemanticMatch)
    );
  }

  async matchObservation(
    observation: ObservationRecord
  ): Promise<MatchCandidate[]> {
    await this.repository.upsertEmbeddingDocument(
      observationEmbeddingDocument(observation)
    );
    const ranked = await this.candidates(observation.search_text);
    const matches = ranked.filter(
      (hit) =>
        !(
          hit.entity_kind === "observation" &&
          hit.entity_id === observation.id
        )
    );
    const suggestions: AttributionSuggestionRecord[] = [];
    for (const hit of matches.slice(0, 10)) {
      // A semantic score is never authority to confirm a relationship.
      suggestions.push(
        await this.repository.saveAttributionSuggestion({
          source_kind: "observation",
          source_id: observation.id,
          target_kind: hit.entity_kind,
          target_id: hit.entity_id,
          state: "suggested",
          method: "semantic_similarity",
          score: hit.score,
          rationale: {
            matched_level: hit.matched_level,
            story_stable_id: hit.story_stable_id,
            acceptance_criterion_stable_id:
              hit.acceptance_criterion_stable_id,
            features: hit.features,
          },
        })
      );
    }
    return matches.slice(0, 10).map((hit, index) => ({
      suggestion_id: suggestions[index].id,
      target_kind: hit.entity_kind,
      target_id: hit.entity_id,
      target_stable_id: candidateStableId(hit.metadata, hit.entity_kind),
      repository:
        typeof hit.metadata.repository === "string"
          ? hit.metadata.repository
          : undefined,
      matched_level: hit.matched_level,
      story_stable_id: hit.story_stable_id,
      acceptance_criterion_stable_id:
        hit.acceptance_criterion_stable_id,
      score: hit.score,
      method: "semantic_similarity",
      features: hit.features,
      admitted_by: semanticAdmissionSignals(hit.features),
    }));
  }

  async advisePlanningCreate(input: {
    title: string;
    summary: string;
  }): Promise<MatchCandidate[]> {
    const ranked = await this.candidates(`${input.title}\n${input.summary}`, {
      document_kinds: [
        "story",
        "acceptance_criterion",
        "backlog_item",
        "observation",
      ],
    });
    return ranked.slice(0, 10).map((hit) => ({
      // No source record exists yet, so this is a stable selection token rather
      // than a persisted attribution suggestion ID.
      suggestion_id: `candidate:${hit.document_id}`,
      target_kind: hit.entity_kind,
      target_id: hit.entity_id,
      target_stable_id: candidateStableId(hit.metadata, hit.entity_kind),
      repository:
        typeof hit.metadata.repository === "string"
          ? hit.metadata.repository
          : undefined,
      matched_level: hit.matched_level,
      story_stable_id: hit.story_stable_id,
      acceptance_criterion_stable_id:
        hit.acceptance_criterion_stable_id,
      score: hit.score,
      method: "semantic_similarity",
      features: hit.features,
      admitted_by: semanticAdmissionSignals(hit.features),
    }));
  }

  async indexBacklogItem(item: BacklogItemRecord): Promise<void> {
    await this.repository.upsertEmbeddingDocument(
      backlogEmbeddingDocument(item)
    );
  }

  async indexPlanningStory(story: ContractStoryRecord): Promise<void> {
    for (const document of contractEmbeddingDocuments([story])) {
      await this.repository.upsertEmbeddingDocument(document);
    }
  }
}

let matcher: SemanticMatcher | null = null;

export function getSemanticMatcher(): SemanticMatcher {
  matcher ??= new DefaultSemanticMatcher();
  return matcher;
}

export function setSemanticMatcher(next: SemanticMatcher | null): void {
  matcher = next;
}

export function installSemanticAdvisors(): void {
  setBacklogCreateAdvisor({
    async beforeCreate(input) {
      const candidates =
        await getSemanticMatcher().advisePlanningCreate(input);
      return {
        candidates: candidates.map((candidate) => ({
          suggestion_id: candidate.suggestion_id,
          target_kind:
            candidate.target_kind === "scenario"
              ? "acceptance_criterion"
              : candidate.target_kind,
          target_stable_id:
            candidate.target_stable_id ??
            candidate.acceptance_criterion_stable_id ??
            candidate.story_stable_id ??
            candidate.target_id,
          repository: candidate.repository,
          score: candidate.score,
          features: candidate.features,
          admitted_by: candidate.admitted_by,
          reason:
            `${candidate.matched_level} match admitted by ` +
            `${candidate.admitted_by.join(" + ")}; blended score orders admitted matches`,
        })),
        require_explicit_continue: true,
      };
    },
  });
}
