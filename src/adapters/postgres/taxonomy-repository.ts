import { getReadSql } from "./connections.js";
const getSql = getReadSql;

// --- taxonomy (for schema://taxonomy resource) ------------------------------

export interface Taxonomy {
  section_keys: { section_key: string; section_name: string; status: string; story_count: number }[];
  actors: string[];
  statuses: string[];
  entity_vocabulary: { entity_slug: string; doc_frequency: number }[];
  help_product_areas: { product_area: string; article_count: number }[];
  help_audiences: string[];
  help_relationship_types: string[];
  modes: string[];
  totals: {
    stories: number;
    sections: number;
    entities: number;
    code_paths: number;
    help_articles: number;
    stories_with_help: number;
  };
}

export async function getTaxonomy(): Promise<Taxonomy> {
  const sql = getSql();
  const sections = await sql<
    { section_key: string; section_name: string; status: string; story_count: number }[]
  >`select section_key, section_name, status, story_count::int as story_count
    from v_section_taxonomy`;
  const actorsRows = await sql<{ actor: string }[]>`
    select distinct actor from user_stories where actor is not null order by actor`;
  const statusesRows = await sql<{ status: string }[]>`
    select distinct status::text as status from user_stories order by status`;
  const vocab = await sql<{ entity_slug: string; doc_frequency: number }[]>`
    select entity_slug, doc_frequency from v_entity_taxonomy`;
  const productAreas = await sql<{ product_area: string; article_count: number }[]>`
    select product_area, count(*)::int as article_count
    from help_articles where product_area is not null
    group by product_area order by article_count desc`;
  const audiences = await sql<{ audience: string }[]>`
    select distinct audience from help_articles where audience is not null order by audience`;
  const relTypes = await sql<{ relationship_type: string }[]>`
    select distinct relationship_type from story_help_articles order by relationship_type`;
  const totals = await sql<
    {
      stories: number;
      sections: number;
      entities: number;
      code_paths: number;
      help_articles: number;
      stories_with_help: number;
    }[]
  >`select
      (select count(*) from user_stories)::int as stories,
      (select count(*) from sections)::int as sections,
      (select count(*) from entities)::int as entities,
      (select count(*) from code_assets)::int as code_paths,
      (select count(*) from help_articles)::int as help_articles,
      (select count(distinct story_id) from story_help_articles)::int as stories_with_help`;

  return {
    section_keys: sections,
    actors: actorsRows.map((a) => a.actor),
    statuses: statusesRows.map((s) => s.status),
    entity_vocabulary: vocab,
    help_product_areas: productAreas,
    help_audiences: audiences.map((a) => a.audience),
    help_relationship_types: relTypes.map((r) => r.relationship_type),
    modes: ["semantic", "structural", "blended"],
    totals: totals[0] ?? {
      stories: 0,
      sections: 0,
      entities: 0,
      code_paths: 0,
      help_articles: 0,
      stories_with_help: 0,
    },
  };
}
