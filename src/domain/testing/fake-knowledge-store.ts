import type {
  HelpArticleRecord,
  HelpArticleRef,
  HelpSearchHit,
  KnowledgeStore,
} from "../knowledge-store.js";
import type {
  AttributionDecision,
  AttributionDecisionRecord,
  BacklogItemLinks,
  BacklogItemRecord,
  BacklogItemSnapshot,
  BacklogMutationResult,
  BacklogStage,
  ObservationRecord,
  PreparedObservation,
} from "../evidence-write-store.js";
import {
  buildContractGraph,
  type ContractCriterionLookup,
  type ContractGraph,
  type HandoffConflictRecord,
  type ContractStoryFilters,
  type ContractStoryGroupBy,
  type ContractStoryRecord,
  type QueryContractStoriesResult,
} from "../contract-read-store.js";
import type {
  CreatePlanningStoryInput,
  PlanningStoryMutationResult,
  UpdatePlanningStoryInput,
} from "../planning-contract-write-store.js";
import type {
  AttributionSuggestionRecord,
  ResolvedRetrievalProfile,
  SemanticSearchCandidate,
  SemanticSearchContext,
  SemanticSearchFilters,
} from "../semantic-search-store.js";
import type { EmbeddingDocumentKind } from "../../derived/embedding-documents.js";
import type {
  ContractAuthority,
  StoryLifecycle,
} from "../../types.js";

const unconfigured = (operation: string): Error =>
  new Error(`FakeKnowledgeStore.${operation} was not configured for this test.`);

export class FakeKnowledgeStore implements KnowledgeStore {
  private readonly contractStories: ContractStoryRecord[] | null;

  constructor(options?: { contractStories?: ContractStoryRecord[] }) {
    this.contractStories = options?.contractStories ?? null;
  }

  async queryContractStories(input: {
    filters: ContractStoryFilters;
    groupBy?: ContractStoryGroupBy | null;
    limit: number;
  }): Promise<QueryContractStoriesResult> {
    if (!this.contractStories) throw unconfigured("queryContractStories");
    const records = this.contractStories.filter((story) => {
      const filters = input.filters;
      if (
        filters.repositories?.length &&
        !filters.repositories.includes(story.repository)
      ) return false;
      if (
        filters.capabilities?.length &&
        !filters.capabilities.includes(story.capability.stable_id)
      ) return false;
      if (
        filters.story_keys?.length &&
        !filters.story_keys.includes(story.stable_id)
      ) return false;
      if (
        filters.actors?.length &&
        (!story.actor || !filters.actors.includes(story.actor))
      ) return false;
      if (
        filters.lifecycles?.length &&
        !filters.lifecycles.includes(story.lifecycle)
      ) return false;
      if (
        filters.authorities?.length &&
        !filters.authorities.includes(story.authority)
      ) return false;
      if (
        filters.code_path &&
        !story.footprint.code_paths.includes(filters.code_path)
      ) return false;
      if (
        filters.help_source &&
        !story.footprint.help.some(
          (link) => link.source === filters.help_source
        )
      ) return false;
      if (
        filters.help_external_id &&
        !story.footprint.help.some(
          (link) => link.external_id === filters.help_external_id
        )
      ) return false;
      if (filters.has_direct_ac_links !== undefined) {
        const hasDirect = story.acceptance_criteria.some(
          (criterion) => criterion.direct_links.length > 0
        );
        if (hasDirect !== filters.has_direct_ac_links) return false;
      }
      return true;
    });
    if (input.groupBy) {
      const counts = new Map<string, number>();
      for (const story of records) {
        const group =
          input.groupBy === "repository"
            ? story.repository
            : input.groupBy === "capability"
              ? story.capability.stable_id
              : input.groupBy === "lifecycle"
                ? story.lifecycle
                : input.groupBy === "authority"
                  ? story.authority
                  : story.actor ?? "(none)";
        counts.set(group, (counts.get(group) ?? 0) + 1);
      }
      return {
        mode: "grouped",
        groups: [...counts]
          .map(([group, count]) => ({ group, count }))
          .sort(
            (left, right) =>
              right.count - left.count ||
              left.group.localeCompare(right.group)
          ),
      };
    }
    return {
      mode: "records",
      total: records.length,
      records: records.slice(0, input.limit).map((story) => ({
        ...story,
        acceptance_criteria: input.filters.include_inactive_criteria
          ? story.acceptance_criteria
          : story.acceptance_criteria.filter((criterion) => criterion.active),
      })),
    };
  }

  async getAcceptanceCriterion(input: {
    repository: string;
    stableId: string;
    includeInactive?: boolean;
  }): Promise<ContractCriterionLookup | null> {
    if (!this.contractStories) throw unconfigured("getAcceptanceCriterion");
    const story = this.contractStories.find(
      (candidate) =>
        candidate.repository === input.repository &&
        candidate.acceptance_criteria.some(
          (criterion) =>
            criterion.stable_id === input.stableId &&
            (input.includeInactive || criterion.active)
        )
    );
    if (!story) return null;
    return {
      story: {
        repository: story.repository,
        stable_id: story.stable_id,
        title: story.title,
        lifecycle: story.lifecycle,
        authority: story.authority,
      },
      criterion: story.acceptance_criteria.find(
        (criterion) => criterion.stable_id === input.stableId
      )!,
    };
  }

  async contractGraph(
    input: {
      repositories?: string[];
      lifecycles?: StoryLifecycle[];
      authorities?: ContractAuthority[];
      includeInactiveCriteria?: boolean;
    } = {}
  ): Promise<ContractGraph> {
    const result = await this.queryContractStories({
      filters: {
        repositories: input.repositories,
        lifecycles: input.lifecycles,
        authorities: input.authorities,
        include_inactive_criteria: input.includeInactiveCriteria,
      },
      limit: Number.MAX_SAFE_INTEGER,
    });
    return buildContractGraph(result.mode === "records" ? result.records : []);
  }

  listHandoffConflicts(): Promise<HandoffConflictRecord[]> {
    return Promise.reject(unconfigured("listHandoffConflicts"));
  }

  resolveRetrievalProfile(): Promise<ResolvedRetrievalProfile> {
    return Promise.reject(unconfigured("resolveRetrievalProfile"));
  }
  searchSemantic(_input: {
    query: string;
    embedding?: number[];
    profile: ResolvedRetrievalProfile;
    filters?: SemanticSearchFilters;
    context?: SemanticSearchContext;
    limit: number;
  }): Promise<SemanticSearchCandidate[]> {
    return Promise.reject(unconfigured("searchSemantic"));
  }
  listAttributionSuggestions(_input?: {
    source_kind?: EmbeddingDocumentKind;
    source_id?: string;
    state?: Array<"suggested" | "confirmed" | "dismissed">;
    limit?: number;
  }): Promise<AttributionSuggestionRecord[]> {
    return Promise.reject(unconfigured("listAttributionSuggestions"));
  }
  decideAttributionSuggestion(_input: {
    suggestion_id: string;
    decision: "confirmed" | "dismissed";
  }): Promise<AttributionSuggestionRecord | null> {
    return Promise.reject(unconfigured("decideAttributionSuggestion"));
  }
  createPlanningStory(
    _input: CreatePlanningStoryInput
  ): Promise<ContractStoryRecord> {
    return Promise.reject(unconfigured("createPlanningStory"));
  }
  updatePlanningStory(
    _input: UpdatePlanningStoryInput
  ): Promise<PlanningStoryMutationResult> {
    return Promise.reject(unconfigured("updatePlanningStory"));
  }
  recordObservation(_input: PreparedObservation): Promise<ObservationRecord> {
    return Promise.reject(unconfigured("recordObservation"));
  }
  decideAttribution(
    _input: AttributionDecision
  ): Promise<AttributionDecisionRecord> {
    return Promise.reject(unconfigured("decideAttribution"));
  }
  createBacklogItem(_input: {
    stable_id?: string;
    title: string;
    summary: string;
    stage?: BacklogStage;
  }): Promise<BacklogItemRecord> {
    return Promise.reject(unconfigured("createBacklogItem"));
  }
  getBacklogItem(_input: {
    stable_id: string;
  }): Promise<BacklogItemSnapshot | null> {
    return Promise.reject(unconfigured("getBacklogItem"));
  }
  updateBacklogItem(_input: {
    stable_id: string;
    expected_revision: number;
    title?: string;
    summary?: string;
    stage?: BacklogStage;
    superseded_by?: string | null;
  }): Promise<BacklogMutationResult> {
    return Promise.reject(unconfigured("updateBacklogItem"));
  }
  setBacklogItemLinks(_input: {
    stable_id: string;
    expected_revision: number;
    links: BacklogItemLinks;
  }): Promise<BacklogMutationResult & { links?: BacklogItemLinks }> {
    return Promise.reject(unconfigured("setBacklogItemLinks"));
  }
  searchHelpArticles(_input: {
    query: string;
    sources?: string[];
    limit: number;
  }): Promise<HelpSearchHit[]> {
    return Promise.reject(unconfigured("searchHelpArticles"));
  }
  getHelpArticles(
    _refs: HelpArticleRef[]
  ): Promise<{ articles: HelpArticleRecord[]; not_found: HelpArticleRef[] }> {
    return Promise.reject(unconfigured("getHelpArticles"));
  }
  async close(): Promise<void> {}
}
