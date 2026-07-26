-- ============================================================================
-- 0008_feature_requests.sql
-- The customer-evidence log + the FR<->story bridge. Run after 0007.
--
-- feature_requests is APPEND-ONLY evidence: one row per individual incoming
-- request, NO embedding, NO semantic search (dedup happens at the story level).
-- Postgres is the system of record; notion_page_id is an outbound pointer to an
-- optional human mirror, not a dependency.
-- ============================================================================

create table if not exists feature_requests (
  id               bigint generated always as identity primary key,
  source           text,
  source_thread_id text,
  source_thread_url text,
  raw_thread_jsonb jsonb,
  title            text not null,
  summary          text,
  requested_change text,
  context          text,
  priority_signal  text,
  confidence       real,
  product_area     text,
  status           text not null default 'triaged',
  notion_page_id   text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  last_triaged_at  timestamptz
);

create index if not exists feature_requests_source_thread_idx
  on feature_requests (source, source_thread_id);
create index if not exists feature_requests_product_area_idx
  on feature_requests (product_area);

-- The bridge. References a story by its bigint id (FK) but also snapshots the
-- title for a stable record; stories have no URL, so url_snapshot stays null.
create table if not exists feature_request_story_links (
  id                        bigint generated always as identity primary key,
  feature_request_id        bigint not null references feature_requests (id) on delete cascade,
  user_story_id             bigint not null references user_stories (id) on delete restrict,
  user_story_title_snapshot text,
  user_story_url_snapshot   text,
  link_type                 text not null check (link_type in ('primary', 'secondary')),
  link_source               text,
  created_at                timestamptz not null default now(),
  unique (feature_request_id, user_story_id)
);

-- At most one primary story per feature request.
create unique index if not exists fr_links_one_primary_idx
  on feature_request_story_links (feature_request_id)
  where link_type = 'primary';

create index if not exists fr_links_fr_idx
  on feature_request_story_links (feature_request_id);
create index if not exists fr_links_story_idx
  on feature_request_story_links (user_story_id);
