import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  listHandoffConflictsOutputShape,
  listHandoffConflictsShape,
  type ListHandoffConflictsInput,
} from "../schemas.js";
import { getReadStore } from "../store.js";
import {
  errorResult,
  formatError,
  jsonResult,
  type ToolResult,
} from "./shared.js";

export function registerHandoffConflictTools(server: McpServer): void {
  server.registerTool(
    "list_handoff_conflicts",
    {
      title: "List planning-to-repository handoff conflicts",
      description:
        "Read unresolved authority-handoff conflicts by default, including the merged repository definition and the later planning snapshot. Use this before materializing or reconciling a planning Story.",
      inputSchema: listHandoffConflictsShape,
      outputSchema: listHandoffConflictsOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input: ListHandoffConflictsInput): Promise<ToolResult> => {
      try {
        const conflicts = await getReadStore().listHandoffConflicts(input);
        return jsonResult({ conflicts });
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );
}
