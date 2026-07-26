-- ============================================================================
-- 0011_typed_story_relationships.sql
-- Typed add/remove/replace operations over normalized story relationships.
-- ============================================================================

grant select, insert, update on entities, code_assets to mcp_writer;
grant select, insert, update, delete on story_entities, story_code_assets, story_help_articles to mcp_writer;
grant usage, select on all sequences in schema public to mcp_writer;
grant delete on feature_request_story_links to mcp_writer;
grant select, insert, update on entities, code_assets to story_lifecycle_owner;
grant select on help_articles to story_lifecycle_owner;
grant select, insert, update, delete on story_entities, story_code_assets, story_help_articles
  to story_lifecycle_owner;
grant execute on function refresh_document_frequencies() to story_lifecycle_owner;

-- Parent-aware RLS ensures direct relationship writes cannot mutate production.
alter table story_entities enable row level security;
drop policy if exists mcp_reader_story_entities_select on story_entities;
create policy mcp_reader_story_entities_select on story_entities for select to mcp_reader using (true);
drop policy if exists mcp_writer_story_entities_select on story_entities;
create policy mcp_writer_story_entities_select on story_entities for select to mcp_writer using (true);
drop policy if exists mcp_writer_story_entities_insert on story_entities;
create policy mcp_writer_story_entities_insert on story_entities for insert to mcp_writer
  with check (exists (select 1 from user_stories us where us.id = story_id and us.status <> 'production'));
drop policy if exists mcp_writer_story_entities_update on story_entities;
create policy mcp_writer_story_entities_update on story_entities for update to mcp_writer
  using (exists (select 1 from user_stories us where us.id = story_id and us.status <> 'production'))
  with check (exists (select 1 from user_stories us where us.id = story_id and us.status <> 'production'));
drop policy if exists mcp_writer_story_entities_delete on story_entities;
create policy mcp_writer_story_entities_delete on story_entities for delete to mcp_writer
  using (exists (select 1 from user_stories us where us.id = story_id and us.status <> 'production'));

alter table story_code_assets enable row level security;
drop policy if exists mcp_reader_story_code_assets_select on story_code_assets;
create policy mcp_reader_story_code_assets_select on story_code_assets for select to mcp_reader using (true);
drop policy if exists mcp_writer_story_code_assets_select on story_code_assets;
create policy mcp_writer_story_code_assets_select on story_code_assets for select to mcp_writer using (true);
drop policy if exists mcp_writer_story_code_assets_insert on story_code_assets;
create policy mcp_writer_story_code_assets_insert on story_code_assets for insert to mcp_writer
  with check (exists (select 1 from user_stories us where us.id = story_id and us.status <> 'production'));
drop policy if exists mcp_writer_story_code_assets_update on story_code_assets;
create policy mcp_writer_story_code_assets_update on story_code_assets for update to mcp_writer
  using (exists (select 1 from user_stories us where us.id = story_id and us.status <> 'production'))
  with check (exists (select 1 from user_stories us where us.id = story_id and us.status <> 'production'));
drop policy if exists mcp_writer_story_code_assets_delete on story_code_assets;
create policy mcp_writer_story_code_assets_delete on story_code_assets for delete to mcp_writer
  using (exists (select 1 from user_stories us where us.id = story_id and us.status <> 'production'));

alter table story_help_articles enable row level security;
drop policy if exists mcp_reader_story_help_articles_select on story_help_articles;
create policy mcp_reader_story_help_articles_select on story_help_articles for select to mcp_reader using (true);
drop policy if exists mcp_writer_story_help_articles_select on story_help_articles;
create policy mcp_writer_story_help_articles_select on story_help_articles for select to mcp_writer using (true);
drop policy if exists mcp_writer_story_help_articles_insert on story_help_articles;
create policy mcp_writer_story_help_articles_insert on story_help_articles for insert to mcp_writer
  with check (exists (select 1 from user_stories us where us.id = story_id and us.status <> 'production'));
drop policy if exists mcp_writer_story_help_articles_update on story_help_articles;
create policy mcp_writer_story_help_articles_update on story_help_articles for update to mcp_writer
  using (exists (select 1 from user_stories us where us.id = story_id and us.status <> 'production'))
  with check (exists (select 1 from user_stories us where us.id = story_id and us.status <> 'production'));
drop policy if exists mcp_writer_story_help_articles_delete on story_help_articles;
create policy mcp_writer_story_help_articles_delete on story_help_articles for delete to mcp_writer
  using (exists (select 1 from user_stories us where us.id = story_id and us.status <> 'production'));

-- Internal normalized patch applier. It is callable only by the guarded wrapper
-- functions below and the dedicated no-login lifecycle owner.
create or replace function apply_story_relationship_patch(p_story_id bigint, p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  item jsonb;
  entity_row_id bigint;
  asset_row_id bigint;
  help_row_id bigint;
  family jsonb;
  additions jsonb;
begin
  if p_patch ? 'entities' then
    family := p_patch->'entities';
    if family ? 'replace' then
      delete from story_entities where story_id = p_story_id;
      additions := coalesce(family->'replace', '[]'::jsonb);
    else
      additions := coalesce(family->'add', '[]'::jsonb);
    end if;
    for item in select value from jsonb_array_elements(coalesce(family->'remove', '[]'::jsonb)) loop
      delete from story_entities se using entities e
      where se.story_id = p_story_id and se.entity_id = e.id
        and e.entity_slug = trim(both '"' from item::text);
    end loop;
    for item in select value from jsonb_array_elements(additions) loop
      insert into entities (entity_slug, entity_name)
      values (item->>'entity_slug', coalesce(item->>'entity_name', initcap(replace(item->>'entity_slug', '-', ' '))))
      on conflict (entity_slug) do update set
        entity_name = coalesce(excluded.entity_name, entities.entity_name), updated_at = now()
      returning id into entity_row_id;
      insert into story_entities (story_id, entity_id, relationship_type)
      values (p_story_id, entity_row_id, coalesce(item->>'relationship_type', 'mentions'))
      on conflict (story_id, entity_id) do update set
        relationship_type = excluded.relationship_type, updated_at = now();
    end loop;
  end if;

  if p_patch ? 'code_assets' then
    family := p_patch->'code_assets';
    if family ? 'replace' then
      delete from story_code_assets where story_id = p_story_id;
      additions := coalesce(family->'replace', '[]'::jsonb);
    else
      additions := coalesce(family->'add', '[]'::jsonb);
    end if;
    for item in select value from jsonb_array_elements(coalesce(family->'remove', '[]'::jsonb)) loop
      delete from story_code_assets sc using code_assets ca
      where sc.story_id = p_story_id and sc.code_asset_id = ca.id
        and ca.repo = item->>'repo'
        and ca.path = item->>'path';
    end loop;
    for item in select value from jsonb_array_elements(additions) loop
      if nullif(item->>'repo', '') is null then
        raise exception 'code_assets entries require repo';
      end if;
      insert into code_assets (repo, path, asset_type, symbol_name, summary, is_active)
      values (item->>'repo', item->>'path', item->>'asset_type',
              item->>'symbol_name', item->>'summary', true)
      on conflict (repo, path) do update set
        asset_type = coalesce(excluded.asset_type, code_assets.asset_type),
        symbol_name = coalesce(excluded.symbol_name, code_assets.symbol_name),
        summary = coalesce(excluded.summary, code_assets.summary), is_active = true, updated_at = now()
      returning id into asset_row_id;
      insert into story_code_assets
        (story_id, code_asset_id, link_type, provenance, confidence, confidence_reason,
         sort_order, last_verified_at)
      values
        (p_story_id, asset_row_id, coalesce(item->>'link_type', 'primary'),
         coalesce(item->>'provenance', 'mcp'), nullif(item->>'confidence', '')::real,
         item->>'confidence_reason', coalesce((item->>'sort_order')::int, 0),
         nullif(item->>'last_verified_at', '')::timestamptz)
      on conflict (story_id, code_asset_id) do update set
        link_type = excluded.link_type, provenance = excluded.provenance,
        confidence = excluded.confidence, confidence_reason = excluded.confidence_reason,
        sort_order = excluded.sort_order, last_verified_at = excluded.last_verified_at,
        updated_at = now();
    end loop;
  end if;

  if p_patch ? 'help_articles' then
    family := p_patch->'help_articles';
    if family ? 'replace' then
      delete from story_help_articles where story_id = p_story_id;
      additions := coalesce(family->'replace', '[]'::jsonb);
    else
      additions := coalesce(family->'add', '[]'::jsonb);
    end if;
    for item in select value from jsonb_array_elements(coalesce(family->'remove', '[]'::jsonb)) loop
      delete from story_help_articles sha using help_articles ha
      where sha.story_id = p_story_id and sha.help_article_id = ha.id
        and ha.article_slug = trim(both '"' from item::text);
    end loop;
    for item in select value from jsonb_array_elements(additions) loop
      select id into help_row_id from help_articles where article_slug = item->>'article_slug';
      if help_row_id is null then raise exception 'Unknown help article slug %', item->>'article_slug'; end if;
      insert into story_help_articles (story_id, help_article_id, relationship_type, confidence)
      values (p_story_id, help_row_id, coalesce(item->>'relationship_type', 'primary'),
              coalesce(nullif(item->>'confidence', '')::real, 1.0))
      on conflict (story_id, help_article_id) do update set
        relationship_type = excluded.relationship_type, confidence = excluded.confidence,
        updated_at = now();
    end loop;
  end if;

end;
$$;

create or replace function mutate_nonproduction_story_relationships(
  p_story_id bigint,
  p_expected_revision int,
  p_patch jsonb,
  p_actor_label text,
  p_source text,
  p_reason text default null
)
returns table (outcome text, current_revision_number int)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare current_story user_stories%rowtype;
begin
  select * into current_story from user_stories where id = p_story_id for update;
  if not found then return query select 'not_found'::text, null::int; return; end if;
  if current_story.status = 'production' then return query select 'requires_approval'::text, current_story.revision_number; return; end if;
  if current_story.revision_number <> p_expected_revision then return query select 'stale'::text, current_story.revision_number; return; end if;
  perform apply_story_relationship_patch(p_story_id, p_patch);
  insert into story_events (story_id, event_type, details, actor_label, source)
  values (p_story_id, 'relationships_changed',
          jsonb_build_object('patch', p_patch, 'reason', p_reason), p_actor_label, p_source);
  return query select 'applied'::text, current_story.revision_number;
end;
$$;

create or replace function approve_story_relationship_change(
  p_proposal_id bigint,
  p_decided_by text,
  p_decision_note text default null
)
returns table (outcome text, story_id bigint, story_key text, revision_number int)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare p story_change_proposals%rowtype; current_story user_stories%rowtype;
begin
  select * into p from story_change_proposals where id = p_proposal_id for update;
  if not found then return query select 'not_found'::text, null::bigint, null::text, null::int; return; end if;
  if p.status <> 'pending' then return query select p.status, p.story_id, p.proposed_story_key, p.base_revision_number; return; end if;
  if p.operation <> 'relationships' then raise exception 'Proposal % is not a relationship change', p.id; end if;
  select * into current_story from user_stories where id = p.story_id for update;
  if not found or current_story.revision_number <> p.base_revision_number then
    update story_change_proposals set status = 'stale', decided_by = p_decided_by,
      decision_note = p_decision_note, decided_at = now() where id = p.id;
    return query select 'stale'::text, p.story_id, p.proposed_story_key,
                        coalesce(current_story.revision_number, p.base_revision_number);
    return;
  end if;
  perform apply_story_relationship_patch(current_story.id, p.patch);
  update story_change_proposals set status = 'approved', decided_by = p_decided_by,
    decision_note = p_decision_note, decided_at = now() where id = p.id;
  insert into story_events (story_id, proposal_id, event_type, details, actor_label, source)
  values (current_story.id, p.id, 'relationships_changed',
          jsonb_build_object('patch', p.patch, 'approved', true), p_decided_by, p.source);
  return query select 'approved'::text, current_story.id, current_story.story_key,
                      current_story.revision_number;
end;
$$;

alter function apply_story_relationship_patch(bigint, jsonb) owner to story_lifecycle_owner;
alter function mutate_nonproduction_story_relationships(bigint, int, jsonb, text, text, text) owner to story_lifecycle_owner;
alter function approve_story_relationship_change(bigint, text, text) owner to story_lifecycle_owner;
revoke all on function apply_story_relationship_patch(bigint, jsonb) from public;
revoke all on function mutate_nonproduction_story_relationships(bigint, int, jsonb, text, text, text) from public;
revoke all on function approve_story_relationship_change(bigint, text, text) from public;
grant execute on function mutate_nonproduction_story_relationships(bigint, int, jsonb, text, text, text) to mcp_writer;
grant execute on function approve_story_relationship_change(bigint, text, text) to mcp_approver;
