/**
 * Shared loader: upsert an ImportPayload (sections + stories) into Postgres,
 * embedding each story on write. Used by the compiled `tieline import` command
 * and the opt-in import MCP tool, so the subtle bits — embed on
 * write, mint-or-upsert story keys, normalize entities/code paths into the
 * inverted-index join tables — live in exactly one place.
 *
 * Embeddings are prepared outside database transactions, then stories commit in
 * bounded atomic batches. Stable import refs make keyless retries idempotent.
 */

import type { Sql } from "postgres";
import { mapWithConcurrency, storyEmbeddingText, type Embedder } from "../embeddings.js";
import { vectorLiteral } from "../adapters/postgres/vector.js";
import { config } from "../config.js";
import type { ImportPayload, SectionRecord, StoryRecord } from "./schema.js";

export interface ImportResult {
  sections: number;
  stories: number;
  entities: number;
  code_paths: number;
  batches?: Array<{
    batch: number;
    stories: number;
    applied: number;
    skipped: number;
    status: "committed";
  }>;
}

/**
 * Deterministic, INJECTIVE fallback prefix over kebab-case section keys: the
 * full key uppercased, with empty segments dropped. Slicing each segment to 4
 * chars collided near-identical keys (e.g. 'user-setting' and 'user-settings'
 * both -> 'USER-SETT'), and mint_story_key then produced the SAME story_key for
 * two sections, which the on-conflict(story_key) upsert silently overwrote
 * (data loss). story_key/key_prefix are unbounded `text`, so long prefixes are
 * fine. Only affects brand-new fallback-minted sections; existing sections keep
 * their real prefixes via the end-of-import reconcile.
 */
function fallbackPrefix(sectionKey: string): string {
  const prefix = sectionKey
    .split("-")
    .filter((w) => w.length > 0)
    .join("-")
    .toUpperCase();
  if (!prefix) {
    throw new Error(
      `Cannot derive a key_prefix from section_key '${sectionKey}': no usable characters.`
    );
  }
  return prefix;
}

async function importStoryBatch(
  sql: Sql,
  embedder: Embedder,
  payload: ImportPayload,
  opts: { repo?: string } = {}
): Promise<ImportResult> {
  // code_assets rows are always grouped by an explicit repository identity.
  // Tieline workspaces provide opts.repo; standalone payloads may use their
  // import_source, and single-repository servers may set REPO_NAME.
  const repo = opts.repo ?? config.repo ?? payload.import_source ?? undefined;
  if (!repo && payload.stories.some((story) => story.code_paths.length > 0)) {
    throw new Error(
      "A repository identity is required when importing code paths. Use a Tieline workspace, " +
        "set import_source in the payload, or configure REPO_NAME."
    );
  }
  const sectionMeta = new Map<string, SectionRecord>(
    payload.sections.map((s) => [s.section_key, s])
  );

  let sectionCount = 0;
  let entityCount = 0;
  let assetCount = 0;

  const refs = payload.import_source
    ? payload.stories.flatMap((story) => (story.import_ref ? [story.import_ref] : []))
    : [];
  const completedRefs = new Set<string>();
  if (payload.import_source && refs.length > 0) {
    const prior = await sql<{ import_ref: string }[]>`
      select import_ref from story_import_refs
      where import_source = ${payload.import_source} and import_ref = any(${refs})`;
    for (const row of prior) completedRefs.add(row.import_ref);
  }
  const pendingStories = payload.stories.filter(
    (story) => !(story.import_ref && completedRefs.has(story.import_ref))
  );
  const prepared = await mapWithConcurrency(pendingStories, 4, async (story) => ({
    story,
    embedding: await embedder.embed(storyEmbeddingText(story.title, story.story_text)),
  }));

  await sql.begin(async (tx) => {
    const sectionId = new Map<string, number>();
    const entityId = new Map<string, number>();
    const assetId = new Map<string, number>();

    const ensureSection = async (key: string): Promise<number> => {
      if (sectionId.has(key)) return sectionId.get(key)!;
      const meta = sectionMeta.get(key);
      const status = meta?.status ?? null;
      const [{ id }] = await tx<{ id: number }[]>`
        insert into sections
          (section_key, section_name, parent_area, default_actor, definition,
           backfill_wave, status, key_prefix)
        values (
          ${key}, ${meta?.section_name || key}, ${meta?.parent_area ?? null},
          ${meta?.actor ?? null}, ${meta?.definition ?? null}, ${meta?.backfill_wave ?? null},
          coalesce(${status}::story_status, 'production'::story_status), ${fallbackPrefix(key)}
        )
        on conflict (section_key) do update set
          section_name  = excluded.section_name,
          parent_area   = excluded.parent_area,
          default_actor = excluded.default_actor,
          definition    = excluded.definition,
          backfill_wave = excluded.backfill_wave,
          status        = coalesce(${status}::story_status, sections.status),
          key_prefix    = coalesce(sections.key_prefix, excluded.key_prefix),
          updated_at    = now()
        returning id`;
      sectionId.set(key, id);
      if (meta?.routes?.length) {
        for (let i = 0; i < meta.routes.length; i++) {
          await tx`
            insert into section_routes (section_id, route_path, sort_order)
            values (${id}, ${meta.routes[i]}, ${i})
            on conflict (section_id, route_path) do update set sort_order = excluded.sort_order`;
        }
      }
      return id;
    };

    const ensureEntity = async (slug: string): Promise<number> => {
      if (entityId.has(slug)) return entityId.get(slug)!;
      const name = slug.replace(/-/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
      const [{ id }] = await tx<{ id: number }[]>`
        insert into entities (entity_slug, entity_name)
        values (${slug}, ${name})
        on conflict (entity_slug) do update set entity_name = excluded.entity_name
        returning id`;
      entityId.set(slug, id);
      return id;
    };

    const ensureAsset = async (path: string): Promise<number> => {
      if (assetId.has(path)) return assetId.get(path)!;
      const [{ id }] = await tx<{ id: number }[]>`
        insert into code_assets (repo, path)
        values (${repo!}, ${path})
        on conflict (repo, path) do update set is_active = true
        returning id`;
      assetId.set(path, id);
      return id;
    };

    for (const preparedStory of prepared) {
      const s: StoryRecord = preparedStory.story;
      const secId = await ensureSection(s.section_key);
      const embedding = preparedStory.embedding;

      // Provided key -> upsert as-is. Keyless -> reuse the key reserved by a
      // stable (import_source, import_ref), otherwise mint once. We deliberately
      // do NOT dedup by title: distinct stories can legitimately share a title,
      // and title matching could silently overwrite an unrelated story.
      let storyKey = s.story_key ?? null;
      if (!storyKey && payload.import_source && s.import_ref) {
        const prior = await tx<{ story_key: string }[]>`
          select us.story_key
          from story_import_refs sir join user_stories us on us.id = sir.story_id
          where sir.import_source = ${payload.import_source} and sir.import_ref = ${s.import_ref}`;
        storyKey = prior[0]?.story_key ?? null;
      }
      if (!storyKey) {
        const k = await tx<{ k: string }[]>`select mint_story_key(${secId}) as k`;
        storyKey = k[0].k;
      }

      const [{ id: storyId, revision_number: revisionNumber }] = await tx<
        { id: number; revision_number: number }[]
      >`
        insert into user_stories (section_id, story_key, title, actor, story_text, status, embedding)
        values (${secId}, ${storyKey}, ${s.title}, ${s.actor ?? null}, ${s.story_text},
                ${s.status}::story_status, ${vectorLiteral(embedding)}::vector)
        on conflict (story_key) do update set
          section_id = excluded.section_id,
          title      = excluded.title,
          actor      = excluded.actor,
          story_text = excluded.story_text,
          status     = excluded.status,
          embedding  = excluded.embedding,
          revision_number = user_stories.revision_number + 1,
          updated_at = now()
        returning id, revision_number`;

      if (payload.import_source && s.import_ref) {
        await tx`
          insert into story_import_refs (story_id, import_source, import_ref)
          values (${storyId}, ${payload.import_source}, ${s.import_ref})
          on conflict (import_source, import_ref) do nothing`;
      }

      await tx`delete from story_entities where story_id = ${storyId}`;
      for (const slug of s.entity_slugs) {
        const eid = await ensureEntity(slug);
        await tx`
          insert into story_entities (story_id, entity_id)
          values (${storyId}, ${eid})
          on conflict (story_id, entity_id) do nothing`;
      }

      await tx`delete from story_code_assets where story_id = ${storyId}`;
      for (let p = 0; p < s.code_paths.length; p++) {
        const aid = await ensureAsset(s.code_paths[p]);
        await tx`
          insert into story_code_assets (story_id, code_asset_id, sort_order)
          values (${storyId}, ${aid}, ${p})
          on conflict (story_id, code_asset_id) do update set sort_order = excluded.sort_order`;
      }

      const revisionRows = await tx<{ id: number }[]>`
        insert into story_revisions
          (story_id, revision_number, section_id, title, actor, story_text, status,
           change_reason, source)
        values
          (${storyId}, ${revisionNumber}, ${secId}, ${s.title}, ${s.actor ?? null},
           ${s.story_text}, ${s.status}::story_status, 'Approved batch import',
           ${payload.import_source ?? "batch-import"})
        on conflict (story_id, revision_number) do nothing
        returning id`;
      const revisionId = revisionRows[0]?.id ?? null;
      await tx`
        insert into story_events
          (story_id, revision_id, event_type, to_status, details, source)
        values
          (${storyId}, ${revisionId}, 'imported', ${s.status}::story_status,
           ${tx.json({ import_ref: s.import_ref ?? null })},
           ${payload.import_source ?? "batch-import"})`;
    }

    // Reconcile key_prefix from the actual story keys (prefers real prefixes over
    // the deterministic fallback), then refresh 1/df weighting inputs. Scoped to
    // ONLY the sections touched this import, and the prefix is picked
    // DETERMINISTICALLY (the prefix of the section's min(story_key)) so a section
    // whose stories carry mixed prefixes doesn't get an arbitrary one; only rows
    // whose stored prefix actually differs are written.
    const touchedSectionIds = [...sectionId.values()];
    if (touchedSectionIds.length > 0) {
      await tx`
        update sections s
        set key_prefix = sub.prefix, updated_at = now()
        from (
          select distinct on (us.section_id)
                 us.section_id,
                 regexp_replace(us.story_key, '-[0-9]+$', '') as prefix
          from user_stories us
          where us.section_id = any(${touchedSectionIds})
          order by us.section_id, us.story_key
        ) sub
        where sub.section_id = s.id
          and s.key_prefix is distinct from sub.prefix`;
    }
    // Stash the caches so the counts below reflect what was touched.
    sectionCount = sectionId.size;
    entityCount = entityId.size;
    assetCount = assetId.size;
  });

  return {
    sections: sectionCount,
    stories: pendingStories.length,
    entities: entityCount,
    code_paths: assetCount,
  };
}

export async function importStories(
  sql: Sql,
  embedder: Embedder,
  payload: ImportPayload,
  opts: {
    repo?: string;
    batchSize?: number;
    onBatch?: (batch: {
      batch: number;
      stories: number;
      applied: number;
      skipped: number;
      status: "committed";
    }) => void | Promise<void>;
  } = {}
): Promise<ImportResult> {
  const batchSize = Math.min(Math.max(opts.batchSize ?? 50, 1), 200);
  const seenRefs = new Set<string>();
  for (const story of payload.stories) {
    if (!story.story_key && !(payload.import_source && story.import_ref)) {
      throw new Error(
        `Keyless story '${story.title}' requires both import_source and import_ref so retries are idempotent.`
      );
    }
    if (story.import_ref) {
      if (seenRefs.has(story.import_ref)) {
        throw new Error(`Duplicate import_ref '${story.import_ref}' in one payload.`);
      }
      seenRefs.add(story.import_ref);
    }
  }
  const batches: NonNullable<ImportResult["batches"]> = [];
  for (let offset = 0, batch = 1; offset < payload.stories.length; offset += batchSize, batch++) {
    const stories = payload.stories.slice(offset, offset + batchSize);
    const result = await importStoryBatch(sql, embedder, { ...payload, stories }, opts);
    const report = {
      batch,
      stories: stories.length,
      applied: result.stories,
      skipped: stories.length - result.stories,
      status: "committed" as const,
    };
    batches.push(report);
    await opts.onBatch?.(report);
  }
  return {
    sections: new Set(payload.stories.map((story) => story.section_key)).size,
    stories: payload.stories.length,
    entities: new Set(payload.stories.flatMap((story) => story.entity_slugs)).size,
    code_paths: new Set(payload.stories.flatMap((story) => story.code_paths)).size,
    batches,
  };
}
