import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import type {
  CreatePlanningStoryInput,
  PlanningContractWriteStore,
  PlanningCriterionInput,
  PlanningStoryMutationResult,
  UpdatePlanningStoryInput,
} from "../../domain/planning-contract-write-store.js";
import type { ContractStoryRecord } from "../../domain/contract-read-store.js";
import { PostgresContractReadRepository } from "./contract-read-repository.js";
import { getWriteSql } from "./connections.js";

type Tx = TransactionSql<Record<string, never>>;

function generatedId(prefix: "US" | "AC"): string {
  return `${prefix}-${randomUUID()}`;
}

function jsonValue(tx: Tx, value: unknown): ReturnType<Tx["json"]> {
  return tx.json(value as Parameters<Tx["json"]>[0]);
}

async function recordPlanningEntityRevision(
  tx: Tx,
  entityKind: "story" | "acceptance_criterion",
  entityId: string,
  revision: string | number,
  content: unknown
): Promise<void> {
  await tx`
    insert into contract_revisions (
      entity_kind, entity_id, revision, authority, content
    ) values (
      ${entityKind}, ${entityId}, ${Number(revision)}, 'planning',
      ${jsonValue(tx, content)}
    )
    on conflict (entity_kind, entity_id, revision) do nothing`;
}

async function recordPlanningCriterionRevision(
  tx: Tx,
  criterionId: string
): Promise<void> {
  const [criterion] = await tx<{
    revision: string | number;
    stable_id: string;
    criterion: string | null;
    rationale: string | null;
    position: number;
    active: boolean;
    aliases: string[];
    applies_to: Record<string, string[]>;
    superseded_by: string | null;
  }[]>`
    select
      ac.revision,
      ac.stable_id,
      ac.criterion,
      ac.rationale,
      ac.position,
      ac.active,
      ac.aliases,
      ac.applies_to,
      successor.stable_id as superseded_by
    from acceptance_criteria ac
    left join acceptance_criteria successor on successor.id = ac.superseded_by_id
    where ac.id = ${criterionId}`;
  const scenarios = await tx<{
    stable_id: string;
    name: string | null;
    given: string;
    when: string;
    then: string;
    position: number;
    active: boolean;
  }[]>`
    select stable_id, name, given_text as given, when_text as when,
           then_text as then, position, active
    from scenarios
    where criterion_id = ${criterionId}
    order by position, stable_id`;
  await recordPlanningEntityRevision(
    tx,
    "acceptance_criterion",
    criterionId,
    criterion.revision,
    { ...criterion, scenarios }
  );
}

async function repositoryId(tx: Tx, key: string): Promise<string> {
  const rows = await tx<{ id: string }[]>`
    select id from repositories where key = ${key}`;
  if (!rows[0]) {
    throw new Error(
      `Unknown repository '${key}'. Repository identity must be configured before planning authoring.`
    );
  }
  return rows[0].id;
}

async function capabilityId(
  tx: Tx,
  repositoryIdValue: string,
  stableId: string | null | undefined
): Promise<string | null> {
  if (!stableId) return null;
  const rows = await tx<{ id: string }[]>`
    select id
    from capabilities
    where repository_id = ${repositoryIdValue} and stable_id = ${stableId}`;
  if (!rows[0]) {
    throw new Error(`Unknown capability '${stableId}'. Nothing was written.`);
  }
  return rows[0].id;
}

async function replaceAliases(
  tx: Tx,
  storyId: string,
  aliases: string[]
): Promise<void> {
  await tx`delete from story_aliases where story_id = ${storyId}`;
  for (const alias of [...new Set(aliases)]) {
    await tx`
      insert into story_aliases (story_id, alias, authority)
      values (${storyId}, ${alias}, 'planning')`;
  }
}

async function upsertCriteria(
  tx: Tx,
  input: {
    storyId: string;
    repositoryId: string;
    criteria: PlanningCriterionInput[];
  }
): Promise<void> {
  const retained: string[] = [];
  for (const [position, criterion] of input.criteria.entries()) {
    const stableId = criterion.stable_id?.trim() || generatedId("AC");
    const rows = await tx<{ id: string }[]>`
      insert into acceptance_criteria (
        story_id, repository_id, stable_id, criterion, rationale,
        position, active, authority, revision, aliases, applies_to
      ) values (
        ${input.storyId}, ${input.repositoryId}, ${stableId},
        ${criterion.criterion?.trim() ?? null},
        ${criterion.rationale?.trim() ?? null},
        ${position}, true, 'planning', 0,
        ${criterion.aliases ?? []},
        ${jsonValue(tx, criterion.applies_to ?? {})}
      )
      on conflict (repository_id, stable_id) do update set
        criterion = excluded.criterion,
        rationale = excluded.rationale,
        position = excluded.position,
        active = true,
        aliases = excluded.aliases,
        applies_to = excluded.applies_to,
        revision = acceptance_criteria.revision + 1,
        updated_at = now()
      where acceptance_criteria.story_id = ${input.storyId}
        and acceptance_criteria.authority = 'planning'
      returning id`;
    if (!rows[0]) {
      throw new Error(
        `Acceptance Criterion '${stableId}' belongs to another Story or authority. Nothing was written.`
      );
    }
    const criterionId = rows[0].id;
    retained.push(criterionId);
    await tx`
      delete from criterion_aliases where criterion_id = ${criterionId}`;
    for (const alias of [...new Set(criterion.aliases ?? [])]) {
      await tx`
        insert into criterion_aliases (
          criterion_id, alias, authority
        ) values (${criterionId}, ${alias}, 'planning')`;
    }
    await tx`
      update scenarios
      set active = false, updated_at = now()
      where criterion_id = ${criterionId}
        and authority = 'planning'
        and active`;
    for (const [scenarioPosition, scenario] of (
      criterion.scenarios ?? []
    ).entries()) {
      await tx`
        insert into scenarios (
          criterion_id, stable_id, name, given_text, when_text,
          then_text, position, active, authority
        ) values (
          ${criterionId}, ${`${stableId}-S${scenarioPosition + 1}`},
          ${scenario.name ?? null}, ${scenario.given}, ${scenario.when},
          ${scenario.then}, ${scenarioPosition}, true, 'planning'
        )
        on conflict (criterion_id, stable_id) do update set
          name = excluded.name,
          given_text = excluded.given_text,
          when_text = excluded.when_text,
          then_text = excluded.then_text,
          position = excluded.position,
          active = true,
          authority = 'planning',
          updated_at = now()`;
    }
    await recordPlanningCriterionRevision(tx, criterionId);
  }
  let retired: Array<{ id: string }>;
  if (retained.length === 0) {
    retired = await tx<{ id: string }[]>`
      update acceptance_criteria
      set active = false, revision = revision + 1, updated_at = now()
      where story_id = ${input.storyId}
        and authority = 'planning'
        and active
      returning id`;
  } else {
    retired = await tx<{ id: string }[]>`
      update acceptance_criteria
      set active = false, revision = revision + 1, updated_at = now()
      where story_id = ${input.storyId}
        and authority = 'planning'
        and active
        and id not in ${tx(retained)}
      returning id`;
  }
  for (const criterion of retired) {
    await recordPlanningCriterionRevision(tx, criterion.id);
  }
}

async function recordPlanningRevision(
  tx: Tx,
  storyId: string
): Promise<void> {
  const [story] = await tx<{
    revision: string | number;
    stable_id: string;
    title: string;
    actor: string | null;
    goal: string | null;
    benefit: string | null;
    aliases: string[];
    applies_to: Record<string, string[]>;
    motivated_by: string[];
  }[]>`
    select revision, stable_id, title, actor, goal, benefit, aliases,
           applies_to, motivated_by
    from user_stories where id = ${storyId}`;
  await recordPlanningEntityRevision(
    tx,
    "story",
    storyId,
    story.revision,
    story
  );
}

export class PostgresPlanningStoryRepository
  implements PlanningContractWriteStore
{
  private readonly reads: PostgresContractReadRepository;

  constructor(private readonly sqlProvider: () => Sql = getWriteSql) {
    this.reads = new PostgresContractReadRepository(sqlProvider);
  }

  private async readStory(
    repository: string,
    stableId: string,
    transaction?: Tx
  ): Promise<ContractStoryRecord> {
    const reads = transaction
      ? new PostgresContractReadRepository(
          () => transaction as unknown as Sql
        )
      : this.reads;
    const result = await reads.queryContractStories({
      filters: {
        repositories: [repository],
        story_keys: [stableId],
        authorities: ["planning"],
        lifecycles: ["backlog"],
        include_inactive_criteria: true,
      },
      limit: 1,
    });
    if (result.mode !== "records" || !result.records[0]) {
      throw new Error(
        `Planning Story '${repository}:${stableId}' could not be read after write.`
      );
    }
    return result.records[0];
  }

  async createPlanningStory(
    input: CreatePlanningStoryInput
  ): Promise<ContractStoryRecord> {
    const sql = this.sqlProvider();
    const stableId = input.stable_id?.trim() || generatedId("US");
    return sql.begin(async (tx) => {
      const repositoryIdValue = await repositoryId(tx, input.repository);
      const capabilityIdValue = await capabilityId(
        tx,
        repositoryIdValue,
        input.capability_stable_id
      );
      const rows = await tx<{ id: string }[]>`
        insert into user_stories (
          repository_id, capability_id, stable_id, title,
          actor, goal, benefit, lifecycle, authority, revision,
          aliases, applies_to, motivated_by
        ) values (
          ${repositoryIdValue}, ${capabilityIdValue}, ${stableId},
          ${input.title.trim()}, ${input.actor?.trim() ?? null},
          ${input.goal?.trim() ?? null}, ${input.benefit?.trim() ?? null},
          'backlog', 'planning', 0, ${input.aliases ?? []},
          ${jsonValue(tx, input.applies_to ?? {})},
          ${input.motivated_by ?? []}
        )
        returning id`;
      await replaceAliases(tx, rows[0].id, input.aliases ?? []);
      await upsertCriteria(tx, {
        storyId: rows[0].id,
        repositoryId: repositoryIdValue,
        criteria: input.acceptance_criteria ?? [],
      });
      await recordPlanningRevision(tx, rows[0].id);
      await tx`
        insert into audit_events (
          event_kind, entity_kind, entity_id, detail
        ) values (
          'planning_story_created', 'story', ${rows[0].id},
          ${jsonValue(tx, { repository: input.repository, stable_id: stableId })}
        )`;
      return this.readStory(input.repository, stableId, tx);
    });
  }

  async updatePlanningStory(
    input: UpdatePlanningStoryInput
  ): Promise<PlanningStoryMutationResult> {
    const fields = [
      input.capability_stable_id,
      input.title,
      input.actor,
      input.goal,
      input.benefit,
      input.aliases,
      input.applies_to,
      input.motivated_by,
      input.superseded_by,
      input.acceptance_criteria,
    ];
    if (fields.every((value) => value === undefined)) {
      return { outcome: "no_fields" };
    }
    const sql = this.sqlProvider();
    const outcome = await sql.begin(async (tx) => {
      const repositoryIdValue = await repositoryId(tx, input.repository);
      if (input.superseded_by !== undefined) {
        await tx`
          select pg_advisory_xact_lock(
            hashtext('tieline-story-supersession')
          )`;
      }
      const rows = await tx<{
        id: string;
        revision: string | number;
      }[]>`
        select id, revision
        from user_stories
        where repository_id = ${repositoryIdValue}
          and stable_id = ${input.stable_id}
          and authority = 'planning'
          and lifecycle = 'backlog'
        for update`;
      if (!rows[0]) return { outcome: "not_found" as const };
      if (Number(rows[0].revision) !== input.expected_revision) {
        return {
          outcome: "stale" as const,
          current_revision: Number(rows[0].revision),
        };
      }
      const capabilityIdValue =
        input.capability_stable_id === undefined
          ? undefined
          : await capabilityId(
              tx,
              repositoryIdValue,
              input.capability_stable_id
            );
      let supersededById: string | null | undefined;
      if (input.superseded_by !== undefined) {
        if (input.superseded_by === null) {
          supersededById = null;
        } else {
          if (input.superseded_by === input.stable_id) {
            throw new Error(
              `Planning Story '${input.stable_id}' cannot supersede itself. Nothing was written.`
            );
          }
          const successor = await tx<{ id: string }[]>`
            select id from user_stories
            where repository_id = ${repositoryIdValue}
              and stable_id = ${input.superseded_by}
              and authority = 'planning'`;
          if (!successor[0]) {
            throw new Error(
              `Unknown planning successor '${input.superseded_by}'. Nothing was written.`
            );
          }
          supersededById = successor[0].id;
        }
      }
      await tx`
        update user_stories story set
          capability_id = case
            when ${input.capability_stable_id !== undefined}
              then ${capabilityIdValue ?? null}::uuid
            else story.capability_id
          end,
          title = coalesce(${input.title?.trim() ?? null}, story.title),
          actor = case when ${input.actor !== undefined}
            then ${input.actor?.trim() ?? null} else story.actor end,
          goal = case when ${input.goal !== undefined}
            then ${input.goal?.trim() ?? null} else story.goal end,
          benefit = case when ${input.benefit !== undefined}
            then ${input.benefit?.trim() ?? null} else story.benefit end,
          aliases = case when ${input.aliases !== undefined}
            then ${input.aliases ?? []} else story.aliases end,
          applies_to = case when ${input.applies_to !== undefined}
            then ${jsonValue(tx, input.applies_to ?? {})} else story.applies_to end,
          motivated_by = case when ${input.motivated_by !== undefined}
            then ${input.motivated_by ?? []} else story.motivated_by end,
          superseded_by_id = case when ${input.superseded_by !== undefined}
            then ${supersededById ?? null}::uuid else story.superseded_by_id end,
          revision = story.revision + 1,
          updated_at = now()
        where story.id = ${rows[0].id}`;
      if (input.aliases) {
        await replaceAliases(tx, rows[0].id, input.aliases);
      }
      if (input.acceptance_criteria) {
        await upsertCriteria(tx, {
          storyId: rows[0].id,
          repositoryId: repositoryIdValue,
          criteria: input.acceptance_criteria,
        });
      }
      await recordPlanningRevision(tx, rows[0].id);
      await tx`
        insert into audit_events (
          event_kind, entity_kind, entity_id, detail
        ) values (
          'planning_story_updated', 'story', ${rows[0].id},
          ${jsonValue(tx, {
            repository: input.repository,
            stable_id: input.stable_id,
            previous_revision: input.expected_revision,
          })}
        )`;
      return {
        outcome: "applied" as const,
        story: await this.readStory(input.repository, input.stable_id, tx),
      };
    });
    return outcome;
  }
}
