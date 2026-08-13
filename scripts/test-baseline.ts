import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertMigrationHistory,
  readPackagedMigrations,
} from "../src/commands/migrate.js";

const migrations = readdirSync(resolve("migrations"))
  .filter((file) => file.endsWith(".sql"))
  .sort();

assert.deepEqual(migrations, [
  "0001_baseline.sql",
  "0002_code_topology.sql",
]);
assert.deepEqual(
  migrations.map((filename) => Number(filename.slice(0, 4))),
  [1, 2],
  "packaged migrations must remain a contiguous ordered sequence"
);

const baselineSql = readFileSync(resolve("migrations/0001_baseline.sql"), "utf8");
assert.equal(
  createHash("sha256").update(baselineSql).digest("hex"),
  "a8fee643ee68cdb20a6c6920d77e83185e3d660747d6bd9daf252be866e98205",
  "the published baseline is immutable"
);
for (const required of [
  "create table repositories",
  "create table user_stories",
  "create table acceptance_criteria",
  "create table observations",
  "create table backlog_items",
  "create table embedding_documents",
  "create table retrieval_profiles",
  "create extension if not exists pg_trgm",
  "create role tieline_reader",
  "create role tieline_planning_writer",
  "create role tieline_repository_sync",
  "enable row level security",
  "create view observation_search",
]) {
  assert.match(baselineSql.toLowerCase(), new RegExp(required.replaceAll(" ", "\\s+")));
}

assert.doesNotMatch(
  baselineSql,
  /code_topology_|mcp_approver|story_change_proposal|feature_requests/i
);
assert.match(baselineSql, /revoke\s+update\s*,?\s*delete\s+on\s+observations/i);
assert.match(baselineSql, /support[\s\S]+engineering[\s\S]+discovery[\s\S]+all/i);
assert.match(
  baselineSql,
  /alter\s+extension\s+vector\s+set\s+schema\s+extensions/i,
  "the baseline must relocate a vector extension preinstalled outside extensions"
);
assert.match(
  baselineSql,
  /search_vector\s+tsvector\s+generated\s+always[\s\S]+using\s+gin\s*\(\s*search_vector\s*\)/i,
  "hybrid retrieval needs a persisted lexical vector and GIN index"
);
assert.match(
  baselineSql,
  /to_tsvector\s*\(\s*'english'/i,
  "lexical prose search must use an explicit immutable English configuration"
);

const topologySql = readFileSync(resolve("migrations/0002_code_topology.sql"), "utf8");
for (const required of [
  "create table code_topology_generations",
  "create table code_topology_files",
  "create table code_topology_symbols",
  "create table code_topology_references",
  "create table code_topology_resolutions",
  "create table code_topology_edges",
  "create table code_topology_checkpoints",
  "create view complete_code_topology_generations",
  "create function promote_code_topology_generation",
  "create function gc_code_topology_generations",
]) {
  assert.match(topologySql.toLowerCase(), new RegExp(required.replaceAll(" ", "\\s+")));
}
assert.match(
  topologySql,
  /foreign\s+key\s*\(\s*generation_identity\s*,\s*source_symbol_identity\s*\)[\s\S]+foreign\s+key\s*\(\s*generation_identity\s*,\s*target_symbol_identity\s*\)/i,
  "both edge endpoints must share the edge generation"
);
assert.match(
  topologySql,
  /create\s+index\s+code_topology_edges_forward\s+on\s+code_topology_edges\s*\(\s*generation_identity\s*,\s*source_symbol_identity\s*\)/i
);
assert.match(
  topologySql,
  /create\s+index\s+code_topology_edges_reverse\s+on\s+code_topology_edges\s*\(\s*generation_identity\s*,\s*target_symbol_identity\s*\)/i
);
assert.match(
  topologySql,
  /grant\s+execute\s+on\s+function\s+promote_code_topology_generation\s*\(\s*uuid\s*,\s*text\s*,\s*text\s*\)\s+to\s+tieline_repository_sync/i,
  "the repository-sync role must publish only through the CAS promotion function"
);
const syncBroadGrant = baselineSql.match(
  /grant\s+select\s*,\s*insert\s*,\s*update\s+on([\s\S]+?)to\s+tieline_repository_sync/i
);
assert.ok(syncBroadGrant);
assert.doesNotMatch(
  syncBroadGrant[1],
  /code_topology_/i,
  "immutable topology tables must not inherit broad update privileges"
);
assert.doesNotMatch(
  topologySql,
  /grant\s+(?:[^;]*\bupdate\b[^;]*|[^;]*\bdelete\b[^;]*)\s+on[^;]*code_topology_(?:generations|files|symbols|references|resolutions|edges|checkpoints)[^;]*to\s+tieline_repository_sync/i,
  "the sync role must not mutate or delete published topology facts directly"
);

const packaged = readPackagedMigrations();
assert.deepEqual(packaged.map((migration) => migration.filename), migrations);
assert.doesNotThrow(() => assertMigrationHistory([], packaged));
assert.doesNotThrow(() => assertMigrationHistory(packaged, packaged));
assert.doesNotThrow(() => assertMigrationHistory(packaged.slice(0, 1), packaged));
assert.throws(
  () => assertMigrationHistory([{ filename: "0009_mcp_writer_role_rls.sql", checksum: "old" }], packaged),
  /not packaged|recreate/i
);
assert.throws(
  () => assertMigrationHistory([{ filename: "0001_baseline.sql", checksum: "old" }], packaged),
  /drift/i
);
assert.throws(
  () => assertMigrationHistory([{ ...packaged[1]!, checksum: "old" }], packaged),
  /prefix|order/i
);
assert.throws(
  () => assertMigrationHistory([packaged[0]!, { ...packaged[1]!, checksum: "old" }], packaged),
  /drift/i
);

console.log("database migration contract passed");
