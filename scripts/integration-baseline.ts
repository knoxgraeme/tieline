import assert from "node:assert/strict";
import postgres from "postgres";
import { migrateDatabase } from "../src/commands/migrate.js";
import { PostgresProfileRepository } from "../src/adapters/postgres/profile-repository.js";

const adminUrl = process.env.DATABASE_URL_ADMIN;
if (!adminUrl) {
  console.log("SKIP - DATABASE_URL_ADMIN not set; baseline integration needs a disposable database.");
  process.exit(0);
}

const bootstrap = postgres(adminUrl, { max: 1, prepare: false });
try {
  const [migrationTable] = await bootstrap<{ present: boolean }[]>`
    select exists (
      select 1
      from information_schema.tables
      where table_schema = 'public' and table_name = 'schema_migrations'
    ) as present`;
  const baselineApplied = migrationTable.present
    ? Boolean(
        (
          await bootstrap<{ present: boolean }[]>`
            select exists (
              select 1 from schema_migrations
              where filename = '0001_baseline.sql'
            ) as present`
        )[0].present
      )
    : false;
  if (!baselineApplied) {
    await bootstrap`create extension if not exists vector with schema public`;
    const [installed] = await bootstrap<{ schema: string }[]>`
      select namespace.nspname as schema
      from pg_extension extension
      join pg_namespace namespace on namespace.oid = extension.extnamespace
      where extension.extname = 'vector'`;
    if (installed.schema !== "public") {
      await bootstrap.unsafe("alter extension vector set schema public");
    }
  }
} finally {
  await bootstrap.end({ timeout: 5 });
}

await migrateDatabase(adminUrl);
await migrateDatabase(adminUrl);

const sql = postgres(adminUrl, { max: 1, prepare: false });
try {
  const roles = await sql<{ rolname: string }[]>`
    select rolname
    from pg_roles
    where rolname in ('tieline_reader', 'tieline_planning_writer', 'tieline_repository_sync', 'mcp_approver')
    order by rolname`;
  assert.deepEqual(
    roles.map((row) => row.rolname),
    ["tieline_planning_writer", "tieline_reader", "tieline_repository_sync"]
  );
  const [vectorExtension] = await sql<{ schema: string }[]>`
    select namespace.nspname as schema
    from pg_extension extension
    join pg_namespace namespace on namespace.oid = extension.extnamespace
    where extension.extname = 'vector'`;
  assert.equal(vectorExtension.schema, "extensions");
  const [privileges] = await sql<{
    writer_observation_insert: boolean;
    writer_observation_update: boolean;
    sync_observation_insert: boolean;
    sync_story_update: boolean;
  }[]>`
    select
      has_table_privilege('tieline_planning_writer', 'observations', 'insert') as writer_observation_insert,
      has_table_privilege('tieline_planning_writer', 'observations', 'update') as writer_observation_update,
      has_table_privilege('tieline_repository_sync', 'observations', 'insert') as sync_observation_insert,
      has_table_privilege('tieline_repository_sync', 'user_stories', 'update') as sync_story_update`;
  assert.equal(privileges.writer_observation_insert, true);
  assert.equal(privileges.writer_observation_update, false);
  assert.equal(privileges.sync_observation_insert, false);
  assert.equal(privileges.sync_story_update, true);

  const profiles = await sql<{ profile_key: string; version: number }[]>`
    select profile_key, version
    from retrieval_profiles
    where active
    order by profile_key`;
  assert.deepEqual(
    profiles.map((row) => `${row.profile_key}:${row.version}`),
    ["all:1", "discovery:1", "engineering:1", "support:1"]
  );
  const profileRepository = new PostgresProfileRepository(
    () => sql,
    () => sql
  );
  const published = await profileRepository.putProfile({
    key: "support",
    definition: {
      authorities: ["repository"],
      lifecycles: ["production"],
      include: ["story", "acceptance_criterion"],
    },
    created_by: "integration",
  });
  assert.equal(published.version, 2);
  const supportVersions = (await profileRepository.listProfiles()).filter(
    (profile) => profile.key === "support"
  );
  assert.deepEqual(
    supportVersions.map((profile) => ({
      version: profile.version,
      active: profile.active,
    })),
    [
      { version: 2, active: true },
      { version: 1, active: false },
    ]
  );

  const [repository] = await sql<{ id: string }[]>`
    insert into repositories (key, display_name)
    values ('baseline-integration', 'Baseline integration')
    returning id`;
  assert.ok(repository);

  await sql.unsafe("set role tieline_planning_writer");
  const [story] = await sql<{ id: string }[]>`
    insert into user_stories (
      repository_id, stable_id, title, lifecycle, authority
    ) values (
      ${repository.id}, 'BASELINE-PLANNING-001', 'Shape a planning Story', 'backlog', 'planning'
    )
    returning id`;
  assert.ok(story);

  await assert.rejects(
    sql`
      insert into user_stories (
        repository_id, stable_id, title, actor, goal, benefit, lifecycle, authority
      ) values (
        ${repository.id},
        'BASELINE-REPOSITORY-001',
        'Bypass repository authority',
        'maintainer',
        'write accepted intent directly',
        'skip review',
        'production',
        'repository'
      )`,
    /row-level security|policy/i
  );

  const [observation] = await sql<{ id: string }[]>`
    insert into observations (
      kind, schema_key, schema_version, summary, source, observed_at, payload, search_text
    ) values (
      'bug', 'bug.v1', 1, 'A stored observation', 'integration', now(),
      '{"private":"remove me"}', 'A stored observation'
    )
    returning id`;
  await assert.rejects(sql`update observations set summary = 'mutated'`, /permission denied|append-only/i);
  await assert.rejects(
    sql`select redact_observation_payload(${observation.id}, 'retention request')`,
    /permission denied|function/i
  );
  await sql.unsafe("reset role");

  await sql`select redact_observation_payload(${observation.id}, 'retention request')`;
  const [redacted] = await sql<{
    summary: string;
    payload: Record<string, unknown>;
    redaction_reason: string | null;
  }[]>`
    select summary, payload, redaction_reason
    from observations
    where id = ${observation.id}`;
  assert.equal(redacted.summary, "[redacted]");
  assert.deepEqual(redacted.payload, {});
  assert.equal(redacted.redaction_reason, "retention request");

  const [rowSecurity] = await sql<{ relrowsecurity: boolean }[]>`
    select relrowsecurity from pg_class where oid = 'user_stories'::regclass`;
  assert.equal(rowSecurity.relrowsecurity, true);

  await sql`
    insert into schema_migrations (filename, checksum)
    values ('0009_legacy_marker.sql', 'legacy')`;
  try {
    await assert.rejects(migrateDatabase(adminUrl), /recreate/i);
  } finally {
    await sql`
      delete from schema_migrations
      where filename = '0009_legacy_marker.sql'`;
  }
} finally {
  await sql.unsafe("reset role").catch(() => undefined);
  await sql.end({ timeout: 5 });
}

console.log("baseline integration passed");
