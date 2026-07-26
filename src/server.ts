/**
 * Builds the base 15-tool server plus two resources. Optional import/review/graph
 * tools are registered only through explicit feature flags. A factory is
 * exported so the stateless HTTP transport can create a fresh server per request.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFindRelated } from "./tools/find_related.js";
import { registerFindCrossover } from "./tools/find_crossover.js";
import { registerQueryStories } from "./tools/query_stories.js";
import { registerFindHelp } from "./tools/find_help.js";
import { registerGetHelpArticle } from "./tools/get_help_article.js";
import { registerCreateUserStory } from "./tools/create_user_story.js";
import { registerUpdateUserStory } from "./tools/update_user_story.js";
import { registerFeatureRequestTools } from "./tools/feature_requests.js";
import { registerImportStories } from "./tools/import_stories.js";
import { registerReviewApp } from "./tools/review_app.js";
import { registerExploreGraph } from "./tools/explore_graph.js";
import { registerGetStoryHistory } from "./tools/get_story_history.js";
import { registerStoryChangeProposals } from "./tools/story_change_proposals.js";
import { registerUpdateStoryRelationships } from "./tools/update_story_relationships.js";
import { registerSuggestStoryHelpLinks } from "./tools/suggest_story_help_links.js";
import { registerResources } from "./resources.js";
import { config } from "./config.js";

export const SERVER_NAME = "tieline";
export const SERVER_VERSION = "0.1.0";

export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Retrieval over a user-story knowledge graph (product sections, stories, " +
        "entity slugs, code paths) plus linked help-center articles and immutable lifecycle history. " +
        "find_related ('like' this — start here, takes free text or code), " +
        "find_crossover ('entangled with' a known key), query_stories ('matching' " +
        "exact attributes — also fetches a story by story_key and returns each story's " +
        "help_articles + feature_requests inline), find_help (semantic search over help " +
        "articles), get_help_article (full help body by slug), get_story_history (accepted revisions/events). " +
        "WRITE tools: create_user_story and update_user_story (production-sensitive changes become " +
        "human-reviewed proposals by default), update_story_relationships, create_feature_request (logs an incoming request + links it to a " +
        "primary + secondary stories), link_feature_request, get_feature_request. Read " +
        "schema://taxonomy for the vocabulary and docs://how-to-query for routing + the concept " +
        "and status definitions.",
    }
  );

  registerFindRelated(server);
  registerFindCrossover(server);
  registerQueryStories(server);
  registerFindHelp(server);
  registerGetHelpArticle(server);
  registerCreateUserStory(server);
  registerUpdateUserStory(server);
  registerFeatureRequestTools(server);
  registerGetStoryHistory(server);
  registerStoryChangeProposals(server);
  registerUpdateStoryRelationships(server);
  registerSuggestStoryHelpLinks(server);
  if (config.enableImportTool) registerImportStories(server);
  if (config.enableReviewApp) registerReviewApp(server);
  if (config.enableGraphApp) registerExploreGraph(server);
  registerResources(server);

  return server;
}
