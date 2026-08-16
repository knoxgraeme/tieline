import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createPlanningStoryOutputShape,
  createPlanningStoryShape,
  updatePlanningStoryOutputShape,
  updatePlanningStoryShape,
  type CreatePlanningStoryToolInput,
  type UpdatePlanningStoryToolInput,
} from "./schemas/planning-stories.js";
import { getSemanticMatcher } from "../semantic-matching.js";
import { getPlanningWriteStore } from "../store.js";
import {
  errorResult,
  formatError,
  jsonResult,
  type ToolResult,
} from "./shared.js";

async function indexResult(
  story: Parameters<
    ReturnType<typeof getSemanticMatcher>["indexPlanningStory"]
  >[0]
): Promise<{ indexing_error?: string; note?: string }> {
  try {
    await getSemanticMatcher().indexPlanningStory(story);
    return {};
  } catch (error) {
    return {
      indexing_error: formatError(error),
      note:
        "The planning Story was committed and remains available for semantic indexing retry.",
    };
  }
}

export function registerPlanningStoryTools(server: McpServer): void {
  server.registerTool(
    "create_planning_story",
    {
      title: "Create a planning Story and ACs",
      description:
        "Search before creating a Postgres-managed backlog Story. Planning records may be incomplete while shaped; repository materialization must satisfy the accepted YAML contract.",
      inputSchema: createPlanningStoryShape,
      outputSchema: createPlanningStoryOutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input: CreatePlanningStoryToolInput): Promise<ToolResult> => {
      try {
        const candidates =
          await getSemanticMatcher().advisePlanningCreate({
            title: input.title,
            summary: [
              input.actor ? `As a ${input.actor}` : null,
              input.goal ? `I want to ${input.goal}` : null,
              input.benefit ? `so that ${input.benefit}` : null,
              ...input.acceptance_criteria.flatMap((criterion) =>
                criterion.criterion ? [criterion.criterion] : []
              ),
            ]
              .filter(Boolean)
              .join("\n"),
          });
        const selected = input.selected_suggestion_id
          ? candidates.find(
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
              "No planning Story was created; the caller selected an existing semantic record.",
          });
        }
        if (!input.continue_without_match) {
          return jsonResult({
            outcome: "match_review_required",
            candidates,
            note:
              candidates.length > 0
                ? "Select an existing record or explicitly continue with a new planning Story."
                : "No credible match was found; explicitly continue before creating a new planning Story.",
          });
        }
        const story =
          await getPlanningWriteStore().createPlanningStory({
            repository: input.repository,
            capability_stable_id: input.capability_stable_id,
            stable_id: input.stable_id,
            title: input.title,
            actor: input.actor,
            goal: input.goal,
            benefit: input.benefit,
            aliases: input.aliases,
            applies_to: input.applies_to,
            motivated_by: input.motivated_by,
            acceptance_criteria: input.acceptance_criteria,
          });
        return jsonResult({
          outcome: "created",
          story,
          ...(await indexResult(story)),
        });
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );

  server.registerTool(
    "update_planning_story",
    {
      title: "Update a planning Story and ACs",
      description:
        "Update only a Postgres-managed backlog Story using optimistic revision. Repository-owned definitions can be changed only through YAML and a PR.",
      inputSchema: updatePlanningStoryShape,
      outputSchema: updatePlanningStoryOutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input: UpdatePlanningStoryToolInput): Promise<ToolResult> => {
      try {
        const result =
          await getPlanningWriteStore().updatePlanningStory(input);
        if (result.outcome !== "applied") return jsonResult(result);
        return jsonResult({
          ...result,
          ...(await indexResult(result.story)),
        });
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );
}
