-- Hosted screens: rendered review pages per ref, the images they reference,
-- and main's image history, behind a publisher role that cannot touch main.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'tieline_capture_publisher') then
    create role tieline_capture_publisher nologin;
  end if;
end;
$$;

create function tieline_screen_digests_valid(p_digests text[])
returns boolean
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select coalesce(bool_and(digest ~ '^[a-f0-9]{64}$'), true)
  from unnest(p_digests) as digest
$$;

revoke all on function tieline_screen_digests_valid(text[]) from public;

-- Image bytes live in an object store under `<repository key>/sha256/<digest>`;
-- a row says the image was published and when anything last referenced it,
-- so retention never deletes an image a publish is still writing.
create table screen_images (
  repository_id uuid not null references repositories(id),
  digest text not null check (digest ~ '^[a-f0-9]{64}$'),
  content_type text not null check (
    content_type in ('image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif')
  ),
  byte_size integer not null check (byte_size between 1 and 26214400),
  first_seen_at timestamptz not null default now(),
  last_referenced_at timestamptz not null default now(),
  primary key (repository_id, digest)
);

-- One row per ref: main (written only by repository sync), and each pull
-- request or branch (written by the capture publisher). Publishing a ref
-- replaces its row; nothing keeps superseded pages.
create table screen_snapshots (
  repository_id uuid not null references repositories(id),
  ref_kind text not null check (ref_kind in ('main', 'pr', 'branch')),
  ref_name text not null,
  head_commit text not null check (head_commit ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
  manifest jsonb not null check (octet_length(manifest::text) <= 16777216),
  images text[] not null check (
    cardinality(images) <= 20000 and tieline_screen_digests_valid(images)
  ),
  page_html text not null check (octet_length(page_html) <= 16777216),
  published_at timestamptz not null default now(),
  closed_at timestamptz,
  primary key (repository_id, ref_kind, ref_name),
  check (
    (ref_kind = 'main' and ref_name = 'main') or
    (ref_kind = 'pr' and ref_name ~ '^[1-9][0-9]{0,9}$') or
    (
      ref_kind = 'branch' and
      ref_name ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$' and
      ref_name !~ '(\.\.|//|/$|\.lock$)'
    )
  ),
  check (closed_at is null or ref_kind = 'pr')
);

create index screen_snapshots_images on screen_snapshots using gin (images);

-- Each image main has accepted for a screen, newest last, so retention can keep
-- the last few replaced versions.
create table screen_history (
  id bigint generated always as identity primary key,
  repository_id uuid not null references repositories(id),
  screen_key text not null check (screen_key ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$'),
  digest text not null check (digest ~ '^[a-f0-9]{64}$'),
  commit_sha text not null check (commit_sha ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
  recorded_at timestamptz not null default now()
);

create index screen_history_by_screen on screen_history (repository_id, screen_key, id desc);
create index screen_history_by_digest on screen_history (repository_id, digest);

alter table screen_snapshots enable row level security;

create policy publisher_snapshot_select on screen_snapshots
  for select to tieline_capture_publisher using (true);
create policy publisher_snapshot_insert on screen_snapshots
  for insert to tieline_capture_publisher with check (ref_kind <> 'main');
create policy publisher_snapshot_update on screen_snapshots
  for update to tieline_capture_publisher
  using (ref_kind <> 'main')
  with check (ref_kind <> 'main');
create policy sync_snapshot_rows on screen_snapshots
  for all to tieline_repository_sync using (true) with check (true);
create policy reader_snapshot_rows on screen_snapshots
  for select to tieline_reader using (true);

grant usage on schema public to tieline_capture_publisher;
grant select (id, key) on repositories to tieline_capture_publisher;
grant select, insert on screen_images, screen_snapshots to tieline_capture_publisher;
grant update (last_referenced_at) on screen_images to tieline_capture_publisher;
grant update (head_commit, manifest, images, page_html, published_at, closed_at)
  on screen_snapshots to tieline_capture_publisher;
grant execute on function tieline_screen_digests_valid(text[])
  to tieline_capture_publisher, tieline_repository_sync;

grant select, insert, update, delete on screen_images, screen_snapshots, screen_history
  to tieline_repository_sync;

grant select on screen_images, screen_snapshots, screen_history to tieline_reader;
