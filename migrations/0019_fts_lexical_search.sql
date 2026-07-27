-- ============================================================================
-- 0019_fts_lexical_search.sql
-- Lexical full-text search as an always-on retrieval signal (see
-- docs/plans/2026-07-27-001-feat-fts-retrieval-baseline-plan.md).
--
-- Adds two native lexical mechanisms so search works with ZERO embedding setup:
--   * tsvector + GIN over prose (story/section/help text) — keyword recall.
--   * pg_trgm trigram GIN over identifiers (code paths, entity slugs) — partial
--     / identifier matching where stemmed FTS is weak and where dense embeddings
--     blur rare tokens.
--
-- pg_trgm is native Postgres contrib, available on every target host (the
-- pgvector/pgvector image, Supabase, Neon, RDS via rds.allowed_extensions,
-- Crunchy, Timescale). Installed exactly like `vector` in 0001 — no schema
-- qualification, so it resolves on generic Postgres and Supabase alike (the
-- migrate runner sets search_path = public, extensions).
--
-- The tsvector columns are GENERATED ALWAYS AS ... STORED: they populate
-- existing rows at ALTER time (no manual backfill) and stay consistent with no
-- trigger surface. to_tsvector is called with the explicit 'english' regconfig
-- so the expression is IMMUTABLE (required for a generated column); the 1-arg
-- form depends on default_text_search_config and is only STABLE.
--
-- Run after 0018.
-- ============================================================================

create extension if not exists pg_trgm;

-- --- tsvector columns (prose) ------------------------------------------------

alter table user_stories
  add column if not exists search_tsv tsvector
  generated always as (
    to_tsvector(
      'english',
      coalesce(title, '') || ' ' || coalesce(actor, '') || ' ' || coalesce(story_text, '')
    )
  ) stored;

alter table sections
  add column if not exists search_tsv tsvector
  generated always as (
    to_tsvector(
      'english',
      coalesce(section_name, '') || ' ' || coalesce(definition, '')
    )
  ) stored;

alter table help_articles
  add column if not exists search_tsv tsvector
  generated always as (
    to_tsvector(
      'english',
      coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(headings::text, '')
    )
  ) stored;

-- --- GIN indexes over the tsvector columns -----------------------------------

create index if not exists user_stories_search_tsv_gin on user_stories using gin (search_tsv);
create index if not exists sections_search_tsv_gin      on sections      using gin (search_tsv);
create index if not exists help_articles_search_tsv_gin on help_articles using gin (search_tsv);

-- --- trigram indexes over identifiers ----------------------------------------
-- Partial / identifier matching: `similarity(path, $q)` and `path % $q` use
-- these. Distinct from the prose tsvector above — code paths and entity slugs
-- are tokens FTS stemming mangles.

create index if not exists code_assets_path_trgm on code_assets using gin (path gin_trgm_ops);
create index if not exists entities_slug_trgm     on entities   using gin (entity_slug gin_trgm_ops);
