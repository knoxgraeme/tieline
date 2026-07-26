/**
 * Create a latest-state story or a human-reviewed create proposal. Keys are
 * minted server-side; search first to avoid duplicate product behavior.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getStore } from "../store.js";
import { createUserStoryShape, createUserStoryOutputShape, type CreateUserStoryInput } from "../schemas.js";
import { jsonResult, errorResult, formatError, type ToolResult } from "./shared.js";

const DESCRIPTION = `Create a new user story in a section. Returns the server-minted story_key.

SEARCH FIRST. Only create when find_related (scope='stories') / query_stories surface no strong existing match — prefer linking/editing an existing story over creating a duplicate.

Args:
  - section_key (required): the section this story belongs to — YOU assign it (must be a valid key; list via query_stories(group_by='section') or schema://taxonomy).
  - title (required): short story title.
  - story_text (required): the narrative, e.g. "As a <actor>, I want <change> so that <outcome>".
  - actor (optional).
  - status (optional, default 'idea'): the lifecycle status — choose it deliberately. Use 'production' for a shipped/existing capability (e.g. backfilling), 'feature_request' when capturing an incoming customer ask during triage, 'idea' for a proposal. See docs://how-to-query for all definitions.

Returns outcome='applied' with the accepted current story, or outcome='proposed' for a production-sensitive create. Pending proposals are not searchable until approved.`;

export function registerCreateUserStory(server: McpServer): void {
  server.registerTool(
    "create_user_story",
    {
      title: "Create story",
      description: DESCRIPTION,
      inputSchema: createUserStoryShape,
      outputSchema: createUserStoryOutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input: CreateUserStoryInput): Promise<ToolResult> => {
      try {
        const result = await getStore().createUserStory({
          sectionKey: input.section_key,
          title: input.title,
          storyText: input.story_text,
          actor: input.actor ?? null,
          status: input.status,
          reason: input.reason ?? null,
          source: input.source,
          proposedBy: input.proposed_by ?? null,
        });
        if (result.outcome === "applied") {
          return jsonResult({
            outcome: result.outcome,
            story: result.story,
            revision_number: result.revision_number,
            note:
              `Story created with status '${result.story.status}' at revision ${result.revision_number}. ` +
              "It is accepted current state and immediately searchable.",
          });
        }
        if (result.outcome === "proposed") {
          return jsonResult({
            outcome: result.outcome,
            proposal: result.proposal,
            note:
              `Production-sensitive create is pending human approval as proposal ${result.proposal.id}. ` +
              "It is not searchable until approved in the local review UI or CLI.",
          });
        }
        return jsonResult({ outcome: result.outcome, note: `Story create returned ${result.outcome}.` });
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );
}
