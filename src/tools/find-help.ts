import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  findHelpOutputShape,
  findHelpShape,
  type FindHelpInput,
} from "./schemas/help.js";
import { getReadStore } from "../store.js";
import {
  errorResult,
  formatError,
  jsonResult,
  type ToolResult,
} from "./shared.js";

const DESCRIPTION = `Deprecated: use search_knowledge with document_kind=["help_article"]
or help_source filters. This compatibility tool searches ingested help content by
words and phrases. Use get_help_articles to hydrate selected full bodies.`;

export function registerFindHelp(server: McpServer): void {
  server.registerTool(
    "find_help",
    {
      title: "Find help articles",
      description: DESCRIPTION,
      inputSchema: findHelpShape,
      outputSchema: findHelpOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input: FindHelpInput): Promise<ToolResult> => {
      try {
        const hits = await getReadStore().searchHelpArticles({
          query: input.query,
          sources: input.source,
          limit: input.limit,
        });
        const results = hits.map(
          ({ id: _id, graph_proximity: _graphProximity, ...hit }) => hit
        );
        return jsonResult({
          query: { source: input.source },
          results,
          ...(results.length === 0
            ? { note: "No ingested help article matched this query." }
            : {}),
        });
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );
}
