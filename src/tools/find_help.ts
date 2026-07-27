/**
 * find_help — "which help-center article explains this?". Hybrid search over the
 * help corpus (title + summary + headings): optional semantic (gte-small vector)
 * matches first, then always-on lexical (Postgres full-text) matches backfill —
 * so it works with no embedding provider configured. Independent of whether a
 * user story links the article. Returns ranked articles with the stories each
 * one documents.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../config.js";
import { getEmbedder } from "../embeddings.js";
import { getStore } from "../store.js";
import { findHelpShape, findHelpOutputShape, type FindHelpInput } from "../schemas.js";
import type { HelpHit } from "../types.js";
import { jsonResult, errorResult, formatError, type ToolResult } from "./shared.js";

const DESCRIPTION = `Find the help-center ARTICLES that best explain a topic, by semantic similarity. Use when you want end-user documentation itself — not the product stories.

Searches the help corpus directly (each article's title + summary + headings), so it finds relevant docs even for features no user story links yet. Hybrid retrieval: semantic (vector) matches when an embedding provider is configured, plus always-on lexical (full-text keyword) matches — so keyword hits surface even with no embeddings. No code/entity overlap.

Args:
  - query (string, required): what the user wants to do or understand, e.g. "invite a teammate to a project".
  - product_area (string[], optional): restrict to product-area values in the imported knowledge base.
  - audience (string[], optional): restrict to audience values in the imported knowledge base.
  - limit (int 1-20, default 5).

Returns ranked articles (title, summary, url, headings) each with the stories it documents (linked_story_keys); see the output schema for the full shape. These are POINTERS + previews, not full bodies — to read an article's content, pass its article_slug to get_help_article.

Notes:
  - score is cosine similarity (0..1) for semantic hits, or a normalized full-text rank (0..1) for lexical-only hits. Semantic hits are gated by min_score (~0.8, gte-small's high baseline); lexical hits by a separate lower floor. An empty result (a top-level "note") means no clearly-matching article — not an error.
  - For "what product stories touch X" use find_related / query_stories instead; for the docs attached to a specific story you already have, query_stories returns help_articles inline.

Examples:
  - find_help(query="invite a teammate", product_area=["projects"]) -> project access articles.
  - find_help(query="update a payment method", product_area=["billing"]) -> billing articles.`;

/** Filter by min-score, sort by score desc, and append each not-yet-seen
 *  article to `out` (dedupe by slug). Preserves first-source-wins ordering. */
function appendUnseen(hits: HelpHit[], minScore: number, seen: Set<string>, out: HelpHit[]): void {
  for (const h of hits.filter((h) => h.score >= minScore).sort((a, b) => b.score - a.score)) {
    if (!seen.has(h.article_slug)) {
      seen.add(h.article_slug);
      out.push(h);
    }
  }
}

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
        // Guard only the embed() call: with no provider configured (or an embed
        // failure), degrade to the always-on lexical path. A downstream
        // matchHelpArticles (DB) error is NOT swallowed — it propagates to the
        // outer catch rather than masquerading as an empty result.
        let vector: number[] | undefined;
        try {
          vector = await embedder.embed(query);
        } catch {
          vector = undefined;
        }
        const knnHitsP = vector
          ? store.matchHelpArticles({
              embedding: vector,
              poolSize: config.helpCandidatePoolSize,
              productArea: product_area,
              audience,
            })
          : Promise.resolve<HelpHit[]>([]);
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
        appendUnseen(knnHits, config.helpMinScore, seen, ordered);
        appendUnseen(lexicalHits, config.helpMinLexicalScore, seen, ordered);
        const results = ordered
          .slice(0, limit)
          .map((h) => ({ ...h, score: Math.round(h.score * 1000) / 1000 }));

        const payload: Record<string, unknown> = {
          query: {
            min_score: config.helpMinScore,
            min_lexical_score: config.helpMinLexicalScore,
            candidate_pool_size: config.helpCandidatePoolSize,
            ...(product_area?.length ? { product_area } : {}),
            ...(audience?.length ? { audience } : {}),
          },
          results,
        };
        if (results.length === 0) {
          payload.note =
            `No help article cleared the semantic (min_score=${config.helpMinScore}) or lexical ` +
            `(min_lexical_score=${config.helpMinLexicalScore}) threshold. ` +
            `We likely have no article on this yet — this empty result is intentional, not an error.`;
        }
        return jsonResult(payload);
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );
}
