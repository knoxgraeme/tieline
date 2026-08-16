import { createHash } from "node:crypto";
import type {
  HelpArticleRecord,
  HelpArticleRef,
  HelpSearchHit,
} from "../../domain/knowledge-store.js";
import type { HelpArticleImportRecord } from "../../authoring/help-schema.js";
import { getReadSql, getSyncSql } from "./connections.js";
import type {
  ContractAuthority,
  StoryLifecycle,
} from "../../types.js";
import type { SemanticSearchContext } from "../../domain/semantic-search-store.js";
import { scoreSearchContext } from "./search-context.js";

interface HelpRow {
  id: string;
  source: string;
  external_id: string;
  title: string | null;
  url: string | null;
  summary: string | null;
  markdown: string | null;
  updated_at: Date | string;
}

interface StoryHelpLink {
  article_id: string;
  repository: string;
  stable_id: string;
  authority: ContractAuthority;
  lifecycle: StoryLifecycle;
}

interface CriterionHelpLink extends StoryHelpLink {
  story_stable_id: string;
}

type LinkedHelpFilters = Pick<
  Parameters<typeof searchHelpArticles>[0],
  "authorities" | "lifecycles" | "repositories" | "include_inactive"
>;

export function hasLinkedHelpFilters(input: LinkedHelpFilters): boolean {
  return Boolean(
    input.authorities?.length ||
      input.lifecycles?.length ||
      input.repositories?.length
  );
}

function articleContent(article: HelpArticleImportRecord): {
  title: string | null;
  url: string | null;
  summary: string | null;
  markdown: string | null;
} {
  return {
    title: article.title ?? null,
    url: article.url ?? null,
    summary: article.summary ?? null,
    markdown: article.markdown ?? null,
  };
}

export async function searchHelpArticles(input: {
  query: string;
  sources?: string[];
  authorities?: ContractAuthority[];
  lifecycles?: StoryLifecycle[];
  repositories?: string[];
  include_inactive?: boolean;
  context?: SemanticSearchContext;
  limit: number;
}): Promise<HelpSearchHit[]> {
  const sql = getReadSql();
  const sourceFilter =
    input.sources?.length
      ? sql`and article.source = any(${input.sources})`
      : sql``;
  const storyAuthorityFilter = input.authorities?.length
    ? sql`and story.authority = any(${input.authorities}::contract_authority[])`
    : sql``;
  const criterionAuthorityFilter = input.authorities?.length
    ? sql`and criterion.authority = any(${input.authorities}::contract_authority[])`
    : sql``;
  const lifecycleFilter = input.lifecycles?.length
    ? sql`and story.lifecycle = any(${input.lifecycles}::story_lifecycle[])`
    : sql``;
  const repositoryFilter = input.repositories?.length
    ? sql`and repository.key = any(${input.repositories})`
    : sql``;
  const activeStoryFilter = input.include_inactive
    ? sql``
    : sql`and story.lifecycle <> 'retired'`;
  const activeCriterionFilter = input.include_inactive
    ? sql``
    : sql`and criterion.active`;
  const linkedRecordFilter =
    hasLinkedHelpFilters(input)
      ? sql`and (
          exists (
            select 1
            from story_help_articles story_link
            join user_stories story on story.id = story_link.story_id
            join repositories repository on repository.id = story.repository_id
            where story_link.article_id = article.id
            ${storyAuthorityFilter}
            ${lifecycleFilter}
            ${repositoryFilter}
            ${activeStoryFilter}
          )
          or exists (
            select 1
            from criterion_help_articles criterion_link
            join acceptance_criteria criterion
              on criterion.id = criterion_link.criterion_id
            join repositories repository
              on repository.id = criterion.repository_id
            join user_stories story on story.id = criterion.story_id
            where criterion_link.article_id = article.id
            ${criterionAuthorityFilter}
            ${lifecycleFilter}
            ${repositoryFilter}
            ${activeStoryFilter}
            ${activeCriterionFilter}
          )
        )`
      : sql``;
  const rows = await sql<
    Array<
      HelpRow & {
        lexical_score: number;
        linked_story_count: number;
        linked_acceptance_criterion_count: number;
      }
    >
  >`
    with query as (
      select websearch_to_tsquery('simple', ${input.query}) as terms
    )
    select
      article.*,
      ts_rank_cd(
        article.search_vector,
        query.terms
      )::float as lexical_score,
      (
        select count(*)::int
        from story_help_articles link
        where link.article_id = article.id
      ) as linked_story_count,
      (
        select count(*)::int
        from criterion_help_articles link
        where link.article_id = article.id
      ) as linked_acceptance_criterion_count
    from help_articles article
    cross join query
    where (
      article.search_vector @@ query.terms
      or article.title ilike ${`%${input.query}%`}
      or article.summary ilike ${`%${input.query}%`}
    )
    ${sourceFilter}
    ${linkedRecordFilter}
    order by lexical_score desc, article.source, article.external_id
    limit ${input.limit}
  `;
  const contextFeatures = input.context
    ? await scoreSearchContext(
        sql,
        rows.map((row) => ({
          document_id: row.id,
          entity_kind: "help_article",
          entity_id: row.id,
        })),
        input.context,
        input.include_inactive === true
      )
    : new Map();
  return rows.map((row) => ({
    id: row.id,
    source: row.source,
    external_id: row.external_id,
    title: row.title,
    url: row.url,
    summary: row.summary,
    lexical_score: Number(row.lexical_score),
    graph_proximity:
      contextFeatures.get(row.id)?.graph_proximity ?? 0,
    linked_story_count: Number(row.linked_story_count),
    linked_acceptance_criterion_count: Number(
      row.linked_acceptance_criterion_count
    ),
  }));
}

export async function getHelpArticles(
  refs: HelpArticleRef[]
): Promise<{ articles: HelpArticleRecord[]; not_found: HelpArticleRef[] }> {
  if (refs.length === 0) return { articles: [], not_found: [] };
  const sql = getReadSql();
  const deduped = [
    ...new Map(
      refs.map((ref) => [`${ref.source}\0${ref.external_id}`, ref])
    ).values(),
  ];
  const rows = await sql<HelpRow[]>`
    with requested as (
      select *
      from unnest(
        ${deduped.map((ref) => ref.source)}::text[],
        ${deduped.map((ref) => ref.external_id)}::text[]
      ) as requested(source, external_id)
    )
    select article.*
    from requested
    join help_articles article using (source, external_id)
  `;
  const articleIds = rows.map((row) => row.id);
  let storyLinks: StoryHelpLink[] = [];
  let criterionLinks: CriterionHelpLink[] = [];
  if (articleIds.length > 0) {
    [storyLinks, criterionLinks] = await Promise.all([
      sql<StoryHelpLink[]>`
          select link.article_id, repository.key as repository,
                 story.stable_id, story.authority::text, story.lifecycle::text
          from story_help_articles link
          join user_stories story on story.id = link.story_id
          join repositories repository on repository.id = story.repository_id
          where link.article_id = any(${articleIds})
          order by repository.key, story.stable_id
        `,
      sql<CriterionHelpLink[]>`
          select link.article_id, repository.key as repository,
                 criterion.stable_id, story.stable_id as story_stable_id,
                 criterion.authority::text, story.lifecycle::text
          from criterion_help_articles link
          join acceptance_criteria criterion on criterion.id = link.criterion_id
          join user_stories story on story.id = criterion.story_id
          join repositories repository on repository.id = criterion.repository_id
          where link.article_id = any(${articleIds})
          order by repository.key, criterion.stable_id
        `,
    ]);
  }
  const storiesByArticle = new Map<
    string,
    HelpArticleRecord["linked_stories"]
  >();
  for (const { article_id, ...link } of storyLinks) {
    const links = storiesByArticle.get(article_id) ?? [];
    links.push(link);
    storiesByArticle.set(article_id, links);
  }
  const criteriaByArticle = new Map<
    string,
    HelpArticleRecord["linked_acceptance_criteria"]
  >();
  for (const { article_id, ...link } of criterionLinks) {
    const links = criteriaByArticle.get(article_id) ?? [];
    links.push(link);
    criteriaByArticle.set(article_id, links);
  }

  const byKey = new Map(
    rows.map((row) => [
      `${row.source}\0${row.external_id}`,
      {
        source: row.source,
        external_id: row.external_id,
        title: row.title,
        url: row.url,
        summary: row.summary,
        markdown: row.markdown,
        updated_at:
          row.updated_at instanceof Date
            ? row.updated_at.toISOString()
            : String(row.updated_at),
        linked_stories: storiesByArticle.get(row.id) ?? [],
        linked_acceptance_criteria:
          criteriaByArticle.get(row.id) ?? [],
      } satisfies HelpArticleRecord,
    ])
  );
  return {
    articles: deduped
      .map((ref) => byKey.get(`${ref.source}\0${ref.external_id}`))
      .filter((article): article is HelpArticleRecord => article !== undefined),
    not_found: deduped.filter(
      (ref) => !byKey.has(`${ref.source}\0${ref.external_id}`)
    ),
  };
}

export async function importHelpArticles(
  articles: HelpArticleImportRecord[],
  options: { batchSize: number }
): Promise<{
  articles: number;
  batches: Array<{ batch: number; articles: number; status: "committed" }>;
}> {
  const seen = new Set<string>();
  for (const article of articles) {
    const key = `${article.source}\0${article.external_id}`;
    if (seen.has(key)) {
      throw new Error(
        `Duplicate help article reference '${article.source}:${article.external_id}'.`
      );
    }
    seen.add(key);
  }
  const sql = getSyncSql();
  const batches: Array<{
    batch: number;
    articles: number;
    status: "committed";
  }> = [];
  for (let offset = 0; offset < articles.length; offset += options.batchSize) {
    const batch = articles.slice(offset, offset + options.batchSize);
    await sql.begin(async (tx) => {
      const rows = batch.map((article) => {
        const content = articleContent(article);
        return {
          source: article.source,
          external_id: article.external_id,
          ...content,
          content_hash: createHash("sha256")
            .update(JSON.stringify(content))
            .digest("hex"),
        };
      });
      await tx`
        insert into help_articles ${tx(rows)}
        on conflict (source, external_id) do update set
          title = excluded.title,
          url = excluded.url,
          summary = excluded.summary,
          markdown = excluded.markdown,
          content_hash = excluded.content_hash,
          updated_at = now()
      `;
    });
    batches.push({
      batch: batches.length + 1,
      articles: batch.length,
      status: "committed",
    });
  }
  return { articles: articles.length, batches };
}
