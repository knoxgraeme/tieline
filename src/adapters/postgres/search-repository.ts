import type { Sql } from "postgres";
import type { Candidate, DocFrequencies, StoryRecord, CrossoverHit, HelpArticleLink } from "../../types.js";
import { getReadSql } from "./connections.js";
import { vectorLiteral } from "./vector.js";
const getSql = getReadSql;
const HELP_ARTICLES_PER_STORY = 5;
const HELP_RELATIONSHIP_RANK: Record<string, number> = {
  primary: 0,
  supporting: 1,
  troubleshooting: 2,
  reference: 3,
};

// --- footprints -------------------------------------------------------------

interface Footprint {
  entity_slugs: string[];
  code_paths: string[];
  help_articles: HelpArticleLink[];
  help_article_count: number;
}

async function footprintsFor(storyIds: number[]): Promise<Map<number, Footprint>> {
  const sql = getSql();
  const map = new Map<number, Footprint>();
  if (storyIds.length === 0) return map;
  for (const id of storyIds)
    map.set(id, { entity_slugs: [], code_paths: [], help_articles: [], help_article_count: 0 });

  const ents = await sql<{ story_id: number; entity_slug: string }[]>`
    select se.story_id, e.entity_slug
    from story_entities se
    join entities e on e.id = se.entity_id
    where se.story_id in ${sql(storyIds)}
  `;
  for (const r of ents) map.get(r.story_id)?.entity_slugs.push(r.entity_slug);

  const paths = await sql<{ story_id: number; path: string }[]>`
    select sc.story_id, c.path
    from story_code_assets sc
    join code_assets c on c.id = sc.code_asset_id
    where sc.story_id in ${sql(storyIds)}
    order by sc.sort_order
  `;
  for (const r of paths) map.get(r.story_id)?.code_paths.push(r.path);

  // Help articles: gather every link, then rank (primary-first, confidence desc)
  // and cap per story in JS — same all-rows-then-shape approach as above.
  const help = await sql<
    {
      story_id: number;
      article_slug: string;
      title: string;
      url: string | null;
      relationship_type: string;
      confidence: number;
    }[]
  >`
    select sha.story_id, ha.article_slug, ha.title, ha.url,
           sha.relationship_type, sha.confidence
    from story_help_articles sha
    join help_articles ha on ha.id = sha.help_article_id
    where sha.story_id in ${sql(storyIds)}
  `;
  const grouped = new Map<number, HelpArticleLink[]>();
  for (const r of help) {
    const arr = grouped.get(r.story_id) ?? [];
    arr.push({
      article_slug: r.article_slug,
      title: r.title,
      url: r.url,
      relationship_type: r.relationship_type,
      confidence: r.confidence,
    });
    grouped.set(r.story_id, arr);
  }
  for (const [storyId, links] of grouped) {
    links.sort(
      (a, b) =>
        (HELP_RELATIONSHIP_RANK[a.relationship_type] ?? 9) -
          (HELP_RELATIONSHIP_RANK[b.relationship_type] ?? 9) ||
        b.confidence - a.confidence
    );
    const fp = map.get(storyId);
    if (fp) {
      fp.help_article_count = links.length;
      fp.help_articles = links.slice(0, HELP_ARTICLES_PER_STORY);
    }
  }

  return map;
}

// --- KNN gate ---------------------------------------------------------------

export async function knnCandidates(
  embedding: number[],
  poolSize: number
): Promise<Candidate[]> {
  const sql = getSql();
  const rows = await sql<
    {
      id: number;
      story_key: string;
      section_id: number;
      section_key: string;
      section_name: string;
      title: string;
      actor: string | null;
      story_text: string;
      status: string;
      similarity: number;
    }[]
  >`select * from match_user_stories(${vectorLiteral(embedding)}::vector, ${poolSize})`;

  const footprints = await footprintsFor(rows.map((r) => r.id));
  return rows.map((r) => ({
    ...r,
    entity_slugs: footprints.get(r.id)?.entity_slugs ?? [],
    code_paths: footprints.get(r.id)?.code_paths ?? [],
    help_articles: footprints.get(r.id)?.help_articles ?? [],
    help_article_count: footprints.get(r.id)?.help_article_count ?? 0,
  }));
}

/** Exact entity/path candidates, independent of the semantic KNN pool. */
export async function structuralCandidates(opts: {
  embedding?: number[];
  entitySlugs: string[];
  codePaths: string[];
  poolSize: number;
}): Promise<Candidate[]> {
  if (opts.entitySlugs.length === 0 && opts.codePaths.length === 0) return [];
  const sql = getSql();
  const rows = await sql<
    {
      id: number;
      story_key: string;
      section_id: number;
      section_key: string;
      section_name: string;
      title: string;
      actor: string | null;
      story_text: string;
      status: string;
      similarity: number;
    }[]
  >`
    select distinct us.id, us.story_key, us.section_id, s.section_key, s.section_name,
           us.title, us.actor, us.story_text, us.status::text as status,
           case when us.embedding is null or ${!opts.embedding} then 0
                else 1 - (us.embedding <=> ${opts.embedding ? vectorLiteral(opts.embedding) : null}::vector) end as similarity
    from user_stories us
    join sections s on s.id = us.section_id
    where
      (${opts.entitySlugs.length > 0} and exists (
        select 1 from story_entities se join entities e on e.id = se.entity_id
        where se.story_id = us.id and e.entity_slug = any(${opts.entitySlugs})
      ))
      or
      (${opts.codePaths.length > 0} and exists (
        select 1 from story_code_assets sc join code_assets ca on ca.id = sc.code_asset_id
        where sc.story_id = us.id and ca.path = any(${opts.codePaths})
      ))
    order by similarity desc
    limit ${Math.max(opts.poolSize, 1)}`;
  const footprints = await footprintsFor(rows.map((row) => row.id));
  return rows.map((row) => ({
    ...row,
    entity_slugs: footprints.get(row.id)?.entity_slugs ?? [],
    code_paths: footprints.get(row.id)?.code_paths ?? [],
    help_articles: footprints.get(row.id)?.help_articles ?? [],
    help_article_count: footprints.get(row.id)?.help_article_count ?? 0,
  }));
}


// --- document frequencies + vocabulary --------------------------------------

export async function getDocFrequencies(_force = false): Promise<DocFrequencies> {
  const sql = getSql();
  const ents = await sql<{ entity_slug: string; doc_frequency: number }[]>`
    select e.entity_slug, count(distinct se.story_id)::int as doc_frequency
    from entities e left join story_entities se on se.entity_id = e.id
    group by e.id`;
  const paths = await sql<{ path: string; doc_frequency: number }[]>`
    select ca.path, count(distinct sc.story_id)::int as doc_frequency
    from code_assets ca left join story_code_assets sc on sc.code_asset_id = ca.id
    group by ca.id`;
  return {
    entity: new Map(ents.map((e) => [e.entity_slug, e.doc_frequency])),
    path: new Map(paths.map((p) => [p.path, p.doc_frequency])),
  };
}

// --- find_crossover ---------------------------------------------------------

interface TargetFootprint {
  sectionKey: string | null;
  entitySlugs: string[];
  codePaths: string[];
}

async function resolveTargetFootprint(
  sectionKey?: string,
  storyKey?: string
): Promise<TargetFootprint | null> {
  const sql = getSql();
  if (storyKey) {
    const story = await sql<{ id: number; section_key: string }[]>`
      select us.id, s.section_key
      from user_stories us join sections s on s.id = us.section_id
      where us.story_key = ${storyKey}`;
    if (story.length === 0) return null;
    const fp = await footprintsFor([story[0].id]);
    const f = fp.get(story[0].id)!;
    return {
      sectionKey: story[0].section_key,
      entitySlugs: f.entity_slugs,
      codePaths: f.code_paths,
    };
  }
  if (sectionKey) {
    const exists = await sql<{ id: number }[]>`
      select id from sections where section_key = ${sectionKey}`;
    if (exists.length === 0) return null;
    const ents = await sql<{ entity_slug: string }[]>`
      select distinct e.entity_slug
      from story_entities se
      join entities e on e.id = se.entity_id
      join user_stories us on us.id = se.story_id
      join sections s on s.id = us.section_id
      where s.section_key = ${sectionKey}`;
    const paths = await sql<{ path: string }[]>`
      select distinct c.path
      from story_code_assets sc
      join code_assets c on c.id = sc.code_asset_id
      join user_stories us on us.id = sc.story_id
      join sections s on s.id = us.section_id
      where s.section_key = ${sectionKey}`;
    return {
      sectionKey,
      entitySlugs: ents.map((e) => e.entity_slug),
      codePaths: paths.map((p) => p.path),
    };
  }
  return null;
}

export async function findCrossover(
  opts: { sectionKey?: string; storyKey?: string; limit: number }
): Promise<{ found: boolean; target?: TargetFootprint; hits: CrossoverHit[] }> {
  const sql = getSql();
  const target = await resolveTargetFootprint(opts.sectionKey, opts.storyKey);
  if (!target) return { found: false, hits: [] };

  const excludeSection = target.sectionKey ?? "";

  // Rows of (section, shared entity, df) for OTHER sections.
  const entRows =
    target.entitySlugs.length === 0
      ? []
      : await sql<{ section_key: string; section_name: string; entity_slug: string; df: number }[]>`
          select distinct s.section_key, s.section_name,
                 e.entity_slug, freq.df
          from story_entities se
          join entities e on e.id = se.entity_id
          join (
            select entity_id, count(distinct story_id)::int as df
            from story_entities group by entity_id
          ) freq on freq.entity_id = e.id
          join user_stories us on us.id = se.story_id
          join sections s on s.id = us.section_id
          where e.entity_slug in ${sql(target.entitySlugs)}
            and s.section_key <> ${excludeSection}`;

  const pathRows =
    target.codePaths.length === 0
      ? []
      : await sql<{ section_key: string; section_name: string; path: string; df: number }[]>`
          select distinct s.section_key, s.section_name,
                 c.path, freq.df
          from story_code_assets sc
          join code_assets c on c.id = sc.code_asset_id
          join (
            select code_asset_id, count(distinct story_id)::int as df
            from story_code_assets group by code_asset_id
          ) freq on freq.code_asset_id = c.id
          join user_stories us on us.id = sc.story_id
          join sections s on s.id = us.section_id
          where c.path in ${sql(target.codePaths)}
            and s.section_key <> ${excludeSection}`;

  // Aggregate per section, weighting each shared item by 1/df.
  interface Acc {
    section_name: string;
    entities: Map<string, number>;
    paths: Map<string, number>;
  }
  const acc = new Map<string, Acc>();
  const ensure = (k: string, name: string): Acc => {
    let a = acc.get(k);
    if (!a) {
      a = { section_name: name, entities: new Map(), paths: new Map() };
      acc.set(k, a);
    }
    return a;
  };
  for (const r of entRows) {
    ensure(r.section_key, r.section_name).entities.set(
      r.entity_slug,
      1 / Math.max(r.df, 1)
    );
  }
  for (const r of pathRows) {
    // code paths weigh a touch more — structural adjacency is the point here.
    ensure(r.section_key, r.section_name).paths.set(r.path, 1.5 / Math.max(r.df, 1));
  }

  const hits: CrossoverHit[] = [];
  for (const [section_key, a] of acc) {
    const shared_entities = [...a.entities.entries()]
      .map(([slug, weight]) => ({ slug, weight: round(weight) }))
      .sort((x, y) => y.weight - x.weight);
    const shared_code_paths = [...a.paths.entries()]
      .map(([path, weight]) => ({ path, weight: round(weight) }))
      .sort((x, y) => y.weight - x.weight);
    const score =
      shared_entities.reduce((s, e) => s + e.weight, 0) +
      shared_code_paths.reduce((s, p) => s + p.weight, 0);
    hits.push({
      section_key,
      section_name: a.section_name,
      score: round(score),
      shared_code_paths,
      shared_entities,
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return { found: true, target, hits: hits.slice(0, opts.limit) };
}

// --- section-crossover graph (whole-corpus coupling map) ---------------------
// The same structural-entanglement relation find_crossover computes for ONE key,
// but materialized for EVERY section pair at once, so a UI can draw the coupling
// map. Section = node (sized by story_count, colored by status); an edge is the
// 1/df-weighted shared footprint between two sections (paths 1.5x, matching
// find_crossover). Undirected: each pair is emitted once (section_key a < b).

export interface GraphNode {
  id: string; // section_key (stable identity used by edges)
  label: string; // section_name
  status: string;
  story_count: number;
}

export interface GraphEdge {
  source: string; // section_key
  target: string; // section_key
  weight: number; // summed 1/df signal (paths weigh 1.5x) — same scale as find_crossover score
  shared_entities: string[]; // top shared slugs by weight (for the "why" tooltip)
  shared_code_paths: string[]; // top shared paths by weight
  shared_count: number; // total distinct shared signals (entities + paths)
}

export interface CrossoverGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export async function sectionCrossoverGraph(
  opts: { minWeight?: number; maxEdges?: number; status?: string[]; topSignals?: number } = {}
): Promise<CrossoverGraph> {
  const sql = getSql();
  const minWeight = opts.minWeight ?? 0;
  const maxEdges = opts.maxEdges ?? 300;
  const topSignals = opts.topSignals ?? 6;
  // Optional status facet: restrict the stories that contribute to both the node
  // counts AND the edges, so the map reflects (say) only in-progress work.
  const statusFilter =
    opts.status && opts.status.length > 0 ? sql`and us.status in ${sql(opts.status)}` : sql``;

  // Nodes: every section with ≥1 contributing story. Isolated sections (stories
  // but no shared footprint) still appear — a valid answer, not a gap.
  const nodeRows = await sql<
    { id: string; label: string; status: string; story_count: number }[]
  >`
    select s.section_key as id, s.section_name as label, s.status::text as status,
           count(us.id)::int as story_count
    from sections s
    join user_stories us on us.section_id = s.id ${statusFilter}
    group by s.id
    order by story_count desc`;

  // Shared entity slugs across section pairs (distinct (section, entity) first so
  // a slug used by many stories in one section still counts once per section).
  const entRows = await sql<{ s1: string; s2: string; item: string; df: number }[]>`
    with sec_ent as (
      select distinct s.section_key, se.entity_id, e.entity_slug, freq.df
      from user_stories us
      join sections s on s.id = us.section_id
      join story_entities se on se.story_id = us.id
      join entities e on e.id = se.entity_id
      join (
        select entity_id, count(distinct story_id)::int as df
        from story_entities group by entity_id
      ) freq on freq.entity_id = e.id
      where true ${statusFilter}
    )
    select a.section_key as s1, b.section_key as s2, a.entity_slug as item, a.df::int as df
    from sec_ent a
    join sec_ent b on a.entity_id = b.entity_id and a.section_key < b.section_key`;

  const pathRows = await sql<{ s1: string; s2: string; item: string; df: number }[]>`
    with sec_path as (
      select distinct s.section_key, sc.code_asset_id, c.path, freq.df
      from user_stories us
      join sections s on s.id = us.section_id
      join story_code_assets sc on sc.story_id = us.id
      join code_assets c on c.id = sc.code_asset_id
      join (
        select code_asset_id, count(distinct story_id)::int as df
        from story_code_assets group by code_asset_id
      ) freq on freq.code_asset_id = c.id
      where true ${statusFilter}
    )
    select a.section_key as s1, b.section_key as s2, a.path as item, a.df::int as df
    from sec_path a
    join sec_path b on a.code_asset_id = b.code_asset_id and a.section_key < b.section_key`;

  // Aggregate per unordered pair, weighting each shared item by 1/df (paths 1.5x),
  // exactly as find_crossover scores a single key's hits.
  interface Acc {
    entities: Map<string, number>;
    paths: Map<string, number>;
  }
  const pairs = new Map<string, { s1: string; s2: string; acc: Acc }>();
  const keyFor = (s1: string, s2: string) => JSON.stringify([s1, s2]);
  const ensurePair = (s1: string, s2: string): Acc => {
    const k = keyFor(s1, s2);
    let p = pairs.get(k);
    if (!p) {
      p = { s1, s2, acc: { entities: new Map(), paths: new Map() } };
      pairs.set(k, p);
    }
    return p.acc;
  };
  for (const r of entRows) {
    ensurePair(r.s1, r.s2).entities.set(r.item, 1 / Math.max(r.df, 1));
  }
  for (const r of pathRows) {
    ensurePair(r.s1, r.s2).paths.set(r.item, 1.5 / Math.max(r.df, 1));
  }

  const topByWeight = (m: Map<string, number>): string[] =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, topSignals).map(([k]) => k);

  const edges: GraphEdge[] = [];
  for (const { s1, s2, acc } of pairs.values()) {
    const weight =
      [...acc.entities.values()].reduce((a, b) => a + b, 0) +
      [...acc.paths.values()].reduce((a, b) => a + b, 0);
    if (weight < minWeight) continue;
    edges.push({
      source: s1,
      target: s2,
      weight: round(weight),
      shared_entities: topByWeight(acc.entities),
      shared_code_paths: topByWeight(acc.paths),
      shared_count: acc.entities.size + acc.paths.size,
    });
  }
  edges.sort((a, b) => b.weight - a.weight);

  return { nodes: nodeRows, edges: edges.slice(0, maxEdges) };
}

// --- query_stories (guarded SELECT) -----------------------------------------

export interface StoryFilters {
  status?: string[];
  section_key?: string[];
  story_key?: string[];
  actor?: string[];
  entity_slug?: string;
  code_path?: string;
  product_area?: string[];
  audience?: string[];
  help_relationship?: string[];
  help_article_slug?: string;
  has_help?: boolean;
}

/** Feature requests linked to each given story (for query_stories records). */
async function featureRequestsForStories(
  storyIds: number[]
): Promise<Map<number, { id: number; title: string; link_type: string }[]>> {
  const sql = getSql();
  const map = new Map<number, { id: number; title: string; link_type: string }[]>();
  if (storyIds.length === 0) return map;
  const rows = await sql<
    { user_story_id: number; id: number; title: string; link_type: string }[]
  >`
    select l.user_story_id, fr.id, fr.title, l.link_type
    from feature_request_story_links l
    join feature_requests fr on fr.id = l.feature_request_id
    where l.user_story_id in ${sql(storyIds)}
    order by l.link_type, fr.id`;
  for (const r of rows) {
    const arr = map.get(r.user_story_id) ?? [];
    arr.push({ id: Number(r.id), title: r.title, link_type: r.link_type });
    map.set(r.user_story_id, arr);
  }
  return map;
}

export type GroupBy = "section" | "status" | "actor" | "product_area";

const SERVER_MAX_LIMIT = 200;

export async function queryStories(opts: {
  filters: StoryFilters;
  groupBy?: GroupBy | null;
  limit: number;
}): Promise<
  | { mode: "records"; total: number; records: StoryRecord[] }
  | { mode: "grouped"; groups: { group: string; count: number }[] }
> {
  const sql = getSql();
  const f = opts.filters;
  const limit = Math.min(Math.max(opts.limit, 1), SERVER_MAX_LIMIT);

  // Build whitelisted, AND-combined conditions as parameterized fragments.
  const conds: ReturnType<Sql>[] = [];
  if (f.status?.length) conds.push(sql`us.status = any(${f.status}::story_status[])`);
  if (f.section_key?.length) conds.push(sql`s.section_key = any(${f.section_key})`);
  if (f.story_key?.length) conds.push(sql`us.story_key = any(${f.story_key})`);
  if (f.actor?.length) conds.push(sql`us.actor = any(${f.actor})`);
  if (f.entity_slug)
    conds.push(sql`us.id in (
      select se.story_id from story_entities se
      join entities e on e.id = se.entity_id
      where e.entity_slug = ${f.entity_slug})`);
  if (f.code_path)
    conds.push(sql`us.id in (
      select sc.story_id from story_code_assets sc
      join code_assets c on c.id = sc.code_asset_id
      where c.path = ${f.code_path})`);
  if (f.product_area?.length)
    conds.push(sql`us.id in (
      select sha.story_id from story_help_articles sha
      join help_articles ha on ha.id = sha.help_article_id
      where ha.product_area = any(${f.product_area}))`);
  if (f.audience?.length)
    conds.push(sql`us.id in (
      select sha.story_id from story_help_articles sha
      join help_articles ha on ha.id = sha.help_article_id
      where ha.audience = any(${f.audience}))`);
  if (f.help_relationship?.length)
    conds.push(sql`us.id in (
      select sha.story_id from story_help_articles sha
      where sha.relationship_type = any(${f.help_relationship}))`);
  if (f.help_article_slug)
    conds.push(sql`us.id in (
      select sha.story_id from story_help_articles sha
      join help_articles ha on ha.id = sha.help_article_id
      where ha.article_slug = ${f.help_article_slug})`);
  if (f.has_help === true)
    conds.push(sql`us.id in (select story_id from story_help_articles)`);
  if (f.has_help === false)
    conds.push(sql`us.id not in (select story_id from story_help_articles)`);

  const whereClause =
    conds.length > 0
      ? conds.reduce((acc, c, i) => (i === 0 ? sql`where ${c}` : sql`${acc} and ${c}`), sql``)
      : sql``;

  if (opts.groupBy) {
    // product_area lives on help_articles (many-per-story), so it needs the help
    // join and a DISTINCT story count — a story spanning two areas counts in each.
    // NB: "group" is a reserved SQL keyword, so the column is aliased to "grp".
    if (opts.groupBy === "product_area") {
      const rows = await sql<{ grp: string; count: number }[]>`
        select ha.product_area as grp, count(distinct us.id)::int as count
        from user_stories us
        join sections s on s.id = us.section_id
        join story_help_articles sha on sha.story_id = us.id
        join help_articles ha on ha.id = sha.help_article_id
        ${whereClause}
        group by ha.product_area
        order by count desc, grp asc`;
      return { mode: "grouped", groups: rows.map((r) => ({ group: r.grp, count: r.count })) };
    }
    const groupCol =
      opts.groupBy === "section"
        ? sql`s.section_key`
        : opts.groupBy === "status"
        ? sql`us.status::text`
        : sql`coalesce(us.actor, '(none)')`;
    const rows = await sql<{ grp: string; count: number }[]>`
      select ${groupCol} as grp, count(*)::int as count
      from user_stories us
      join sections s on s.id = us.section_id
      ${whereClause}
      group by ${groupCol}
      order by count desc, grp asc`;
    return { mode: "grouped", groups: rows.map((r) => ({ group: r.grp, count: r.count })) };
  }

  const countRows = await sql<{ count: number }[]>`
    select count(*)::int as count
    from user_stories us join sections s on s.id = us.section_id
    ${whereClause}`;
  const total = countRows[0]?.count ?? 0;

  const base = await sql<
    {
      id: number;
      story_key: string;
      section_id: number;
      section_key: string;
      section_name: string;
      title: string;
      actor: string | null;
      story_text: string;
      status: string;
    }[]
  >`
    select us.id, us.story_key, us.section_id, s.section_key, s.section_name,
           us.title, us.actor, us.story_text, us.status::text as status
    from user_stories us
    join sections s on s.id = us.section_id
    ${whereClause}
    order by s.section_key, us.story_key
    limit ${limit}`;

  const footprints = await footprintsFor(base.map((b) => b.id));
  const frLinks = await featureRequestsForStories(base.map((b) => b.id));
  const records: StoryRecord[] = base.map((b) => ({
    ...b,
    entity_slugs: footprints.get(b.id)?.entity_slugs ?? [],
    code_paths: footprints.get(b.id)?.code_paths ?? [],
    help_articles: footprints.get(b.id)?.help_articles ?? [],
    help_article_count: footprints.get(b.id)?.help_article_count ?? 0,
    feature_requests: frLinks.get(b.id) ?? [],
  }));
  return { mode: "records", total, records };
}


// --- zero-result vocabulary suggestions -------------------------------------
// When an exact entity_slug/code_path filter matches nothing, surface the
// closest *existing* values so a caller can recover (e.g. they passed a bare
// filename and the corpus stores the full path). Discovery in-band, on the
// miss path only — never on the happy path.

/** Escape LIKE wildcards so a user value can't act as a pattern. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Character-trigram set with word-boundary padding. */
function trigrams(s: string): Set<string> {
  const t = `  ${s.toLowerCase()} `;
  const set = new Set<string>();
  for (let i = 0; i < t.length - 2; i++) set.add(t.slice(i, i + 3));
  return set;
}

/** Sørensen–Dice similarity over trigrams, ~0..1. */
function diceSim(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const g of ta) if (tb.has(g)) inter++;
  return (2 * inter) / (ta.size + tb.size);
}

/** Rank candidates by similarity to the needle; keep the closest above a floor. */
function rankClosest(needle: string, candidates: string[], limit: number): string[] {
  const n = needle.toLowerCase();
  return candidates
    .map((value) => ({ value, score: diceSim(n, value) }))
    .filter((c) => c.score >= 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((c) => c.value);
}

export async function suggestVocabulary(opts: {
  codePath?: string;
  entitySlug?: string;
  limit?: number;
}): Promise<{ code_path?: string[]; entity_slug?: string[] }> {
  const sql = getSql();
  const limit = opts.limit ?? 5;
  const out: { code_path?: string[]; entity_slug?: string[] } = {};

  if (opts.codePath) {
    const needle = opts.codePath.toLowerCase();
    const base = needle.split("/").pop() || needle;
    // Cheap substring pre-filter on the basename; fall back to a capped scan so
    // typos (no substring hit) can still be caught by trigram ranking.
    let rows = await sql<{ path: string }[]>`
      select path from code_assets
      where lower(path) like ${"%" + escapeLike(base) + "%"} escape '\\'
      limit 200`;
    if (rows.length === 0) {
      rows = await sql<{ path: string }[]>`select path from code_assets limit 2000`;
    }
    const ranked = rankClosest(needle, rows.map((r) => r.path), limit);
    if (ranked.length) out.code_path = ranked;
  }

  if (opts.entitySlug) {
    const needle = opts.entitySlug.toLowerCase();
    let rows = await sql<{ entity_slug: string }[]>`
      select entity_slug from entities
      where lower(entity_slug) like ${"%" + escapeLike(needle) + "%"} escape '\\'
      limit 200`;
    if (rows.length === 0) {
      rows = await sql<{ entity_slug: string }[]>`select entity_slug from entities limit 2000`;
    }
    const ranked = rankClosest(needle, rows.map((r) => r.entity_slug), limit);
    if (ranked.length) out.entity_slug = ranked;
  }

  return out;
}


function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
