/** Explicit lifecycle retrieval; ordinary search remains current-state only. */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getStore } from "../store.js";
import { jsonResult, errorResult, formatError, type ToolResult } from "./shared.js";

const inputShape = {
  story_key: z.string().min(1).describe("Exact story key whose accepted lifecycle to retrieve."),
  revision_limit: z.number().int().min(1).max(100).default(20),
  event_limit: z.number().int().min(1).max(500).default(100),
};

const outputShape = {
  history: z
    .object({
      current: z.object({
        id: z.number(),
        story_key: z.string(),
        section_key: z.string(),
        title: z.string(),
        actor: z.string().nullable(),
        story_text: z.string(),
        status: z.string(),
        revision_number: z.number().int(),
      }),
      revisions: z.array(
        z.object({
          revision_number: z.number().int(),
          section_key: z.string(),
          title: z.string(),
          actor: z.string().nullable(),
          story_text: z.string(),
          status: z.string(),
          change_reason: z.string().nullable(),
          actor_label: z.string().nullable(),
          source: z.string(),
          created_at: z.string(),
        })
      ),
      events: z.array(
        z.object({
          id: z.number(),
          revision_number: z.number().int().nullable(),
          proposal_id: z.number().nullable(),
          event_type: z.string(),
          from_status: z.string().nullable(),
          to_status: z.string().nullable(),
          details: z.record(z.unknown()),
          actor_label: z.string().nullable(),
          source: z.string(),
          created_at: z.string(),
        })
      ),
    })
    .nullable(),
  note: z.string().optional(),
};

export function registerGetStoryHistory(server: McpServer): void {
  server.registerTool(
    "get_story_history",
    {
      title: "Get story lifecycle",
      description:
        "Retrieve immutable accepted revisions and lifecycle/relationship events for one exact story key. " +
        "This is the explicit history path; find_related and query_stories intentionally search only the latest accepted state.",
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input): Promise<ToolResult> => {
      try {
        const history = await getStore().getStoryHistory(input.story_key, {
          revisionLimit: input.revision_limit,
          eventLimit: input.event_limit,
        });
        return jsonResult(
          history
            ? { history }
            : { history: null, note: `No story with story_key '${input.story_key}'.` }
        );
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );
}
