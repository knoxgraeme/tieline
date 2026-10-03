/**
 * Contract change events against a disposable database: repository sync
 * backfills them from git history on its first run, records only what is new
 * afterwards, records nothing twice, and leaves sync unchanged when the synced
 * commit is not a git commit. Role grants keep the table append-only.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import postgres from "postgres";
import { runCli, type TielineCliIO } from "../../src/cli.js";
import { migrateDatabase } from "../../src/commands/migrate.js";
import { compileContractManifestWithSources, writeContractManifest } from "../../src/contract/manifest.js";
import { withRole } from "../support/db.js";
import { requireIntegrationDatabaseAdminUrl } from "../support/integration-database-preflight.js";
import { createScreensWorkspace, notesSpecYaml } from "../support/screen-fixtures.js";

const adminUrl = requireIntegrationDatabaseAdminUrl(process.env);

await migrateDatabase(adminUrl);
const sql = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => undefined });
const repositoryKey = `change-events-${Date.now()}`;
const workspace = createScreensWorkspace({ git: true });
const manifestDirectory = resolve(workspace.root, ".tieline/manifest");

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: workspace.root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(spec: string, subject: string): string {
  workspace.write(".tieline/spec/notes.yaml", spec);
  writeContractManifest(
    manifestDirectory,
    compileContractManifestWithSources({ repositoryRoot: workspace.root, repositoryKey, specDirectory: ".tieline/spec" })
  );
  git("add", "-A");
  git("commit", "-q", "-m", subject);
  return git("rev-parse", "HEAD");
}

async function sync(extra: string[] = []): Promise<{ code: number; result: Record<string, unknown> }> {
  let output = "";
  const io: TielineCliIO = {
    write(message) {
      output += message;
    },
    error(message) {
      throw new Error(message);
    },
    async question() {
      throw new Error("change events integration must not prompt");
    },
  };
  const code = await runCli(
    ["contract", "sync", workspace.root, "--repo", repositoryKey, "--output", manifestDirectory, "--json", ...extra],
    io,
    { ...process.env, DATABASE_URL_SYNC: adminUrl, EMBEDDING_PROVIDER: "hash" }
  );
  return { code, result: JSON.parse(output) as Record<string, unknown> };
}

async function events(stableId: string): Promise<Array<[string, number | null]>> {
  const rows = await sql<{ status: string; pull_request: number | null }[]>`
    select event.status, event.pull_request
    from contract_change_events event
    join repositories repository on repository.id = event.repository_id
    where repository.key = ${repositoryKey} and event.stable_id = ${stableId}
    order by event.committed_at, event.id`;
  return rows.map((row) => [row.status, row.pull_request]);
}

try {
  git("checkout", "-q", "-b", "main");
  const spec = notesSpecYaml();
  commit(spec, "feat: notes (#1)");
  const reworded = spec.replace("newest first", "most recent first");
  commit(reworded, "docs: reword the notes list criterion (#2)");

  // The first sync backfills every change git holds.
  const first = await sync();
  assert.equal(first.code, 0);
  const firstEvents = first.result.change_events as { status: string; recorded: number; since: string | null; commits_read: number };
  assert.equal(firstEvents.status, "recorded");
  assert.equal(firstEvents.since, null);
  assert.equal(firstEvents.commits_read, 2);
  assert.deepEqual(await events("NOTES-001-AC1"), [
    ["added", 1],
    ["changed", 2],
  ]);
  assert.deepEqual(await events("NOTES-001-AC2"), [["added", 1]]);

  // Syncing the same commit again records nothing new.
  const again = await sync();
  assert.equal(again.code, 0);
  assert.equal((again.result.change_events as { recorded: number }).recorded, 0);

  // A later sync records only what changed after the last recorded commit.
  const second = git("rev-parse", "HEAD");
  commit(reworded.replace("invite a member without notes", "invite a new member"), "Merge pull request #3 from acme/empty-state");
  const third = await sync();
  const thirdEvents = third.result.change_events as { recorded: number; since: string };
  assert.equal(thirdEvents.since, second);
  assert.equal(thirdEvents.recorded, 1);
  assert.deepEqual(await events("NOTES-001-AC2"), [
    ["added", 1],
    ["changed", 3],
  ]);

  // An explicit commit that is not a git commit syncs exactly as before.
  const labelled = await sync(["--commit", "release-candidate"]);
  assert.equal(labelled.code, 0);
  assert.deepEqual(labelled.result.change_events, {
    status: "unavailable",
    detail: "the synced commit 'release-candidate' is not a full git commit SHA",
  });

  // Readers read; only repository sync writes, and nothing updates or deletes.
  const readable = await withRole(sql, "tieline_reader", () => sql`select count(*)::int as count from contract_change_events`);
  assert.ok((readable[0] as { count: number }).count > 0);
  await withRole(sql, "tieline_planning_writer", () => sql`select 1 from contract_change_events limit 1`);
  await assert.rejects(withRole(sql, "tieline_capture_publisher", () => sql`select 1 from contract_change_events limit 1`), /permission denied/);
  await assert.rejects(withRole(sql, "tieline_reader", () => sql`delete from contract_change_events`), /permission denied/);
  await assert.rejects(withRole(sql, "tieline_repository_sync", () => sql`update contract_change_events set title = 'x'`), /permission denied/);
  await assert.rejects(withRole(sql, "tieline_repository_sync", () => sql`delete from contract_change_events`), /permission denied/);
  await assert.rejects(
    sql`
      insert into contract_change_events (repository_id, entity_kind, stable_id, status, aspects, title, commit_sha, committed_at)
      select id, 'story', 'X-1', 'added', array['content'], 'x', ${"a".repeat(40)}, now()
      from repositories where key = ${repositoryKey}`,
    /violates check constraint/,
    "an added item carries no aspects"
  );

  console.log("change events integration passed");
} finally {
  await sql`
    delete from contract_change_events
    where repository_id in (select id from repositories where key = ${repositoryKey})`;
  workspace.cleanup();
  await sql.end({ timeout: 5 });
}
