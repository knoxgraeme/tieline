import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getEmbedder } from "../embeddings.js";
import {
  groupSemanticHitsAroundAcceptanceCriteria,
  rankSemanticDocuments,
} from "../ranking.js";
import {
  findRelatedOutputShape,
  findRelatedShape,
  type FindRelatedInput,
} from "../schemas.js";
import { getReadStore } from "../store.js";
import {
  errorResult,
  formatError,
  jsonResult,
  type ToolResult,
} from "./shared.js";

const DESCRIPTION = `Find semantically related business context at Story, AC, Scenario, Backlog Item, or Observation level.

The selected retrieval profile applies authority and lifecycle predicates before ranking. Optional filters can only narrow that profile. Results identify the matched level and Story/AC ancestry; lifecycle and authority are returned as state metadata and never embedded as semantic prose.`;

export function registerFindRelated(server: McpServer): void {
  server.registerTool(
    "find_related",
    {
      title: "Find related business context",
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
        const store = getReadStore();
        const profile = await store.resolveRetrievalProfile(input.profile);
        const embedding = await getEmbedder().embed(input.context);
        const candidates = await store.searchSemantic({
          query: input.context,
          embedding,
          profile,
          filters: {
            authorities: input.authority,
            lifecycles: input.lifecycle,
            repositories: input.repository,
            applicability: input.applicability,
            include_inactive: input.include_inactive,
          },
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
          authority: hit.metadata.authority,
          lifecycle: hit.metadata.lifecycle,
          backlog_stage: hit.metadata.backlog_stage,
          repository: hit.metadata.repository,
          coverage: hit.metadata.coverage ?? null,
          freshness: hit.metadata.freshness ?? "not_applicable",
          canonical_text: hit.canonical_text,
        }));
        return jsonResult({
          query: {
            profile: profile.key,
            profile_version: profile.version,
            filters: {
              authority: input.authority,
              lifecycle: input.lifecycle,
              repository: input.repository,
              applicability: input.applicability,
              include_inactive: input.include_inactive,
            },
          },
          results,
          ...(results.length === 0
            ? {
                note:
                  "No records matched the selected profile and narrowing filters.",
              }
            : {}),
        });
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );
}
