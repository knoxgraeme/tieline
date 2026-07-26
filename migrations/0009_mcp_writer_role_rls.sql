-- ============================================================================
-- 0009_mcp_writer_role_rls.sql
-- Two dedicated, least-privilege roles + row-level security:
--   * mcp_writer — the agent-facing WRITE tools (INSERT/UPDATE, no DELETE).
--   * mcp_reader — the read path (SELECT only); point DATABASE_URL here.
-- Run after 0008.
--
-- WRITE role (mcp_writer): can INSERT/UPDATE stories, feature requests, and their
-- links, and can create stories with ANY lifecycle status (production included) —
-- status is the author's deliberate choice, not a lock. The remaining guardrails:
--   * no DELETE anywhere (the grant is simply never given), and
--   * a separate connection/credential from the owner/read path (auditing +
--     blast-radius), with RLS enabled so a fresh Supabase project's default-deny
--     still applies to any other roles (e.g. anon / authenticated via PostgREST).
--
-- READ role (mcp_reader): a symmetric least-privilege role for the server's read
-- path. It has SELECT everywhere plus a permissive `for select ... using (true)`
-- policy on every RLS-enabled table it reads, so RLS's default-deny does NOT
-- silently return zero rows. Point DATABASE_URL at mcp_reader (or at the owner,
-- which bypasses RLS) — a bare least-privilege role with NO policy would read
-- nothing once RLS is on.
--
-- RLS is enabled on the four tables that carry policies here: user_stories,
-- sections, feature_requests, feature_request_story_links. That is the complete
-- set of tables 0009 defines policies for; per the "never enable RLS without a
-- matching reader policy" rule we do NOT enable RLS on the other tables
-- (entities, code_assets, story_entities, story_code_assets, help_articles,
-- story_help_articles), which stay reachable via the plain SELECT grant.
--
-- The owner (postgres) — used by migrate and ingest — bypasses RLS (policies are
-- not FORCEd), so those paths are unaffected regardless of which role reads.
--
-- CREDENTIAL: this migration creates both roles with NO password (no secret in
-- the repo). Set one out-of-band before pointing a DATABASE_URL* at a role, e.g.
--   ALTER ROLE mcp_writer LOGIN PASSWORD '<your-secret>';
--   ALTER ROLE mcp_reader LOGIN PASSWORD '<your-secret>';
-- or manage auth via your platform (IAM/Vault/etc.). On a trust-auth local dev
-- database the roles work immediately with no password. Until DATABASE_URL_WRITE
-- is configured, the write tools are disabled and reads are unaffected.
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mcp_writer') then
    create role mcp_writer login nosuperuser nocreatedb nocreaterole;
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mcp_reader') then
    create role mcp_reader login nosuperuser nocreatedb nocreaterole;
  end if;
end $$;

grant usage on schema public to mcp_writer;
grant select on all tables in schema public to mcp_writer;

-- Read role: SELECT on everything the read tools touch. Tables without RLS
-- (entities, code_assets, join tables, help_articles, ...) are served by this
-- grant alone; RLS-enabled tables additionally need the reader policies below.
grant usage on schema public to mcp_reader;
grant select on all tables in schema public to mcp_reader;

-- Write access — INSERT/UPDATE only (no DELETE grant), on the three write tables.
grant insert, update on user_stories to mcp_writer;
grant insert, update on feature_requests to mcp_writer;
grant insert, update on feature_request_story_links to mcp_writer;
grant execute on function mint_story_key(bigint) to mcp_writer;

-- Identity-backed INSERTs call nextval() on their backing sequences. Table
-- INSERT alone is insufficient: a clean least-privilege install must grant the
-- writer sequence USAGE (and SELECT for currval/diagnostics) explicitly.
grant usage, select on all sequences in schema public to mcp_writer;

-- Cover sequences created by later migrations run by this migration owner.
alter default privileges in schema public
  grant usage, select on sequences to mcp_writer;

-- ============================================================================
-- Row-level security. Enabled on exactly the four tables that carry policies
-- below. The owner bypasses RLS; mcp_writer gets its write/read policies and
-- mcp_reader gets a permissive SELECT policy so the read path is never
-- default-denied to empty results.
-- ============================================================================

-- --- user_stories -----------------------------------------------------------
alter table user_stories enable row level security;

drop policy if exists mcp_writer_select on user_stories;
create policy mcp_writer_select on user_stories
  for select to mcp_writer using (true);

drop policy if exists mcp_writer_insert on user_stories;
create policy mcp_writer_insert on user_stories
  for insert to mcp_writer with check (true);

drop policy if exists mcp_writer_update on user_stories;
create policy mcp_writer_update on user_stories
  for update to mcp_writer using (true) with check (true);

drop policy if exists mcp_reader_select on user_stories;
create policy mcp_reader_select on user_stories
  for select to mcp_reader using (true);

-- --- sections ---------------------------------------------------------------
-- RLS enabled so the default-deny is real on a fresh Supabase project. The read
-- path (query_stories joins, find_crossover, create/update section lookups) and
-- the writer's section_key validation both need a matching SELECT policy.
alter table sections enable row level security;

drop policy if exists mcp_writer_sections_select on sections;
create policy mcp_writer_sections_select on sections
  for select to mcp_writer using (true);

drop policy if exists mcp_reader_sections_select on sections;
create policy mcp_reader_sections_select on sections
  for select to mcp_reader using (true);

-- --- feature_requests + links -----------------------------------------------
-- feature_requests + links: fully agent-owned evidence/bridge tables. RLS is
-- enabled here (it was not before, so the writer's FOR ALL policies were inert
-- and anon/authenticated could read/write on Supabase). The DELETE block comes
-- from withholding the grant, not policy, so FOR ALL is safe for the writer.
-- The read path reads both inline (query_stories feature_requests, getFeatureRequest),
-- so mcp_reader needs a SELECT policy on each.
alter table feature_requests enable row level security;

drop policy if exists mcp_writer_feature_requests_all on feature_requests;
create policy mcp_writer_feature_requests_all on feature_requests
  for all to mcp_writer using (true) with check (true);

drop policy if exists mcp_reader_feature_requests_select on feature_requests;
create policy mcp_reader_feature_requests_select on feature_requests
  for select to mcp_reader using (true);

alter table feature_request_story_links enable row level security;

drop policy if exists mcp_writer_fr_links_all on feature_request_story_links;
create policy mcp_writer_fr_links_all on feature_request_story_links
  for all to mcp_writer using (true) with check (true);

drop policy if exists mcp_reader_fr_links_select on feature_request_story_links;
create policy mcp_reader_fr_links_select on feature_request_story_links
  for select to mcp_reader using (true);
