-- Document frequency is derived from relationship truth. The legacy columns and
-- refresh function remain for one compatibility release but runtime reads no
-- longer depend on manual refreshes.

create or replace view v_entity_taxonomy as
  select e.entity_slug, count(distinct se.story_id)::int as doc_frequency
  from entities e
  left join story_entities se on se.entity_id = e.id
  group by e.id
  order by doc_frequency desc, e.entity_slug asc;

