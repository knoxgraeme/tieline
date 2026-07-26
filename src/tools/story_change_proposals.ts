/** Read-only proposal queue visibility. Decisions remain local UI/CLI only. */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getStore } from "../store.js";
import { jsonResult, errorResult, formatError, type ToolResult } from "./shared.js";

const STATUSES = ["pending", "approved", "rejected", "stale"] as const;
const inputShape = {
  status: z.array(z.enum(STATUSES)).default(["pending"]),
  story_key: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).default(50),
};

const proposalObject = z.object({
  id: z.number(),
  operation: z.enum(["create", "update", "relationships"]),
  status: z.enum(STATUSES),
  story_key: z.string().nullable(),
  story_id: z.number().nullable(),
  base_revision_number: z.number().int().nullable(),
  patch_version: z.number().int(),
  patch: z.record(z.unknown()),
  reason: z.string().nullable(),
  proposed_by: z.string().nullable(),
  source: z.string(),
  decided_by: z.string().nullable(),
  decision_note: z.string().nullable(),
  created_at: z.string(),
  decided_at: z.string().nullable(),
});

export function registerStoryChangeProposals(server: McpServer): void {
  server.registerTool(
    "list_story_change_proposals",
    {
      title: "List story change proposals",
      description:
        "Read the human-review queue and its typed before/after patch metadata. This tool cannot approve or reject; " +
        "decisions are deliberately limited to the localhost review UI and CLI.",
      inputSchema: inputShape,
      outputSchema: { proposals: z.array(proposalObject), note: z.string().optional() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input): Promise<ToolResult> => {
      try {
        const proposals = await getStore().listStoryChangeProposals({
          status: input.status,
          storyKey: input.story_key,
          limit: input.limit,
        });
        return jsonResult({
          proposals,
          ...(proposals.length === 0
            ? { note: "No proposals matched this queue filter." }
            : {}),
        });
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );
}
