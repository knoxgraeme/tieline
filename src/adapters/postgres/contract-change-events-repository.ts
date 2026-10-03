/**
 * The change events repository sync records: one row per Story, acceptance
 * criterion, or screen a commit on the synced branch added, changed, or
 * removed. Recording a commit again changes nothing, so a sync that is run
 * again, or that re-reads commits an earlier sync covered, is safe.
 */
import type { Sql, TransactionSql } from "postgres";
import type { ContractHistoryChange } from "../../contract/history.js";

type Tx = TransactionSql<Record<string, never>>;

function jsonValue(tx: Tx, value: unknown): ReturnType<Tx["json"]> {
  return tx.json(value as Parameters<Tx["json"]>[0]);
}

/** Rows inserted per statement. */
const BATCH = 2_000;
/** Characters of a title kept; the database bounds titles at 4096 bytes. */
const TITLE_CHARS = 1_000;

export class PostgresContractChangeEventsRepository {
  constructor(private readonly sqlProvider: () => Sql) {}

  /** The commit of the most recent event recorded for the repository, or null. */
  async lastRecordedCommit(repositoryKey: string): Promise<string | null> {
    const rows = await this.sqlProvider()<{ commit_sha: string }[]>`
      select event.commit_sha
      from contract_change_events event
      join repositories repository on repository.id = event.repository_id
      where repository.key = ${repositoryKey}
      order by event.committed_at desc, event.id desc
      limit 1`;
    return rows[0]?.commit_sha ?? null;
  }

  /** Records the changes, oldest first, and returns how many were new. */
  async record(repositoryKey: string, changes: readonly ContractHistoryChange[]): Promise<number> {
    if (changes.length === 0) return 0;
    return this.sqlProvider().begin(async (tx: Tx) => {
      const [repository] = await tx<{ id: string }[]>`select id from repositories where key = ${repositoryKey}`;
      if (!repository) throw new Error(`Repository '${repositoryKey}' is not in the database.`);
      let inserted = 0;
      const ordered = [...changes].reverse();
      for (let start = 0; start < ordered.length; start += BATCH) {
        const rows = ordered.slice(start, start + BATCH).map((change) => ({
          entity_kind: change.kind,
          stable_id: change.stable_id,
          status: change.status,
          aspects: change.aspects,
          title: change.title.length > TITLE_CHARS ? `${change.title.slice(0, TITLE_CHARS - 1)}…` : change.title,
          commit_sha: change.commit.commit,
          committed_at: change.commit.date,
          pull_request: change.commit.pull_request,
        }));
        const result = await tx`
          insert into contract_change_events (
            repository_id, entity_kind, stable_id, status, aspects, title, commit_sha, committed_at, pull_request
          )
          select ${repository.id}, row.entity_kind, row.stable_id, row.status, row.aspects, row.title,
                 row.commit_sha, row.committed_at, row.pull_request
          from jsonb_to_recordset(${jsonValue(tx, rows)}) as row(
            entity_kind text, stable_id text, status text, aspects text[], title text,
            commit_sha text, committed_at timestamptz, pull_request integer
          )
          on conflict (repository_id, commit_sha, entity_kind, stable_id) do nothing
          returning id`;
        inserted += result.length;
      }
      return inserted;
    });
  }
}
