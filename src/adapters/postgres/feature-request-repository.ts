import type { FeatureRequestRecord } from "../../types.js";
import { config } from "../../config.js";
import type {
  FeatureRequestLinkMutationResult,
  StoryChangeProposalSummary,
} from "../../domain/knowledge-store.js";
import { getApprovalSql, getReadSql, getWriteSql } from "./connections.js";
const getSql = getReadSql;

export interface NewFeatureRequest {
  source?: string | null;
  source_thread_id?: string | null;
  source_thread_url?: string | null;
  raw_thread_jsonb?: unknown;
  title: string;
  summary?: string | null;
  requested_change?: string | null;
  context?: string | null;
  priority_signal?: string | null;
  confidence?: number | null;
  product_area?: string | null;
  status?: string | null;
  notion_page_id?: string | null;
}

/** Resolve story_keys → {id, title}, throwing if any are unknown. */
interface ResolvedStory {
  id: number;
  title: string;
  status: string;
  revision_number: number;
}

async function resolveStories(keys: string[]): Promise<Map<string, ResolvedStory>> {
  const read = getSql();
  const rows = await read<(ResolvedStory & { story_key: string })[]>`
    select id, story_key, title, status::text as status, revision_number
    from user_stories where story_key = any(${keys})`;
  const map = new Map(rows.map((r) => [r.story_key, {
    id: r.id,
    title: r.title,
    status: r.status,
    revision_number: r.revision_number,
  }]));
  const missing = keys.filter((k) => !map.has(k));
  if (missing.length) throw new Error(`Unknown story_key(s): ${missing.join(", ")}. Nothing was written.`);
  return map;
}

function proposalSummary(row: {
  id: number;
  operation: "relationships";
  status: "pending";
  proposed_story_key: string;
  base_revision_number: number;
  reason: string | null;
  source: string;
  created_at: string | Date;
}): StoryChangeProposalSummary {
  return {
    id: Number(row.id),
    operation: row.operation,
    status: row.status,
    story_key: row.proposed_story_key,
    base_revision_number: row.base_revision_number,
    reason: row.reason,
    source: row.source,
    created_at: new Date(row.created_at).toISOString(),
  };
}

/** Insert an FR + its primary/secondary links in ONE transaction. */
export async function createFeatureRequest(opts: {
  fr: NewFeatureRequest;
  primaryStoryKey: string;
  secondaryStoryKeys?: string[];
  linkSource?: string | null;
}): Promise<{ id: number; link_revision: number; links: { story_key: string; link_type: string }[] }> {
  const secondaries = [...new Set(opts.secondaryStoryKeys ?? [])].filter(
    (k) => k !== opts.primaryStoryKey
  );
  const stories = await resolveStories([opts.primaryStoryKey, ...secondaries]);

  const sql = getWriteSql();
  const f = opts.fr;
  return await sql.begin(async (tx) => {
    const fr = await tx<{ id: number }[]>`
      insert into feature_requests
        (source, source_thread_id, source_thread_url, raw_thread_jsonb, title, summary,
         requested_change, context, priority_signal, confidence, product_area, status,
         notion_page_id, last_triaged_at)
      values
        (${f.source ?? null}, ${f.source_thread_id ?? null}, ${f.source_thread_url ?? null},
         ${f.raw_thread_jsonb != null ? tx.json(f.raw_thread_jsonb as Parameters<typeof tx.json>[0]) : null}, ${f.title},
         ${f.summary ?? null}, ${f.requested_change ?? null}, ${f.context ?? null},
         ${f.priority_signal ?? null}, ${f.confidence ?? null}, ${f.product_area ?? null},
         ${f.status ?? "triaged"}, ${f.notion_page_id ?? null}, now())
      returning id`;
    const frId = Number(fr[0].id);

    const links: { story_key: string; link_type: string }[] = [];
    const insertLink = async (storyKey: string, linkType: "primary" | "secondary") => {
      const s = stories.get(storyKey)!;
      await tx`
        insert into feature_request_story_links
          (feature_request_id, user_story_id, user_story_title_snapshot, link_type, link_source)
        values (${frId}, ${s.id}, ${s.title}, ${linkType}, ${opts.linkSource ?? null})`;
      links.push({ story_key: storyKey, link_type: linkType });
    };
    await insertLink(opts.primaryStoryKey, "primary");
    for (const k of secondaries) await insertLink(k, "secondary");
    return { id: frId, link_revision: 1, links };
  });
}

/** Add one link to an existing FR (respects the one-primary constraint). */
export async function linkFeatureRequest(opts: {
  featureRequestId: number;
  storyKey: string;
  linkType: "primary" | "secondary";
  linkSource?: string | null;
}): Promise<{ feature_request_id: number; story_key: string; link_type: string; link_revision: number }> {
  const stories = await resolveStories([opts.storyKey]);
  const s = stories.get(opts.storyKey)!;
  if (config.storyApprovalMode === "all" || s.status === "production") {
    throw new Error(
      "link_feature_request is a deprecated additive alias and cannot alter approval-sensitive mappings. " +
        "Use set_feature_request_story_links with the complete desired mapping."
    );
  }
  const sql = getWriteSql();
  const linkRevision = await sql.begin(async (tx) => {
    const current = await tx<{ link_revision: number }[]>`
      select link_revision from feature_requests where id = ${opts.featureRequestId} for update`;
    if (!current[0]) throw new Error(`Unknown feature_request_id ${opts.featureRequestId}. Nothing was written.`);
    await tx`
      insert into feature_request_story_links
        (feature_request_id, user_story_id, user_story_title_snapshot, link_type, link_source)
      values (${opts.featureRequestId}, ${s.id}, ${s.title}, ${opts.linkType}, ${opts.linkSource ?? null})`;
    const updated = await tx<{ link_revision: number }[]>`
      update feature_requests set link_revision = link_revision + 1, updated_at = now()
      where id = ${opts.featureRequestId} returning link_revision`;
    await tx`insert into story_events (story_id, event_type, details, actor_label, source)
      values (${s.id}, 'feature_request_link_added',
              ${tx.json({ feature_request_id: opts.featureRequestId, link_type: opts.linkType })},
              ${opts.linkSource ?? null}, ${opts.linkSource ?? "mcp"})`;
    return Number(updated[0].link_revision);
  });
  return { feature_request_id: opts.featureRequestId, story_key: opts.storyKey, link_type: opts.linkType, link_revision: linkRevision };
}

/** Atomically replace the complete primary/secondary mapping for one request. */
export async function setFeatureRequestStoryLinks(opts: {
  featureRequestId: number;
  primaryStoryKey: string;
  secondaryStoryKeys?: string[];
  linkSource?: string | null;
  expectedVersion?: number;
}): Promise<FeatureRequestLinkMutationResult> {
  const secondaryKeys = [...new Set(opts.secondaryStoryKeys ?? [])].filter(
    (key) => key !== opts.primaryStoryKey
  );
  const stories = await resolveStories([opts.primaryStoryKey, ...secondaryKeys]);
  const read = getSql();
  const currentFr = await read<{ link_revision: number }[]>`
    select link_revision from feature_requests where id = ${opts.featureRequestId}`;
  if (!currentFr[0]) return { outcome: "not_found" };
  if (opts.expectedVersion !== undefined && opts.expectedVersion !== currentFr[0].link_revision) {
    return { outcome: "stale", current_version: currentFr[0].link_revision };
  }
  const currentStatuses = await read<{ status: string }[]>`
    select us.status::text as status
    from feature_request_story_links links
    join user_stories us on us.id = links.user_story_id
    where links.feature_request_id = ${opts.featureRequestId}`;
  const sensitive =
    [...stories.values()].some((story) => story.status === "production") ||
    currentStatuses.some((story) => story.status === "production");
  const requiresProposal =
    config.storyApprovalMode === "all" ||
    (config.storyApprovalMode === "production" && sensitive) ||
    (config.storyApprovalMode === "off" && sensitive);
  const expectedVersion = opts.expectedVersion ?? currentFr[0].link_revision;
  const sql = getWriteSql();
  if (requiresProposal) {
    const anchor = stories.get(opts.primaryStoryKey)!;
    const source = opts.linkSource ?? "mcp";
    const rows = await sql<{
      id: number;
      operation: "relationships";
      status: "pending";
      proposed_story_key: string;
      base_revision_number: number;
      reason: string | null;
      source: string;
      created_at: string | Date;
    }[]>`
      insert into story_change_proposals
        (story_id, proposed_story_key, operation, patch, base_revision_number,
         reason, proposed_by, source)
      values
        (${anchor.id}, ${opts.primaryStoryKey}, 'relationships',
         ${sql.json({
           feature_request_links: {
             feature_request_id: opts.featureRequestId,
             primary_story_key: opts.primaryStoryKey,
             secondary_story_keys: secondaryKeys,
             expected_version: expectedVersion,
             link_source: opts.linkSource ?? null,
           },
         })}, ${anchor.revision_number}, 'Replace feature-request story mapping',
         ${opts.linkSource ?? null}, ${source})
      returning id, operation, status, proposed_story_key, base_revision_number,
                reason, source, created_at`;
    const proposal = proposalSummary(rows[0]);
    if (config.storyApprovalMode === "off") {
      const approval = getApprovalSql();
      const approved = await approval<{ outcome: string }[]>`
        select * from approve_feature_request_link_change(
          ${proposal.id}, ${opts.linkSource ?? "auto-approval"},
          ${"STORY_APPROVAL_MODE=off"}
        )`;
      if (approved[0]?.outcome !== "approved") {
        if (approved[0]?.outcome === "stale") {
          const latest = await read<{ link_revision: number }[]>`
            select link_revision from feature_requests where id = ${opts.featureRequestId}`;
          return { outcome: "stale", current_version: latest[0]?.link_revision ?? expectedVersion };
        }
        throw new Error(`Automatic feature-request link approval failed with '${approved[0]?.outcome}'.`);
      }
      const latest = await read<{ link_revision: number }[]>`
        select link_revision from feature_requests where id = ${opts.featureRequestId}`;
      return {
        outcome: "applied",
        feature_request_id: opts.featureRequestId,
        link_revision: latest[0].link_revision,
        links: [
          { story_key: opts.primaryStoryKey, link_type: "primary" },
          ...secondaryKeys.map((story_key) => ({ story_key, link_type: "secondary" })),
        ],
      };
    }
    return { outcome: "proposed", proposal };
  }
  return sql.begin(async (tx) => {
    const exists = await tx<{ id: number; link_revision: number }[]>`
      select id, link_revision from feature_requests where id = ${opts.featureRequestId} for update`;
    if (!exists[0]) throw new Error(`Unknown feature_request_id ${opts.featureRequestId}. Nothing was written.`);
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== exists[0].link_revision) {
      throw new Error(
        `Stale feature request link version: expected ${opts.expectedVersion}, current ${exists[0].link_revision}. Nothing was written.`
      );
    }
    await tx`delete from feature_request_story_links where feature_request_id = ${opts.featureRequestId}`;
    const links: { story_key: string; link_type: string }[] = [];
    const insert = async (storyKey: string, linkType: "primary" | "secondary") => {
      const story = stories.get(storyKey)!;
      await tx`
        insert into feature_request_story_links
          (feature_request_id, user_story_id, user_story_title_snapshot, link_type, link_source)
        values
          (${opts.featureRequestId}, ${story.id}, ${story.title}, ${linkType}, ${opts.linkSource ?? null})`;
      links.push({ story_key: storyKey, link_type: linkType });
    };
    await insert(opts.primaryStoryKey, "primary");
    for (const key of secondaryKeys) await insert(key, "secondary");
    for (const [storyKey, story] of stories) {
      await tx`
        insert into story_events (story_id, event_type, details, actor_label, source)
        values
          (${story.id}, 'feature_request_links_replaced',
           ${tx.json({ feature_request_id: opts.featureRequestId, story_key: storyKey })},
           ${opts.linkSource ?? null}, ${opts.linkSource ?? "mcp"})`;
    }
    const updated = await tx<{ link_revision: number }[]>`
      update feature_requests set link_revision = link_revision + 1, updated_at = now()
      where id = ${opts.featureRequestId} returning link_revision`;
    return { outcome: "applied" as const, feature_request_id: opts.featureRequestId, link_revision: Number(updated[0].link_revision), links };
  });
}

/** Read back an FR + its primary/secondary stories (READ connection). */
export async function getFeatureRequest(id: number): Promise<FeatureRequestRecord | null> {
  const read = getSql();
  const fr = await read<
    {
      id: number; source: string | null; source_thread_id: string | null;
      source_thread_url: string | null; title: string; summary: string | null;
      requested_change: string | null; context: string | null; priority_signal: string | null;
      confidence: number | null; product_area: string | null; status: string;
      notion_page_id: string | null; created_at: string; link_revision: number;
    }[]
  >`
    select id, source, source_thread_id, source_thread_url, title, summary, requested_change,
           context, priority_signal, confidence, product_area, status, notion_page_id, created_at, link_revision
    from feature_requests where id = ${id}`;
  if (fr.length === 0) return null;

  const links = await read<{ link_type: string; story_key: string; title: string }[]>`
    select l.link_type, us.story_key, us.title
    from feature_request_story_links l
    join user_stories us on us.id = l.user_story_id
    where l.feature_request_id = ${id}
    order by l.link_type, us.story_key`;

  const primary = links.find((l) => l.link_type === "primary") ?? null;
  const secondaries = links.filter((l) => l.link_type === "secondary");
  return {
    ...fr[0],
    id: Number(fr[0].id),
    created_at: new Date(fr[0].created_at as unknown as string | Date).toISOString(),
    primary_story: primary ? { story_key: primary.story_key, title: primary.title } : null,
    secondary_stories: secondaries.map((s) => ({ story_key: s.story_key, title: s.title })),
  };
}
