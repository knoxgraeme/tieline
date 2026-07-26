-- ============================================================================
-- 0002_schema.sql
-- Canonical user-story knowledge-graph schema (matches
-- docs/artifacts/postgres-import-schema-confirmation.md) plus the retrieval
-- additions the MCP server needs: a pgvector embedding column on user_stories,
-- materialized document-frequency columns for 1/df weighting, and the inverted
-- indexes (join tables) that keep overlap queries fast as the corpus grows.
--
-- Embedding dimension is 384 (gte-small, the default local provider). If you
-- switch EMBEDDING_PROVIDER to a different-dim model (e.g. OpenAI
-- text-embedding-3-small = 1536), change vector(384) -> vector(1536) here and in
-- 0003/0006, then re-run migrate + ingest and re-create the HNSW index.
-- ============================================================================

-- Lifecycle values allowed for sections.status and user_stories.status.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'story_status') then
    create type story_status as enum (
      'production', 'qa', 'in_progress', 'in_review', 'cancelled', 'idea'
    );
  end if;
end$$;

-- --- sections ----------------------------------------------------------------
create table if not exists sections (
  id            bigint generated always as identity primary key,
  section_key   text not null unique,
  section_name  text not null,
  parent_area   text,
  default_actor text,
  definition    text,
  backfill_wave int,
  status        story_status not null default 'production',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- --- section_routes (one row per anchoring route/code path) -------------------
create table if not exists section_routes (
  id         bigint generated always as identity primary key,
  section_id bigint not null references sections(id) on delete cascade,
  route_path text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (section_id, route_path)
);

-- --- user_stories ------------------------------------------------------------
create table if not exists user_stories (
  id         bigint generated always as identity primary key,
  section_id bigint not null references sections(id) on delete cascade,
  story_key  text not null unique,
  title      text not null,
  actor      text,
  story_text text not null,
  status     story_status not null default 'production',
  -- Semantic vector over (title + "\n" + story_text). Nullable until ingest
  -- embeds the row. 384 dims = Supabase/gte-small.
  embedding  vector(384),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- --- entities (canonical product concepts) -----------------------------------
create table if not exists entities (
  id            bigint generated always as identity primary key,
  entity_slug   text not null unique,
  entity_name   text,
  entity_type   text,
  description   text,
  -- # of distinct stories referencing this entity. Maintained by
  -- refresh_document_frequencies(). Drives the 1/df rare-slug weighting.
  doc_frequency int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- --- code_assets (canonical code files/symbols) ------------------------------
create table if not exists code_assets (
  id            bigint generated always as identity primary key,
  repo          text not null,
  path          text not null,
  asset_type    text,
  symbol_name   text,
  summary       text,
  is_active     boolean not null default true,
  doc_frequency int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (repo, path)
);

-- --- story_entities (inverted index: story <-> entity) -----------------------
create table if not exists story_entities (
  id                bigint generated always as identity primary key,
  story_id          bigint not null references user_stories(id) on delete cascade,
  entity_id         bigint not null references entities(id) on delete cascade,
  relationship_type text not null default 'mentions',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (story_id, entity_id)
);

-- --- story_code_assets (inverted index: story <-> code path) -----------------
create table if not exists story_code_assets (
  id                bigint generated always as identity primary key,
  story_id          bigint not null references user_stories(id) on delete cascade,
  code_asset_id     bigint not null references code_assets(id) on delete cascade,
  link_type         text not null default 'primary',
  provenance        text default 'imported_from_csv',
  confidence        real,
  confidence_reason text,
  sort_order        int not null default 0,
  last_verified_at  timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (story_id, code_asset_id)
);

-- ============================================================================
-- Indexes
-- ============================================================================

-- Vector KNN gate. HNSW (not IVFFlat): no train-after-N-rows step, good at the
-- small-and-growing corpus size. cosine ops because we normalize embeddings.
create index if not exists user_stories_embedding_hnsw
  on user_stories using hnsw (embedding vector_cosine_ops);

-- Overlap / filter / join support.
create index if not exists user_stories_section_idx on user_stories (section_id);
create index if not exists user_stories_status_idx  on user_stories (status);
create index if not exists user_stories_actor_idx   on user_stories (actor);

create index if not exists story_entities_entity_idx     on story_entities (entity_id);
create index if not exists story_entities_story_idx      on story_entities (story_id);
create index if not exists story_code_assets_asset_idx   on story_code_assets (code_asset_id);
create index if not exists story_code_assets_story_idx   on story_code_assets (story_id);
create index if not exists section_routes_section_idx    on section_routes (section_id);
