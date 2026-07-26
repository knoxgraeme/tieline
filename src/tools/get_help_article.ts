/**
 * get_help_article — fetch the FULL body of help-center articles by exact slug.
 * The "fetch" half of the search-then-fetch split: find_help / query_stories /
 * find_related return cheap article pointers (slug + summary + url); call this
 * only for the article(s) you actually need to read, to avoid paying body tokens
 * for everything.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getStore } from "../store.js";
import { getHelpArticleShape, getHelpArticleOutputShape, type GetHelpArticleInput } from "../schemas.js";
import { jsonResult, errorResult, formatError, type ToolResult } from "./shared.js";

const DESCRIPTION = `Fetch the FULL markdown body (+ metadata) of one or more help-center articles by exact slug. This is the "fetch" step after a "search" step.

Use AFTER find_help / query_stories / find_related hand you an article_slug and you need to actually read the content — not before. Those tools return cheap pointers (slug, title, summary, url); fetching the body costs real tokens, so pull only the slugs you've decided you need.

Args (provide at least one):
  - article_slug (string): a single slug, e.g. 'adding-a-cookie-banner-360034018992'.
  - article_slugs (string[], 1-10): several at once. Combined with article_slug if both given.

Returns the requested articles (in request order) plus any slugs that didn't match; see the output schema for the full shape. Each article includes the full 'markdown' body, 'headings', 'tags', 'url', and product_area/audience.

Notes:
  - Unknown slugs come back in "not_found" (not an error) — re-check the slug via find_help / schema://taxonomy.
  - Large bodies: if the combined response exceeds the size cap it is trimmed (a top-level "note" says so); request fewer slugs.

Examples:
  - get_help_article(article_slug="how-do-i-turn-store-on-115003479411") -> that article's full body.
  - get_help_article(article_slugs=["downloads-115003810212","favorites-..."]) -> both bodies in one call.`;

export function registerGetHelpArticle(server: McpServer): void {
  server.registerTool(
    "get_help_article",
    {
      title: "Get full help article",
      description: DESCRIPTION,
      inputSchema: getHelpArticleShape,
      outputSchema: getHelpArticleOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input: GetHelpArticleInput): Promise<ToolResult> => {
      try {
        // Merge the single + array forms, dedupe, preserve first-seen order.
        const requested = [
          ...(input.article_slug ? [input.article_slug] : []),
          ...(input.article_slugs ?? []),
        ];
        const slugs = [...new Set(requested)];
        if (slugs.length === 0) {
          return errorResult("Provide article_slug and/or article_slugs.");
        }

        const { articles, not_found } = await getStore().getHelpArticles(slugs);

        const payload: Record<string, unknown> = { articles, not_found };
        if (articles.length === 0) {
          payload.note =
            "None of the requested slugs matched a help article — see not_found. " +
            "Re-check the slug via find_help or schema://taxonomy. This is not an error.";
        }
        return jsonResult(payload);
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );
}
