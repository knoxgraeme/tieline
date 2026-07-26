-- ============================================================================
-- 0006_help_articles.sql
-- The help-center corpus: the help_articles table, the story<->article bridge,
-- and the pgvector embedding + KNN function that make articles semantically
-- searchable on their own (not just via the stories they're linked to). Run
-- after 0003.
--
-- Embeddings are computed by the application (whatever loads the help corpus)
-- and written with the row — the same embed-on-write model as user_stories, no
-- in-database trigger pipeline.
--
-- "Summary-card" embedding: embed title + summary + headings, NOT the full
-- markdown body. gte-small caps at ~512 tokens and most article bodies (avg
-- ~1,380 tokens) would be silently truncated; the curated summaries + headings
-- fit and describe what each article covers, which is what a topical search
-- wants. Swap to a help_article_chunks table later if body-specific recall
-- proves necessary.
-- ============================================================================

-- --- tables -----------------------------------------------------------------

create table if not exists help_articles (
  id            bigint generated always as identity primary key,
  article_slug  text not null unique,
  title         text not null,
  summary       text,
  url           text,
  product_area  text,
  audience      text,
  tags          text[],
  headings      jsonb,
  markdown      text,
  embedding     vector(384),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Story <-> article bridge. relationship_type ranks how the doc relates to the
-- story (primary | supporting | troubleshooting | reference); confidence is the
-- link certainty used for ordering.
create table if not exists story_help_articles (
  id                bigint generated always as identity primary key,
  story_id          bigint not null references user_stories(id) on delete cascade,
  help_article_id   bigint not null references help_articles(id) on delete cascade,
  relationship_type text not null default 'primary',
  confidence        real,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (story_id, help_article_id)
);

create index if not exists story_help_articles_story_idx   on story_help_articles (story_id);
create index if not exists story_help_articles_article_idx on story_help_articles (help_article_id);
create index if not exists help_articles_product_area_idx  on help_articles (product_area);

-- --- storage + index --------------------------------------------------------

-- (Kept as a separate ALTER so databases created before this migration existed
-- also get the column.)
alter table help_articles
  add column if not exists embedding vector(384);

-- HNSW cosine index. Safe to build on an all-NULL column; entries are added as
-- rows get embedded (NULLs are simply not indexed).
create index if not exists help_articles_embedding_hnsw
  on help_articles using hnsw (embedding vector_cosine_ops);

-- --- content function -------------------------------------------------------
-- Documents (and lets you recompute in SQL) the text that should be embedded for
-- each article: title + summary + headings. The application uses the same recipe
-- when it embeds on write. headings is a jsonb array of strings; flatten it to
-- newline-joined text and tolerate NULL/empty.
create or replace function help_article_embedding_input(article help_articles)
returns text
language plpgsql
immutable
as $$
declare
  heading_text text;
begin
  select coalesce(string_agg(h, E'\n'), '')
    into heading_text
    from jsonb_array_elements_text(coalesce(article.headings, '[]'::jsonb)) as h;

  return article.title
    || E'\n' || coalesce(article.summary, '')
    || case when heading_text <> '' then E'\n' || heading_text else '' end;
end;
$$;

-- --- KNN gate ---------------------------------------------------------------
-- Cosine nearest-neighbour lookup over the HNSW index, mirroring
-- match_user_stories. The MCP server passes only the query vector + count.
create or replace function match_help_articles(
  query_embedding vector(384),
  match_count int default 20
)
returns table (
  id            bigint,
  article_slug  text,
  title         text,
  summary       text,
  url           text,
  product_area  text,
  audience      text,
  tags          text[],
  headings      jsonb,
  similarity    double precision
)
language sql
stable
as $$
  select
    ha.id,
    ha.article_slug,
    ha.title,
    ha.summary,
    ha.url,
    ha.product_area,
    ha.audience,
    ha.tags,
    ha.headings,
    1 - (ha.embedding <=> query_embedding) as similarity
  from help_articles ha
  where ha.embedding is not null
  order by ha.embedding <=> query_embedding
  limit greatest(match_count, 1);
$$;
