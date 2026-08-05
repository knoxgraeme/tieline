/**
 * Builds the lifecycle-aware MCP surface and its static orientation resource.
 * A factory is exported so the stateless HTTP transport can create a fresh
 * server per request.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFindRelated } from "./tools/find_related.js";
import { registerQueryStories } from "./tools/query_stories.js";
import { registerFindHelp } from "./tools/find_help.js";
import { registerGetHelpArticle } from "./tools/get_help_article.js";
import { registerGetPathCriteria } from "./tools/path-criteria.js";
import { registerObservationTools } from "./tools/observations.js";
import { registerBacklogItemTools } from "./tools/backlog-items.js";
import { registerResources } from "./resources.js";
import { installSemanticAdvisors } from "./semantic-matching.js";
import { registerAttributionTools } from "./tools/attributions.js";
import { registerPlanningStoryTools } from "./tools/planning-stories.js";
import { registerSearchKnowledge } from "./tools/search-knowledge.js";
import { registerPrompts } from "./prompts.js";
import { registerHandoffConflictTools } from "./tools/handoff-conflicts.js";

export const SERVER_NAME = "tieline";
export const SERVER_VERSION = "0.1.2";

export function createServer(): McpServer {
  installSemanticAdvisors();
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Tieline is a lifecycle-aware semantic contract grounded in repository YAML. " +
        "Use search_knowledge with an explicit profile for cross-type search, find_related for engineering-oriented discovery, and query_stories for exact Story/AC reads. " +
        "Use get_path_criteria before editing a repository path to learn which acceptance criteria the accepted contract records for it; the tool reads the compiled manifest and needs no database. " +
        "Use the tieline_author prompt to onboard or reconcile repository behavior. " +
        "Planning writes can shape backlog Stories/ACs, append Observations, and manage " +
        "Backlog Items. Repository-owned behavior changes only through YAML and normal PR review.",
    }
  );

  registerFindRelated(server);
  registerSearchKnowledge(server);
  registerQueryStories(server);
  registerFindHelp(server);
  registerGetHelpArticle(server);
  registerGetPathCriteria(server);
  registerObservationTools(server);
  registerBacklogItemTools(server);
  registerPlanningStoryTools(server);
  registerAttributionTools(server);
  registerHandoffConflictTools(server);
  registerResources(server);
  registerPrompts(server);

  return server;
}
