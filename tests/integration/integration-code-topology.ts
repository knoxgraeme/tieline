import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { PostgresCodeTopologyRepository } from "../../src/adapters/postgres/code-topology-repository.js";
import { FakeCodeTopologyStore } from "../support/fakes/fake-code-topology-store.js";
import { migrateDatabase } from "../../src/commands/migrate.js";
import { traceCodeTopology } from "../../src/contract/code-topology.js";
import {
  buildCommittedTopologyGeneration,
  persistCommittedTopologyGeneration,
} from "../../src/contract/topology-generation.js";
import { codeTopologySelectedInputDigest } from "../../src/domain/code-topology-store.js";

const adminUrl = process.env.DATABASE_URL_ADMIN;
if (!adminUrl) {
  console.log(
    "SKIP - DATABASE_URL_ADMIN not set; topology integration needs a disposable database."
  );
  process.exit(0);
}

await migrateDatabase(adminUrl);
const sql = postgres(adminUrl, { max: 1, prepare: false });
const root = mkdtempSync(join(tmpdir(), "tieline-topology-integration-"));
const repository = `topology-integration-${Date.now()}`;

function git(args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

try {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src/main.ts"),
    'import { dependency } from "./dependency.js";\nexport const main = dependency;\n'
  );
  writeFileSync(join(root, "src/dependency.ts"), "export const dependency = true;\n");
  writeFileSync(
    join(root, "src/schema.sql"),
    "CREATE TABLE accounts (id BIGINT PRIMARY KEY);\n"
  );
  git(["init", "-q"]);
  git(["config", "user.email", "topology@example.test"]);
  git(["config", "user.name", "Topology Integration"]);
  git(["add", "."]);
  git(["commit", "-qm", "fixture"]);

  await sql`
    insert into repositories (key, display_name)
    values (${repository}, ${repository})`;
  const result = await buildCommittedTopologyGeneration({
    repositoryRoot: root,
    repository,
    revision: "HEAD",
    sourceRoots: ["src"],
  });
  assert.equal(result.status, "complete");
  const topology = new PostgresCodeTopologyRepository(
    () => sql,
    () => sql,
    () => sql
  );
  const first = await persistCommittedTopologyGeneration({
    store: topology,
    result,
    expectedPreviousGenerationIdentity: null,
  });
  assert.equal(first.outcome, "inserted");
  const stored = await topology.getGeneration(first.generation_identity);
  assert.ok(stored);
  assert.equal(stored.counts.files, 3);
  assert.ok(stored.counts.edges > 0);
  assert.equal(
    stored.header.revision,
    codeTopologySelectedInputDigest(stored.header)
  );
  const [storedSqlFile] = await sql<{ language: string }[]>`
    select language
    from code_topology_files
    where generation_identity = ${first.generation_identity}
      and path = 'src/schema.sql'`;
  assert.deepEqual(storedSqlFile, { language: "sql" });
  const [storedSqlSymbol] = await sql<{ canonical_selector: string | null }[]>`
    select canonical_selector
    from code_topology_symbols
    where generation_identity = ${first.generation_identity}
      and file_path = 'src/schema.sql'
      and canonical_selector = 'type:accounts'`;
  assert.deepEqual(storedSqlSymbol, { canonical_selector: "type:accounts" });
  const repeated = await persistCommittedTopologyGeneration({
    store: topology,
    result,
    expectedPreviousGenerationIdentity: first.generation_identity,
  });
  assert.equal(repeated.outcome, "existing");

  const fake = new FakeCodeTopologyStore();
  assert.equal(result.status, "complete");
  if (result.status !== "complete") throw new Error(result.detail);
  await fake.commitGeneration({
    generation: result.generation,
    expected_previous_generation_identity: null,
  });
  const request = {
    generation_identity: first.generation_identity,
    generation_role: "current" as const,
    locator: {
      repository,
      kind: "code" as const,
      path: "src/main.ts",
      selector: null,
      framework_hint: null,
    },
    direction: "dependencies" as const,
  };
  const [postgresTrace, fakeTrace] = await Promise.all([
    traceCodeTopology({ store: topology, ...request }),
    traceCodeTopology({ store: fake, ...request }),
  ]);
  assert.deepEqual(postgresTrace, fakeTrace, "fake and Postgres traversal reads stay contract-equivalent");

  writeFileSync(
    join(root, "src/main.ts"),
    'import { replacement } from "./replacement";\nexport const main = replacement;\n'
  );
  writeFileSync(join(root, "src/replacement.ts"), "export const replacement = true;\n");
  git(["add", "."]);
  git(["commit", "-qm", "retarget fixture"]);
  const retargeted = await buildCommittedTopologyGeneration({
    repositoryRoot: root,
    repository,
    revision: "HEAD",
    sourceRoots: ["src"],
  });
  assert.equal(retargeted.status, "complete");
  if (retargeted.status !== "complete") throw new Error(retargeted.detail);
  const current = await persistCommittedTopologyGeneration({
    store: topology,
    result: retargeted,
    expectedPreviousGenerationIdentity: first.generation_identity,
  });
  await fake.commitGeneration({
    generation: retargeted.generation,
    expected_previous_generation_identity: first.generation_identity,
  });
  const comparisonInput = {
    base_generation_identity: first.generation_identity,
    current_generation_identity: current.generation_identity,
  };
  const [postgresComparison, fakeComparison] = await Promise.all([
    topology.compareGenerations(comparisonInput),
    fake.compareGenerations(comparisonInput),
  ]);
  assert.deepEqual(
    postgresComparison,
    fakeComparison,
    "SQL comparison must match the compact in-memory generation comparison"
  );
  assert.ok(postgresComparison?.files.some(
    (change) => change.status === "modified" && change.path === "src/main.ts"
  ));
  assert.ok(postgresComparison?.edges.some((change) => change.status === "deleted"));
  assert.ok(postgresComparison?.edges.some((change) => change.status === "added"));

  const plans = await sql.begin(async (tx) => {
    await tx`set local enable_seqscan = off`;
    return tx<{ "QUERY PLAN": unknown }[]>`
      explain (format json)
      select identity from code_topology_edges
      where generation_identity = ${first.generation_identity}
        and source_symbol_identity = ${result.generation.edges[0]!.source.symbol_identity}`;
  });
  const plan = JSON.stringify(plans);
  assert.match(plan, /Index (?:Only )?Scan/i);
  assert.doesNotMatch(plan, /Seq Scan/i);
  const [forwardIndex] = await sql<{ indexdef: string }[]>`
    select indexdef from pg_indexes
    where schemaname = 'public'
      and indexname = 'code_topology_edges_forward'`;
  assert.ok(forwardIndex);
  assert.match(
    forwardIndex.indexdef,
    /\(generation_identity, source_symbol_identity\)/i,
    "the forward frontier index must retain source as its second key"
  );
} finally {
  rmSync(root, { recursive: true, force: true });
  await sql.end({ timeout: 5 });
}

console.log("code topology generation integration passed");
