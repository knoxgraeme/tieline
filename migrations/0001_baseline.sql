create schema if not exists extensions;
do $$
declare
  installed_schema text;
begin
  select namespace.nspname
    into installed_schema
    from pg_extension extension
    join pg_namespace namespace on namespace.oid = extension.extnamespace
   where extension.extname = 'vector';

  if installed_schema is null then
    execute 'create extension vector with schema extensions';
  elsif installed_schema <> 'extensions' then
    execute 'alter extension vector set schema extensions';
  end if;
end;
$$;
create extension if not exists pgcrypto;

create type contract_authority as enum ('planning', 'repository');
create type story_lifecycle as enum ('backlog', 'in_progress', 'production', 'retired');
create type backlog_stage as enum ('open', 'planned', 'in_progress', 'done', 'declined');
create type observation_kind as enum ('request', 'bug', 'question');
create type attribution_state as enum ('suggested', 'confirmed', 'dismissed');
create type semantic_entity_kind as enum (
  'capability',
  'story',
  'acceptance_criterion',
  'scenario',
  'backlog_item',
  'observation'
);

create table repositories (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'),
  display_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table capabilities (
  id uuid primary key default gen_random_uuid(),
  repository_id uuid not null references repositories(id),
  stable_id text not null,
  name text not null,
  description text not null,
  aliases text[] not null default '{}',
  applies_to jsonb not null default '{}',
  active boolean not null default true,
  superseded_by_id uuid references capabilities(id),
  repository_commit text,
  contract_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (repository_id, stable_id)
);

create table user_stories (
  id uuid primary key default gen_random_uuid(),
  repository_id uuid not null references repositories(id),
  capability_id uuid references capabilities(id),
  stable_id text not null,
  title text not null,
  actor text,
  goal text,
  benefit text,
  lifecycle story_lifecycle not null,
  authority contract_authority not null,
  revision bigint not null default 0 check (revision >= 0),
  materialized_revision bigint check (materialized_revision >= 0),
  aliases text[] not null default '{}',
  applies_to jsonb not null default '{}',
  motivated_by text[] not null default '{}',
  superseded_by_id uuid references user_stories(id),
  repository_commit text,
  contract_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (repository_id, stable_id),
  check (superseded_by_id is null or superseded_by_id <> id),
  check (
    (authority = 'planning' and lifecycle = 'backlog') or
    (authority = 'repository' and lifecycle <> 'backlog')
  ),
  check (
    authority = 'planning' or
    (actor is not null and goal is not null and benefit is not null)
  )
);

create table acceptance_criteria (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references user_stories(id),
  repository_id uuid not null references repositories(id),
  stable_id text not null,
  criterion text,
  rationale text,
  position integer not null default 0 check (position >= 0),
  active boolean not null default true,
  authority contract_authority not null,
  revision bigint not null default 0 check (revision >= 0),
  aliases text[] not null default '{}',
  applies_to jsonb not null default '{}',
  superseded_by_id uuid references acceptance_criteria(id),
  repository_commit text,
  contract_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (repository_id, stable_id),
  check (authority = 'planning' or criterion is not null)
);

create table scenarios (
  id uuid primary key default gen_random_uuid(),
  criterion_id uuid not null references acceptance_criteria(id) on delete cascade,
  stable_id text not null,
  name text,
  given_text text not null,
  when_text text not null,
  then_text text not null,
  position integer not null default 0 check (position >= 0),
  active boolean not null default true,
  authority contract_authority not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (criterion_id, stable_id)
);

create table story_aliases (
  story_id uuid not null references user_stories(id) on delete cascade,
  alias text not null,
  authority contract_authority not null,
  created_at timestamptz not null default now(),
  primary key (story_id, alias)
);

create table criterion_aliases (
  criterion_id uuid not null references acceptance_criteria(id) on delete cascade,
  alias text not null,
  authority contract_authority not null,
  created_at timestamptz not null default now(),
  primary key (criterion_id, alias)
);

create table code_assets (
  id uuid primary key default gen_random_uuid(),
  repository_id uuid not null references repositories(id),
  kind text not null check (kind in ('code', 'test')),
  path text not null check (path !~ '(^/|(^|/)\.\.(/|$))'),
  selector text,
  framework_hint text,
  content_hash text check (
    content_hash is null or content_hash ~ '^[a-f0-9]{64}$'
  ),
  created_at timestamptz not null default now()
);

create unique index code_assets_identity
  on code_assets (repository_id, kind, path, coalesce(selector, ''), coalesce(framework_hint, ''));

create table help_articles (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  external_id text not null,
  title text,
  url text,
  summary text,
  markdown text,
  content_hash text,
  updated_at timestamptz not null default now(),
  unique (source, external_id)
);

create table story_code_assets (
  story_id uuid not null references user_stories(id) on delete cascade,
  asset_id uuid not null references code_assets(id),
  relation text not null check (relation in ('implements', 'enforces', 'tests')),
  reviewed_content_hash text check (
    reviewed_content_hash is null or reviewed_content_hash ~ '^[a-f0-9]{64}$'
  ),
  primary key (story_id, asset_id, relation)
);

create table criterion_code_assets (
  criterion_id uuid not null references acceptance_criteria(id) on delete cascade,
  asset_id uuid not null references code_assets(id),
  relation text not null check (relation in ('implements', 'enforces', 'tests')),
  reviewed_content_hash text check (
    reviewed_content_hash is null or reviewed_content_hash ~ '^[a-f0-9]{64}$'
  ),
  primary key (criterion_id, asset_id, relation)
);

create table story_help_articles (
  story_id uuid not null references user_stories(id) on delete cascade,
  article_id uuid not null references help_articles(id),
  relation text not null default 'documents' check (relation = 'documents'),
  primary key (story_id, article_id)
);

create table criterion_help_articles (
  criterion_id uuid not null references acceptance_criteria(id) on delete cascade,
  article_id uuid not null references help_articles(id),
  relation text not null default 'documents' check (relation = 'documents'),
  primary key (criterion_id, article_id)
);

create table contract_revisions (
  id bigint generated always as identity primary key,
  entity_kind semantic_entity_kind not null,
  entity_id uuid not null,
  revision bigint not null check (revision >= 0),
  authority contract_authority not null,
  content jsonb not null,
  recorded_at timestamptz not null default now(),
  unique (entity_kind, entity_id, revision)
);

create table observations (
  id uuid primary key default gen_random_uuid(),
  kind observation_kind not null,
  schema_key text not null,
  schema_version integer not null check (schema_version > 0),
  summary text not null check (octet_length(summary) <= 4000),
  source text not null,
  external_id text,
  external_url text,
  observed_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  payload jsonb not null default '{}' check (octet_length(payload::text) <= 262144),
  search_text text not null,
  supersedes_observation_id uuid references observations(id),
  redacted_at timestamptz,
  redaction_reason text,
  check (supersedes_observation_id is null or supersedes_observation_id <> id)
);

create unique index observations_external_identity
  on observations (source, external_id)
  where external_id is not null;

create table backlog_items (
  id uuid primary key default gen_random_uuid(),
  stable_id text not null unique,
  title text not null,
  summary text not null,
  stage backlog_stage not null default 'open',
  revision bigint not null default 0 check (revision >= 0),
  superseded_by_id uuid references backlog_items(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (superseded_by_id is null or superseded_by_id <> id)
);

create table observation_story_attributions (
  observation_id uuid not null references observations(id),
  story_id uuid not null references user_stories(id),
  relation text not null check (relation in ('violates', 'requests_change', 'asks_about', 'supports')),
  state attribution_state not null,
  method text not null,
  confidence real check (confidence is null or confidence between 0 and 1),
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (observation_id, story_id, relation)
);

create table observation_criterion_attributions (
  observation_id uuid not null references observations(id),
  criterion_id uuid not null references acceptance_criteria(id),
  relation text not null check (relation in ('violates', 'requests_change', 'asks_about', 'supports')),
  state attribution_state not null,
  method text not null,
  confidence real check (confidence is null or confidence between 0 and 1),
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (observation_id, criterion_id, relation)
);

create table observation_backlog_attributions (
  observation_id uuid not null references observations(id),
  backlog_item_id uuid not null references backlog_items(id),
  relation text not null default 'supports' check (relation = 'supports'),
  state attribution_state not null,
  method text not null,
  confidence real check (confidence is null or confidence between 0 and 1),
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (observation_id, backlog_item_id)
);

create table backlog_story_targets (
  backlog_item_id uuid not null references backlog_items(id),
  story_id uuid not null references user_stories(id),
  created_at timestamptz not null default now(),
  primary key (backlog_item_id, story_id)
);

create table backlog_criterion_targets (
  backlog_item_id uuid not null references backlog_items(id),
  criterion_id uuid not null references acceptance_criteria(id),
  created_at timestamptz not null default now(),
  primary key (backlog_item_id, criterion_id)
);

create table embedding_documents (
  id uuid primary key default gen_random_uuid(),
  entity_kind semantic_entity_kind not null,
  entity_id uuid not null,
  document_kind text not null check (document_kind in ('story', 'acceptance_criterion', 'scenario', 'backlog_item', 'observation')),
  canonical_text text not null,
  search_vector tsvector generated always as (
    to_tsvector('simple', canonical_text)
  ) stored,
  source_text_hash text not null,
  embedding_model text not null,
  embedding_version text not null,
  embedding extensions.vector(384),
  filter_metadata jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  unique (entity_kind, entity_id, document_kind, embedding_model, embedding_version)
);

create index embedding_documents_vector
  on embedding_documents using hnsw (embedding extensions.vector_cosine_ops);
create index embedding_documents_search
  on embedding_documents using gin (search_vector);
create index embedding_documents_filters on embedding_documents using gin (filter_metadata);

create table attribution_suggestions (
  id uuid primary key default gen_random_uuid(),
  source_kind semantic_entity_kind not null,
  source_id uuid not null,
  target_kind semantic_entity_kind not null,
  target_id uuid not null,
  state attribution_state not null default 'suggested',
  method text not null,
  score real check (score is null or score between 0 and 1),
  rationale jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_kind, source_id, target_kind, target_id, method)
);

create index acceptance_criteria_story_graph
  on acceptance_criteria (story_id);
create index observation_story_attributions_target_graph
  on observation_story_attributions (story_id)
  where state = 'confirmed';
create index observation_criterion_attributions_target_graph
  on observation_criterion_attributions (criterion_id)
  where state = 'confirmed';
create index observation_backlog_attributions_target_graph
  on observation_backlog_attributions (backlog_item_id)
  where state = 'confirmed';
create index backlog_story_targets_target_graph
  on backlog_story_targets (story_id);
create index backlog_criterion_targets_target_graph
  on backlog_criterion_targets (criterion_id);
create index attribution_suggestions_target_graph
  on attribution_suggestions (target_kind, target_id)
  where state = 'confirmed';
create index attribution_suggestions_source_graph
  on attribution_suggestions (source_kind, source_id)
  where state = 'confirmed';
create index user_stories_motivated_by_graph
  on user_stories using gin (motivated_by);
create index user_stories_superseded_by_graph
  on user_stories (superseded_by_id)
  where superseded_by_id is not null;
create index acceptance_criteria_superseded_by_graph
  on acceptance_criteria (superseded_by_id)
  where superseded_by_id is not null;
create index backlog_items_superseded_by_graph
  on backlog_items (superseded_by_id)
  where superseded_by_id is not null;
create index observations_supersedes_graph
  on observations (supersedes_observation_id)
  where supersedes_observation_id is not null;

create table retrieval_profiles (
  id uuid primary key default gen_random_uuid(),
  profile_key text not null,
  version integer not null check (version > 0),
  definition jsonb not null,
  active boolean not null default false,
  created_at timestamptz not null default now(),
  created_by text not null,
  unique (profile_key, version)
);

create unique index retrieval_profiles_one_active
  on retrieval_profiles (profile_key)
  where active;

insert into retrieval_profiles (profile_key, version, definition, active, created_by) values
  ('support', 1, '{"authorities":["repository"],"lifecycles":["production"],"include_inactive":false,"observation_attribution_states":["confirmed"],"include":["story","acceptance_criterion","observation"]}', true, 'baseline'),
  ('engineering', 1, '{"authorities":["repository"],"lifecycles":["in_progress","production","retired"],"include_inactive":true,"include":["story","acceptance_criterion","scenario","observation"]}', true, 'baseline'),
  ('discovery', 1, '{"authorities":["planning","repository"],"lifecycles":["backlog","in_progress","production","retired"],"include_inactive":true,"include":["story","acceptance_criterion","scenario","backlog_item","observation"]}', true, 'baseline'),
  ('all', 1, '{"include_inactive":true,"include":["story","acceptance_criterion","scenario","backlog_item","observation"]}', true, 'baseline');

create table repository_sync_checkpoints (
  repository_id uuid primary key references repositories(id),
  commit_sha text not null,
  synced_at timestamptz not null default now()
);

create table handoff_conflicts (
  id uuid primary key default gen_random_uuid(),
  repository_id uuid not null references repositories(id),
  story_id uuid not null references user_stories(id),
  materialized_revision bigint not null,
  later_planning_revision bigint not null,
  merged_content jsonb not null,
  planning_content jsonb not null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (story_id, materialized_revision, later_planning_revision)
);

create table audit_events (
  id bigint generated always as identity primary key,
  event_kind text not null,
  entity_kind semantic_entity_kind,
  entity_id uuid,
  actor text,
  detail jsonb not null default '{}',
  occurred_at timestamptz not null default now()
);

create function tieline_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create function tieline_require_revision_increment() returns trigger
language plpgsql as $$
begin
  if new.revision <> old.revision + 1 then
    raise exception 'revision must increment from % to %', old.revision, old.revision + 1;
  end if;
  return new;
end;
$$;

create trigger user_stories_touch before update on user_stories
  for each row execute function tieline_touch_updated_at();
create trigger user_stories_revision before update on user_stories
  for each row execute function tieline_require_revision_increment();
create trigger acceptance_criteria_touch before update on acceptance_criteria
  for each row execute function tieline_touch_updated_at();
create trigger acceptance_criteria_revision before update on acceptance_criteria
  for each row execute function tieline_require_revision_increment();
create trigger backlog_items_touch before update on backlog_items
  for each row execute function tieline_touch_updated_at();
create trigger backlog_items_revision before update on backlog_items
  for each row execute function tieline_require_revision_increment();

create function tieline_reject_story_supersession_cycle() returns trigger
language plpgsql as $$
declare
  cycle_found boolean;
begin
  if new.authority <> 'planning' or new.superseded_by_id is null then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('tieline-story-supersession'));
  with recursive successors(id, superseded_by_id) as (
    select id, superseded_by_id
    from user_stories
    where id = new.superseded_by_id
    union all
    select story.id, story.superseded_by_id
    from user_stories story
    join successors on story.id = successors.superseded_by_id
  )
  select exists(select 1 from successors where id = new.id)
    into cycle_found;
  if cycle_found then
    raise exception 'story supersession cycle detected for %', new.stable_id;
  end if;
  return new;
end;
$$;

create trigger user_stories_supersession_cycle
  before insert or update on user_stories
  for each row execute function tieline_reject_story_supersession_cycle();

create function tieline_reject_backlog_supersession_cycle() returns trigger
language plpgsql as $$
declare
  cycle_found boolean;
begin
  if new.superseded_by_id is null then
    return new;
  end if;
  with recursive successors(id, superseded_by_id) as (
    select id, superseded_by_id
    from backlog_items
    where id = new.superseded_by_id
    union all
    select item.id, item.superseded_by_id
    from backlog_items item
    join successors on item.id = successors.superseded_by_id
  )
  select exists(select 1 from successors where id = new.id)
    into cycle_found;
  if cycle_found then
    raise exception 'backlog supersession cycle detected for %', new.stable_id;
  end if;
  return new;
end;
$$;

create trigger backlog_items_supersession_cycle
  before insert or update on backlog_items
  for each row execute function tieline_reject_backlog_supersession_cycle();

create function tieline_observations_append_only() returns trigger
language plpgsql as $$
begin
  if current_setting('tieline.retention_write', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'observations are append-only';
end;
$$;

create trigger observations_append_only
  before update or delete on observations
  for each row execute function tieline_observations_append_only();

create function redact_observation_payload(p_observation_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform set_config('tieline.retention_write', 'on', true);
  update observations
     set summary = '[redacted]',
         payload = '{}'::jsonb,
         search_text = '[redacted]',
         redacted_at = now(),
         redaction_reason = p_reason
   where id = p_observation_id;
  if not found then
    raise exception 'observation % not found', p_observation_id;
  end if;
  insert into audit_events (event_kind, entity_kind, entity_id, detail)
    values ('observation_payload_redacted', 'observation', p_observation_id, jsonb_build_object('reason', p_reason));
end;
$$;

revoke all on function redact_observation_payload(uuid, text) from public;

create view observation_search as
select
  id,
  kind,
  schema_key,
  schema_version,
  summary,
  source,
  external_id,
  external_url,
  observed_at,
  recorded_at,
  search_text,
  supersedes_observation_id,
  redacted_at
from observations;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'tieline_reader') then
    create role tieline_reader nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'tieline_planning_writer') then
    create role tieline_planning_writer nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'tieline_repository_sync') then
    create role tieline_repository_sync nologin;
  end if;
end;
$$;

revoke all on all tables in schema public from public;
revoke all on all sequences in schema public from public;
revoke update, delete on observations from tieline_planning_writer;

grant usage on schema public, extensions to tieline_reader, tieline_planning_writer, tieline_repository_sync;

grant select on
  repositories,
  capabilities,
  user_stories,
  acceptance_criteria,
  scenarios,
  story_aliases,
  criterion_aliases,
  code_assets,
  help_articles,
  story_code_assets,
  criterion_code_assets,
  story_help_articles,
  criterion_help_articles,
  contract_revisions,
  backlog_items,
  observation_story_attributions,
  observation_criterion_attributions,
  observation_backlog_attributions,
  backlog_story_targets,
  backlog_criterion_targets,
  embedding_documents,
  attribution_suggestions,
  retrieval_profiles,
  repository_sync_checkpoints,
  handoff_conflicts,
  audit_events,
  observation_search
to tieline_reader;

grant select on
  repositories,
  capabilities,
  user_stories,
  acceptance_criteria,
  scenarios,
  story_aliases,
  criterion_aliases,
  contract_revisions,
  code_assets,
  help_articles,
  story_code_assets,
  criterion_code_assets,
  story_help_articles,
  criterion_help_articles,
  observation_search,
  backlog_items,
  observation_story_attributions,
  observation_criterion_attributions,
  observation_backlog_attributions,
  backlog_story_targets,
  backlog_criterion_targets,
  embedding_documents,
  attribution_suggestions,
  retrieval_profiles
to tieline_planning_writer;

grant insert, update on
  user_stories,
  acceptance_criteria,
  scenarios,
  story_aliases,
  criterion_aliases,
  backlog_items,
  observation_story_attributions,
  observation_criterion_attributions,
  observation_backlog_attributions,
  backlog_story_targets,
  backlog_criterion_targets,
  embedding_documents,
  attribution_suggestions
to tieline_planning_writer;
grant insert on observations, contract_revisions, audit_events to tieline_planning_writer;
grant select (id, source, external_id) on observations to tieline_planning_writer;
grant delete on
  scenarios,
  story_aliases,
  criterion_aliases,
  observation_backlog_attributions,
  backlog_story_targets,
  backlog_criterion_targets
to tieline_planning_writer;
grant usage, select on all sequences in schema public to tieline_planning_writer;

grant select, insert, update on
  repositories,
  capabilities,
  user_stories,
  acceptance_criteria,
  scenarios,
  story_aliases,
  criterion_aliases,
  code_assets,
  help_articles,
  story_code_assets,
  criterion_code_assets,
  story_help_articles,
  criterion_help_articles,
  contract_revisions,
  embedding_documents,
  repository_sync_checkpoints,
  handoff_conflicts,
  audit_events
to tieline_repository_sync;
grant delete on
  story_aliases,
  criterion_aliases,
  story_code_assets,
  criterion_code_assets,
  story_help_articles,
  criterion_help_articles
to tieline_repository_sync;
grant usage, select on all sequences in schema public to tieline_repository_sync;

alter table user_stories enable row level security;
alter table acceptance_criteria enable row level security;
alter table scenarios enable row level security;
alter table story_aliases enable row level security;
alter table criterion_aliases enable row level security;
alter table observations enable row level security;
alter table backlog_items enable row level security;
alter table observation_story_attributions enable row level security;
alter table observation_criterion_attributions enable row level security;
alter table observation_backlog_attributions enable row level security;
alter table backlog_story_targets enable row level security;
alter table backlog_criterion_targets enable row level security;
alter table attribution_suggestions enable row level security;

create policy planning_story_rows on user_stories
  for all to tieline_planning_writer
  using (authority = 'planning' and lifecycle = 'backlog')
  with check (authority = 'planning' and lifecycle = 'backlog');

create policy planning_story_reference_rows on user_stories
  for select to tieline_planning_writer
  using (true);

create policy sync_story_rows on user_stories
  for all to tieline_repository_sync
  using (true)
  with check (true);

create policy planning_criterion_rows on acceptance_criteria
  for all to tieline_planning_writer
  using (authority = 'planning')
  with check (
    authority = 'planning' and
    exists (
      select 1 from user_stories
      where user_stories.id = acceptance_criteria.story_id
        and user_stories.authority = 'planning'
        and user_stories.lifecycle = 'backlog'
    )
  );

create policy planning_criterion_reference_rows on acceptance_criteria
  for select to tieline_planning_writer
  using (true);

create policy sync_criterion_rows on acceptance_criteria
  for all to tieline_repository_sync
  using (true)
  with check (true);

create policy planning_scenario_rows on scenarios
  for all to tieline_planning_writer
  using (authority = 'planning')
  with check (
    authority = 'planning' and
    exists (
      select 1
      from acceptance_criteria
      where acceptance_criteria.id = scenarios.criterion_id
        and acceptance_criteria.authority = 'planning'
    )
  );

create policy sync_scenario_rows on scenarios
  for all to tieline_repository_sync
  using (true)
  with check (true);

create policy planning_story_alias_rows on story_aliases
  for all to tieline_planning_writer
  using (authority = 'planning')
  with check (
    authority = 'planning' and
    exists (
      select 1 from user_stories
      where user_stories.id = story_aliases.story_id
        and user_stories.authority = 'planning'
    )
  );

create policy sync_story_alias_rows on story_aliases
  for all to tieline_repository_sync
  using (true)
  with check (true);

create policy planning_criterion_alias_rows on criterion_aliases
  for all to tieline_planning_writer
  using (authority = 'planning')
  with check (
    authority = 'planning' and
    exists (
      select 1 from acceptance_criteria
      where acceptance_criteria.id = criterion_aliases.criterion_id
        and acceptance_criteria.authority = 'planning'
    )
  );

create policy sync_criterion_alias_rows on criterion_aliases
  for all to tieline_repository_sync
  using (true)
  with check (true);

create policy planning_observation_select on observations
  for select to tieline_planning_writer using (true);
create policy planning_observation_insert on observations
  for insert to tieline_planning_writer with check (true);

create policy planning_backlog_rows on backlog_items
  for all to tieline_planning_writer using (true) with check (true);
create policy planning_observation_story_rows on observation_story_attributions
  for all to tieline_planning_writer using (true) with check (true);
create policy planning_observation_criterion_rows on observation_criterion_attributions
  for all to tieline_planning_writer using (true) with check (true);
create policy planning_observation_backlog_rows on observation_backlog_attributions
  for all to tieline_planning_writer using (true) with check (true);
create policy planning_backlog_story_rows on backlog_story_targets
  for all to tieline_planning_writer using (true) with check (true);
create policy planning_backlog_criterion_rows on backlog_criterion_targets
  for all to tieline_planning_writer using (true) with check (true);
create policy planning_suggestion_rows on attribution_suggestions
  for all to tieline_planning_writer using (true) with check (true);

create policy reader_story_rows on user_stories
  for select to tieline_reader using (true);
create policy reader_criterion_rows on acceptance_criteria
  for select to tieline_reader using (true);
create policy reader_scenario_rows on scenarios
  for select to tieline_reader using (true);
create policy reader_story_alias_rows on story_aliases
  for select to tieline_reader using (true);
create policy reader_criterion_alias_rows on criterion_aliases
  for select to tieline_reader using (true);
create policy reader_observation_rows on observations
  for select to tieline_reader using (true);
create policy reader_backlog_rows on backlog_items
  for select to tieline_reader using (true);
create policy reader_observation_story_rows on observation_story_attributions
  for select to tieline_reader using (true);
create policy reader_observation_criterion_rows on observation_criterion_attributions
  for select to tieline_reader using (true);
create policy reader_observation_backlog_rows on observation_backlog_attributions
  for select to tieline_reader using (true);
create policy reader_backlog_story_rows on backlog_story_targets
  for select to tieline_reader using (true);
create policy reader_backlog_criterion_rows on backlog_criterion_targets
  for select to tieline_reader using (true);
create policy reader_suggestion_rows on attribution_suggestions
  for select to tieline_reader using (true);
