/**
 * find_help — "which help-center article explains this?". Pure semantic search
 * over the help corpus (title + summary + headings embedded with gte-small),
 * independent of whether a user story links the article. Returns ranked articles
 * with the stories each one documents.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../config.js";
import { getEmbedder } from "../embeddings.js";
import { getStore } from "../store.js";
import { findHelpShape, findHelpOutputShape, type FindHelpInput } from "../schemas.js";
import type { HelpHit } from "../types.js";
import { jsonResult, errorResult, formatError, type ToolResult } from "./shared.js";

const DESCRIPTION = `Find the help-center ARTICLES that best explain a topic, by semantic similarity. Use when you want end-user documentation itself — not the product stories.

Searches the help corpus directly (each article's title + summary + headings are embedded), so it finds relevant docs even for features no user story links yet. Pure vector match — no code/entity overlap.

Args:
  - query (string, required): what the user wants to do or understand, e.g. "invite a teammate to a project".
  - product_area (string[], optional): restrict to product-area values in the imported knowledge base.
  - audience (string[], optional): restrict to audience values in the imported knowledge base.
  - limit (int 1-20, default 5).

Returns ranked articles (title, summary, url, headings) each with the stories it documents (linked_story_keys); see the output schema for the full shape. These are POINTERS + previews, not full bodies — to read an article's content, pass its article_slug to get_help_article.

Notes:
  - score is cosine similarity (0..1). gte-small runs a high baseline, so a min_score gate (~0.8) filters off-topic noise; an empty result (a top-level "note") means no clearly-matching article — not an error.
  - For "what product stories touch X" use find_related / query_stories instead; for the docs attached to a specific story you already have, query_stories returns help_articles inline.

Examples:
  - find_help(query="invite a teammate", product_area=["projects"]) -> project access articles.
  - find_help(query="update a payment method", product_area=["billing"]) -> billing articles.`;

export function registerFindHelp(server: McpServer): void {
  server.registerTool(
    "find_help",
    {
      title: "Find help-center articles",
      description: DESCRIPTION,
      inputSchema: findHelpShape,
      outputSchema: findHelpOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input: FindHelpInput): Promise<ToolResult> => {
      try {
        const { query, product_area, audience, limit } = input;

        const store = getStore();
        const embedder = getEmbedder();
        // KNN needs embeddings; if none are configured (or embedding fails), it
        // degrades to empty and the always-on lexical path carries the result.
        const knnHitsP = embedder
          .embed(query)
          .then((vector) =>
            store.matchHelpArticles({
              embedding: vector,
              poolSize: config.helpCandidatePoolSize,
              productArea: product_area,
              audience,
            })
          )
          .catch(() => []);
        const lexicalHitsP = store.lexicalHelpArticles({
          query,
          poolSize: config.helpCandidatePoolSize,
          productArea: product_area,
          audience,
        });
        const [knnHits, lexicalHits] = await Promise.all([knnHitsP, lexicalHitsP]);

        // Semantic hits (cosine >= helpMinScore) first, then lexical hits
        // (ts_rank >= helpMinLexicalScore) backfilling any article not already
        // surfaced — preserves semantic-first ordering when embeddings are good
        // while guaranteeing results when they are absent.
        const seen = new Set<string>();
        const ordered: HelpHit[] = [];
        for (const h of knnHits
          .filter((h) => h.score >= config.helpMinScore)
          .sort((a, b) => b.score - a.score)) {
          if (!seen.has(h.article_slug)) {
            seen.add(h.article_slug);
            ordered.push(h);
          }
        }
        for (const h of lexicalHits
          .filter((h) => h.score >= config.helpMinLexicalScore)
          .sort((a, b) => b.score - a.score)) {
          if (!seen.has(h.article_slug)) {
            seen.add(h.article_slug);
            ordered.push(h);
          }
        }
        const results = ordered
          .slice(0, limit)
          .map((h) => ({ ...h, score: Math.round(h.score * 1000) / 1000 }));

        const payload: Record<string, unknown> = {
          query: {
            min_score: config.helpMinScore,
            candidate_pool_size: config.helpCandidatePoolSize,
            ...(product_area?.length ? { product_area } : {}),
            ...(audience?.length ? { audience } : {}),
          },
          results,
        };
        if (results.length === 0) {
          payload.note =
            `No help article cleared the relevance threshold (min_score=${config.helpMinScore}). ` +
            `We likely have no article on this yet — this empty result is intentional, not an error.`;
        }
        return jsonResult(payload);
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );
}
