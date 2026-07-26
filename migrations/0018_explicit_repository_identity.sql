-- Code assets must always name the repository they belong to. The application
-- supplies this from a Tieline workspace, import_source, or explicit REPO_NAME.
alter table code_assets alter column repo drop default;

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

alter function apply_story_relationship_patch(bigint, jsonb) owner to story_lifecycle_owner;
revoke all on function apply_story_relationship_patch(bigint, jsonb) from public;
