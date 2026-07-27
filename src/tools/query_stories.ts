/**
 * query_stories — "things *matching* these attributes". Exact, complete,
 * deterministic filter/aggregate. A guarded SELECT: whitelisted filters,
 * read-only, server-enforced LIMIT. The SQL is ours; only the values are the agent's.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getStore } from "../store.js";
import { queryStoriesShape, queryStoriesOutputShape, type QueryStoriesInput } from "../schemas.js";
import { jsonResult, errorResult, formatError, type ToolResult } from "./shared.js";

const DESCRIPTION = `Exact, complete, deterministic lookup over the user-story corpus via whitelisted, AND-combined filters (a guarded read-only SELECT — never raw SQL).

Use for precise attribute questions: "what's in_progress", "what touches InviteMember.ts", "everything tagged invitation", "count stories per section".

Args (all optional, AND-combined — pass at the TOP LEVEL, not nested):
  - status: string[]      — any of: production, qa, in_progress, in_review, cancelled, idea, feature_request
  - section_key: string[] — any of these section keys
  - story_key: string[]   — fetch these exact stories by key (this is how you fetch a story by id)
  - actor: string[]       — any of these actors
  - entity_slug: string   — stories tagged with this exact slug
  - code_path: string     — stories touching this exact code path
  - product_area: string[] — stories with a linked help article in any of these product areas
  - audience: string[]    — stories whose help articles target any of these audiences
  - help_relationship: string[] — stories with a help link of any of these types (primary, supporting, reference, troubleshooting)
  - help_article_slug: string — reverse lookup: stories linked to this exact help article slug
  - has_help: bool        — true = only stories with help articles; false = only stories without
  - group_by ('section'|'status'|'actor'|'product_area'|null): if set, return grouped counts instead of records.
  - limit (int 1-200, default 25): max records when not grouping.

Returns either records (mode='records') or grouped counts (mode='grouped'); see the output schema for the full shape. Records carry their linked help_articles (capped at 5, primary-first; help_article_count is the true total) and their linked feature_requests ({id,title,link_type}). Key semantics:
  - Every response echoes "applied_filters" — exactly what the server filtered on — so an unfiltered fallback can never be mistaken for a filtered result. Always check it.
  - Empty results carry a top-level "note" (same convention as the other verbs): zero matches is a complete, correct answer, not an error.
  - When an exact entity_slug/code_path is the likely culprit, the response ALSO sets "no_match": true and "suggestions" with the closest existing values. Suggestions are NOT results (total stays 0) — pick an exact value and re-query.

Examples:
  - query_stories(status=["in_progress"], group_by="section") -> counts per section.
  - query_stories(code_path="src/projects/InviteMember.ts") -> every story touching that file.
  - query_stories(entity_slug="invitation") -> everything tagged invitation.
  - query_stories(product_area=["billing"], group_by="product_area") -> story coverage per help product area.
  - query_stories(help_article_slug="invite-a-teammate") -> stories that article documents.
  - query_stories(has_help=false, status=["production"]) -> shipped stories still missing help docs.

Don't use when: you only have free text/code (use find_related) or a key to expand entanglement from (use find_crossover).`;

export function registerQueryStories(server: McpServer): void {
  server.registerTool(
    "query_stories",
    {
      title: "Query stories by attributes",
      description: DESCRIPTION,
      inputSchema: queryStoriesShape,
      outputSchema: queryStoriesOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input: QueryStoriesInput): Promise<ToolResult> => {
      try {
        // Merge top-level filters (preferred) with the deprecated nested form.
        // Top-level wins on conflict; either shape works, neither is dropped.
        const nested = input.filters ?? {};
        const filters = {
          status: input.status ?? nested.status,
          section_key: input.section_key ?? nested.section_key,
          story_key: input.story_key ?? nested.story_key,
          actor: input.actor ?? nested.actor,
          entity_slug: input.entity_slug ?? nested.entity_slug,
          code_path: input.code_path ?? nested.code_path,
          product_area: input.product_area ?? nested.product_area,
          audience: input.audience ?? nested.audience,
          help_relationship: input.help_relationship ?? nested.help_relationship,
          help_article_slug: input.help_article_slug ?? nested.help_article_slug,
          has_help: input.has_help ?? nested.has_help,
          keyword: input.keyword ?? nested.keyword,
        };

        // Echo exactly what the server filtered on (omitting unset keys), so a
        // caller can never mistake an unfiltered fallback for a filtered result.
        const appliedFilters: Record<string, unknown> = {};
        if (filters.status?.length) appliedFilters.status = filters.status;
        if (filters.section_key?.length) appliedFilters.section_key = filters.section_key;
        if (filters.story_key?.length) appliedFilters.story_key = filters.story_key;
        if (filters.actor?.length) appliedFilters.actor = filters.actor;
        if (filters.entity_slug) appliedFilters.entity_slug = filters.entity_slug;
        if (filters.code_path) appliedFilters.code_path = filters.code_path;
        if (filters.product_area?.length) appliedFilters.product_area = filters.product_area;
        if (filters.audience?.length) appliedFilters.audience = filters.audience;
        if (filters.help_relationship?.length)
          appliedFilters.help_relationship = filters.help_relationship;
        if (filters.help_article_slug) appliedFilters.help_article_slug = filters.help_article_slug;
        if (filters.has_help !== undefined) appliedFilters.has_help = filters.has_help;
        if (filters.keyword?.trim()) appliedFilters.keyword = filters.keyword.trim();

        const store = getStore();
        const result = await store.queryStories({
          filters,
          groupBy: input.group_by ?? null,
          limit: input.limit,
        });

        if (result.mode === "grouped") {
          const grouped: Record<string, unknown> = {
            mode: "grouped",
            group_by: input.group_by,
            applied_filters: appliedFilters,
            groups: result.groups,
          };
          // Consistent empty-result convention (see find_related/find_help/
          // find_crossover): a top-level `note` whenever there is nothing to show.
          if (result.groups.length === 0) {
            grouped.note =
              "No stories matched these filters, so there is nothing to group. This empty " +
              "result is intentional, not an error.";
          }
          return jsonResult(grouped);
        }

        // Zero-result convention: always carry a top-level `note` (consistent with
        // the other verbs). For exact path/slug misses additionally surface the
        // closest existing values via `no_match` + `suggestions` so the miss is
        // recoverable — those are suggestions, NOT results (total stays 0).
        let noMatchExtras: Record<string, unknown> = {};
        if (result.total === 0) {
          const isExactMiss = Boolean(filters.code_path || filters.entity_slug);
          if (isExactMiss) {
            const suggestions = await store.suggestVocabulary({
              codePath: filters.code_path,
              entitySlug: filters.entity_slug,
            });
            const hasAny = Boolean(suggestions.code_path || suggestions.entity_slug);
            noMatchExtras = {
              no_match: true,
              note:
                "No stories matched these filters. This empty result is intentional, not an " +
                "error — but the code_path/entity_slug may be slightly off; see suggestions.",
              suggestions: {
                note: hasAny
                  ? "Closest existing values — re-query with an exact one."
                  : "No similar existing values were found. Check schema://taxonomy for the valid vocabulary.",
                ...suggestions,
              },
            };
          } else {
            noMatchExtras = {
              no_match: true,
              note:
                "No stories matched these filters. This is a complete, correct answer (the corpus " +
                "has none) — not an error. Check schema://taxonomy if you expected a match.",
            };
          }
        }

        return jsonResult({
          mode: "records",
          group_by: null,
          applied_filters: appliedFilters,
          total: result.total,
          count: result.records.length,
          truncated: result.total > result.records.length,
          records: result.records,
          ...noMatchExtras,
        });
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );
}
