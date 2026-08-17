import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { optionalQueryEmbedding } from "../embeddings.js";
import {
  groupSemanticHitsAroundAcceptanceCriteria,
  rankSemanticDocuments,
  type RankedSemanticDocument,
  type SemanticDocumentCandidate,
} from "../ranking.js";
import {
  searchKnowledgeOutputShape,
  searchKnowledgeShape,
  type SearchKnowledgeInput,
} from "./schemas/search-knowledge.js";
import type {
  SearchDocumentKind,
  SemanticSearchAnchor,
} from "../domain/semantic-search-store.js";
import type { HelpSearchHit } from "../domain/knowledge-store.js";
import { isEmbeddingDocumentKind } from "../derived/embedding-documents.js";
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
  if (hit.entity_kind === "help_article") {
    const source = metadataString(hit.metadata, "help_source");
    const externalId = metadataString(hit.metadata, "help_external_id");
    return source && externalId
      ? { kind: "help_article", source, external_id: externalId }
      : undefined;
  }
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

function effectiveDocumentKinds(
  profileKinds: SearchDocumentKind[] | undefined,
  requestedKinds: SearchDocumentKind[] | undefined
): SearchDocumentKind[] | undefined {
  if (!profileKinds) return requestedKinds;
  if (!requestedKinds) return profileKinds;
  const requested = new Set(requestedKinds);
  const effective = profileKinds.filter((kind) => requested.has(kind));
  if (effective.length === 0) {
    throw new Error(
      "document kind filter does not intersect the retrieval profile."
    );
  }
  return effective;
}

function effectiveFilter<T extends string>(
  profileValues: T[] | undefined,
  requestedValues: T[] | undefined,
  label: string
): T[] | undefined {
  if (!profileValues) return requestedValues;
  if (!requestedValues) return profileValues;
  const requested = new Set(requestedValues);
  const effective = profileValues.filter((value) => requested.has(value));
  if (effective.length === 0) {
    throw new Error(
      `${label} filter does not intersect the retrieval profile.`
    );
  }
  return effective;
}

function helpArtifactOverlap(
  hit: HelpSearchHit,
  input: SearchKnowledgeInput
): number {
  const artifacts = input.context?.artifacts;
  if (!artifacts?.length) return 0;
  const matches = artifacts.filter(
    (artifact) =>
      artifact.kind === "help" &&
      artifact.source === hit.source &&
      artifact.external_id === hit.external_id
  ).length;
  return matches / artifacts.length;
}

function helpCandidate(
  hit: HelpSearchHit,
  input: SearchKnowledgeInput
): SemanticDocumentCandidate<"help_article"> {
  return {
    document_id: `help:${hit.id}`,
    entity_kind: "help_article",
    entity_id: hit.id,
    matched_level: "help_article",
    canonical_text: [hit.title, hit.summary].filter(Boolean).join("\n"),
    vector_score: 0,
    lexical_score: hit.lexical_score,
    alias_match: false,
    artifact_overlap: helpArtifactOverlap(hit, input),
    graph_proximity: hit.graph_proximity,
    applicable: true,
    metadata: {
      help_source: hit.source,
      help_external_id: hit.external_id,
      help_url: hit.url,
      help_title: hit.title,
      help_summary: hit.summary,
      linked_story_count: hit.linked_story_count,
      linked_acceptance_criterion_count:
        hit.linked_acceptance_criterion_count,
      active: true,
      coverage: null,
      freshness: "not_applicable",
    },
  };
}

export function registerSearchKnowledge(server: McpServer): void {
  server.registerTool(
    "search_knowledge",
    {
      title: "Search the Tieline knowledge graph",
      description:
        "The single discovery entry point across Stories, ACs, Scenarios, Backlog Items, sanitized Observations, and ingested help articles. A retrieval profile is required; caller filters can only narrow it. Optional typed anchors and code, test, or help artifacts rerank the authorized candidate set without confirming relationships. Every result returns explicit state, ranking features, and a reusable context anchor when available. Use get_help_articles to hydrate selected full help bodies.",
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
        if (
          input.help_source &&
          input.document_kind &&
          !input.document_kind.includes("help_article")
        ) {
          throw new Error(
            "help_source requires document_kind to include help_article."
          );
        }
        const requestedKinds: SearchDocumentKind[] | undefined =
          input.document_kind ??
          (input.help_source ? ["help_article"] : undefined);
        const effectiveKinds = effectiveDocumentKinds(
          profile.definition.include,
          requestedKinds
        );
        const semanticKinds = effectiveKinds?.filter(isEmbeddingDocumentKind);
        const searchSemantic =
          effectiveKinds === undefined || (semanticKinds?.length ?? 0) > 0;
        const searchHelp =
          effectiveKinds === undefined || effectiveKinds.includes("help_article");
        const authorities = effectiveFilter(
          profile.definition.authorities,
          input.authority,
          "authority"
        );
        const lifecycles = effectiveFilter(
          profile.definition.lifecycles,
          input.lifecycle,
          "lifecycle"
        );
        const includeInactive =
          profile.definition.include_inactive === true &&
          input.include_inactive !== false;
        const helpPromise = (
          searchHelp
            ? store.searchHelpArticles({
                query: input.query,
                sources: input.help_source,
                authorities,
                lifecycles,
                repositories: input.repository,
                include_inactive: includeInactive,
                context: input.context,
                limit: Math.min(input.limit * 4, 200),
              })
            : Promise.resolve([])
        ).then(
          (hits) => ({ hits, error: undefined }),
          (error: unknown) => ({ hits: [], error })
        );
        const embedding = searchSemantic
          ? await optionalQueryEmbedding(input.query)
          : undefined;
        const semanticPromise = searchSemantic
          ? store.searchSemantic({
                query: input.query,
                embedding,
                profile,
                filters: {
                  document_kinds: semanticKinds,
                  authorities: input.authority,
                  lifecycles: input.lifecycle,
                  backlog_stages: input.backlog_stage,
                  repositories: input.repository,
                  applicability: input.applicability,
                  include_inactive: input.include_inactive,
                },
                context: input.context,
                limit: input.limit,
              })
          : Promise.resolve([]);
        const [semanticCandidates, helpOutcome] = await Promise.all([
          semanticPromise,
          helpPromise,
        ]);
        if (helpOutcome.error !== undefined) throw helpOutcome.error;
        const candidates: SemanticDocumentCandidate[] = [
          ...semanticCandidates,
          ...helpOutcome.hits.map((hit) => helpCandidate(hit, input)),
        ];
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
          ...(hit.entity_kind === "help_article"
            ? {
                help_article: {
                  source: metadataString(hit.metadata, "help_source")!,
                  external_id: metadataString(
                    hit.metadata,
                    "help_external_id"
                  )!,
                  title: metadataString(hit.metadata, "help_title"),
                  url: metadataString(hit.metadata, "help_url"),
                  summary: metadataString(hit.metadata, "help_summary"),
                  linked_story_count: Number(
                    hit.metadata.linked_story_count ?? 0
                  ),
                  linked_acceptance_criterion_count: Number(
                    hit.metadata.linked_acceptance_criterion_count ?? 0
                  ),
                },
              }
            : {}),
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
            help_source: input.help_source,
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
