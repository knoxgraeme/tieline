import type { Sql } from "postgres";
import { config } from "../../config.js";
import {
  EMBEDDING_DOCUMENT_VERSION,
  isEmbeddingDocumentKind,
  type DerivedEmbeddingDocument,
  type EmbeddingDocumentKind,
} from "../../derived/embedding-documents.js";
import type {
  AttributionSuggestionRecord,
  AttributionSuggestionStore,
  DerivedDocumentStore,
  DerivedDocumentWriteResult,
  ResolvedRetrievalProfile,
  RetrievalProfileDefinition,
  SemanticSearchCandidate,
  SemanticSearchContext,
  SemanticSearchFilters,
  SemanticSearchStore,
} from "../../domain/semantic-search-store.js";
import { getEmbedder, type Embedder } from "../../embeddings.js";
import { getReadSql } from "./connections.js";
import { scoreSearchContext } from "./search-context.js";
import { vectorLiteral } from "./vector.js";

interface ProfileRow {
  profile_key: string;
  version: number;
  definition: RetrievalProfileDefinition;
}

interface DocumentRow {
  document_id: string;
  entity_kind: EmbeddingDocumentKind;
  entity_id: string;
  document_kind: EmbeddingDocumentKind;
  canonical_text: string;
  vector_score: number | string | null;
  lexical_score: number | string | null;
  filter_metadata: Record<string, unknown>;
  attribution_state: "suggested" | "confirmed" | "dismissed" | null;
}

function stringValue(
  metadata: Record<string, unknown>,
  key: string
): string | undefined {
  return typeof metadata[key] === "string"
    ? (metadata[key] as string)
    : undefined;
}

function arrayIntersection<T>(left?: T[], right?: T[]): T[] | undefined {
  if (!left && !right) return undefined;
  if (!left) return right;
  if (!right) return left;
  const allowed = new Set(right);
  return left.filter((value) => allowed.has(value));
}

/** Caller filters can only intersect a profile; they can never broaden it. */
export function narrowSemanticFilters(
  profile: RetrievalProfileDefinition,
  requested: SemanticSearchFilters = {}
): SemanticSearchFilters {
  return {
    authorities: arrayIntersection(
      profile.authorities,
      requested.authorities
    ),
    lifecycles: arrayIntersection(
      profile.lifecycles,
      requested.lifecycles
    ),
    backlog_stages: arrayIntersection(
      profile.backlog_stages,
      requested.backlog_stages
    ),
    document_kinds: arrayIntersection(
      profile.include?.filter(isEmbeddingDocumentKind),
      requested.document_kinds
    ),
    repositories: requested.repositories,
    applicability: requested.applicability,
    include_inactive:
      profile.include_inactive === true &&
      requested.include_inactive !== false,
  };
}

function ensureNotBroadened(
  profileValues: string[] | undefined,
  requestedValues: string[] | undefined,
  effectiveValues: string[] | undefined,
  label: string
): void {
  if (
    profileValues &&
    requestedValues !== undefined &&
    effectiveValues?.length === 0
  ) {
    throw new Error(
      `${label} filter does not intersect retrieval profile '${label}'.`
    );
  }
}

function modelKey(embedder: Embedder): string {
  return config.embeddingModel?.trim() || embedder.provider;
}

function jsonValue(
  sql: Sql,
  value: Record<string, unknown>
): ReturnType<Sql["json"]> {
  return sql.json(value as Parameters<Sql["json"]>[0]);
}

export class PostgresSemanticRepository
  implements
    SemanticSearchStore,
    DerivedDocumentStore,
    AttributionSuggestionStore
{
  constructor(
    private readonly sqlProvider: () => Sql = getReadSql,
    private readonly embedderProvider: () => Embedder = getEmbedder
  ) {}

  async resolveRetrievalProfile(
    profileKey: string,
    version?: number
  ): Promise<ResolvedRetrievalProfile> {
    const sql = this.sqlProvider();
    const rows = version
      ? await sql<ProfileRow[]>`
          select profile_key, version, definition
          from retrieval_profiles
          where profile_key = ${profileKey} and version = ${version}`
      : await sql<ProfileRow[]>`
          select profile_key, version, definition
          from retrieval_profiles
          where profile_key = ${profileKey} and active`;
    if (!rows[0]) {
      throw new Error(
        `Unknown retrieval profile '${profileKey}'${version ? ` version ${version}` : ""}.`
      );
    }
    return {
      key: rows[0].profile_key,
      version: rows[0].version,
      definition: rows[0].definition,
    };
  }

  async searchSemantic(input: {
    query: string;
    embedding?: number[];
    profile: ResolvedRetrievalProfile;
    filters?: SemanticSearchFilters;
    context?: SemanticSearchContext;
    limit: number;
  }): Promise<SemanticSearchCandidate[]> {
    const sql = this.sqlProvider();
    const filters = narrowSemanticFilters(
      input.profile.definition,
      input.filters
    );
    ensureNotBroadened(
      input.profile.definition.authorities,
      input.filters?.authorities,
      filters.authorities,
      "authority"
    );
    ensureNotBroadened(
      input.profile.definition.lifecycles,
      input.filters?.lifecycles,
      filters.lifecycles,
      "lifecycle"
    );
    ensureNotBroadened(
      input.profile.definition.include,
      input.filters?.document_kinds,
      filters.document_kinds,
      "document kind"
    );
    ensureNotBroadened(
      input.profile.definition.backlog_stages,
      input.filters?.backlog_stages,
      filters.backlog_stages,
      "backlog stage"
    );

    const conditions: ReturnType<Sql>[] = [
      sql`ed.embedding_version = ${EMBEDDING_DOCUMENT_VERSION}`,
    ];
    if (filters.authorities?.length) {
      conditions.push(
        sql`(
          ed.document_kind not in ('story', 'acceptance_criterion', 'scenario')
          or ed.filter_metadata->>'authority' = any(${filters.authorities})
        )`
      );
    }
    if (filters.lifecycles?.length) {
      conditions.push(
        sql`(
          ed.document_kind not in ('story', 'acceptance_criterion', 'scenario')
          or ed.filter_metadata->>'lifecycle' = any(${filters.lifecycles})
        )`
      );
    }
    if (filters.backlog_stages?.length) {
      conditions.push(
        sql`(
          ed.document_kind <> 'backlog_item'
          or ed.filter_metadata->>'backlog_stage' = any(${filters.backlog_stages})
        )`
      );
    }
    if (filters.document_kinds !== undefined) {
      conditions.push(
        filters.document_kinds.length > 0
          ? sql`ed.document_kind = any(${filters.document_kinds})`
          : sql`false`
      );
    }
    if (filters.repositories?.length) {
      conditions.push(
        sql`ed.filter_metadata->>'repository' = any(${filters.repositories})`
      );
    }
    if (!filters.include_inactive) {
      conditions.push(
        sql`coalesce((ed.filter_metadata->>'active')::boolean, true)`
      );
    }
    if (filters.applicability) {
      for (const [dimension, requestedValues] of Object.entries(
        filters.applicability
      )) {
        const values = [...new Set(requestedValues)];
        if (values.length === 0) continue;
        conditions.push(sql`(
          not (
            coalesce(
              ed.filter_metadata->'applicability',
              '{}'::jsonb
            ) ? ${dimension}
          )
          or exists (
            select 1
            from jsonb_array_elements_text(
              coalesce(
                ed.filter_metadata->'applicability'->${dimension},
                '[]'::jsonb
              )
            ) as applicable(value)
            where applicable.value = any(${values})
          )
        )`);
      }
    }
    const observationStates =
      input.profile.definition.observation_attribution_states;
    if (observationStates?.length) {
      conditions.push(sql`(
        ed.document_kind <> 'observation'
        or exists (
          select 1
          from attribution_suggestions suggestion
          where suggestion.source_kind = 'observation'
            and suggestion.source_id = ed.entity_id
            and suggestion.state = any(${observationStates}::attribution_state[])
        )
        or exists (
          select 1 from observation_story_attributions attribution
          where attribution.observation_id = ed.entity_id
            and attribution.state = any(${observationStates}::attribution_state[])
        )
        or exists (
          select 1 from observation_criterion_attributions attribution
          where attribution.observation_id = ed.entity_id
            and attribution.state = any(${observationStates}::attribution_state[])
        )
        or exists (
          select 1 from observation_backlog_attributions attribution
          where attribution.observation_id = ed.entity_id
            and attribution.state = any(${observationStates}::attribution_state[])
        )
      )`);
    }
    const where = conditions.reduce(
      (combined, condition, index) =>
        index === 0 ? sql`where ${condition}` : sql`${combined} and ${condition}`,
      sql``
    );
    const candidateLimit = Math.min(
      Math.max(input.limit * 8, 40),
      400
    );
    const resultLimit = Math.min(Math.max(input.limit * 4, 20), 200);
    const queryModel = input.embedding
      ? modelKey(this.embedderProvider())
      : "";
    const queryVector = input.embedding
      ? vectorLiteral(input.embedding)
      : undefined;
    const vectorCandidates = queryVector
      ? sql`
          select
            ed.id,
            greatest(
              0,
              1 - (
                ed.embedding OPERATOR(extensions.<=>)
                ${queryVector}::extensions.vector
              )
            ) as vector_score
          from embedding_documents ed
          ${where}
            and ed.embedding_model = ${queryModel}
            and ed.embedding is not null
          order by
            ed.embedding OPERATOR(extensions.<=>)
            ${queryVector}::extensions.vector,
            ed.id
          limit ${candidateLimit}`
      : sql`
          select document.id, 0::double precision as vector_score
          from filtered_documents document
          where false`;
    const rows = await sql<DocumentRow[]>`
      with filtered_documents as materialized (
        select distinct on (
          ed.entity_kind,
          ed.entity_id,
          ed.document_kind
        ) ed.*
        from embedding_documents ed
        ${where}
        order by
          ed.entity_kind,
          ed.entity_id,
          ed.document_kind,
          case
            when ${Boolean(input.embedding)}
              and ed.embedding_model = ${queryModel}
              then 0
            else 1
          end,
          ed.updated_at desc,
          ed.id
      ),
      query_terms as (
        select websearch_to_tsquery('english', ${input.query}) as tsquery
      ),
      vector_candidates as materialized (
        ${vectorCandidates}
      ),
      lexical_candidates as materialized (
        select
          document.id,
          greatest(
            prose.score / (prose.score + 1),
            identifiers.score
          ) as lexical_score
        from filtered_documents document
        cross join query_terms
        cross join lateral (
          select ts_rank_cd(
            document.search_vector,
            query_terms.tsquery
          ) as score
        ) prose
        cross join lateral (
          select coalesce(max(word_similarity(
            lower(${input.query}),
            lower(identifier.value)
          )), 0) as score
          from jsonb_array_elements_text(
            case
              when jsonb_typeof(document.filter_metadata->'identifiers') = 'array'
                then document.filter_metadata->'identifiers'
              else '[]'::jsonb
            end
          ) identifier(value)
        ) identifiers
        where
          document.search_vector @@ query_terms.tsquery
          or identifiers.score >= 0.3
        order by
          greatest(
            prose.score / (prose.score + 1),
            identifiers.score
          ) desc,
          document.id
        limit ${candidateLimit}
      ),
      candidate_ids as (
        select id from vector_candidates
        union
        select id from lexical_candidates
      )
      select
        ed.id as document_id,
        ed.entity_kind::text,
        ed.entity_id,
        ed.document_kind,
        ed.canonical_text,
        coalesce(vector.vector_score, 0) as vector_score,
        coalesce(lexical.lexical_score, 0) as lexical_score,
        ed.filter_metadata,
        attribution.effective_state as attribution_state
      from candidate_ids candidate
      join filtered_documents ed on ed.id = candidate.id
      left join vector_candidates vector on vector.id = ed.id
      left join lexical_candidates lexical on lexical.id = ed.id
      left join lateral (
        select case
          when bool_or(states.state = 'confirmed') then 'confirmed'
          when bool_or(states.state = 'suggested') then 'suggested'
          when bool_or(states.state = 'dismissed') then 'dismissed'
          else null
        end as effective_state
        from (
          select suggestion.state
          from attribution_suggestions suggestion
          where suggestion.source_kind = 'observation'
            and suggestion.source_id = ed.entity_id
          union all
          select story.state
          from observation_story_attributions story
          where story.observation_id = ed.entity_id
          union all
          select criterion.state
          from observation_criterion_attributions criterion
          where criterion.observation_id = ed.entity_id
          union all
          select backlog.state
          from observation_backlog_attributions backlog
          where backlog.observation_id = ed.entity_id
        ) states
        where ed.document_kind = 'observation'
      ) attribution on true
      order by
        (
          0.65 * coalesce(vector.vector_score, 0) +
          0.35 * coalesce(lexical.lexical_score, 0)
        ) desc,
        ed.id
      limit ${resultLimit}`;

    const contextFeatures = input.context
      ? await scoreSearchContext(
          sql,
          rows,
          input.context,
          filters.include_inactive === true
        )
      : new Map();
    const normalizedQuery = input.query.trim().toLowerCase();
    return rows.map((row) => {
      const metadata: Record<string, unknown> = {
        ...row.filter_metadata,
        ...(row.attribution_state
          ? { attribution_state: row.attribution_state }
          : {}),
      };
      const aliases = Array.isArray(metadata.aliases)
        ? metadata.aliases.filter(
            (value): value is string => typeof value === "string"
          )
        : [];
      const contextFeature = contextFeatures.get(row.document_id);
      return {
        document_id: row.document_id,
        entity_kind: row.entity_kind,
        entity_id: row.entity_id,
        matched_level: row.document_kind,
        canonical_text: row.canonical_text,
        vector_score: Number(row.vector_score ?? 0),
        lexical_score: Number(row.lexical_score ?? 0),
        alias_match: aliases.some(
          (alias) => alias.toLowerCase() === normalizedQuery
        ),
        artifact_overlap: contextFeature?.artifact_overlap ?? 0,
        graph_proximity: contextFeature?.graph_proximity ?? 0,
        applicable: true,
        story_id: stringValue(metadata, "story_id"),
        story_stable_id: stringValue(metadata, "story_stable_id"),
        acceptance_criterion_id: stringValue(
          metadata,
          "acceptance_criterion_id"
        ),
        acceptance_criterion_stable_id: stringValue(
          metadata,
          "acceptance_criterion_stable_id"
        ),
        metadata,
      };
    });
  }

  async upsertEmbeddingDocument(
    document: DerivedEmbeddingDocument
  ): Promise<DerivedDocumentWriteResult> {
    const sql = this.sqlProvider();
    let embedder: Embedder | undefined;
    try {
      embedder = this.embedderProvider();
    } catch {
      embedder = undefined;
    }
    const model =
      config.embeddingModel?.trim() ||
      embedder?.provider ||
      config.embeddingProvider;
    const existing = await sql<{
      id: string;
      source_text_hash: string;
      has_embedding: boolean;
    }[]>`
      select id, source_text_hash, embedding is not null as has_embedding
      from embedding_documents
      where entity_kind = ${document.entity_kind}::semantic_entity_kind
        and entity_id = ${document.entity_id}
        and document_kind = ${document.document_kind}
        and embedding_model = ${model}
        and embedding_version = ${EMBEDDING_DOCUMENT_VERSION}`;
    const changed =
      !existing[0] ||
      existing[0].source_text_hash !== document.source_text_hash;
    if (!changed && existing[0]?.has_embedding) {
      await sql`
        update embedding_documents
        set filter_metadata = ${jsonValue(sql, document.filter_metadata)},
            updated_at = now()
        where id = ${existing[0].id}`;
      return {
        embedded: false,
        document_id: existing[0].id,
        embedding_status: "unchanged",
      };
    }
    let embedding: number[] | undefined;
    if (embedder) {
      try {
        embedding = await embedder.embed(document.canonical_text);
      } catch {
        embedding = undefined;
      }
    }
    const rows = await sql<{ id: string }[]>`
      insert into embedding_documents (
        entity_kind, entity_id, document_kind, canonical_text,
        source_text_hash, embedding_model, embedding_version,
        embedding, filter_metadata
      ) values (
        ${document.entity_kind}::semantic_entity_kind,
        ${document.entity_id},
        ${document.document_kind},
        ${document.canonical_text},
        ${document.source_text_hash},
        ${model},
        ${EMBEDDING_DOCUMENT_VERSION},
        ${embedding ? vectorLiteral(embedding) : null}::extensions.vector,
        ${jsonValue(sql, document.filter_metadata)}
      )
      on conflict (
        entity_kind, entity_id, document_kind,
        embedding_model, embedding_version
      ) do update set
        canonical_text = excluded.canonical_text,
        source_text_hash = excluded.source_text_hash,
        embedding = excluded.embedding,
        filter_metadata = excluded.filter_metadata,
        updated_at = now()
      returning id`;
    return {
      embedded: embedding !== undefined,
      document_id: rows[0].id,
      embedding_status:
        embedding === undefined ? "unavailable" : "embedded",
    };
  }

  async saveAttributionSuggestion(input: {
    source_kind: EmbeddingDocumentKind;
    source_id: string;
    target_kind: EmbeddingDocumentKind;
    target_id: string;
    state: "suggested" | "confirmed";
    method: string;
    score?: number | null;
    rationale?: Record<string, unknown>;
  }): Promise<AttributionSuggestionRecord> {
    const sql = this.sqlProvider();
    const rows = await sql<AttributionSuggestionRecord[]>`
      insert into attribution_suggestions (
        source_kind, source_id, target_kind, target_id,
        state, method, score, rationale
      ) values (
        ${input.source_kind}::semantic_entity_kind,
        ${input.source_id},
        ${input.target_kind}::semantic_entity_kind,
        ${input.target_id},
        ${input.state}::attribution_state,
        ${input.method},
        ${input.score ?? null},
        ${jsonValue(sql, input.rationale ?? {})}
      )
      on conflict (
        source_kind, source_id, target_kind, target_id, method
      ) do update set
        score = excluded.score,
        rationale = excluded.rationale,
        updated_at = now()
      returning
        id, source_kind::text, source_id, target_kind::text, target_id,
        state::text, method, score, rationale`;
    return rows[0];
  }

  async listAttributionSuggestions(input: {
    source_kind?: EmbeddingDocumentKind;
    source_id?: string;
    state?: Array<"suggested" | "confirmed" | "dismissed">;
    limit?: number;
  } = {}): Promise<AttributionSuggestionRecord[]> {
    const sql = this.sqlProvider();
    const states = input.state ?? ["suggested"];
    return sql<AttributionSuggestionRecord[]>`
      select
        id, source_kind::text, source_id, target_kind::text, target_id,
        state::text, method, score, rationale
      from attribution_suggestions
      where state = any(${states}::attribution_state[])
        and (${input.source_kind ?? null}::text is null or source_kind = ${input.source_kind ?? null}::semantic_entity_kind)
        and (${input.source_id ?? null}::uuid is null or source_id = ${input.source_id ?? null}::uuid)
      order by score desc nulls last, created_at
      limit ${Math.min(Math.max(input.limit ?? 50, 1), 200)}`;
  }

  async decideAttributionSuggestion(input: {
    suggestion_id: string;
    decision: "confirmed" | "dismissed";
  }): Promise<AttributionSuggestionRecord | null> {
    const sql = this.sqlProvider();
    const rows = await sql<AttributionSuggestionRecord[]>`
      update attribution_suggestions
      set state = ${input.decision}::attribution_state, updated_at = now()
      where id = ${input.suggestion_id}
      returning
        id, source_kind::text, source_id, target_kind::text, target_id,
        state::text, method, score, rationale`;
    return rows[0] ?? null;
  }
}
