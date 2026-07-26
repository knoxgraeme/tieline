import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../config.js";
import { getStore } from "../store.js";
import { errorResult, formatError, jsonResult, type ToolResult } from "./shared.js";

const inputShape = {
  story_key: z.string().min(1).optional(),
  article_slug: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).default(10),
  min_score: z.number().min(0).max(1).optional(),
};
const inputSchema = z
  .object(inputShape)
  .refine((value) => Boolean(value.story_key) !== Boolean(value.article_slug), {
    message: "Provide exactly one of story_key or article_slug.",
  });

const outputSchema = {
  direction: z.enum(["story_to_articles", "article_to_stories"]).nullable(),
  source_key: z.string(),
  min_score: z.number(),
  suggestions: z.array(
    z.object({
      story_key: z.string(),
      story_title: z.string(),
      article_slug: z.string(),
      article_title: z.string(),
      score: z.number(),
      already_linked: z.boolean(),
    })
  ),
  note: z.string().optional(),
};

export function registerSuggestStoryHelpLinks(server: McpServer): void {
  server.registerTool(
    "suggest_story_help_links",
    {
      title: "Suggest story/help links",
      description:
        "Read-only semantic match between one current story and KB articles, or one article and current stories. It never creates links; review suggestions and use update_story_relationships to accept one.",
      inputSchema: inputShape,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input: z.infer<typeof inputSchema>): Promise<ToolResult> => {
      try {
        const parsed = inputSchema.parse(input);
        const minScore = parsed.min_score ?? config.helpMinScore;
        const result = await getStore().suggestStoryHelpLinks({
          storyKey: parsed.story_key,
          articleSlug: parsed.article_slug,
          limit: parsed.limit,
        });
        const sourceKey = parsed.story_key ?? parsed.article_slug!;
        if (!result) {
          return jsonResult({
            direction: null,
            source_key: sourceKey,
            min_score: minScore,
            suggestions: [],
            note: "The source story/article was not found.",
          });
        }
        const suggestions = result.suggestions
          .filter((suggestion) => suggestion.score >= minScore)
          .map((suggestion) => ({ ...suggestion, score: Math.round(suggestion.score * 1000) / 1000 }));
        return jsonResult({
          direction: result.direction,
          source_key: result.source_key,
          min_score: minScore,
          suggestions,
          ...(suggestions.length === 0 ? { note: "No candidate cleared the relevance threshold." } : {}),
        });
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );
}
