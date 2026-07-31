import type { ContractAuthority, StoryLifecycle } from "../types.js";
import type {
  DerivedEmbeddingDocument,
  EmbeddingDocumentKind,
} from "../derived/embedding-documents.js";
import type { ContractTarget } from "../contract/schema.js";

export const RETRIEVAL_PROFILE_KEYS = [
  "support",
  "engineering",
  "discovery",
  "all",
] as const;
export type RetrievalProfileKey = (typeof RETRIEVAL_PROFILE_KEYS)[number];

export interface RetrievalProfileDefinition {
  authorities?: ContractAuthority[];
  lifecycles?: StoryLifecycle[];
  backlog_stages?: string[];
  include_inactive?: boolean;
  observation_attribution_states?: Array<
    "suggested" | "confirmed" | "dismissed"
  >;
  include?: EmbeddingDocumentKind[];
}

export interface ResolvedRetrievalProfile {
  key: string;
  version: number;
  definition: RetrievalProfileDefinition;
}

export interface SemanticSearchFilters {
  authorities?: ContractAuthority[];
  lifecycles?: StoryLifecycle[];
  backlog_stages?: string[];
  document_kinds?: EmbeddingDocumentKind[];
  repositories?: string[];
  applicability?: Record<string, string[]>;
  include_inactive?: boolean;
}

export type SemanticSearchAnchor =
  | { kind: "observation"; id: string }
  | { kind: "backlog_item"; stable_id: string }
  | {
      kind: "story" | "acceptance_criterion";
      repository: string;
      stable_id: string;
    };

export type SemanticSearchArtifact = ContractTarget;

export interface SemanticSearchContext {
  anchor?: SemanticSearchAnchor;
  artifacts?: SemanticSearchArtifact[];
}

export interface SemanticSearchCandidate {
  document_id: string;
  entity_kind: EmbeddingDocumentKind;
  entity_id: string;
  matched_level: EmbeddingDocumentKind;
  canonical_text: string;
  vector_score: number;
  lexical_score: number;
  alias_match: boolean;
  artifact_overlap: number;
  graph_proximity: number;
  applicable: boolean;
  story_id?: string;
  story_stable_id?: string;
  acceptance_criterion_id?: string;
  acceptance_criterion_stable_id?: string;
  metadata: Record<string, unknown>;
}

export interface AttributionSuggestionRecord {
  id: string;
  source_kind: EmbeddingDocumentKind;
  source_id: string;
  target_kind: EmbeddingDocumentKind;
  target_id: string;
  state: "suggested" | "confirmed" | "dismissed";
  method: string;
  score: number | null;
  rationale: Record<string, unknown>;
}

export interface SemanticSearchStore {
  resolveRetrievalProfile(
    profileKey: string,
    version?: number
  ): Promise<ResolvedRetrievalProfile>;
  searchSemantic(input: {
    query: string;
    embedding?: number[];
    profile: ResolvedRetrievalProfile;
    filters?: SemanticSearchFilters;
    context?: SemanticSearchContext;
    limit: number;
  }): Promise<SemanticSearchCandidate[]>;
}

export interface DerivedDocumentStore {
  upsertEmbeddingDocument(
    document: DerivedEmbeddingDocument
  ): Promise<{ embedded: boolean; document_id: string }>;
}

export interface AttributionSuggestionStore {
  saveAttributionSuggestion(input: {
    source_kind: EmbeddingDocumentKind;
    source_id: string;
    target_kind: EmbeddingDocumentKind;
    target_id: string;
    state: "suggested" | "confirmed";
    method: string;
    score?: number | null;
    rationale?: Record<string, unknown>;
  }): Promise<AttributionSuggestionRecord>;
  listAttributionSuggestions(input?: {
    source_kind?: EmbeddingDocumentKind;
    source_id?: string;
    state?: Array<"suggested" | "confirmed" | "dismissed">;
    limit?: number;
  }): Promise<AttributionSuggestionRecord[]>;
  decideAttributionSuggestion(input: {
    suggestion_id: string;
    decision: "confirmed" | "dismissed";
  }): Promise<AttributionSuggestionRecord | null>;
}
