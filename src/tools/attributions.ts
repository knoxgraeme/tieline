import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PostgresSemanticRepository } from "../adapters/postgres/semantic-repository.js";
import {
  getReadSql,
  getWriteSql,
} from "../adapters/postgres/connections.js";
import {
  errorResult,
  formatError,
  jsonResult,
  type ToolResult,
} from "./shared.js";

const entityKind = z.enum([
  "story",
  "acceptance_criterion",
  "scenario",
  "backlog_item",
  "observation",
]);

export function registerAttributionTools(server: McpServer): void {
  server.registerTool(
    "list_attribution_suggestions",
    {
      title: "List attribution suggestions",
      description:
        "List pending machine suggestions by default. Dismissed rows remain auditable and appear only when explicitly requested.",
      inputSchema: {
        source_kind: entityKind.optional(),
        source_id: z.string().uuid().optional(),
        state: z
          .array(z.enum(["suggested", "confirmed", "dismissed"]))
          .optional(),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input): Promise<ToolResult> => {
      try {
        const repository = new PostgresSemanticRepository(getReadSql);
        const suggestions = await repository.listAttributionSuggestions(input);
        return jsonResult({ suggestions });
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );

  server.registerTool(
    "decide_attribution_suggestion",
    {
      title: "Confirm or dismiss an attribution suggestion",
      description:
        "Record the review state of a machine suggestion. This preserves its method, score, and rationale for audit.",
      inputSchema: {
        suggestion_id: z.string().uuid(),
        decision: z.enum(["confirmed", "dismissed"]),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input): Promise<ToolResult> => {
      try {
        const repository = new PostgresSemanticRepository(getWriteSql);
        const suggestion =
          await repository.decideAttributionSuggestion(input);
        if (!suggestion) {
          return errorResult(
            `Unknown attribution suggestion '${input.suggestion_id}'.`
          );
        }
        return jsonResult({ suggestion });
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );
}
