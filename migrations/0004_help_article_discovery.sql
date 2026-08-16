alter type semantic_entity_kind add value if not exists 'help_article';

alter table help_articles
  add column search_vector tsvector generated always as (
    to_tsvector(
      'simple',
      coalesce(title, '') || ' ' ||
      coalesce(summary, '') || ' ' ||
      coalesce(markdown, '')
    )
  ) stored;

create index help_articles_search
  on help_articles using gin (search_vector);
create index help_articles_title_trigram
  on help_articles using gin (title gin_trgm_ops);
create index help_articles_summary_trigram
  on help_articles using gin (summary gin_trgm_ops);
create index story_help_articles_article
  on story_help_articles (article_id);
create index criterion_help_articles_article
  on criterion_help_articles (article_id);

select pg_advisory_xact_lock(hashtext('tieline-profile:' || profile_key))
from (
  values ('all'), ('discovery'), ('engineering'), ('support')
) as built_in_profile(profile_key)
order by profile_key;

create temporary table tieline_help_profile_upgrades on commit drop as
select profile_key, definition
from retrieval_profiles
where active
  and profile_key in ('support', 'engineering', 'discovery', 'all')
  and definition ? 'include'
  and not (definition->'include' ? 'help_article');

update retrieval_profiles profile
set active = false
from tieline_help_profile_upgrades upgrade
where profile.profile_key = upgrade.profile_key
  and profile.active;

insert into retrieval_profiles (
  profile_key,
  version,
  definition,
  active,
  created_by
)
select
  upgrade.profile_key,
  coalesce((
    select max(existing.version)
    from retrieval_profiles existing
    where existing.profile_key = upgrade.profile_key
  ), 0) + 1,
  jsonb_set(
    upgrade.definition,
    '{include}',
    (upgrade.definition->'include') || '["help_article"]'::jsonb
  ),
  true,
  'migration-0004'
from tieline_help_profile_upgrades upgrade;
