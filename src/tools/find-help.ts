import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  findHelpOutputShape,
  findHelpShape,
  type FindHelpInput,
} from "../schemas.js";
import { getReadStore } from "../store.js";
import {
  errorResult,
  formatError,
  jsonResult,
  type ToolResult,
} from "./shared.js";

const DESCRIPTION = `Search ingested help content by words and phrases. Results use
the stable source + external_id pointer carried by Story/AC links and report how
many accepted/planning contract records reference each article. Use
get_help_article to fetch selected full bodies.`;

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
        const results = await getReadStore().searchHelpArticles({
          query: input.query,
          sources: input.source,
          limit: input.limit,
        });
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
