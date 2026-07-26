-- Production-sensitive complete feature-request mapping changes use the same
-- proposal/approver boundary as other typed story relationships.
grant select, update on feature_requests to story_lifecycle_owner;
grant select, insert, update, delete on feature_request_story_links to story_lifecycle_owner;

create or replace function approve_feature_request_link_change(
  p_proposal_id bigint,
  p_decided_by text,
  p_decision_note text default null
)
returns table (outcome text, story_id bigint, story_key text, revision_number int)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  p story_change_proposals%rowtype;
  anchor user_stories%rowtype;
  payload jsonb;
  fr_id bigint;
  expected_version int;
  primary_key text;
  secondary_key text;
  link_source text;
  primary_story user_stories%rowtype;
  secondary_story user_stories%rowtype;
  changed_ids bigint[] := '{}'::bigint[];
begin
  select * into p from story_change_proposals where id = p_proposal_id for update;
  if not found then return query select 'not_found'::text, null::bigint, null::text, null::int; return; end if;
  if p.status <> 'pending' then
    return query select p.status, p.story_id, p.proposed_story_key, p.base_revision_number;
    return;
  end if;
  if p.operation <> 'relationships' or not (p.patch ? 'feature_request_links') then
    raise exception 'Proposal % is not a feature-request link change', p.id;
  end if;

  select * into anchor from user_stories where id = p.story_id for update;
  if not found or anchor.revision_number <> p.base_revision_number then
    update story_change_proposals set status = 'stale', decided_by = p_decided_by,
      decision_note = p_decision_note, decided_at = now() where id = p.id;
    return query select 'stale'::text, p.story_id, p.proposed_story_key,
                        coalesce(anchor.revision_number, p.base_revision_number);
    return;
  end if;

  payload := p.patch->'feature_request_links';
  fr_id := (payload->>'feature_request_id')::bigint;
  expected_version := (payload->>'expected_version')::int;
  primary_key := payload->>'primary_story_key';
  link_source := nullif(payload->>'link_source', '');

  perform 1 from feature_requests
  where id = fr_id and link_revision = expected_version for update;
  if not found then
    update story_change_proposals set status = 'stale', decided_by = p_decided_by,
      decision_note = coalesce(p_decision_note, 'Feature-request link version changed'),
      decided_at = now() where id = p.id;
    return query select 'stale'::text, anchor.id, anchor.story_key, anchor.revision_number;
    return;
  end if;

  select us.* into primary_story from user_stories us where us.story_key = primary_key;
  if not found then raise exception 'Unknown primary story_key %', primary_key; end if;
  for secondary_key in
    select value from jsonb_array_elements_text(coalesce(payload->'secondary_story_keys', '[]'::jsonb))
  loop
    select us.* into secondary_story from user_stories us where us.story_key = secondary_key;
    if not found then raise exception 'Unknown secondary story_key %', secondary_key; end if;
  end loop;

  select coalesce(array_agg(distinct user_story_id), '{}'::bigint[]) into changed_ids
  from feature_request_story_links where feature_request_id = fr_id;
  changed_ids := array_append(changed_ids, primary_story.id);
  for secondary_key in
    select value from jsonb_array_elements_text(coalesce(payload->'secondary_story_keys', '[]'::jsonb))
  loop
    select us.* into secondary_story from user_stories us where us.story_key = secondary_key;
    changed_ids := array_append(changed_ids, secondary_story.id);
  end loop;

  delete from feature_request_story_links where feature_request_id = fr_id;
  insert into feature_request_story_links
    (feature_request_id, user_story_id, user_story_title_snapshot, link_type, link_source)
  values (fr_id, primary_story.id, primary_story.title, 'primary', link_source);
  for secondary_key in
    select value from jsonb_array_elements_text(coalesce(payload->'secondary_story_keys', '[]'::jsonb))
  loop
    select us.* into secondary_story from user_stories us where us.story_key = secondary_key;
    insert into feature_request_story_links
      (feature_request_id, user_story_id, user_story_title_snapshot, link_type, link_source)
    values (fr_id, secondary_story.id, secondary_story.title, 'secondary', link_source);
  end loop;
  update feature_requests set link_revision = link_revision + 1, updated_at = now() where id = fr_id;
  update story_change_proposals set status = 'approved', decided_by = p_decided_by,
    decision_note = p_decision_note, decided_at = now() where id = p.id;
  insert into story_events (story_id, proposal_id, event_type, details, actor_label, source)
    select id, p.id, 'feature_request_links_replaced',
           jsonb_build_object('feature_request_id', fr_id, 'approved', true),
           p_decided_by, p.source
    from (select distinct unnest(changed_ids) as id) changed;
  return query select 'approved'::text, anchor.id, anchor.story_key, anchor.revision_number;
end;
$$;

alter function approve_feature_request_link_change(bigint, text, text) owner to story_lifecycle_owner;
revoke all on function approve_feature_request_link_change(bigint, text, text) from public;
grant execute on function approve_feature_request_link_change(bigint, text, text) to mcp_approver;
