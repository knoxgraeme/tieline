-- Immutable topology generations and their narrow read/write role boundaries.

create table code_topology_generations (
  identity text primary key check (identity ~ '^[a-f0-9]{64}$'),
  repository_id uuid not null references repositories(id),
  revision text not null check (revision ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
  inventory_digest text not null check (inventory_digest ~ '^[a-f0-9]{64}$'),
  parser_compatibility_digest text not null check (parser_compatibility_digest ~ '^[a-f0-9]{64}$'),
  resolver_implementation text not null check (resolver_implementation <> ''),
  resolver_configuration_digest text not null check (resolver_configuration_digest ~ '^[a-f0-9]{64}$'),
  topology_schema_version integer not null check (topology_schema_version > 0),
  fact_policy_digest text not null check (fact_policy_digest ~ '^[a-f0-9]{64}$'),
  facts_digest text not null check (facts_digest ~ '^[a-f0-9]{64}$'),
  expected_file_count integer not null check (expected_file_count >= 0),
  expected_symbol_count integer not null check (expected_symbol_count >= 0),
  expected_reference_count integer not null check (expected_reference_count >= 0),
  expected_resolution_count integer not null check (expected_resolution_count >= 0),
  expected_edge_count integer not null check (expected_edge_count >= 0),
  complete boolean not null default false,
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (repository_id, identity),
  unique (
    repository_id,
    revision,
    inventory_digest,
    parser_compatibility_digest,
    resolver_implementation,
    resolver_configuration_digest,
    topology_schema_version,
    fact_policy_digest
  ),
  check (complete = (completed_at is not null))
);

create table code_topology_files (
  generation_identity text not null references code_topology_generations(identity) on delete cascade,
  path text not null check (path !~ '(^/|(^|/)\.\.(/|$))'),
  asset_kind text not null check (asset_kind in ('code', 'test')),
  framework_hint text,
  language text not null check (language in ('javascript', 'jsx', 'typescript', 'tsx', 'python', 'rust')),
  source_hash text not null check (source_hash ~ '^[a-f0-9]{64}$'),
  parser_identity text not null,
  diagnostics jsonb not null default '[]',
  symbols_truncated boolean not null default false,
  references_truncated boolean not null default false,
  diagnostics_truncated boolean not null default false,
  primary key (generation_identity, path)
);

create table code_topology_symbols (
  generation_identity text not null references code_topology_generations(identity) on delete cascade,
  identity text not null,
  file_path text not null,
  name text,
  native_kind text not null,
  kind text not null check (kind in ('class', 'const', 'function', 'method', 'module', 'type', 'variable')),
  canonical_selector text,
  owner_identity text,
  owner_chain jsonb not null default '[]',
  name_range jsonb,
  body_range jsonb,
  syntax_status text not null check (syntax_status in ('exact', 'recovered')),
  primary key (generation_identity, identity),
  foreign key (generation_identity, file_path)
    references code_topology_files(generation_identity, path) on delete cascade,
  foreign key (generation_identity, owner_identity)
    references code_topology_symbols(generation_identity, identity)
    deferrable initially deferred
);

create table code_topology_references (
  generation_identity text not null references code_topology_generations(identity) on delete cascade,
  identity text not null,
  file_path text not null,
  owner_symbol_identity text,
  kind text not null check (kind in ('import', 'dynamic_import', 'export', 'reexport')),
  native_kind text not null,
  module_specifier text,
  module_specifier_range jsonb,
  statement_range jsonb,
  is_type_only boolean not null default false,
  bindings jsonb not null default '[]',
  primary key (generation_identity, identity),
  foreign key (generation_identity, file_path)
    references code_topology_files(generation_identity, path) on delete cascade,
  foreign key (generation_identity, owner_symbol_identity)
    references code_topology_symbols(generation_identity, identity)
);

create table code_topology_resolutions (
  generation_identity text not null references code_topology_generations(identity) on delete cascade,
  reference_identity text not null,
  status text not null check (status in ('resolved', 'ambiguous', 'unresolved', 'external')),
  rule text not null,
  resolver_configuration_digest text not null check (resolver_configuration_digest ~ '^[a-f0-9]{64}$'),
  target_file_path text,
  target_symbol_identity text,
  candidate_targets jsonb not null default '[]',
  diagnostics jsonb not null default '[]',
  primary key (generation_identity, reference_identity),
  foreign key (generation_identity, reference_identity)
    references code_topology_references(generation_identity, identity) on delete cascade,
  foreign key (generation_identity, target_file_path)
    references code_topology_files(generation_identity, path),
  foreign key (generation_identity, target_symbol_identity)
    references code_topology_symbols(generation_identity, identity)
);

create table code_topology_edges (
  generation_identity text not null references code_topology_generations(identity) on delete cascade,
  identity text not null,
  kind text not null,
  source_symbol_identity text not null,
  target_symbol_identity text not null,
  reference_identity text,
  primary key (generation_identity, identity),
  foreign key (generation_identity, source_symbol_identity)
    references code_topology_symbols(generation_identity, identity),
  foreign key (generation_identity, target_symbol_identity)
    references code_topology_symbols(generation_identity, identity),
  foreign key (generation_identity, reference_identity)
    references code_topology_references(generation_identity, identity)
);

create index code_topology_symbols_locator
  on code_topology_symbols (generation_identity, file_path, canonical_selector)
  include (identity, kind, name);
create index code_topology_references_file
  on code_topology_references (generation_identity, file_path)
  include (identity, module_specifier, kind);
create index code_topology_edges_forward
  on code_topology_edges (generation_identity, source_symbol_identity)
  include (target_symbol_identity, kind, reference_identity);
create index code_topology_edges_reverse
  on code_topology_edges (generation_identity, target_symbol_identity)
  include (source_symbol_identity, kind, reference_identity);

create table code_topology_checkpoints (
  repository_id uuid primary key references repositories(id),
  generation_identity text not null,
  promoted_at timestamptz not null default now(),
  foreign key (repository_id, generation_identity)
    references code_topology_generations(repository_id, identity)
);

create view complete_code_topology_generations as
select * from code_topology_generations where complete;

create view complete_code_topology_files as
select file.*
from code_topology_files file
join code_topology_generations generation
  on generation.identity = file.generation_identity
where generation.complete;

create view complete_code_topology_symbols as
select symbol.*
from code_topology_symbols symbol
join code_topology_generations generation
  on generation.identity = symbol.generation_identity
where generation.complete;

create view complete_code_topology_references as
select reference.*
from code_topology_references reference
join code_topology_generations generation
  on generation.identity = reference.generation_identity
where generation.complete;

create view complete_code_topology_resolutions as
select resolution.*
from code_topology_resolutions resolution
join code_topology_generations generation
  on generation.identity = resolution.generation_identity
where generation.complete;

create view complete_code_topology_edges as
select edge.*
from code_topology_edges edge
join code_topology_generations generation
  on generation.identity = edge.generation_identity
where generation.complete;

create function tieline_require_incomplete_topology_generation() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  invalid_generation text;
  invalid_complete boolean;
begin
  select batch.generation_identity, generation.complete
    into invalid_generation, invalid_complete
    from (select distinct generation_identity from inserted) batch
    left join code_topology_generations generation
      on generation.identity = batch.generation_identity
   where generation.identity is null or generation.complete
   limit 1;
  if invalid_generation is null then
    return null;
  end if;
  if invalid_complete is null then
    raise exception 'topology generation % does not exist', invalid_generation;
  end if;
  raise exception 'topology generation % is immutable', invalid_generation;
end;
$$;

create trigger code_topology_files_incomplete
  after insert on code_topology_files
  referencing new table as inserted
  for each statement execute function tieline_require_incomplete_topology_generation();
create trigger code_topology_symbols_incomplete
  after insert on code_topology_symbols
  referencing new table as inserted
  for each statement execute function tieline_require_incomplete_topology_generation();
create trigger code_topology_references_incomplete
  after insert on code_topology_references
  referencing new table as inserted
  for each statement execute function tieline_require_incomplete_topology_generation();
create trigger code_topology_resolutions_incomplete
  after insert on code_topology_resolutions
  referencing new table as inserted
  for each statement execute function tieline_require_incomplete_topology_generation();
create trigger code_topology_edges_incomplete
  after insert on code_topology_edges
  referencing new table as inserted
  for each statement execute function tieline_require_incomplete_topology_generation();

create function promote_code_topology_generation(
  p_repository_id uuid,
  p_generation_identity text,
  p_expected_previous_generation_identity text
) returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  generation_row code_topology_generations%rowtype;
  current_identity text;
  observed_count bigint;
begin
  perform pg_advisory_xact_lock(hashtext('tieline-topology:' || p_repository_id::text));
  select generation_identity
    into current_identity
    from code_topology_checkpoints
   where repository_id = p_repository_id
   for update;
  if current_identity is distinct from p_expected_previous_generation_identity
     and current_identity is distinct from p_generation_identity then
    raise exception 'topology checkpoint changed: expected %, found %',
      coalesce(p_expected_previous_generation_identity, 'no generation'),
      coalesce(current_identity, 'no generation');
  end if;

  select *
    into generation_row
    from code_topology_generations
   where repository_id = p_repository_id
     and identity = p_generation_identity
   for update;
  if not found then
    raise exception 'topology generation % not found', p_generation_identity;
  end if;

  if not generation_row.complete then
    select count(*) into observed_count from code_topology_files
      where generation_identity = p_generation_identity;
    if observed_count <> generation_row.expected_file_count then
      raise exception 'topology file count mismatch: expected %, found %',
        generation_row.expected_file_count, observed_count;
    end if;
    select count(*) into observed_count from code_topology_symbols
      where generation_identity = p_generation_identity;
    if observed_count <> generation_row.expected_symbol_count then
      raise exception 'topology symbol count mismatch: expected %, found %',
        generation_row.expected_symbol_count, observed_count;
    end if;
    select count(*) into observed_count from code_topology_references
      where generation_identity = p_generation_identity;
    if observed_count <> generation_row.expected_reference_count then
      raise exception 'topology reference count mismatch: expected %, found %',
        generation_row.expected_reference_count, observed_count;
    end if;
    select count(*) into observed_count from code_topology_resolutions
      where generation_identity = p_generation_identity;
    if observed_count <> generation_row.expected_resolution_count then
      raise exception 'topology resolution count mismatch: expected %, found %',
        generation_row.expected_resolution_count, observed_count;
    end if;
    select count(*) into observed_count from code_topology_edges
      where generation_identity = p_generation_identity;
    if observed_count <> generation_row.expected_edge_count then
      raise exception 'topology edge count mismatch: expected %, found %',
        generation_row.expected_edge_count, observed_count;
    end if;
    if exists (
      select 1 from code_topology_resolutions
       where generation_identity = p_generation_identity
         and resolver_configuration_digest <> generation_row.resolver_configuration_digest
    ) then
      raise exception 'topology resolver metadata mismatch for generation %', p_generation_identity;
    end if;
    if generation_row.expected_reference_count <> generation_row.expected_resolution_count then
      raise exception 'every topology reference requires one resolution outcome';
    end if;
    update code_topology_generations
       set complete = true,
           completed_at = now()
     where identity = p_generation_identity;
  end if;

  insert into code_topology_checkpoints (
    repository_id, generation_identity, promoted_at
  ) values (
    p_repository_id, p_generation_identity, now()
  )
  on conflict (repository_id) do update
    set generation_identity = excluded.generation_identity,
        promoted_at = excluded.promoted_at;
  insert into audit_events (event_kind, detail)
    values (
      'code_topology_generation_promoted',
      jsonb_build_object(
        'repository_id', p_repository_id,
        'generation_identity', p_generation_identity,
        'previous_generation_identity', current_identity
      )
    );
  return current_identity;
end;
$$;

revoke all on function promote_code_topology_generation(uuid, text, text) from public;

create function gc_code_topology_generations(
  p_repository_id uuid,
  p_generation_identities text[]
) returns table (generation_identity text, protected boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_identity text;
  candidate text;
  candidate_pinned boolean;
begin
  perform pg_advisory_xact_lock(hashtext('tieline-topology:' || p_repository_id::text));
  select checkpoint.generation_identity
    into current_identity
    from code_topology_checkpoints checkpoint
   where checkpoint.repository_id = p_repository_id
   for update;
  foreach candidate in array p_generation_identities loop
    select generation.pinned
      into candidate_pinned
      from code_topology_generations generation
     where generation.repository_id = p_repository_id
       and generation.identity = candidate
     for update;
    if not found then
      continue;
    end if;
    generation_identity := candidate;
    protected := candidate = current_identity or candidate_pinned;
    if not protected then
      delete from code_topology_generations generation
       where generation.repository_id = p_repository_id
         and generation.identity = candidate;
    end if;
    return next;
  end loop;
end;
$$;

revoke all on function gc_code_topology_generations(uuid, text[]) from public;

create function pin_code_topology_generation(
  p_repository_id uuid,
  p_generation_identity text,
  p_pinned boolean
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update code_topology_generations
     set pinned = p_pinned
   where repository_id = p_repository_id
     and identity = p_generation_identity
     and complete;
  return found;
end;
$$;

revoke all on function pin_code_topology_generation(uuid, text, boolean) from public;

grant select on
  code_topology_checkpoints,
  complete_code_topology_generations,
  complete_code_topology_files,
  complete_code_topology_symbols,
  complete_code_topology_references,
  complete_code_topology_resolutions,
  complete_code_topology_edges
to tieline_reader;

grant select on
  code_topology_generations,
  code_topology_files,
  code_topology_symbols,
  code_topology_references,
  code_topology_resolutions,
  code_topology_edges,
  code_topology_checkpoints,
  complete_code_topology_generations,
  complete_code_topology_files,
  complete_code_topology_symbols,
  complete_code_topology_references,
  complete_code_topology_resolutions,
  complete_code_topology_edges
to tieline_repository_sync;

grant insert (
  identity, repository_id, revision, inventory_digest,
  parser_compatibility_digest, resolver_implementation,
  resolver_configuration_digest, topology_schema_version,
  fact_policy_digest, facts_digest, expected_file_count,
  expected_symbol_count, expected_reference_count,
  expected_resolution_count, expected_edge_count
) on code_topology_generations to tieline_repository_sync;

grant insert on
  code_topology_files,
  code_topology_symbols,
  code_topology_references,
  code_topology_resolutions,
  code_topology_edges
to tieline_repository_sync;

grant execute on function promote_code_topology_generation(uuid, text, text)
  to tieline_repository_sync;
