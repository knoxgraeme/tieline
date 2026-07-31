import type { Sql, TransactionSql } from "postgres";
import type {
  AttributionDecision,
  AttributionDecisionRecord,
  AttributionRelation,
  ObservationKind,
  ObservationRecord,
  ObservationWriteStore,
  PreparedObservation,
  SemanticTargetRef,
} from "../../domain/evidence-write-store.js";
import { getWriteSql } from "./connections.js";

interface ObservationRow {
  id: string;
  kind: ObservationKind;
  schema_key: string;
  schema_version: number;
  summary: string;
  source: string;
  external_id: string | null;
  external_url: string | null;
  observed_at: string | Date;
  recorded_at: string | Date;
  search_text: string;
  supersedes_observation_id: string | null;
}

type QuerySql = Sql | TransactionSql;

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function observationRecord(
  row: ObservationRow,
  outcome: ObservationRecord["outcome"]
): ObservationRecord {
  return {
    ...row,
    observed_at: iso(row.observed_at),
    recorded_at: iso(row.recorded_at),
    outcome,
  };
}

function validateExistingSupersession(
  existing: ObservationRow,
  requested: string | null | undefined
): void {
  if (!requested) return;
  if (requested === existing.id) {
    throw new Error(`Observation '${existing.id}' cannot supersede itself.`);
  }
  if (requested !== existing.supersedes_observation_id) {
    throw new Error(
      `Observation '${existing.id}' is immutable and cannot change its supersedes relationship.`
    );
  }
}

async function existingObservation(
  sql: QuerySql,
  source: string,
  externalId: string
): Promise<ObservationRow | undefined> {
  const rows = await sql<ObservationRow[]>`
    select *
    from observation_search
    where source = ${source} and external_id = ${externalId}`;
  return rows[0];
}

async function resolveSemanticTarget(
  sql: QuerySql,
  kind: "story" | "acceptance_criterion",
  target: SemanticTargetRef
): Promise<{ id: string; stable_id: string }> {
  const rows =
    kind === "story"
      ? await sql<{ id: string; stable_id: string }[]>`
          select us.id, us.stable_id
          from user_stories us
          join repositories r on r.id = us.repository_id
          where r.key = ${target.repository} and us.stable_id = ${target.stable_id}`
      : await sql<{ id: string; stable_id: string }[]>`
          select ac.id, ac.stable_id
          from acceptance_criteria ac
          join repositories r on r.id = ac.repository_id
          where r.key = ${target.repository} and ac.stable_id = ${target.stable_id}`;
  if (!rows[0]) {
    throw new Error(
      `Unknown ${kind} '${target.repository}:${target.stable_id}'. Nothing was written.`
    );
  }
  return rows[0];
}

export class PostgresObservationRepository implements ObservationWriteStore {
  constructor(private readonly sqlProvider: () => Sql = getWriteSql) {}

  async recordObservation(
    input: PreparedObservation
  ): Promise<ObservationRecord> {
    const sql = this.sqlProvider();
    return sql.begin(async (tx) => {
      if (input.external_id) {
        const existing = await existingObservation(
          tx,
          input.source,
          input.external_id
        );
        if (existing) {
          validateExistingSupersession(
            existing,
            input.supersedes_observation_id
          );
          return observationRecord(existing, "existing");
        }
      }
      if (input.supersedes_observation_id) {
        const target = await tx<{ id: string }[]>`
          select id
          from observation_search
          where id = ${input.supersedes_observation_id}`;
        if (!target[0]) {
          throw new Error(
            `Unknown supersedes_observation_id '${input.supersedes_observation_id}'. Nothing was written.`
          );
        }
      }

      const inserted = await tx<{ id: string }[]>`
        insert into observations (
          kind, schema_key, schema_version, summary, source, external_id,
          external_url, observed_at, payload, search_text,
          supersedes_observation_id
        ) values (
          ${input.kind}, ${input.schema_key}, ${input.schema_version},
          ${input.summary}, ${input.source}, ${input.external_id ?? null},
          ${input.external_url ?? null}, ${input.observed_at},
          ${tx.json(input.payload as Parameters<typeof tx.json>[0])},
          ${input.search_text}, ${input.supersedes_observation_id ?? null}
        )
        on conflict (source, external_id) where external_id is not null
        do nothing
        returning id`;
      if (!inserted[0] && input.external_id) {
        const raced = await existingObservation(
          tx,
          input.source,
          input.external_id
        );
        if (!raced) {
          throw new Error("Observation idempotency conflict could not be resolved.");
        }
        validateExistingSupersession(raced, input.supersedes_observation_id);
        return observationRecord(raced, "existing");
      }
      const insertedId = inserted[0]?.id;
      if (!insertedId) throw new Error("Observation was not created.");
      const createdRows = await tx<ObservationRow[]>`
        select * from observation_search where id = ${insertedId}`;
      const created = createdRows[0];
      if (!created) throw new Error("Created observation could not be read back.");
      await tx`
        insert into audit_events (
          event_kind, entity_kind, entity_id, detail
        ) values (
          'observation_recorded', 'observation', ${created.id},
          ${tx.json({
            observation_id: created.id,
            kind: created.kind,
            schema_key: created.schema_key,
            schema_version: created.schema_version,
            source: created.source,
          })}
        )`;
      return observationRecord(created, "created");
    });
  }

  async decideAttribution(
    input: AttributionDecision
  ): Promise<AttributionDecisionRecord> {
    const sql = this.sqlProvider();
    return sql.begin(async (tx) => {
      const observation = await tx<{ id: string }[]>`
        select id from observation_search where id = ${input.observation_id}`;
      if (!observation[0]) {
        throw new Error(
          `Unknown observation '${input.observation_id}'. Nothing was written.`
        );
      }
      let target: { id: string; stable_id: string };
      if (input.target_kind === "backlog_item") {
        if (input.relation !== "supports") {
          throw new Error(
            "Backlog Item attributions use the 'supports' relation."
          );
        }
        const rows = await tx<{ id: string; stable_id: string }[]>`
          select id, stable_id
          from backlog_items
          where stable_id = ${(input.target as { stable_id: string }).stable_id}`;
        if (!rows[0]) {
          throw new Error(
            `Unknown backlog_item '${(input.target as { stable_id: string }).stable_id}'. Nothing was written.`
          );
        }
        target = rows[0];
        await tx`
          insert into observation_backlog_attributions (
            observation_id, backlog_item_id, relation, state, method,
            decided_by, decided_at
          ) values (
            ${input.observation_id}, ${target.id}, 'supports',
            ${input.decision}, 'explicit_decision',
            ${input.decided_by ?? null}, now()
          )
          on conflict (observation_id, backlog_item_id) do update set
            state = excluded.state,
            method = excluded.method,
            decided_by = excluded.decided_by,
            decided_at = excluded.decided_at,
            updated_at = now()`;
      } else {
        target = await resolveSemanticTarget(
          tx,
          input.target_kind,
          input.target as SemanticTargetRef
        );
        if (input.target_kind === "story") {
          await tx`
            insert into observation_story_attributions (
              observation_id, story_id, relation, state, method,
              decided_by, decided_at
            ) values (
              ${input.observation_id}, ${target.id}, ${input.relation},
              ${input.decision}, 'explicit_decision',
              ${input.decided_by ?? null}, now()
            )
            on conflict (observation_id, story_id, relation) do update set
              state = excluded.state,
              method = excluded.method,
              decided_by = excluded.decided_by,
              decided_at = excluded.decided_at,
              updated_at = now()`;
        } else {
          await tx`
            insert into observation_criterion_attributions (
              observation_id, criterion_id, relation, state, method,
              decided_by, decided_at
            ) values (
              ${input.observation_id}, ${target.id}, ${input.relation},
              ${input.decision}, 'explicit_decision',
              ${input.decided_by ?? null}, now()
            )
            on conflict (observation_id, criterion_id, relation) do update set
              state = excluded.state,
              method = excluded.method,
              decided_by = excluded.decided_by,
              decided_at = excluded.decided_at,
              updated_at = now()`;
        }
      }
      const decidedAt = new Date().toISOString();
      await tx`
        insert into audit_events (
          event_kind, entity_kind, entity_id, actor, detail
        ) values (
          'attribution_decided', 'observation', ${input.observation_id},
          ${input.decided_by ?? null},
          ${tx.json({
            observation_id: input.observation_id,
            target_kind: input.target_kind,
            target_id: target.id,
            relation: input.relation,
            state: input.decision,
          })}
        )`;
      return {
        observation_id: input.observation_id,
        target_kind: input.target_kind,
        target_id: target.id,
        target_stable_id: target.stable_id,
        relation: input.relation as AttributionRelation,
        state: input.decision,
        decided_by: input.decided_by ?? null,
        decided_at: decidedAt,
      };
    });
  }
}
