import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import type {
  BacklogItemLinks,
  BacklogItemRecord,
  BacklogItemSnapshot,
  BacklogMutationResult,
  BacklogReadStore,
  BacklogStage,
  BacklogWriteStore,
  SemanticTargetRef,
} from "../../domain/evidence-write-store.js";
import { getWriteSql } from "./connections.js";

interface BacklogRow {
  id: string;
  stable_id: string;
  title: string;
  summary: string;
  stage: BacklogStage;
  revision: string | number;
  superseded_by: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

type Tx = TransactionSql<Record<string, never>>;

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function backlogRecord(row: BacklogRow): BacklogItemRecord {
  return {
    ...row,
    revision: Number(row.revision),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueTargets(values: SemanticTargetRef[]): SemanticTargetRef[] {
  const targets = new Map<string, SemanticTargetRef>();
  for (const value of values) {
    targets.set(`${value.repository}\0${value.stable_id}`, value);
  }
  return [...targets.values()];
}

async function backlogByStableId(
  tx: Tx,
  stableId: string,
  lock = false
): Promise<BacklogRow | undefined> {
  const rows = lock
    ? await tx<BacklogRow[]>`
        select
          item.id, item.stable_id, item.title, item.summary,
          item.stage::text, item.revision,
          successor.stable_id as superseded_by,
          item.created_at, item.updated_at
        from backlog_items item
        left join backlog_items successor on successor.id = item.superseded_by_id
        where item.stable_id = ${stableId}
        for update of item`
    : await tx<BacklogRow[]>`
        select
          item.id, item.stable_id, item.title, item.summary,
          item.stage::text, item.revision,
          successor.stable_id as superseded_by,
          item.created_at, item.updated_at
        from backlog_items item
        left join backlog_items successor on successor.id = item.superseded_by_id
        where item.stable_id = ${stableId}`;
  return rows[0];
}

async function resolveTargets(
  tx: Tx,
  kind: "story" | "acceptance_criterion",
  targets: SemanticTargetRef[]
): Promise<Array<{ id: string; target: SemanticTargetRef }>> {
  const resolved: Array<{ id: string; target: SemanticTargetRef }> = [];
  for (const target of uniqueTargets(targets)) {
    const rows =
      kind === "story"
        ? await tx<{ id: string }[]>`
            select us.id
            from user_stories us
            join repositories r on r.id = us.repository_id
            where r.key = ${target.repository} and us.stable_id = ${target.stable_id}`
        : await tx<{ id: string }[]>`
            select ac.id
            from acceptance_criteria ac
            join repositories r on r.id = ac.repository_id
            where r.key = ${target.repository} and ac.stable_id = ${target.stable_id}`;
    if (!rows[0]) {
      throw new Error(
        `Unknown ${kind} '${target.repository}:${target.stable_id}'. Nothing was written.`
      );
    }
    resolved.push({ id: rows[0].id, target });
  }
  return resolved;
}

export class PostgresBacklogRepository
  implements BacklogWriteStore, BacklogReadStore
{
  constructor(private readonly sqlProvider: () => Sql = getWriteSql) {}

  async getBacklogItem(input: {
    stable_id: string;
  }): Promise<BacklogItemSnapshot | null> {
    const sql = this.sqlProvider();
    const rows = await sql<BacklogRow[]>`
      select
        item.id, item.stable_id, item.title, item.summary,
        item.stage::text, item.revision,
        successor.stable_id as superseded_by,
        item.created_at, item.updated_at
      from backlog_items item
      left join backlog_items successor on successor.id = item.superseded_by_id
      where item.stable_id = ${input.stable_id}`;
    if (!rows[0]) return null;
    const observationRows = await sql<{ id: string }[]>`
      select attribution.observation_id as id
      from observation_backlog_attributions attribution
      where attribution.backlog_item_id = ${rows[0].id}
      order by attribution.observation_id`;
    const storyRows = await sql<SemanticTargetRef[]>`
      select repository.key as repository, story.stable_id
      from backlog_story_targets target
      join user_stories story on story.id = target.story_id
      join repositories repository on repository.id = story.repository_id
      where target.backlog_item_id = ${rows[0].id}
      order by repository.key, story.stable_id`;
    const criterionRows = await sql<SemanticTargetRef[]>`
      select repository.key as repository, criterion.stable_id
      from backlog_criterion_targets target
      join acceptance_criteria criterion
        on criterion.id = target.criterion_id
      join repositories repository
        on repository.id = criterion.repository_id
      where target.backlog_item_id = ${rows[0].id}
      order by repository.key, criterion.stable_id`;
    return {
      item: backlogRecord(rows[0]),
      links: {
        observation_ids: Array.from(observationRows, (row) => row.id),
        stories: Array.from(storyRows),
        acceptance_criteria: Array.from(criterionRows),
      },
    };
  }

  async createBacklogItem(input: {
    stable_id?: string;
    title: string;
    summary: string;
    stage?: BacklogStage;
  }): Promise<BacklogItemRecord> {
    const sql = this.sqlProvider();
    const stableId = input.stable_id?.trim() || `BL-${randomUUID()}`;
    return sql.begin(async (tx) => {
      const rows = await tx<BacklogRow[]>`
        insert into backlog_items (stable_id, title, summary, stage)
        values (
          ${stableId}, ${input.title.trim()}, ${input.summary.trim()},
          ${input.stage ?? "open"}
        )
        returning
          id, stable_id, title, summary, stage::text, revision,
          null::text as superseded_by, created_at, updated_at`;
      const item = rows[0];
      await tx`
        insert into audit_events (
          event_kind, entity_kind, entity_id, detail
        ) values (
          'backlog_item_created', 'backlog_item', ${item.id},
          ${tx.json({
            backlog_item_id: item.id,
            stable_id: item.stable_id,
            stage: item.stage,
          })}
        )`;
      return backlogRecord(item);
    });
  }

  async updateBacklogItem(input: {
    stable_id: string;
    expected_revision: number;
    title?: string;
    summary?: string;
    stage?: BacklogStage;
    superseded_by?: string | null;
  }): Promise<BacklogMutationResult> {
    if (
      input.title === undefined &&
      input.summary === undefined &&
      input.stage === undefined &&
      input.superseded_by === undefined
    ) {
      return { outcome: "no_fields" };
    }
    const sql = this.sqlProvider();
    return sql.begin(async (tx) => {
      if (input.superseded_by !== undefined) {
        await tx`
          select pg_advisory_xact_lock(
            hashtext('tieline-backlog-supersession')
          )`;
      }
      const current = await backlogByStableId(tx, input.stable_id, true);
      if (!current) return { outcome: "not_found" as const };
      if (Number(current.revision) !== input.expected_revision) {
        return {
          outcome: "stale" as const,
          current_revision: Number(current.revision),
        };
      }

      let successorId: string | null | undefined;
      if (input.superseded_by !== undefined) {
        if (input.superseded_by === null) {
          successorId = null;
        } else {
          const successor = await backlogByStableId(tx, input.superseded_by);
          if (!successor) {
            throw new Error(
              `Unknown superseded_by Backlog Item '${input.superseded_by}'. Nothing was written.`
            );
          }
          successorId = successor.id;
        }
      }
      const rows = await tx<BacklogRow[]>`
        update backlog_items item set
          title = coalesce(${input.title?.trim() ?? null}, item.title),
          summary = coalesce(${input.summary?.trim() ?? null}, item.summary),
          stage = coalesce(${input.stage ?? null}::backlog_stage, item.stage),
          superseded_by_id = case
            when ${input.superseded_by !== undefined}
              then ${successorId ?? null}::uuid
            else item.superseded_by_id
          end,
          revision = item.revision + 1
        where item.id = ${current.id}
        returning
          item.id, item.stable_id, item.title, item.summary, item.stage::text,
          item.revision,
          (
            select stable_id from backlog_items
            where id = item.superseded_by_id
          ) as superseded_by,
          item.created_at, item.updated_at`;
      const updated = backlogRecord(rows[0]);
      await tx`
        insert into audit_events (
          event_kind, entity_kind, entity_id, detail
        ) values (
          'backlog_item_updated', 'backlog_item', ${updated.id},
          ${tx.json({
            backlog_item_id: updated.id,
            stable_id: updated.stable_id,
            revision: updated.revision,
            stage: updated.stage,
            superseded_by: updated.superseded_by,
          })}
        )`;
      return { outcome: "applied" as const, item: updated };
    });
  }

  async setBacklogItemLinks(input: {
    stable_id: string;
    expected_revision: number;
    links: BacklogItemLinks;
  }): Promise<BacklogMutationResult & { links?: BacklogItemLinks }> {
    const sql = this.sqlProvider();
    return sql.begin(async (tx) => {
      const current = await backlogByStableId(tx, input.stable_id, true);
      if (!current) return { outcome: "not_found" as const };
      if (Number(current.revision) !== input.expected_revision) {
        return {
          outcome: "stale" as const,
          current_revision: Number(current.revision),
        };
      }

      const observationIds = unique(input.links.observation_ids);
      if (observationIds.length > 0) {
        const observations = await tx<{ id: string }[]>`
          select id from observation_search where id in ${tx(observationIds)}`;
        const found = new Set(observations.map((row) => row.id));
        const missing = observationIds.filter((id) => !found.has(id));
        if (missing.length > 0) {
          throw new Error(
            `Unknown observation ID(s): ${missing.join(", ")}. Nothing was written.`
          );
        }
      }
      const stories = await resolveTargets(tx, "story", input.links.stories);
      const criteria = await resolveTargets(
        tx,
        "acceptance_criterion",
        input.links.acceptance_criteria
      );

      await tx`
        delete from observation_backlog_attributions
        where backlog_item_id = ${current.id}`;
      await tx`
        delete from backlog_story_targets
        where backlog_item_id = ${current.id}`;
      await tx`
        delete from backlog_criterion_targets
        where backlog_item_id = ${current.id}`;

      for (const observationId of observationIds) {
        await tx`
          insert into observation_backlog_attributions (
            observation_id, backlog_item_id, relation, state, method,
            decided_at
          ) values (
            ${observationId}, ${current.id}, 'supports', 'confirmed',
            'explicit_backlog_link', now()
          )`;
      }
      for (const story of stories) {
        await tx`
          insert into backlog_story_targets (backlog_item_id, story_id)
          values (${current.id}, ${story.id})`;
      }
      for (const criterion of criteria) {
        await tx`
          insert into backlog_criterion_targets (backlog_item_id, criterion_id)
          values (${current.id}, ${criterion.id})`;
      }

      const updatedRows = await tx<BacklogRow[]>`
        update backlog_items item
        set revision = item.revision + 1
        where item.id = ${current.id}
        returning
          item.id, item.stable_id, item.title, item.summary, item.stage::text,
          item.revision,
          (
            select stable_id from backlog_items
            where id = item.superseded_by_id
          ) as superseded_by,
          item.created_at, item.updated_at`;
      const item = backlogRecord(updatedRows[0]);
      const links: BacklogItemLinks = {
        observation_ids: observationIds,
        stories: stories.map((story) => story.target),
        acceptance_criteria: criteria.map((criterion) => criterion.target),
      };
      await tx`
        insert into audit_events (
          event_kind, entity_kind, entity_id, detail
        ) values (
          'backlog_item_links_replaced', 'backlog_item', ${item.id},
          ${tx.json({
            backlog_item_id: item.id,
            revision: item.revision,
            observations: links.observation_ids.length,
            stories: links.stories.length,
            acceptance_criteria: links.acceptance_criteria.length,
          })}
        )`;
      return { outcome: "applied" as const, item, links };
    });
  }
}
