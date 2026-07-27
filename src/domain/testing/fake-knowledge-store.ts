/**
 * Minimal in-memory/test adapter seam.
 *
 * Tests can subclass this and override only the capabilities they exercise.
 * Every unconfigured operation fails loudly so a test cannot accidentally pass
 * because the fake returned an empty value for an unsupported capability.
 */

import type {
  CrossoverGraph,
  KnowledgeStore,
  NewFeatureRequest,
  QueryStoriesResult,
  StoryFilters,
  StoryGroupBy,
  StoryImportResult,
  StoryHistory,
  StoryChangeProposal,
  StoryMutationResult,
  RelationshipMutationResult,
  StoryRelationshipPatch,
  HelpArticleImportInput,
  HelpArticleImportResult,
  HelpLinkSuggestionResult,
  FeatureRequestLinkMutationResult,
  TargetFootprint,
  Taxonomy,
} from "../knowledge-store.js";
import type {
  Candidate,
  CrossoverHit,
  DocFrequencies,
  FeatureRequestRecord,
  HelpArticle,
  HelpHit,
  WrittenStory,
} from "../../types.js";
import type { ImportPayload } from "../../authoring/schema.js";

const unconfigured = (operation: string): Error =>
  new Error(`FakeKnowledgeStore.${operation} was not configured for this test.`);

export class FakeKnowledgeStore implements KnowledgeStore {
  knnCandidates(_embedding: number[], _poolSize: number): Promise<Candidate[]> {
    return Promise.reject(unconfigured("knnCandidates"));
  }
  structuralCandidates(_opts: {
    embedding?: number[];
    entitySlugs: string[];
    codePaths: string[];
    poolSize: number;
  }): Promise<Candidate[]> {
    return Promise.reject(unconfigured("structuralCandidates"));
  }
  lexicalCandidates(_opts: {
    query: string;
    embedding?: number[];
    poolSize: number;
    trigramThreshold?: number;
  }): Promise<Candidate[]> {
    return Promise.reject(unconfigured("lexicalCandidates"));
  }
  getDocFrequencies(_force?: boolean): Promise<DocFrequencies> {
    return Promise.reject(unconfigured("getDocFrequencies"));
  }
  findCrossover(_opts: { sectionKey?: string; storyKey?: string; limit: number }): Promise<{
    found: boolean;
    target?: TargetFootprint;
    hits: CrossoverHit[];
  }> {
    return Promise.reject(unconfigured("findCrossover"));
  }
  sectionCrossoverGraph(_opts?: {
    minWeight?: number;
    maxEdges?: number;
    status?: string[];
    topSignals?: number;
  }): Promise<CrossoverGraph> {
    return Promise.reject(unconfigured("sectionCrossoverGraph"));
  }
  queryStories(_opts: {
    filters: StoryFilters;
    groupBy?: StoryGroupBy | null;
    limit: number;
  }): Promise<QueryStoriesResult> {
    return Promise.reject(unconfigured("queryStories"));
  }
  suggestVocabulary(_opts: {
    codePath?: string;
    entitySlug?: string;
    limit?: number;
  }): Promise<{ code_path?: string[]; entity_slug?: string[] }> {
    return Promise.reject(unconfigured("suggestVocabulary"));
  }
  getTaxonomy(): Promise<Taxonomy> {
    return Promise.reject(unconfigured("getTaxonomy"));
  }
  matchHelpArticles(_opts: {
    embedding: number[];
    poolSize: number;
    productArea?: string[];
    audience?: string[];
  }): Promise<HelpHit[]> {
    return Promise.reject(unconfigured("matchHelpArticles"));
  }
  getHelpArticles(_slugs: string[]): Promise<{ articles: HelpArticle[]; not_found: string[] }> {
    return Promise.reject(unconfigured("getHelpArticles"));
  }
  importHelpArticles(
    _articles: HelpArticleImportInput[],
    _opts?: { batchSize?: number }
  ): Promise<HelpArticleImportResult> {
    return Promise.reject(unconfigured("importHelpArticles"));
  }
  suggestStoryHelpLinks(_opts: {
    storyKey?: string;
    articleSlug?: string;
    limit?: number;
  }): Promise<HelpLinkSuggestionResult | null> {
    return Promise.reject(unconfigured("suggestStoryHelpLinks"));
  }
  createUserStory(_opts: {
    sectionKey: string;
    title: string;
    storyText: string;
    actor?: string | null;
    status?: string;
    reason?: string | null;
    source?: string;
    proposedBy?: string | null;
  }): Promise<StoryMutationResult> {
    return Promise.reject(unconfigured("createUserStory"));
  }
  updateUserStory(_opts: {
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
  }): Promise<StoryMutationResult> {
    return Promise.reject(unconfigured("updateUserStory"));
  }
  updateStoryRelationships(_opts: {
    storyKey: string;
    patch: StoryRelationshipPatch;
    expectedRevision?: number;
    reason?: string | null;
    source?: string;
    proposedBy?: string | null;
  }): Promise<RelationshipMutationResult> {
    return Promise.reject(unconfigured("updateStoryRelationships"));
  }
  createFeatureRequest(_opts: {
    fr: NewFeatureRequest;
    primaryStoryKey: string;
    secondaryStoryKeys?: string[];
    linkSource?: string | null;
  }): Promise<{ id: number; link_revision: number; links: { story_key: string; link_type: string }[] }> {
    return Promise.reject(unconfigured("createFeatureRequest"));
  }
  linkFeatureRequest(_opts: {
    featureRequestId: number;
    storyKey: string;
    linkType: "primary" | "secondary";
    linkSource?: string | null;
  }): Promise<{ feature_request_id: number; story_key: string; link_type: string; link_revision: number }> {
    return Promise.reject(unconfigured("linkFeatureRequest"));
  }
  getFeatureRequest(_id: number): Promise<FeatureRequestRecord | null> {
    return Promise.reject(unconfigured("getFeatureRequest"));
  }
  setFeatureRequestStoryLinks(_opts: {
    featureRequestId: number;
    primaryStoryKey: string;
    secondaryStoryKeys?: string[];
    linkSource?: string | null;
    expectedVersion?: number;
  }): Promise<FeatureRequestLinkMutationResult> {
    return Promise.reject(unconfigured("setFeatureRequestStoryLinks"));
  }
  importStories(_payload: ImportPayload): Promise<StoryImportResult> {
    return Promise.reject(unconfigured("importStories"));
  }
  getStoryHistory(
    _storyKey: string,
    _opts?: { revisionLimit?: number; eventLimit?: number }
  ): Promise<StoryHistory | null> {
    return Promise.reject(unconfigured("getStoryHistory"));
  }
  listStoryChangeProposals(_opts?: {
    status?: Array<"pending" | "approved" | "rejected" | "stale">;
    storyKey?: string;
    limit?: number;
  }): Promise<StoryChangeProposal[]> {
    return Promise.reject(unconfigured("listStoryChangeProposals"));
  }
  getStoryChangeProposal(_id: number): Promise<StoryChangeProposal | null> {
    return Promise.reject(unconfigured("getStoryChangeProposal"));
  }
  async close(): Promise<void> {}
}
