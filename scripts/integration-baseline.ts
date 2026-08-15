import assert from "node:assert/strict";
import postgres from "postgres";
import {
  migrateDatabase,
  readPackagedMigrations,
} from "../src/commands/migrate.js";
import { PostgresProfileRepository } from "../src/adapters/postgres/profile-repository.js";
import { PostgresSemanticRepository } from "../src/adapters/postgres/semantic-repository.js";
import {
  PostgresCodeTopologyRepository,
  type CodeTopologyWriteStage,
} from "../src/adapters/postgres/code-topology-repository.js";
import {
  codeTopologyGenerationIdentity,
  type CompleteCodeTopologyGeneration,
} from "../src/domain/code-topology-store.js";
import { runDatabasePreflight } from "../src/tieline/preflight.js";

const topologyDigest = (character: string): string => character.repeat(64);

function topologyGeneration(label: string): CompleteCodeTopologyGeneration {
  const identityFields = {
    repository: "baseline-integration",
    revision: label.repeat(40),
    inventory_digest: topologyDigest(label === "a" ? "1" : label === "b" ? "2" : "3"),
    parser_compatibility_digest: topologyDigest("4"),
    resolver_implementation: "baseline-resolver@1",
    resolver_configuration_digest: topologyDigest("5"),
    topology_schema_version: 1,
    fact_policy_digest: topologyDigest("6"),
  };
  const identity = codeTopologyGenerationIdentity(identityFields);
  return {
    header: { ...identityFields, identity },
    files: [
      {
        path: "src/index.ts",
        kind: "code",
        framework_hint: null,
        language: "typescript",
        source_hash: topologyDigest("7"),
        parser_identity: "baseline-parser",
        diagnostics: [],
        symbols_truncated: false,
        references_truncated: false,
        diagnostics_truncated: false,
      },
      {
        path: "src/dependency.ts",
        kind: "code",
        framework_hint: null,
        language: "typescript",
        source_hash: topologyDigest("8"),
        parser_identity: "baseline-parser",
        diagnostics: [],
        symbols_truncated: false,
        references_truncated: false,
        diagnostics_truncated: false,
      },
    ],
    symbols: [
      {
        identity: `symbol:${label}:source`,
        file_path: "src/index.ts",
        name: "source",
        native_kind: "function_declaration",
        kind: "function",
        canonical_selector: "function:source",
        owner_identity: null,
        owner_chain: [],
        name_range: null,
        body_range: null,
        syntax_status: "exact",
      },
      {
        identity: `symbol:${label}:target`,
        file_path: "src/dependency.ts",
        name: "target",
        native_kind: "function_declaration",
        kind: "function",
        canonical_selector: "function:target",
        owner_identity: null,
        owner_chain: [],
        name_range: null,
        body_range: null,
        syntax_status: "exact",
      },
    ],
    references: [
      {
        identity: `reference:${label}`,
        file_path: "src/index.ts",
        owner_symbol_identity: `symbol:${label}:source`,
        kind: "import",
        native_kind: "import_statement",
        module_specifier: "./dependency.js",
        module_specifier_range: null,
        statement_range: null,
        is_type_only: false,
        bindings: [],
      },
    ],
    resolutions: [
      {
        reference_identity: `reference:${label}`,
        status: "resolved",
        rule: "relative-file",
        resolver_configuration_digest: identityFields.resolver_configuration_digest,
        target_file_path: "src/dependency.ts",
        target_symbol_identity: `symbol:${label}:target`,
        candidate_targets: [],
        diagnostics: [],
      },
    ],
    edges: [
      {
        identity: `edge:${label}`,
        kind: "imports",
        source: {
          generation_identity: identity,
          symbol_identity: `symbol:${label}:source`,
        },
        target: {
          generation_identity: identity,
          symbol_identity: `symbol:${label}:target`,
        },
        reference_identity: `reference:${label}`,
      },
    ],
  };
}

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
    const baseline = readPackagedMigrations()[0]!;
    await bootstrap.begin(async (tx) => {
      await tx`
        create table schema_migrations (
          filename text primary key,
          checksum text not null,
          applied_at timestamptz not null default now()
        )`;
      await tx.unsafe(baseline.content);
      await tx`
        insert into schema_migrations (filename, checksum)
        values (${baseline.filename}, ${baseline.checksum})`;
    });
    const [upgradeFixture] = await bootstrap<{ baseline_recorded: boolean; topology_absent: boolean }[]>`
      select
        exists (
          select 1 from schema_migrations
          where filename = '0001_baseline.sql'
        ) as baseline_recorded,
        to_regclass('public.code_topology_generations') is null as topology_absent`;
    assert.deepEqual(upgradeFixture, {
      baseline_recorded: true,
      topology_absent: true,
    });
  }
} finally {
  await bootstrap.end({ timeout: 5 });
}

await migrateDatabase(adminUrl);
await migrateDatabase(adminUrl);
await migrateDatabase(adminUrl, true);
const migrationPreflight = (await runDatabasePreflight({ DATABASE_URL_ADMIN: adminUrl }))
  .find((check) => check.key === "migrations");
assert.deepEqual(migrationPreflight, {
  key: "migrations",
  status: "pass",
  message: "All 3 migrations are applied with matching checksums.",
});

const sql = postgres(adminUrl, { max: 1, prepare: false });
try {
  const appliedMigrations = await sql<{ filename: string; checksum: string }[]>`
    select filename, checksum from schema_migrations order by filename`;
  assert.deepEqual(
    [...appliedMigrations],
    readPackagedMigrations().map(({ filename, checksum }) => ({ filename, checksum }))
  );
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
  const [trigramExtension] = await sql<{ present: boolean }[]>`
    select exists (
      select 1 from pg_extension where extname = 'pg_trgm'
    ) as present`;
  assert.equal(trigramExtension.present, true);
  const [privileges] = await sql<{
    writer_observation_insert: boolean;
    writer_observation_update: boolean;
    sync_observation_insert: boolean;
    sync_story_update: boolean;
    reader_complete_topology_select: boolean;
    reader_raw_topology_select: boolean;
    planning_topology_select: boolean;
    sync_topology_insert: boolean;
    sync_topology_update: boolean;
    sync_checkpoint_insert: boolean;
    sync_promote_execute: boolean;
    sync_gc_execute: boolean;
  }[]>`
    select
      has_table_privilege('tieline_planning_writer', 'observations', 'insert') as writer_observation_insert,
      has_table_privilege('tieline_planning_writer', 'observations', 'update') as writer_observation_update,
      has_table_privilege('tieline_repository_sync', 'observations', 'insert') as sync_observation_insert,
      has_table_privilege('tieline_repository_sync', 'user_stories', 'update') as sync_story_update,
      has_table_privilege('tieline_reader', 'complete_code_topology_generations', 'select') as reader_complete_topology_select,
      has_table_privilege('tieline_reader', 'code_topology_generations', 'select') as reader_raw_topology_select,
      has_table_privilege('tieline_planning_writer', 'complete_code_topology_generations', 'select') as planning_topology_select,
      has_column_privilege('tieline_repository_sync', 'code_topology_generations', 'identity', 'insert') as sync_topology_insert,
      has_table_privilege('tieline_repository_sync', 'code_topology_generations', 'update') as sync_topology_update,
      has_table_privilege('tieline_repository_sync', 'code_topology_checkpoints', 'insert') as sync_checkpoint_insert,
      has_function_privilege('tieline_repository_sync', 'promote_code_topology_generation(uuid,text,text)', 'execute') as sync_promote_execute,
      has_function_privilege('tieline_repository_sync', 'gc_code_topology_generations(uuid,text[])', 'execute') as sync_gc_execute`;
  assert.equal(privileges.writer_observation_insert, true);
  assert.equal(privileges.writer_observation_update, false);
  assert.equal(privileges.sync_observation_insert, false);
  assert.equal(privileges.sync_story_update, true);
  assert.equal(privileges.reader_complete_topology_select, true);
  assert.equal(privileges.reader_raw_topology_select, false);
  assert.equal(privileges.planning_topology_select, false);
  assert.equal(privileges.sync_topology_insert, true);
  assert.equal(privileges.sync_topology_update, false);
  assert.equal(privileges.sync_checkpoint_insert, false);
  assert.equal(privileges.sync_promote_execute, true);
  assert.equal(privileges.sync_gc_execute, false);

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

  const topologyRepository = new PostgresCodeTopologyRepository(
    () => sql,
    () => sql,
    () => sql
  );
  const firstTopology = topologyGeneration("a");
  await sql.unsafe("set role tieline_repository_sync");
  try {
    const topologyInsert = await topologyRepository.commitGeneration({
      generation: firstTopology,
      expected_previous_generation_identity: null,
    });
    assert.equal(topologyInsert.outcome, "inserted");
    await assert.rejects(
      sql`
        update code_topology_generations set facts_digest = ${topologyDigest("9")}
        where identity = ${firstTopology.header.identity}`,
      /permission denied/i
    );
    await assert.rejects(
      sql`
        delete from code_topology_edges
        where generation_identity = ${firstTopology.header.identity}`,
      /permission denied/i
    );
    await assert.rejects(
      sql`
        insert into code_topology_checkpoints (repository_id, generation_identity)
        values (${repository.id}, ${firstTopology.header.identity})
        on conflict (repository_id) do nothing`,
      /permission denied/i
    );
  } finally {
    await sql.unsafe("reset role");
  }
  await sql.unsafe("set role tieline_reader");
  try {
    const visible = await sql<{ identity: string }[]>`
      select identity from complete_code_topology_generations
      where identity = ${firstTopology.header.identity}`;
    assert.deepEqual(visible.map((row) => row.identity), [firstTopology.header.identity]);
    await assert.rejects(
      sql`
        select identity from code_topology_generations
        where identity = ${firstTopology.header.identity}`,
      /permission denied/i
    );
  } finally {
    await sql.unsafe("reset role");
  }
  const topologyDuplicate = await topologyRepository.commitGeneration({
    generation: firstTopology,
    expected_previous_generation_identity: firstTopology.header.identity,
  });
  assert.equal(topologyDuplicate.outcome, "existing");
  const storedTopology = await topologyRepository.getGeneration(
    firstTopology.header.identity
  );
  assert.equal(storedTopology?.counts.edges, 1);
  assert.deepEqual(
    (await topologyRepository.listForwardEdges({
      generation_identity: firstTopology.header.identity,
      source_symbol_identities: ["symbol:a:source"],
    })).map((edge) => edge.identity),
    ["edge:a"]
  );
  assert.deepEqual(
    (await topologyRepository.listReverseEdges({
      generation_identity: firstTopology.header.identity,
      target_symbol_identities: ["symbol:a:target"],
    })).map((edge) => edge.identity),
    ["edge:a"]
  );

  const staleTopology = topologyGeneration("b");
  await assert.rejects(
    topologyRepository.commitGeneration({
      generation: staleTopology,
      expected_previous_generation_identity: null,
    }),
    /checkpoint changed/i
  );
  assert.equal(await topologyRepository.getGeneration(staleTopology.header.identity), null);

  const mismatchedFacts = structuredClone(firstTopology);
  mismatchedFacts.files[0].source_hash = topologyDigest("9");
  await assert.rejects(
    topologyRepository.commitGeneration({
      generation: mismatchedFacts,
      expected_previous_generation_identity: firstTopology.header.identity,
    }),
    /different metadata or facts/i
  );

  for (const stage of [
    "generation",
    "files",
    "symbols",
    "references",
    "resolutions",
    "edges",
    "promotion",
  ] as const satisfies readonly CodeTopologyWriteStage[]) {
    const candidate = topologyGeneration(stage === "generation" ? "c" : "d");
    candidate.header.revision = topologyDigest(stage.length.toString(16).slice(-1));
    candidate.header.inventory_digest = topologyDigest(stage.charCodeAt(0).toString(16).slice(-1));
    candidate.header.identity = codeTopologyGenerationIdentity(candidate.header);
    for (const edge of candidate.edges) {
      edge.source.generation_identity = candidate.header.identity;
      edge.target.generation_identity = candidate.header.identity;
    }
    const failing = new PostgresCodeTopologyRepository(
      () => sql,
      () => sql,
      () => sql,
      {
        afterWrite(observed) {
          if (observed === stage) throw new Error(`injected ${stage}`);
        },
      }
    );
    await assert.rejects(
      failing.commitGeneration({
        generation: candidate,
        expected_previous_generation_identity: firstTopology.header.identity,
      }),
      new RegExp(`injected ${stage}`)
    );
    assert.equal(await topologyRepository.getGeneration(candidate.header.identity), null);
    assert.equal(
      await topologyRepository.getCurrentGenerationIdentity("baseline-integration"),
      firstTopology.header.identity
    );
  }

  const secondTopology = topologyGeneration("b");
  await topologyRepository.commitGeneration({
    generation: secondTopology,
    expected_previous_generation_identity: firstTopology.header.identity,
  });
  const protectedCurrent = await topologyRepository.deleteGenerations({
    repository: "baseline-integration",
    generation_identities: [secondTopology.header.identity],
  });
  assert.deepEqual(protectedCurrent.protected_generation_identities, [
    secondTopology.header.identity,
  ]);
  assert.equal(
    await topologyRepository.setGenerationPinned({
      repository: "baseline-integration",
      generation_identity: firstTopology.header.identity,
      pinned: true,
    }),
    true
  );
  const protectedPinned = await topologyRepository.deleteGenerations({
    repository: "baseline-integration",
    generation_identities: [firstTopology.header.identity],
  });
  assert.deepEqual(protectedPinned.protected_generation_identities, [
    firstTopology.header.identity,
  ]);
  await topologyRepository.setGenerationPinned({
    repository: "baseline-integration",
    generation_identity: firstTopology.header.identity,
    pinned: false,
  });
  const deletedOld = await topologyRepository.deleteGenerations({
    repository: "baseline-integration",
    generation_identities: [firstTopology.header.identity],
  });
  assert.deepEqual(deletedOld.deleted_generation_identities, [
    firstTopology.header.identity,
  ]);
  const [cascaded] = await sql<{ files: number; symbols: number; edges: number }[]>`
    select
      (select count(*)::int from code_topology_files where generation_identity = ${firstTopology.header.identity}) as files,
      (select count(*)::int from code_topology_symbols where generation_identity = ${firstTopology.header.identity}) as symbols,
      (select count(*)::int from code_topology_edges where generation_identity = ${firstTopology.header.identity}) as edges`;
  assert.deepEqual(cascaded, { files: 0, symbols: 0, edges: 0 });

  await sql.unsafe("set role tieline_planning_writer");
  const [story] = await sql<{ id: string }[]>`
    insert into user_stories (
      repository_id, stable_id, title, lifecycle, authority
    ) values (
      ${repository.id}, 'BASELINE-PLANNING-001', 'Shape a planning Story', 'backlog', 'planning'
    )
    returning id`;
  assert.ok(story);

  await sql`
    insert into embedding_documents (
      entity_kind, entity_id, document_kind, canonical_text,
      source_text_hash, embedding_model, embedding_version,
      embedding, filter_metadata
    ) values (
      'story', ${story.id}, 'story',
      'Rotate authentication credentials safely',
      'baseline-lexical-only', 'unconfigured', 'contract-v1',
      null,
      ${sql.json({
        repository: "baseline-integration",
        authority: "planning",
        lifecycle: "backlog",
        active: true,
        story_id: story.id,
        story_stable_id: "BASELINE-PLANNING-001",
        identifiers: [
          "BASELINE-PLANNING-001",
          "src/auth/token-rotator.ts",
        ],
      })}
    )`;
  const semanticRepository = new PostgresSemanticRepository(
    () => sql,
    () => {
      throw new Error("embedding provider must not be required");
    }
  );
  const discoveryProfile =
    await semanticRepository.resolveRetrievalProfile("discovery");
  const lexicalOnly = await semanticRepository.searchSemantic({
    query: "token-rotator",
    profile: discoveryProfile,
    limit: 5,
  });
  const lexicalStory = lexicalOnly.find(
    (candidate) => candidate.entity_id === story.id
  );
  assert.ok(lexicalStory);
  assert.equal(lexicalStory.vector_score, 0);
  assert.ok(lexicalStory.lexical_score >= 0.3);

  let embeddingAvailable = false;
  const recoveringSemanticRepository = new PostgresSemanticRepository(
    () => sql,
    () => ({
      provider: "hash",
      dim: 384,
      async embed() {
        if (!embeddingAvailable) {
          throw new Error("embedding provider temporarily unavailable");
        }
        return new Array<number>(384).fill(0.01);
      },
    })
  );
  const recoveringDocument = {
    entity_kind: "story" as const,
    entity_id: story.id,
    document_kind: "story" as const,
    canonical_text: "Recover vector indexing without changing source text",
    source_text_hash: "recovering-vector-source",
    filter_metadata: {
      repository: "baseline-integration",
      authority: "planning",
      lifecycle: "backlog",
      active: true,
      story_id: story.id,
      story_stable_id: "BASELINE-PLANNING-001",
      identifiers: ["BASELINE-PLANNING-001"],
    },
  };
  const unavailableWrite =
    await recoveringSemanticRepository.upsertEmbeddingDocument(
      recoveringDocument
    );
  assert.equal(unavailableWrite.embedding_status, "unavailable");
  const [lexicalWrite] = await sql<{ has_embedding: boolean }[]>`
    select embedding is not null as has_embedding
    from embedding_documents
    where id = ${unavailableWrite.document_id}`;
  assert.equal(lexicalWrite.has_embedding, false);

  embeddingAvailable = true;
  const recoveredWrite =
    await recoveringSemanticRepository.upsertEmbeddingDocument(
      recoveringDocument
    );
  assert.equal(recoveredWrite.embedding_status, "embedded");
  assert.equal(recoveredWrite.document_id, unavailableWrite.document_id);
  const [vectorWrite] = await sql<{ has_embedding: boolean }[]>`
    select embedding is not null as has_embedding
    from embedding_documents
    where id = ${recoveredWrite.document_id}`;
  assert.equal(vectorWrite.has_embedding, true);
  const unchangedWrite =
    await recoveringSemanticRepository.upsertEmbeddingDocument(
      recoveringDocument
    );
  assert.equal(unchangedWrite.embedding_status, "unchanged");

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
