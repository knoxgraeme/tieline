/**
 * Builds the lifecycle-aware MCP surface and its static orientation resource.
 * A factory is exported so the stateless HTTP transport can create a fresh
 * server per request.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFindRelated } from "./tools/find-related.js";
import { registerQueryStories } from "./tools/query-stories.js";
import { registerFindHelp } from "./tools/find-help.js";
import { registerGetHelpArticle } from "./tools/get-help-article.js";
import { registerGetPathCriteria } from "./tools/path-criteria.js";
import { registerIntentContextTools } from "./tools/intent-context.js";
import { registerObservationTools } from "./tools/observations.js";
import { registerBacklogItemTools } from "./tools/backlog-items.js";
import { registerResources } from "./resources.js";
import { installSemanticAdvisors } from "./semantic-matching.js";
import { registerAttributionTools } from "./tools/attributions.js";
import { registerPlanningStoryTools } from "./tools/planning-stories.js";
import { registerSearchKnowledge } from "./tools/search-knowledge.js";
import { registerPrompts } from "./prompts.js";
import { registerHandoffConflictTools } from "./tools/handoff-conflicts.js";
import { registerCodeTopologyTools } from "./tools/code-topology.js";

export const SERVER_NAME = "tieline";
export const SERVER_VERSION = (
  JSON.parse(
    readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../package.json"),
      "utf8"
    )
  ) as { version: string }
).version;

export function createServer(): McpServer {
  installSemanticAdvisors();
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Tieline is a lifecycle-aware semantic contract grounded in repository YAML. " +
        "When an exact repository path, selector, or Acceptance Criterion stable ID is known, use get_asset_intent_context or get_acceptance_criterion_context before semantic search to read its manifest-backed intent neighborhood and contract coupling without a database. " +
        "Use search_knowledge with an explicit profile for cross-type search, find_related for engineering-oriented discovery, and query_stories for exact Story/AC reads. " +
        "get_path_criteria remains available for compatibility when only the criteria recorded for whole paths are needed. " +
        "Use trace_code_dependencies for bounded, generation-identified derived code dependencies or dependents, and analyze_code_blast_radius for advisory may_be_impacted joins from changed code to authored ACs. These read-only tools preserve unresolved frontiers, distinguish derived_code_dependency from contract_coupling, and never claim implementation satisfies an AC. " +
        "Use the tieline prompt to onboard, author, grade, or reconcile repository behavior. " +
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
  registerIntentContextTools(server);
  registerObservationTools(server);
  registerBacklogItemTools(server);
  registerPlanningStoryTools(server);
  registerAttributionTools(server);
  registerHandoffConflictTools(server);
  registerCodeTopologyTools(server);
  registerResources(server);
  registerPrompts(server);

  return server;
}
