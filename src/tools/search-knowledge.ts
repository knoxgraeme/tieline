import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { optionalQueryEmbedding } from "../embeddings.js";
import {
  groupSemanticHitsAroundAcceptanceCriteria,
  rankSemanticDocuments,
} from "../ranking.js";
import {
  searchKnowledgeOutputShape,
  searchKnowledgeShape,
  type SearchKnowledgeInput,
} from "../schemas.js";
import type { SemanticSearchAnchor } from "../domain/semantic-search-store.js";
import type { RankedSemanticDocument } from "../ranking.js";
import { getReadStore } from "../store.js";
import {
  errorResult,
  formatError,
  jsonResult,
  type ToolResult,
} from "./shared.js";

function metadataString(
  metadata: Record<string, unknown>,
  key: string
): string | null {
  return typeof metadata[key] === "string"
    ? (metadata[key] as string)
    : null;
}

function resultContextAnchor(
  hit: RankedSemanticDocument
): SemanticSearchAnchor | undefined {
  if (hit.entity_kind === "observation") {
    return { kind: "observation", id: hit.entity_id };
  }
  if (hit.entity_kind === "backlog_item") {
    const stableId = metadataString(hit.metadata, "backlog_stable_id");
    return stableId
      ? { kind: "backlog_item", stable_id: stableId }
      : undefined;
  }
  const repository = metadataString(hit.metadata, "repository");
  if (hit.entity_kind === "story") {
    return repository && hit.story_stable_id
      ? {
          kind: "story",
          repository,
          stable_id: hit.story_stable_id,
        }
      : undefined;
  }
  return repository && hit.acceptance_criterion_stable_id
    ? {
        kind: "acceptance_criterion",
        repository,
        stable_id: hit.acceptance_criterion_stable_id,
      }
    : undefined;
}

export function registerSearchKnowledge(server: McpServer): void {
  server.registerTool(
    "search_knowledge",
    {
      title: "Search the Tieline knowledge graph",
      description:
        "Cross-type semantic search over Stories, ACs, Scenarios, Backlog Items, and sanitized Observations. A retrieval profile is required; caller filters can only narrow it. Optional typed anchors and code, test, or help artifacts rerank the authorized candidate set without confirming relationships. Every result returns explicit state, ranking features, and a reusable context anchor when available.",
      inputSchema: searchKnowledgeShape,
      outputSchema: searchKnowledgeOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input: SearchKnowledgeInput): Promise<ToolResult> => {
      try {
        const store = getReadStore();
        const profile = await store.resolveRetrievalProfile(
          input.profile,
          input.profile_version
        );
        const embedding = await optionalQueryEmbedding(input.query);
        const candidates = await store.searchSemantic({
          query: input.query,
          embedding,
          profile,
          filters: {
            document_kinds: input.document_kind,
            authorities: input.authority,
            lifecycles: input.lifecycle,
            backlog_stages: input.backlog_stage,
            repositories: input.repository,
            applicability: input.applicability,
            include_inactive: input.include_inactive,
          },
          context: input.context,
          limit: input.limit,
        });
        const ranked = groupSemanticHitsAroundAcceptanceCriteria(
          rankSemanticDocuments(candidates)
        ).slice(0, input.limit);
        const results = ranked.map((hit) => ({
          entity_kind: hit.entity_kind,
          entity_id: hit.entity_id,
          matched_level: hit.matched_level,
          story_id: hit.story_id,
          story_stable_id: hit.story_stable_id,
          acceptance_criterion_id: hit.acceptance_criterion_id,
          acceptance_criterion_stable_id:
            hit.acceptance_criterion_stable_id,
          score: hit.score,
          features: hit.features,
          why: hit.why,
          canonical_text: hit.canonical_text,
          context_anchor: resultContextAnchor(hit),
          state: {
            authority: metadataString(hit.metadata, "authority"),
            lifecycle: metadataString(hit.metadata, "lifecycle"),
            backlog_stage: metadataString(
              hit.metadata,
              "backlog_stage"
            ),
            observation_kind: metadataString(
              hit.metadata,
              "observation_kind"
            ),
            attribution_state: metadataString(
              hit.metadata,
              "attribution_state"
            ),
            active: hit.metadata.active !== false,
            coverage: hit.metadata.coverage ?? null,
            freshness:
              metadataString(hit.metadata, "freshness") ??
              "not_applicable",
          },
        }));
        return jsonResult({
          profile: { key: profile.key, version: profile.version },
          applied_filters: {
            document_kind: input.document_kind,
            authority: input.authority,
            lifecycle: input.lifecycle,
            backlog_stage: input.backlog_stage,
            repository: input.repository,
            applicability: input.applicability,
            include_inactive: input.include_inactive,
          },
          signals: {
            lexical: "applied",
            embedding: embedding ? "applied" : "unavailable",
          },
          results,
          ...(results.length === 0
            ? {
                note:
                  "No authorized record matched the profile and narrowing filters.",
              }
            : {}),
        });
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );
}
