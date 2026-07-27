/** PostgreSQL + pgvector implementation of the domain-owned KnowledgeStore. */

import * as search from "./search-repository.js";
import * as stories from "./story-repository.js";
import * as history from "./history-repository.js";
import * as relationships from "./relationship-repository.js";
import * as help from "./help-repository.js";
import * as featureRequests from "./feature-request-repository.js";
import * as taxonomy from "./taxonomy-repository.js";
import { importStories } from "./import-repository.js";
import { closeConnections } from "./connections.js";
import { getEmbedder } from "../../embeddings.js";
import type { ImportPayload } from "../../authoring/schema.js";
import type {
  HelpArticleImportInput,
  KnowledgeStore,
  StoryImportResult,
} from "../../domain/knowledge-store.js";

export class PostgresStore implements KnowledgeStore {
  knnCandidates = search.knnCandidates;
  structuralCandidates = search.structuralCandidates;
  lexicalCandidates = search.lexicalCandidates;
  getDocFrequencies = search.getDocFrequencies;
  matchHelpArticles = help.matchHelpArticles;
  lexicalHelpArticles = help.lexicalHelpArticles;
  getHelpArticles = help.getHelpArticles;
  importHelpArticles = (articles: HelpArticleImportInput[], opts?: { batchSize?: number }) =>
    help.importHelpArticles(articles, getEmbedder(), opts);
  suggestStoryHelpLinks = help.suggestStoryHelpLinks;
  findCrossover = search.findCrossover;
  sectionCrossoverGraph = search.sectionCrossoverGraph;
  queryStories = search.queryStories;
  suggestVocabulary = search.suggestVocabulary;
  getTaxonomy = taxonomy.getTaxonomy;
  createUserStory = stories.createUserStory;
  updateUserStory = stories.updateUserStory;
  updateStoryRelationships = relationships.updateStoryRelationships;
  createFeatureRequest = featureRequests.createFeatureRequest;
  linkFeatureRequest = featureRequests.linkFeatureRequest;
  setFeatureRequestStoryLinks = featureRequests.setFeatureRequestStoryLinks;
  getFeatureRequest = featureRequests.getFeatureRequest;
  getStoryHistory = history.getStoryHistory;
  listStoryChangeProposals = history.listStoryChangeProposals;
  getStoryChangeProposal = history.getStoryChangeProposal;
  importStories = (payload: ImportPayload): Promise<StoryImportResult> =>
    importStories(payload);
  close = closeConnections;
}
