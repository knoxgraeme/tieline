-- mint_story_key is intentionally callable by mcp_writer, but its internal
-- section lock/read must not require broad UPDATE permission on sections.
-- The advisory lock already serializes key allocation, so no row lock is needed.
create or replace function mint_story_key(p_section_id bigint)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prefix text;
  v_next int;
begin
  perform pg_advisory_xact_lock(73001, p_section_id::int);
  select key_prefix into v_prefix from sections where id = p_section_id;
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

alter function mint_story_key(bigint) owner to story_lifecycle_owner;
revoke all on function mint_story_key(bigint) from public;
grant execute on function mint_story_key(bigint) to mcp_writer, story_lifecycle_owner;
