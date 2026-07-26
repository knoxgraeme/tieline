-- ============================================================================
-- 0003_functions.sql
-- Read-only retrieval helpers + the ingest-time document-frequency refresh.
-- Run after 0002. Safe to re-run (create or replace).
--
-- Everything that needs the pgvector operator lives here as a SQL function so
-- the MCP server only passes *values*, never SQL. Fusion / ranking / the 1/df
-- weighting itself live in the app layer (src/ranking.ts) so they stay unit-
-- testable without a database.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- match_user_stories: the KNN gate for find_related.
-- Embeds happen in the app (Supabase/gte-small); this just does the cosine
-- nearest-neighbour lookup against the HNSW index and returns a candidate pool.
-- similarity = 1 - cosine_distance, so higher = closer (range ~0..1).
-- ---------------------------------------------------------------------------
create or replace function match_user_stories(
  query_embedding vector(384),
  match_count int default 50
)
returns table (
  id           bigint,
  story_key    text,
  section_id   bigint,
  section_key  text,
  section_name text,
  title        text,
  actor        text,
  story_text   text,
  status       text,
  similarity   double precision
)
language sql
stable
as $$
  select
    us.id,
    us.story_key,
    us.section_id,
    s.section_key,
    s.section_name,
    us.title,
    us.actor,
    us.story_text,
    us.status::text,
    1 - (us.embedding <=> query_embedding) as similarity
  from user_stories us
  join sections s on s.id = us.section_id
  where us.embedding is not null
  order by us.embedding <=> query_embedding
  limit greatest(match_count, 1);
$$;

-- ---------------------------------------------------------------------------
-- refresh_document_frequencies: recompute entities.doc_frequency and
-- code_assets.doc_frequency from the join tables. Called once at the end of an
-- ingest run. df is the # of distinct stories referencing each slug/path, and
-- is what the 1/df rare-slug weighting reads so hub tags (e.g. `folder`) don't
-- dominate distinctive ones (e.g. `tax-rate`).
-- ---------------------------------------------------------------------------
create or replace function refresh_document_frequencies()
returns void
language plpgsql
as $$
begin
  update entities e
  set doc_frequency = sub.df,
      updated_at = now()
  from (
    select entity_id, count(distinct story_id) as df
    from story_entities
    group by entity_id
  ) sub
  where sub.entity_id = e.id;

  -- entities with no links -> df 0
  update entities e
  set doc_frequency = 0, updated_at = now()
  where not exists (select 1 from story_entities se where se.entity_id = e.id)
    and e.doc_frequency <> 0;

  update code_assets c
  set doc_frequency = sub.df,
      updated_at = now()
  from (
    select code_asset_id, count(distinct story_id) as df
    from story_code_assets
    group by code_asset_id
  ) sub
  where sub.code_asset_id = c.id;

  update code_assets c
  set doc_frequency = 0, updated_at = now()
  where not exists (select 1 from story_code_assets sc where sc.code_asset_id = c.id)
    and c.doc_frequency <> 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- Convenience read-only views for the schema://taxonomy resource.
-- ---------------------------------------------------------------------------

-- Slug vocabulary with document frequency (for taxonomy + 1/df transparency).
create or replace view v_entity_taxonomy as
  select entity_slug, doc_frequency
  from entities
  order by doc_frequency desc, entity_slug asc;

-- Section roster with story counts.
create or replace view v_section_taxonomy as
  select
    s.section_key,
    s.section_name,
    s.status::text as status,
    s.default_actor,
    count(us.id) as story_count
  from sections s
  left join user_stories us on us.section_id = s.id
  group by s.id
  order by s.section_key;
