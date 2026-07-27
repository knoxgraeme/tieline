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
-- LOCK NOTE: adding a STORED generated column rewrites the whole table under an
-- ACCESS EXCLUSIVE lock (each row's tsvector is computed at ALTER time), and the
-- GIN builds below are non-CONCURRENT. Negligible on the current small corpus;
-- against a large, write-active database, run this in a maintenance window.
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

-- --- trigram identifier matching (pg_trgm) -----------------------------------
-- lexicalCandidates uses word_similarity(path/slug, $q) to catch partial code
-- paths and entity slugs that FTS stemming mangles. No GIN trigram index is
-- created here on purpose: the function-form predicate
-- `word_similarity(col, $q) >= threshold` cannot use a gin_trgm_ops index (only
-- the %/<%/%> operators engage it), so an index would be dead weight. At this
-- corpus size the per-query scan of the small story<->code/entity join tables is
-- cheap. When the corpus grows, switch the query to the `%>` operator driven by
-- `pg_trgm.word_similarity_threshold` and add the gin_trgm_ops indexes in a new
-- migration so the planner can use them.
