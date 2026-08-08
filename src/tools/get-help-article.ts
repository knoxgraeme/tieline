import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getHelpArticleOutputShape,
  getHelpArticleShape,
  type GetHelpArticleInput,
} from "../schemas.js";
import { getReadStore } from "../store.js";
import {
  errorResult,
  formatError,
  jsonResult,
  type ToolResult,
} from "./shared.js";

export function registerGetHelpArticle(server: McpServer): void {
  server.registerTool(
    "get_help_article",
    {
      title: "Get full help articles",
      description:
        "Fetch up to ten ingested help articles by exact source + external_id pointer, including Story and AC references.",
      inputSchema: getHelpArticleShape,
      outputSchema: getHelpArticleOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input: GetHelpArticleInput): Promise<ToolResult> => {
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
