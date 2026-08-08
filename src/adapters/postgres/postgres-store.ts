import type { KnowledgeStore } from "../../domain/knowledge-store.js";
import { PostgresBacklogRepository } from "./backlog-repository.js";
import { closeConnections, getReadSql, getWriteSql } from "./connections.js";
import { PostgresContractReadRepository } from "./contract-read-repository.js";
import * as help from "./help-repository.js";
import { PostgresObservationRepository } from "./observation-repository.js";
import { PostgresPlanningStoryRepository } from "./planning-story-repository.js";
import { PostgresSemanticRepository } from "./semantic-repository.js";

export class PostgresStore implements KnowledgeStore {
  private readonly contractReads = new PostgresContractReadRepository();
  private readonly observations = new PostgresObservationRepository();
  private readonly backlog = new PostgresBacklogRepository();
  private readonly backlogReads = new PostgresBacklogRepository(getReadSql);
  private readonly semantic = new PostgresSemanticRepository();
  private readonly semanticWrites = new PostgresSemanticRepository(getWriteSql);
  private readonly planning = new PostgresPlanningStoryRepository();

  queryContractStories =
    this.contractReads.queryContractStories.bind(this.contractReads);
  getAcceptanceCriterion =
    this.contractReads.getAcceptanceCriterion.bind(this.contractReads);
  contractGraph = this.contractReads.contractGraph.bind(this.contractReads);
  listHandoffConflicts =
    this.contractReads.listHandoffConflicts.bind(this.contractReads);

  recordObservation =
    this.observations.recordObservation.bind(this.observations);
  decideAttribution =
    this.observations.decideAttribution.bind(this.observations);
  createBacklogItem = this.backlog.createBacklogItem.bind(this.backlog);
  updateBacklogItem = this.backlog.updateBacklogItem.bind(this.backlog);
  setBacklogItemLinks =
    this.backlog.setBacklogItemLinks.bind(this.backlog);
  getBacklogItem =
    this.backlogReads.getBacklogItem.bind(this.backlogReads);

  resolveRetrievalProfile =
    this.semantic.resolveRetrievalProfile.bind(this.semantic);
  searchSemantic = this.semantic.searchSemantic.bind(this.semantic);
  listAttributionSuggestions =
    this.semantic.listAttributionSuggestions.bind(this.semantic);
  decideAttributionSuggestion =
    this.semanticWrites.decideAttributionSuggestion.bind(this.semanticWrites);

  createPlanningStory =
    this.planning.createPlanningStory.bind(this.planning);
  updatePlanningStory =
    this.planning.updatePlanningStory.bind(this.planning);

  searchHelpArticles = help.searchHelpArticles;
  getHelpArticles = help.getHelpArticles;
  close = closeConnections;
}
