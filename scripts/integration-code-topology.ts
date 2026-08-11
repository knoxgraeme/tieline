import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { PostgresCodeTopologyRepository } from "../src/adapters/postgres/code-topology-repository.js";
import { FakeCodeTopologyStore } from "../src/adapters/fakes/fake-code-topology-store.js";
import { migrateDatabase } from "../src/commands/migrate.js";
import { traceCodeTopology } from "../src/contract/code-topology.js";
import {
  buildCommittedTopologyGeneration,
  persistCommittedTopologyGeneration,
} from "../src/contract/topology-generation.js";

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
    'import { dependency } from "./dependency";\nexport const main = dependency;\n'
  );
  writeFileSync(join(root, "src/dependency.ts"), "export const dependency = true;\n");
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
  assert.equal(stored.counts.files, 2);
  assert.ok(stored.counts.edges > 0);
  assert.equal(stored.header.revision, execFileSync(
    "git",
    ["rev-parse", "HEAD^{tree}"],
    { cwd: root, encoding: "utf8" }
  ).trim());
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

  const plans = await sql.begin(async (tx) => {
    await tx`set local enable_seqscan = off`;
    return tx<{ "QUERY PLAN": unknown }[]>`
      explain (format json)
      select identity from code_topology_edges
      where generation_identity = ${first.generation_identity}
        and source_symbol_identity = ${result.generation.edges[0]!.source.symbol_identity}`;
  });
  const plan = JSON.stringify(plans);
  assert.match(plan, /code_topology_edges_(?:forward|pkey)/i);
} finally {
  rmSync(root, { recursive: true, force: true });
  await sql.end({ timeout: 5 });
}

console.log("code topology generation integration passed");
