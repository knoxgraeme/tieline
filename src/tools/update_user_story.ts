/**
 * update_user_story — edit an existing story by `story_key`: its content
 * (title / story_text / actor), lifecycle `status`, and/or `section_key`. Any
 * lifecycle status is allowed as intent; production-sensitive changes are
 * proposals by default. Writes use the least-privilege writer credential, and
 * a content change (title or story_text) re-embeds the story so it stays
 * searchable.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getStore } from "../store.js";
import { updateUserStoryShape, updateUserStoryOutputShape, type UpdateUserStoryInput } from "../schemas.js";
import { jsonResult, errorResult, formatError, type ToolResult } from "./shared.js";

const DESCRIPTION = `Edit an existing story's content and/or lifecycle status.

Args:
  - story_key (required): the story to edit.
  - title / story_text / actor / section_key / status (all optional): provide the fields to change. Editing title or story_text re-triggers the embedding. Set status to promote a story (e.g. 'idea' -> 'in_progress' -> 'production'); see docs://how-to-query for status definitions.

Returns an explicit applied/proposed/stale/not_found/no_fields outcome. Pass expected_revision to prevent stale overwrites.`;

export function registerUpdateUserStory(server: McpServer): void {
  server.registerTool(
    "update_user_story",
    {
      title: "Edit story",
      description: DESCRIPTION,
      inputSchema: updateUserStoryShape,
      outputSchema: updateUserStoryOutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input: UpdateUserStoryInput): Promise<ToolResult> => {
      try {
        const result = await getStore().updateUserStory({
          storyKey: input.story_key,
          title: input.title,
          storyText: input.story_text,
          actor: input.actor,
          sectionKey: input.section_key,
          status: input.status,
          expectedRevision: input.expected_revision,
          reason: input.reason ?? null,
          source: input.source,
          proposedBy: input.proposed_by ?? null,
        });
        if (result.outcome === "applied") {
          return jsonResult({
            outcome: result.outcome,
            updated: true,
            story: result.story,
            revision_number: result.revision_number,
          });
        }
        if (result.outcome === "proposed") {
          return jsonResult({
            outcome: result.outcome,
            updated: false,
            proposal: result.proposal,
            note: `Change is pending human approval as proposal ${result.proposal.id}; current search is unchanged.`,
          });
        }
        if (result.outcome === "stale") {
          return jsonResult({
            outcome: result.outcome,
            updated: false,
            current_revision_number: result.current_revision_number,
            note: `Expected revision is stale; current revision is ${result.current_revision_number}.`,
          });
        }
        const note =
          result.outcome === "not_found"
            ? `No story '${input.story_key}' found.`
            : "No fields to update were provided.";
        return jsonResult({ outcome: result.outcome, updated: false, note });
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );
}
