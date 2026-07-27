/**
 * find_related — "things *like* this". Primary entry point.
 * Free-text or code in, ranked areas/stories out.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../config.js";
import { getEmbedder } from "../embeddings.js";
import { getStore } from "../store.js";
import {
  detectCode,
  extractQueryEntities,
  extractQueryPaths,
  scoreCandidates,
  toAreaHits,
  toStoryHits,
} from "../ranking.js";
import { findRelatedShape, findRelatedOutputShape, type FindRelatedInput } from "../schemas.js";
import { jsonResult, errorResult, formatError, type ToolResult } from "./shared.js";

const DESCRIPTION = `Retrieve existing product areas/stories that are conceptually or structurally LIKE a piece of context. This is the primary entry point — start here.

Accepts free-form prose OR pasted code/diff and returns a ranked, self-describing slice of the user-story knowledge graph (keys, story text, code paths, and a "why"), so you can act without knowing our taxonomy in advance.

Args:
  - context (string, required): what you're working on — a task description, feature concept, competitor blurb, or a code snippet/diff.
  - mode ('semantic'|'structural'|'blended', default 'blended'): 'semantic' = vector similarity only; 'structural' = lean on code-path overlap; 'blended' = fuse vector + entity/path overlap. If you pass 'blended' and the context looks like code, the server auto-forks to 'structural'.
  - scope ('areas'|'stories', default 'areas'): return ranked sections (each with matched stories) or a flat ranked story list.
  - limit (int 1-20, default 5).

Returns ranked sections (scope='areas', each with matched stories) or a flat ranked story list (scope='stories'); see the output schema for the full shape. Each result self-describes with a "why" (shared entities/paths) and carries the story's linked help_articles (the docs that explain that feature).

Notes:
  - score is an absolute 0..1 relevance blend, comparable across calls (it gates min_score); score_breakdown holds the pool-normalized per-signal strengths. You can't infer either from the raw number — they're documented here, not in the result.
  - Empty results (a top-level "note") are correct and intentional when we genuinely lack the pattern — it does NOT force five matches; don't retry with looser intent.

Examples:
  - Use when: "invite a teammate to a project" -> nearest existing areas.
  - Use when: pasting a component diff -> areas sharing those code paths.
  - Don't use when: you already have a section/story key and want what it's entangled with (use find_crossover) or exact attribute filters (use query_stories).`;

export function registerFindRelated(server: McpServer): void {
  server.registerTool(
    "find_related",
    {
      title: "Find related areas/stories",
      description: DESCRIPTION,
      inputSchema: findRelatedShape,
      outputSchema: findRelatedOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input: FindRelatedInput): Promise<ToolResult> => {
      try {
        const { context, mode, scope, limit } = input;

        const isCode = detectCode(context);
        // Auto-fork: a default 'blended' call on code leans structural.
        const modeUsed = mode === "blended" && isCode ? "structural" : mode;
        const weights = config.weights[modeUsed];

        const store = getStore();
        const df = await store.getDocFrequencies();
        const queryEntities = new Set(extractQueryEntities(context, df.entity.keys()));
        const queryPaths = new Set(extractQueryPaths(context));

        const canUseExactOnly =
          modeUsed === "structural" && (queryEntities.size > 0 || queryPaths.size > 0);
        // Guard only the embed() call: if no provider is configured (or it fails),
        // degrade to the always-on lexical + structural sources rather than erroring
        // the whole tool. A downstream store error still propagates to the outer catch.
        let vector: number[] | undefined;
        if (!canUseExactOnly) {
          try {
            vector = await getEmbedder().embed(context);
          } catch {
            vector = undefined;
          }
        }
        const [semanticCandidates, exactStructuralCandidates, lexical] = await Promise.all([
          vector ? store.knnCandidates(vector, config.candidatePoolSize) : Promise.resolve([]),
          store.structuralCandidates({
            embedding: vector,
            entitySlugs: [...queryEntities],
            codePaths: [...queryPaths],
            poolSize: config.candidatePoolSize,
          }),
          // Always-on lexical source — needs no embedding provider.
          store.lexicalCandidates({
            query: context,
            embedding: vector,
            poolSize: config.candidatePoolSize,
          }),
        ]);
        // Union all three sources by story id. Semantic and structural rows are
        // identical for a shared story (same cosine, same footprint), so the
        // first-seen row wins. Lexical is the exception: it carries the one field
        // the others lack, so merge its `lexical` score onto an existing row.
        const byId = new Map(semanticCandidates.map((candidate) => [candidate.id, candidate]));
        for (const candidate of exactStructuralCandidates) {
          byId.set(candidate.id, byId.get(candidate.id) ?? candidate);
        }
        for (const candidate of lexical) {
          const existing = byId.get(candidate.id);
          byId.set(candidate.id, existing ? { ...existing, lexical: candidate.lexical } : candidate);
        }
        const candidates = [...byId.values()];

        const scored = scoreCandidates({
          candidates,
          queryEntities,
          queryPaths,
          df,
          weights,
          rrfK: config.rrfK,
        });

        const results =
          scope === "stories"
            ? toStoryHits(
                scored,
                {
                  minVector: config.findRelatedMinVectorScore,
                  minStructural: config.findRelatedMinStructuralScore,
                  // Gate lexical by the mode's own weight: semantic mode (lexical
                  // weight 0) must not admit lexical-only hits — it is vector-only
                  // by contract. Infinity = never qualifies on lexical alone.
                  minLexical: (weights.lexical ?? 0) > 0 ? config.findRelatedMinLexicalScore : Infinity,
                  allowStructural: modeUsed !== "semantic",
                },
                limit
              )
            : toAreaHits(
                scored,
                {
                  minVector: config.findRelatedMinVectorScore,
                  minStructural: config.findRelatedMinStructuralScore,
                  // Gate lexical by the mode's own weight: semantic mode (lexical
                  // weight 0) must not admit lexical-only hits — it is vector-only
                  // by contract. Infinity = never qualifies on lexical alone.
                  minLexical: (weights.lexical ?? 0) > 0 ? config.findRelatedMinLexicalScore : Infinity,
                  allowStructural: modeUsed !== "semantic",
                },
                limit
              );

        const payload: Record<string, unknown> = {
          query: {
            mode_requested: mode,
            mode_used: modeUsed,
            scope,
            detected_code: isCode,
            candidate_pool_size: config.candidatePoolSize,
            semantic_candidates: semanticCandidates.length,
            structural_candidates: exactStructuralCandidates.length,
            lexical_candidates: lexical.length,
            candidate_union_size: candidates.length,
            embedding_used: Boolean(vector),
            min_vector_score: config.findRelatedMinVectorScore,
            min_structural_score: config.findRelatedMinStructuralScore,
            min_lexical_score: config.findRelatedMinLexicalScore,
            query_entities: [...queryEntities],
            query_code_paths: [...queryPaths],
          },
          results,
        };
        if (results.length === 0) {
          payload.note =
            `No stored stories cleared the semantic (min=${config.findRelatedMinVectorScore}), ` +
            `lexical (min=${config.findRelatedMinLexicalScore}), or structural ` +
            `(min=${config.findRelatedMinStructuralScore}) qualification gate. ` +
            `We likely don't have this pattern yet — this empty result is intentional, not an error.`;
        }
        return jsonResult(payload);
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );
}
