import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getHelpArticlesOutputShape,
  getHelpArticlesShape,
  type GetHelpArticlesInput,
} from "../schemas.js";
import { getReadStore } from "../store.js";
import {
  errorResult,
  formatError,
  jsonResult,
  type ToolResult,
} from "./shared.js";

export function registerGetHelpArticles(server: McpServer): void {
  server.registerTool(
    "get_help_articles",
    {
      title: "Get full help articles",
      description:
        "Hydrate up to ten ingested help articles selected by search_knowledge, using their exact source + external_id pointers. Returns full bodies and Story/AC references.",
      inputSchema: getHelpArticlesShape,
      outputSchema: getHelpArticlesOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input: GetHelpArticlesInput): Promise<ToolResult> => {
      try {
        const result = await getReadStore().getHelpArticles(input.articles);
        return jsonResult({
          ...result,
          ...(result.articles.length === 0
            ? {
                note:
                  "None of the requested source + external_id pointers have ingested content.",
              }
            : {}),
        });
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );
}
