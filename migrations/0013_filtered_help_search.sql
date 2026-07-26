-- Apply help facets before the nearest-neighbour LIMIT so eligible articles are
-- never discarded by globally-nearer rows from another product area/audience.

create or replace function match_help_articles(
  query_embedding vector(384),
  match_count int default 20,
  product_areas text[] default null,
  audiences text[] default null
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
  select ha.id, ha.article_slug, ha.title, ha.summary, ha.url, ha.product_area,
         ha.audience, ha.tags, ha.headings,
         1 - (ha.embedding <=> query_embedding) as similarity
  from help_articles ha
  where ha.embedding is not null
    and (product_areas is null or ha.product_area = any(product_areas))
    and (audiences is null or ha.audience = any(audiences))
  order by ha.embedding <=> query_embedding
  limit greatest(match_count, 1);
$$;

