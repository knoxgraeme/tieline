import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { adviseBacklogCreate } from "../backlog-advisor.js";
import {
  createBacklogItemOutputShape,
  createBacklogItemShape,
  getBacklogItemOutputShape,
  getBacklogItemShape,
  setBacklogItemLinksOutputShape,
  setBacklogItemLinksSchema,
  updateBacklogItemOutputShape,
  updateBacklogItemShape,
  type CreateBacklogItemInput,
  type GetBacklogItemInput,
  type SetBacklogItemLinksInput,
  type UpdateBacklogItemInput,
} from "../schemas.js";
import { getEvidenceWriteStore, getReadStore } from "../store.js";
import { getSemanticMatcher } from "../semantic-matching.js";
import {
  errorResult,
  formatError,
  jsonResult,
  type ToolResult,
} from "./shared.js";

async function indexBacklogItem(
  item: Parameters<
    ReturnType<typeof getSemanticMatcher>["indexBacklogItem"]
  >[0]
): Promise<{ indexing_error?: string; note?: string }> {
  try {
    await getSemanticMatcher().indexBacklogItem(item);
    return {};
  } catch (error) {
    return {
      indexing_error: formatError(error),
      note:
        "The Backlog Item was committed and remains available for semantic indexing retry.",
    };
  }
}

export function registerBacklogItemTools(server: McpServer): void {
  server.registerTool(
    "get_backlog_item",
    {
      title: "Get a Backlog Item and its links",
      description:
        "Read a Backlog Item's current revision, Observation links, and Story/AC targets before applying an optimistic update or replacing its links.",
      inputSchema: getBacklogItemShape,
      outputSchema: getBacklogItemOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input: GetBacklogItemInput): Promise<ToolResult> => {
      try {
        const snapshot = await getReadStore().getBacklogItem(input);
        if (!snapshot) {
          return errorResult(
            `Unknown Backlog Item '${input.stable_id}'.`
          );
        }
        return jsonResult({ ...snapshot });
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );

  server.registerTool(
    "create_backlog_item",
    {
      title: "Create a Backlog Item",
      description:
        "Create a DB-native work record without requiring an Observation or Story. " +
        "The semantic match-before-create advisor can pause this call for explicit " +
        "reuse/continue selection; repository Stories are never created here.",
      inputSchema: createBacklogItemShape,
      outputSchema: createBacklogItemOutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input: CreateBacklogItemInput): Promise<ToolResult> => {
      try {
        const advice = await adviseBacklogCreate({
          title: input.title,
          summary: input.summary,
        });
        if (advice) {
          const selected = input.selected_suggestion_id
            ? advice.candidates.find(
                (candidate) =>
                  candidate.suggestion_id === input.selected_suggestion_id
              )
            : undefined;
          if (input.selected_suggestion_id && !selected) {
            return errorResult(
              `Unknown selected_suggestion_id '${input.selected_suggestion_id}'.`
            );
          }
          if (selected) {
            return jsonResult({
              outcome: "reuse_selected",
              selected,
              note:
                "No Backlog Item was created; the caller selected an existing semantic record.",
            });
          }
          if (
            !selected &&
            !input.continue_without_match &&
            (advice.candidates.length > 0 ||
              advice.require_explicit_continue)
          ) {
            return jsonResult({
              outcome: "match_review_required",
              candidates: advice.candidates,
              note:
                advice.candidates.length > 0
                  ? "Select a suggested existing record or explicitly continue without reuse."
                  : "No credible existing match was found; explicitly continue to create a new Backlog Item.",
            });
          }
        }
        const item = await getEvidenceWriteStore().createBacklogItem({
          stable_id: input.stable_id,
          title: input.title,
          summary: input.summary,
          stage: input.stage,
        });
        return jsonResult({
          outcome: "created",
          item,
          ...(await indexBacklogItem(item)),
        });
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );

  server.registerTool(
    "update_backlog_item",
    {
      title: "Update a Backlog Item",
      description:
        "Update title, summary, stage, or supersession with optimistic revision. " +
        "Any declared stage transition is allowed; stale writes change nothing.",
      inputSchema: updateBacklogItemShape,
      outputSchema: updateBacklogItemOutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input: UpdateBacklogItemInput): Promise<ToolResult> => {
      try {
        const result = await getEvidenceWriteStore().updateBacklogItem(input);
        const indexing =
          result.outcome === "applied"
            ? await indexBacklogItem(result.item)
            : {};
        return jsonResult({
          ...result,
          ...indexing,
          ...(result.outcome === "stale"
            ? {
                note: `Expected revision is stale; current revision is ${result.current_revision}.`,
              }
            : {}),
        });
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );

  server.registerTool(
    "set_backlog_item_links",
    {
      title: "Replace Backlog Item evidence and targets",
      description:
        "Atomically replace an item's Observation links and Story/AC targets by " +
        "stable references. Semantic fields are never copied into the Backlog Item.",
      inputSchema: setBacklogItemLinksSchema,
      outputSchema: setBacklogItemLinksOutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input: SetBacklogItemLinksInput): Promise<ToolResult> => {
      try {
        const result = await getEvidenceWriteStore().setBacklogItemLinks({
          stable_id: input.stable_id,
          expected_revision: input.expected_revision,
          links: {
            observation_ids: input.observation_ids,
            stories: input.stories,
            acceptance_criteria: input.acceptance_criteria,
          },
        });
        return jsonResult({
          ...result,
          ...(result.outcome === "stale"
            ? {
                note: `Expected revision is stale; current revision is ${result.current_revision}.`,
              }
            : {}),
        });
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );
}
