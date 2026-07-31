import type { ContractReadStore } from "./contract-read-store.js";
import type { EvidenceWriteStore } from "./evidence-write-store.js";
import type { BacklogReadStore } from "./evidence-write-store.js";
import type { PlanningContractWriteStore } from "./planning-contract-write-store.js";
import type { SemanticSearchStore } from "./semantic-search-store.js";
import type {
  ContractAuthority,
  StoryLifecycle,
} from "../types.js";

export interface HelpArticleRef {
  source: string;
  external_id: string;
}

export interface HelpArticleRecord extends HelpArticleRef {
  title: string | null;
  url: string | null;
  summary: string | null;
  markdown: string | null;
  updated_at: string;
  linked_stories: Array<{
    repository: string;
    stable_id: string;
    authority: ContractAuthority;
    lifecycle: StoryLifecycle;
  }>;
  linked_acceptance_criteria: Array<{
    repository: string;
    stable_id: string;
    story_stable_id: string;
    authority: ContractAuthority;
    lifecycle: StoryLifecycle;
  }>;
}

export interface HelpSearchHit extends HelpArticleRef {
  title: string | null;
  url: string | null;
  summary: string | null;
  lexical_score: number;
  linked_story_count: number;
  linked_acceptance_criterion_count: number;
}

export interface HelpReadStore {
  searchHelpArticles(input: {
    query: string;
    sources?: string[];
    limit: number;
  }): Promise<HelpSearchHit[]>;
  getHelpArticles(
    refs: HelpArticleRef[]
  ): Promise<{ articles: HelpArticleRecord[]; not_found: HelpArticleRef[] }>;
}

export interface KnowledgeStore
  extends ContractReadStore,
    BacklogReadStore,
    SemanticSearchStore,
    PlanningContractWriteStore,
    EvidenceWriteStore,
    HelpReadStore {
  close(): Promise<void>;
}
