-- ============================================================================
-- 0007_feature_request_status_and_keygen.sql
-- Groundwork for agent-created feature-request stories. Run after 0006.
--
-- (1) Adds 'feature_request' to the story_status enum (the only new status —
--     no 'draft'). NOTE: the ADD VALUE must be committed BEFORE any RLS policy
--     (migration 0009) references the literal, so apply this file on its own.
-- (2) Adds sections.key_prefix and backfills it 1:1 from existing story_keys
--     (verified against every existing section before this migration was added).
-- (3) mint_story_key(section_id): server-side, race-safe story_key generation so
--     the agent never supplies a key and keys stay section-consistent + unique.
-- ============================================================================

-- (1) new status value (idempotent)
alter type story_status add value if not exists 'feature_request';

-- (2) section key prefix
alter table sections add column if not exists key_prefix text;

-- backfill from existing keys (1:1 by section)
update sections s
set key_prefix = sub.prefix
from (
  select us.section_id, regexp_replace(us.story_key, '-[0-9]+$', '') as prefix
  from user_stories us
  group by us.section_id, regexp_replace(us.story_key, '-[0-9]+$', '')
) sub
where sub.section_id = s.id
  and s.key_prefix is null;

-- deterministic fallback for any story-less section (first 4 chars of each
-- hyphen segment, uppercased): feature-requests -> FEAT-REQU
update sections
set key_prefix = upper(
  array_to_string(
    array(select left(w, 4) from unnest(string_to_array(section_key, '-')) w),
    '-'
  )
)
where key_prefix is null;

-- (3) race-safe key minting. Must be called inside the same transaction as the
-- INSERT so the advisory lock (per section) holds across mint+insert.
create or replace function mint_story_key(p_section_id bigint)
returns text
language plpgsql
as $$
declare
  v_prefix text;
  v_next   int;
begin
  perform pg_advisory_xact_lock(p_section_id);

  select key_prefix into v_prefix from sections where id = p_section_id;
  if v_prefix is null then
    raise exception 'section % not found or has no key_prefix', p_section_id;
  end if;

  select coalesce(max(substring(story_key from '[0-9]+$')::int), 0) + 1
    into v_next
  from user_stories
  where section_id = p_section_id;

  return v_prefix || '-' || lpad(v_next::text, 3, '0');
end;
$$;
