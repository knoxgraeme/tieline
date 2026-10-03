-- When each Story, acceptance criterion, and screen changed on the synced
-- branch, and in which pull request, recorded by repository sync from the
-- committed manifest's git history. One row per item a commit added, changed,
-- or removed; recording the same commit again changes nothing.

create table contract_change_events (
  id bigint generated always as identity primary key,
  repository_id uuid not null references repositories(id),
  entity_kind text not null check (entity_kind in ('story', 'acceptance_criterion', 'screen')),
  stable_id text not null check (stable_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$'),
  status text not null check (status in ('added', 'changed', 'removed')),
  aspects text[] not null default '{}' check (
    cardinality(aspects) <= 8 and
    aspects <@ array['content', 'screens', 'moved', 'reordered', 'details', 'image', 'text']::text[]
  ),
  title text not null check (octet_length(title) <= 4096),
  commit_sha text not null check (commit_sha ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
  committed_at timestamptz not null,
  pull_request integer check (pull_request is null or pull_request > 0),
  recorded_at timestamptz not null default now(),
  unique (repository_id, commit_sha, entity_kind, stable_id),
  check (status = 'changed' or cardinality(aspects) = 0)
);

create index contract_change_events_by_item
  on contract_change_events (repository_id, entity_kind, stable_id, committed_at desc);

alter table screen_history
  add column pull_request integer check (pull_request is null or pull_request > 0);

grant select, insert on contract_change_events to tieline_repository_sync;
grant select on contract_change_events to tieline_reader, tieline_planning_writer;
