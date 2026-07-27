/**
 * Domain-owned persistence contract.
 *
 * Nothing in this file knows which database, vector index, or transaction
 * library implements the operations. Adapters implement these capabilities and
 * are free to use PostgreSQL, another database, or an in-memory test store.
 */

import type { ImportPayload } from "../authoring/schema.js";
import type {
  Candidate,
  CrossoverHit,
  DocFrequencies,
  FeatureRequestRecord,
  HelpArticle,
  HelpHit,
  StoryRecord,
  WrittenStory,
} from "../types.js";

export interface StoryFilters {
  status?: string[];
  section_key?: string[];
  story_key?: string[];
  actor?: string[];
  entity_slug?: string;
  code_path?: string;
  product_area?: string[];
  audience?: string[];
  help_relationship?: string[];
  help_article_slug?: string;
  has_help?: boolean;
  keyword?: string;
}

export type StoryGroupBy = "section" | "status" | "actor" | "product_area";

export type QueryStoriesResult =
  | { mode: "records"; total: number; records: StoryRecord[] }
  | { mode: "grouped"; groups: { group: string; count: number }[] };

export interface TargetFootprint {
  sectionKey: string | null;
  entitySlugs: string[];
  codePaths: string[];
}

export interface GraphNode {
  id: string;
  label: string;
  status: string;
  story_count: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  weight: number;
  shared_entities: string[];
  shared_code_paths: string[];
  shared_count: number;
}

export interface CrossoverGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface Taxonomy {
  section_keys: { section_key: string; section_name: string; status: string; story_count: number }[];
  actors: string[];
  statuses: string[];
  entity_vocabulary: { entity_slug: string; doc_frequency: number }[];
  help_product_areas: { product_area: string; article_count: number }[];
  help_audiences: string[];
  help_relationship_types: string[];
  modes: string[];
  totals: {
    stories: number;
    sections: number;
    entities: number;
    code_paths: number;
    help_articles: number;
    stories_with_help: number;
  };
}

export interface NewFeatureRequest {
  source?: string | null;
  source_thread_id?: string | null;
  source_thread_url?: string | null;
  raw_thread_jsonb?: unknown;
  title: string;
  summary?: string | null;
  requested_change?: string | null;
  context?: string | null;
  priority_signal?: string | null;
  confidence?: number | null;
  product_area?: string | null;
  status?: string | null;
  notion_page_id?: string | null;
}

export interface StoryImportResult {
  sections: number;
  stories: number;
  entities: number;
  code_paths: number;
  batches?: Array<{
    batch: number;
    stories: number;
    applied: number;
    skipped: number;
    status: "committed";
  }>;
}

export interface StoryChangeProposalSummary {
  id: number;
  operation: "create" | "update" | "relationships";
  status: "pending" | "approved" | "rejected" | "stale";
  story_key: string | null;
  base_revision_number: number | null;
  reason: string | null;
  source: string;
  created_at: string;
}

export interface StoryChangeProposal extends StoryChangeProposalSummary {
  story_id: number | null;
  patch_version: number;
  patch: Record<string, unknown>;
  proposed_by: string | null;
  decided_by: string | null;
  decision_note: string | null;
  decided_at: string | null;
}

export interface StoryRevision {
  revision_number: number;
  section_key: string;
  title: string;
  actor: string | null;
  story_text: string;
  status: string;
  change_reason: string | null;
  actor_label: string | null;
  source: string;
  created_at: string;
}

export interface StoryEvent {
  id: number;
  revision_number: number | null;
  proposal_id: number | null;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  details: Record<string, unknown>;
  actor_label: string | null;
  source: string;
  created_at: string;
}

export interface StoryHistory {
  current: WrittenStory & { revision_number: number };
  revisions: StoryRevision[];
  events: StoryEvent[];
}

export type StoryMutationResult =
  | { outcome: "applied"; story: WrittenStory; revision_number: number }
  | { outcome: "proposed"; proposal: StoryChangeProposalSummary }
  | { outcome: "stale"; current_revision_number: number }
  | { outcome: "not_found" | "no_fields" };

export interface EntityRelationshipInput {
  entity_slug: string;
  entity_name?: string | null;
  relationship_type?: string;
}

export interface CodeRelationshipInput {
  repo?: string;
  path: string;
  asset_type?: string | null;
  symbol_name?: string | null;
  summary?: string | null;
  link_type?: string;
  provenance?: string;
  confidence?: number | null;
  confidence_reason?: string | null;
  sort_order?: number;
  last_verified_at?: string | null;
}

export interface HelpRelationshipInput {
  article_slug: string;
  relationship_type?: string;
  confidence?: number;
}

export interface StoryRelationshipPatch {
  entities?: {
    add?: EntityRelationshipInput[];
    remove?: string[];
    replace?: EntityRelationshipInput[];
  };
  code_assets?: {
    add?: CodeRelationshipInput[];
    remove?: Array<{ repo?: string; path: string }>;
    replace?: CodeRelationshipInput[];
  };
  help_articles?: {
    add?: HelpRelationshipInput[];
    remove?: string[];
    replace?: HelpRelationshipInput[];
  };
}

export type RelationshipMutationResult =
  | { outcome: "applied"; revision_number: number }
  | { outcome: "proposed"; proposal: StoryChangeProposalSummary }
  | { outcome: "stale"; current_revision_number: number }
  | { outcome: "not_found" | "no_fields" };

export interface SearchStore {
  knnCandidates(embedding: number[], poolSize: number): Promise<Candidate[]>;
  structuralCandidates(opts: {
    embedding?: number[];
    entitySlugs: string[];
    codePaths: string[];
    poolSize: number;
  }): Promise<Candidate[]>;
  /** Lexical (tsvector + trigram) candidates. Needs no embedding provider. */
  lexicalCandidates(opts: {
    query: string;
    embedding?: number[];
    poolSize: number;
    trigramThreshold?: number;
  }): Promise<Candidate[]>;
  getDocFrequencies(force?: boolean): Promise<DocFrequencies>;
  findCrossover(opts: {
    sectionKey?: string;
    storyKey?: string;
    limit: number;
  }): Promise<{ found: boolean; target?: TargetFootprint; hits: CrossoverHit[] }>;
  sectionCrossoverGraph(opts?: {
    minWeight?: number;
    maxEdges?: number;
    status?: string[];
    topSignals?: number;
  }): Promise<CrossoverGraph>;
  queryStories(opts: {
    filters: StoryFilters;
    groupBy?: StoryGroupBy | null;
    limit: number;
  }): Promise<QueryStoriesResult>;
  suggestVocabulary(opts: {
    codePath?: string;
    entitySlug?: string;
    limit?: number;
  }): Promise<{ code_path?: string[]; entity_slug?: string[] }>;
  getTaxonomy(): Promise<Taxonomy>;
}

export interface HelpStore {
  matchHelpArticles(opts: {
    embedding: number[];
    poolSize: number;
    productArea?: string[];
    audience?: string[];
  }): Promise<HelpHit[]>;
  /** Lexical (tsvector) help search — needs no embedding provider. */
  lexicalHelpArticles(opts: {
    query: string;
    poolSize: number;
    productArea?: string[];
    audience?: string[];
  }): Promise<HelpHit[]>;
  getHelpArticles(slugs: string[]): Promise<{ articles: HelpArticle[]; not_found: string[] }>;
  importHelpArticles(
    articles: HelpArticleImportInput[],
    opts?: { batchSize?: number }
  ): Promise<HelpArticleImportResult>;
  suggestStoryHelpLinks(opts: {
    storyKey?: string;
    articleSlug?: string;
    limit?: number;
  }): Promise<HelpLinkSuggestionResult | null>;
}

export interface HelpArticleImportInput {
  article_slug: string;
  title: string;
  summary?: string | null;
  url?: string | null;
  product_area?: string | null;
  audience?: string | null;
  tags?: string[];
  headings?: string[];
  markdown?: string | null;
}

export interface HelpArticleImportResult {
  articles: number;
  batches: Array<{ batch: number; articles: number; status: "committed" }>;
}

export interface HelpLinkSuggestion {
  story_key: string;
  story_title: string;
  article_slug: string;
  article_title: string;
  score: number;
  already_linked: boolean;
}

export interface HelpLinkSuggestionResult {
  direction: "story_to_articles" | "article_to_stories";
  source_key: string;
  suggestions: HelpLinkSuggestion[];
}

export interface StoryWriter {
  createUserStory(opts: {
    sectionKey: string;
    title: string;
    storyText: string;
    actor?: string | null;
    status?: string;
    reason?: string | null;
    source?: string;
    proposedBy?: string | null;
  }): Promise<StoryMutationResult>;
  updateUserStory(opts: {
    storyKey: string;
    title?: string;
    storyText?: string;
    actor?: string | null;
    sectionKey?: string;
    status?: string;
    expectedRevision?: number;
    reason?: string | null;
    source?: string;
    proposedBy?: string | null;
  }): Promise<StoryMutationResult>;
  updateStoryRelationships(opts: {
    storyKey: string;
    patch: StoryRelationshipPatch;
    expectedRevision?: number;
    reason?: string | null;
    source?: string;
    proposedBy?: string | null;
  }): Promise<RelationshipMutationResult>;
}

export interface FeatureRequestStore {
  createFeatureRequest(opts: {
    fr: NewFeatureRequest;
    primaryStoryKey: string;
    secondaryStoryKeys?: string[];
    linkSource?: string | null;
  }): Promise<{ id: number; link_revision: number; links: { story_key: string; link_type: string }[] }>;
  linkFeatureRequest(opts: {
    featureRequestId: number;
    storyKey: string;
    linkType: "primary" | "secondary";
    linkSource?: string | null;
  }): Promise<{ feature_request_id: number; story_key: string; link_type: string; link_revision: number }>;
  getFeatureRequest(id: number): Promise<FeatureRequestRecord | null>;
  setFeatureRequestStoryLinks(opts: {
    featureRequestId: number;
    primaryStoryKey: string;
    secondaryStoryKeys?: string[];
    linkSource?: string | null;
    expectedVersion?: number;
  }): Promise<FeatureRequestLinkMutationResult>;
}

export type FeatureRequestLinkMutationResult =
  | {
      outcome: "applied";
      feature_request_id: number;
      link_revision: number;
      links: { story_key: string; link_type: string }[];
    }
  | { outcome: "proposed"; proposal: StoryChangeProposalSummary }
  | { outcome: "stale"; current_version: number }
  | { outcome: "not_found" };

export interface ImportStore {
  importStories(payload: ImportPayload): Promise<StoryImportResult>;
}

export interface HistoryStore {
  getStoryHistory(
    storyKey: string,
    opts?: { revisionLimit?: number; eventLimit?: number }
  ): Promise<StoryHistory | null>;
  listStoryChangeProposals(opts?: {
    status?: Array<"pending" | "approved" | "rejected" | "stale">;
    storyKey?: string;
    limit?: number;
  }): Promise<StoryChangeProposal[]>;
  getStoryChangeProposal(id: number): Promise<StoryChangeProposal | null>;
}

export interface KnowledgeStore
  extends SearchStore,
    HelpStore,
    StoryWriter,
    FeatureRequestStore,
    ImportStore,
    HistoryStore {
  close(): Promise<void>;
}
