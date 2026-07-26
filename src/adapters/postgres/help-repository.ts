import { mapWithConcurrency, type Embedder } from "../../embeddings.js";
import type { HelpArticle, HelpHit } from "../../types.js";
import type { HelpArticleImportInput, HelpArticleImportResult, HelpLinkSuggestionResult } from "../../domain/knowledge-store.js";
import { getIngestSql, getReadSql } from "./connections.js";
import { vectorLiteral } from "./vector.js";
const getSql = getReadSql;

// --- find_help (semantic search over help articles) -------------------------

const HELP_LINKED_STORIES_CAP = 5;

/** KNN over help_articles, optionally post-filtered by product_area/audience,
 *  each hit enriched with the story keys it documents. The min_score gate and
 *  final limit are applied by the caller (tool layer), mirroring find_related. */
export async function matchHelpArticles(opts: {
  embedding: number[];
  poolSize: number;
  productArea?: string[];
  audience?: string[];
}): Promise<HelpHit[]> {
  const sql = getSql();
  const rows = await sql<
    {
      id: number;
      article_slug: string;
      title: string;
      summary: string | null;
      url: string | null;
      product_area: string | null;
      audience: string | null;
      tags: string[] | null;
      headings: unknown;
      similarity: number;
    }[]
  >`select * from match_help_articles(
      ${vectorLiteral(opts.embedding)}::vector,
      ${opts.poolSize},
      ${opts.productArea?.length ? opts.productArea : null}::text[],
      ${opts.audience?.length ? opts.audience : null}::text[]
    )`;

  // Reverse lookup: the stories each surviving article documents.
  const linkMap = new Map<number, string[]>();
  if (rows.length) {
    const links = await sql<{ help_article_id: number; story_key: string }[]>`
      select sha.help_article_id, us.story_key
      from story_help_articles sha
      join user_stories us on us.id = sha.story_id
      where sha.help_article_id in ${sql(rows.map((r) => r.id))}
      order by sha.confidence desc`;
    for (const l of links) {
      const arr = linkMap.get(l.help_article_id) ?? [];
      arr.push(l.story_key);
      linkMap.set(l.help_article_id, arr);
    }
  }

  return rows.map((r) => {
    const stories = linkMap.get(r.id) ?? [];
    return {
      article_slug: r.article_slug,
      title: r.title,
      summary: r.summary,
      url: r.url,
      product_area: r.product_area,
      audience: r.audience,
      tags: r.tags ?? [],
      headings: Array.isArray(r.headings) ? (r.headings as string[]) : [],
      score: r.similarity,
      linked_story_keys: stories.slice(0, HELP_LINKED_STORIES_CAP),
      linked_story_count: stories.length,
    };
  });
}

// --- get_help_article (full body on demand, by exact slug) ------------------

/** Fetch full article bodies by exact slug. Returns the found articles in the
 *  caller's requested order plus the slugs that didn't match (recoverable miss,
 *  consistent with the rest of the server's "unmistakable empty" convention). */
export async function getHelpArticles(
  slugs: string[]
): Promise<{ articles: HelpArticle[]; not_found: string[] }> {
  const sql = getSql();
  if (slugs.length === 0) return { articles: [], not_found: [] };

  const rows = await sql<
    {
      article_slug: string;
      title: string;
      url: string | null;
      product_area: string | null;
      audience: string | null;
      tags: string[] | null;
      headings: unknown;
      markdown: string | null;
    }[]
  >`
    select article_slug, title, url, product_area, audience, tags, headings, markdown
    from help_articles
    where article_slug = any(${slugs})`;

  const bySlug = new Map(rows.map((r) => [r.article_slug, r]));
  const articles: HelpArticle[] = [];
  const not_found: string[] = [];
  for (const slug of slugs) {
    const r = bySlug.get(slug);
    if (!r) {
      not_found.push(slug);
      continue;
    }
    articles.push({
      article_slug: r.article_slug,
      title: r.title,
      url: r.url,
      product_area: r.product_area,
      audience: r.audience,
      tags: r.tags ?? [],
      headings: Array.isArray(r.headings) ? (r.headings as string[]) : [],
      markdown: r.markdown,
    });
  }
  return { articles, not_found };
}

/** Batch-upsert the KB corpus. Embeddings are prepared before each transaction,
 * so an external provider failure cannot leave a partially committed batch. */
export async function importHelpArticles(
  articles: HelpArticleImportInput[],
  embedder: Embedder,
  opts: { batchSize?: number } = {}
): Promise<HelpArticleImportResult> {
  const batchSize = opts.batchSize ?? 50;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 200) {
    throw new Error("Help import batchSize must be an integer from 1 to 200.");
  }
  const slugs = new Set<string>();
  for (const article of articles) {
    if (slugs.has(article.article_slug)) {
      throw new Error(`Duplicate help article_slug in import: ${article.article_slug}`);
    }
    slugs.add(article.article_slug);
  }

  const sql = getIngestSql();
  const batches: HelpArticleImportResult["batches"] = [];
  for (let offset = 0; offset < articles.length; offset += batchSize) {
    const batch = articles.slice(offset, offset + batchSize);
    const prepared = await mapWithConcurrency(batch, 4, async (article) => ({
      article,
      embedding: await embedder.embed(
        [article.title, article.summary ?? "", ...(article.headings ?? [])]
          .filter(Boolean)
          .join("\n")
      ),
    }));
    await sql.begin(async (tx) => {
      for (const { article, embedding } of prepared) {
        await tx`
          insert into help_articles (
            article_slug, title, summary, url, product_area, audience,
            tags, headings, markdown, embedding, updated_at
          ) values (
            ${article.article_slug}, ${article.title}, ${article.summary ?? null},
            ${article.url ?? null}, ${article.product_area ?? null}, ${article.audience ?? null},
            ${article.tags ?? []}, ${JSON.stringify(article.headings ?? [])}::jsonb,
            ${article.markdown ?? null}, ${vectorLiteral(embedding)}::vector, now()
          )
          on conflict (article_slug) do update set
            title = excluded.title,
            summary = excluded.summary,
            url = excluded.url,
            product_area = excluded.product_area,
            audience = excluded.audience,
            tags = excluded.tags,
            headings = excluded.headings,
            markdown = excluded.markdown,
            embedding = excluded.embedding,
            updated_at = now()`;
      }
    });
    batches.push({ batch: batches.length + 1, articles: batch.length, status: "committed" });
  }
  return { articles: articles.length, batches };
}

/** Rank unlinked and already-linked story/article pairs for human review.
 * This never mutates links; update_story_relationships remains the sole link path. */
export async function suggestStoryHelpLinks(opts: {
  storyKey?: string;
  articleSlug?: string;
  limit?: number;
}): Promise<HelpLinkSuggestionResult | null> {
  if (Boolean(opts.storyKey) === Boolean(opts.articleSlug)) {
    throw new Error("Provide exactly one of storyKey or articleSlug.");
  }
  const sql = getSql();
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  if (opts.storyKey) {
    const source = await sql<{ id: number; story_key: string }[]>`
      select id, story_key from user_stories where story_key = ${opts.storyKey}`;
    if (!source[0]) return null;
    const rows = await sql<{
      story_key: string; story_title: string; article_slug: string; article_title: string;
      score: number; already_linked: boolean;
    }[]>`
      select us.story_key, us.title as story_title, ha.article_slug,
             ha.title as article_title, 1 - (us.embedding <=> ha.embedding) as score,
             exists(select 1 from story_help_articles sha
                    where sha.story_id = us.id and sha.help_article_id = ha.id) as already_linked
      from user_stories us cross join help_articles ha
      where us.id = ${source[0].id} and us.embedding is not null and ha.embedding is not null
      order by us.embedding <=> ha.embedding
      limit ${limit}`;
    return { direction: "story_to_articles", source_key: opts.storyKey, suggestions: rows };
  }

  const source = await sql<{ id: number; article_slug: string }[]>`
    select id, article_slug from help_articles where article_slug = ${opts.articleSlug!}`;
  if (!source[0]) return null;
  const rows = await sql<{
    story_key: string; story_title: string; article_slug: string; article_title: string;
    score: number; already_linked: boolean;
  }[]>`
    select us.story_key, us.title as story_title, ha.article_slug,
           ha.title as article_title, 1 - (us.embedding <=> ha.embedding) as score,
           exists(select 1 from story_help_articles sha
                  where sha.story_id = us.id and sha.help_article_id = ha.id) as already_linked
    from help_articles ha cross join user_stories us
    where ha.id = ${source[0].id} and ha.embedding is not null and us.embedding is not null
    order by ha.embedding <=> us.embedding
    limit ${limit}`;
  return { direction: "article_to_stories", source_key: opts.articleSlug!, suggestions: rows };
}
