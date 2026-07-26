-- ============================================================================
-- 0010_story_lifecycle_and_approval.sql
-- Current-state stories remain searchable in user_stories. Accepted snapshots,
-- semantic events, and pending human decisions are append-only alongside them.
-- ============================================================================

alter table user_stories
  add column if not exists revision_number int not null default 1;

do $$ begin
  alter table user_stories
    add constraint user_stories_revision_positive check (revision_number > 0);
exception when duplicate_object then null;
end $$;

create table if not exists story_change_proposals (
  id                   bigint generated always as identity primary key,
  story_id             bigint references user_stories(id) on delete restrict,
  proposed_story_key   text,
  operation            text not null check (operation in ('create', 'update', 'relationships')),
  patch_version        int not null default 1 check (patch_version > 0),
  patch                jsonb not null,
  base_revision_number int,
  status               text not null default 'pending'
                         check (status in ('pending', 'approved', 'rejected', 'stale')),
  reason               text,
  proposed_by          text,
  source               text not null default 'mcp',
  decided_by           text,
  decision_note        text,
  created_at           timestamptz not null default now(),
  decided_at           timestamptz,
  check (
    (operation = 'create' and story_id is null and base_revision_number is null and proposed_story_key is not null)
    or
    (operation <> 'create' and story_id is not null and base_revision_number is not null)
  )
);

create unique index if not exists story_change_proposals_pending_key_idx
  on story_change_proposals (proposed_story_key)
  where status = 'pending' and proposed_story_key is not null;
create index if not exists story_change_proposals_review_idx
  on story_change_proposals (status, created_at, id);
create index if not exists story_change_proposals_story_idx
  on story_change_proposals (story_id, created_at desc);

create table if not exists story_revisions (
  id              bigint generated always as identity primary key,
  story_id        bigint not null references user_stories(id) on delete restrict,
  revision_number int not null check (revision_number > 0),
  section_id      bigint not null references sections(id) on delete restrict,
  title           text not null,
  actor           text,
  story_text      text not null,
  status          story_status not null,
  change_reason   text,
  actor_label     text,
  source          text not null default 'system',
  created_at      timestamptz not null default now(),
  unique (story_id, revision_number)
);
create index if not exists story_revisions_story_created_idx
  on story_revisions (story_id, created_at desc, id desc);

create table if not exists story_events (
  id           bigint generated always as identity primary key,
  story_id     bigint references user_stories(id) on delete restrict,
  revision_id  bigint references story_revisions(id) on delete restrict,
  proposal_id  bigint references story_change_proposals(id) on delete restrict,
  event_type   text not null,
  from_status  story_status,
  to_status    story_status,
  details      jsonb not null default '{}'::jsonb,
  actor_label  text,
  source       text not null default 'system',
  created_at   timestamptz not null default now()
);
create index if not exists story_events_story_created_idx
  on story_events (story_id, created_at desc, id desc);
create index if not exists story_events_proposal_idx
  on story_events (proposal_id) where proposal_id is not null;

create table if not exists story_import_refs (
  story_id      bigint not null references user_stories(id) on delete cascade,
  import_source text not null,
  import_ref    text not null,
  created_at    timestamptz not null default now(),
  primary key (import_source, import_ref),
  unique (story_id, import_source, import_ref)
);

-- Baseline snapshots make every pre-lifecycle story immediately auditable.
insert into story_revisions
  (story_id, revision_number, section_id, title, actor, story_text, status,
   change_reason, source, created_at)
select us.id, us.revision_number, us.section_id, us.title, us.actor, us.story_text,
       us.status, 'Lifecycle history baseline', 'migration-0010', us.updated_at
from user_stories us
on conflict (story_id, revision_number) do nothing;

insert into story_events
  (story_id, revision_id, event_type, to_status, details, source, created_at)
select us.id, sr.id, 'baseline_imported', us.status,
       jsonb_build_object('migration', '0010'), 'migration-0010', us.updated_at
from user_stories us
join story_revisions sr
  on sr.story_id = us.id and sr.revision_number = us.revision_number
where not exists (
  select 1 from story_events se
  where se.story_id = us.id and se.event_type = 'baseline_imported'
);

-- Rows in the audit log are immutable even if a future grant is too broad.
create or replace function reject_immutable_story_history()
returns trigger
language plpgsql
as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '55000';
end;
$$;

drop trigger if exists story_revisions_immutable on story_revisions;
create trigger story_revisions_immutable
before update or delete on story_revisions
for each row execute function reject_immutable_story_history();

drop trigger if exists story_events_immutable on story_events;
create trigger story_events_immutable
before update or delete on story_events
for each row execute function reject_immutable_story_history();

-- Key minting must consider reserved keys on pending production-create proposals.
create or replace function mint_story_key(p_section_id bigint)
returns text
language plpgsql
as $$
declare
  v_prefix text;
  v_next int;
begin
  perform pg_advisory_xact_lock(73001, p_section_id::int);
  select key_prefix into v_prefix from sections where id = p_section_id for update;
  if v_prefix is null then
    raise exception 'Section % has no key_prefix', p_section_id;
  end if;

  select coalesce(max(n), 0) + 1 into v_next
  from (
    select nullif(substring(story_key from '([0-9]+)$'), '')::int as n
    from user_stories where section_id = p_section_id
    union all
    select nullif(substring(proposed_story_key from '([0-9]+)$'), '')::int as n
    from story_change_proposals
    where status = 'pending'
      and proposed_story_key like v_prefix || '-%'
  ) keys;
  return v_prefix || '-' || lpad(v_next::text, 3, '0');
end;
$$;

-- Separate roles: ordinary writers can propose; only the approver can execute
-- the narrowly-scoped decision functions below.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'story_lifecycle_owner') then
    create role story_lifecycle_owner nologin nosuperuser nocreatedb nocreaterole;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'mcp_approver') then
    create role mcp_approver login nosuperuser nocreatedb nocreaterole;
  end if;
end $$;

grant usage on schema public to mcp_approver;
grant select on story_change_proposals, user_stories, sections to mcp_approver;
grant usage on schema public to story_lifecycle_owner;
grant select, insert, update on user_stories, story_change_proposals to story_lifecycle_owner;
grant select, insert on story_revisions, story_events to story_lifecycle_owner;
grant select on sections to story_lifecycle_owner;
grant usage, select on all sequences in schema public to story_lifecycle_owner;
alter role story_lifecycle_owner bypassrls;
grant select, insert on story_change_proposals to mcp_writer;
grant select, insert on story_revisions, story_events to mcp_writer;
grant select on story_revisions, story_events, story_change_proposals to mcp_reader;
grant usage, select on all sequences in schema public to mcp_writer;
alter default privileges in schema public grant usage, select on sequences to mcp_writer;

-- Tighten ordinary writes: a writer may edit non-production state, but cannot
-- touch a production row or transition a row into production directly.
drop policy if exists mcp_writer_insert on user_stories;
create policy mcp_writer_insert on user_stories
  for insert to mcp_writer with check (status <> 'production');

drop policy if exists mcp_writer_update on user_stories;
create policy mcp_writer_update on user_stories
  for update to mcp_writer
  using (status <> 'production')
  with check (status <> 'production');

alter table story_change_proposals enable row level security;
drop policy if exists mcp_writer_proposals_select on story_change_proposals;
create policy mcp_writer_proposals_select on story_change_proposals
  for select to mcp_writer using (true);
drop policy if exists mcp_writer_proposals_insert on story_change_proposals;
create policy mcp_writer_proposals_insert on story_change_proposals
  for insert to mcp_writer with check (status = 'pending');
drop policy if exists mcp_reader_proposals_select on story_change_proposals;
create policy mcp_reader_proposals_select on story_change_proposals
  for select to mcp_reader using (true);
drop policy if exists mcp_approver_proposals_select on story_change_proposals;
create policy mcp_approver_proposals_select on story_change_proposals
  for select to mcp_approver using (true);

-- Apply a content/create proposal atomically. Relationship proposals are added
-- to this function by the relationship migration.
create or replace function approve_story_change(
  p_proposal_id bigint,
  p_decided_by text,
  p_decision_note text default null,
  p_embedding vector(384) default null
)
returns table (outcome text, story_id bigint, story_key text, revision_number int)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  p story_change_proposals%rowtype;
  current_story user_stories%rowtype;
  target_section_id bigint;
  new_revision_id bigint;
  old_status story_status;
begin
  select * into p from story_change_proposals where id = p_proposal_id for update;
  if not found then return query select 'not_found'::text, null::bigint, null::text, null::int; return; end if;
  if p.status <> 'pending' then
    return query select p.status, p.story_id, p.proposed_story_key, p.base_revision_number;
    return;
  end if;
  if p.operation = 'relationships' then
    raise exception 'Relationship proposal approval requires migration 0011';
  end if;

  select id into target_section_id from sections where section_key = p.patch->>'section_key';
  if p.operation = 'create' then
    if target_section_id is null then raise exception 'Unknown section_key in proposal %', p.id; end if;
    if p_embedding is null then raise exception 'An embedding is required to approve a story create'; end if;
    insert into user_stories
      (section_id, story_key, title, actor, story_text, status, embedding, revision_number)
    values
      (target_section_id, p.proposed_story_key, p.patch->>'title', p.patch->>'actor',
       p.patch->>'story_text', (p.patch->>'status')::story_status, p_embedding, 1)
    returning * into current_story;
    old_status := null;
  else
    select * into current_story from user_stories where id = p.story_id for update;
    if not found or current_story.revision_number <> p.base_revision_number then
      update story_change_proposals
      set status = 'stale', decided_by = p_decided_by, decision_note = p_decision_note,
          decided_at = now()
      where id = p.id;
      return query select 'stale'::text, p.story_id, p.proposed_story_key,
                          coalesce(current_story.revision_number, p.base_revision_number);
      return;
    end if;
    old_status := current_story.status;
    if p.patch ? 'section_key' then
      if target_section_id is null then raise exception 'Unknown section_key in proposal %', p.id; end if;
    else
      target_section_id := current_story.section_id;
    end if;
    update user_stories us set
      section_id = target_section_id,
      title = case when p.patch ? 'title' then p.patch->>'title' else us.title end,
      actor = case when p.patch ? 'actor' then p.patch->>'actor' else us.actor end,
      story_text = case when p.patch ? 'story_text' then p.patch->>'story_text' else us.story_text end,
      status = case when p.patch ? 'status' then (p.patch->>'status')::story_status else us.status end,
      embedding = case when p_embedding is not null then p_embedding else us.embedding end,
      revision_number = us.revision_number + 1,
      updated_at = now()
    where us.id = p.story_id
    returning * into current_story;
  end if;

  insert into story_revisions
    (story_id, revision_number, section_id, title, actor, story_text, status,
     change_reason, actor_label, source)
  values
    (current_story.id, current_story.revision_number, current_story.section_id,
     current_story.title, current_story.actor, current_story.story_text, current_story.status,
     p.reason, p_decided_by, p.source)
  returning id into new_revision_id;

  update story_change_proposals
  set status = 'approved', story_id = current_story.id, decided_by = p_decided_by,
      decision_note = p_decision_note, decided_at = now()
  where id = p.id;

  insert into story_events
    (story_id, revision_id, proposal_id, event_type, from_status, to_status,
     details, actor_label, source)
  values
    (current_story.id, new_revision_id, p.id,
     case when p.operation = 'create' then 'created' else 'revised' end,
     old_status, current_story.status,
     jsonb_build_object('patch', p.patch, 'approved', true), p_decided_by, p.source);

  return query select 'approved'::text, current_story.id, current_story.story_key,
                      current_story.revision_number;
end;
$$;

create or replace function reject_story_change(
  p_proposal_id bigint,
  p_decided_by text,
  p_decision_note text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare p story_change_proposals%rowtype;
begin
  select * into p from story_change_proposals where id = p_proposal_id for update;
  if not found then return 'not_found'; end if;
  if p.status <> 'pending' then return p.status; end if;
  update story_change_proposals
  set status = 'rejected', decided_by = p_decided_by, decision_note = p_decision_note,
      decided_at = now()
  where id = p.id;
  insert into story_events
    (story_id, proposal_id, event_type, details, actor_label, source)
  values
    (p.story_id, p.id, 'proposal_rejected', jsonb_build_object('note', p_decision_note),
     p_decided_by, p.source);
  return 'rejected';
end;
$$;

alter function approve_story_change(bigint, text, text, vector) owner to story_lifecycle_owner;
alter function reject_story_change(bigint, text, text) owner to story_lifecycle_owner;
revoke all on function approve_story_change(bigint, text, text, vector) from public;
revoke all on function reject_story_change(bigint, text, text) from public;
grant execute on function approve_story_change(bigint, text, text, vector) to mcp_approver;
grant execute on function reject_story_change(bigint, text, text) to mcp_approver;
