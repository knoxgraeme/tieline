import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { assertBaselineHistory } from "../src/commands/migrate.js";

const migrations = readdirSync(resolve("migrations"))
  .filter((file) => file.endsWith(".sql"))
  .sort();

assert.deepEqual(migrations, ["0001_baseline.sql"]);

const sql = readFileSync(resolve("migrations/0001_baseline.sql"), "utf8");
for (const required of [
  "create table repositories",
  "create table user_stories",
  "create table acceptance_criteria",
  "create table observations",
  "create table backlog_items",
  "create table embedding_documents",
  "create table retrieval_profiles",
  "create table code_topology_generations",
  "create table code_topology_files",
  "create table code_topology_symbols",
  "create table code_topology_references",
  "create table code_topology_resolutions",
  "create table code_topology_edges",
  "create table code_topology_checkpoints",
  "create extension if not exists pg_trgm",
  "create role tieline_reader",
  "create role tieline_planning_writer",
  "create role tieline_repository_sync",
  "enable row level security",
  "create view observation_search",
  "create view complete_code_topology_generations",
  "create function promote_code_topology_generation",
  "create function gc_code_topology_generations",
]) {
  assert.match(sql.toLowerCase(), new RegExp(required.replaceAll(" ", "\\s+")));
}

assert.doesNotMatch(sql, /mcp_approver|story_change_proposal|feature_requests/i);
assert.match(sql, /revoke\s+update\s*,?\s*delete\s+on\s+observations/i);
assert.match(sql, /support[\s\S]+engineering[\s\S]+discovery[\s\S]+all/i);
assert.match(
  sql,
  /alter\s+extension\s+vector\s+set\s+schema\s+extensions/i,
  "the baseline must relocate a vector extension preinstalled outside extensions"
);
assert.match(
  sql,
  /search_vector\s+tsvector\s+generated\s+always[\s\S]+using\s+gin\s*\(\s*search_vector\s*\)/i,
  "hybrid retrieval needs a persisted lexical vector and GIN index"
);
assert.match(
  sql,
  /to_tsvector\s*\(\s*'english'/i,
  "lexical prose search must use an explicit immutable English configuration"
);
assert.match(
  sql,
  /foreign\s+key\s*\(\s*source_generation_identity\s*,\s*source_symbol_identity\s*\)[\s\S]+foreign\s+key\s*\(\s*target_generation_identity\s*,\s*target_symbol_identity\s*\)/i,
  "both edge endpoints must be protected by generation-bearing foreign keys"
);
assert.match(
  sql,
  /create\s+index\s+code_topology_edges_forward\s+on\s+code_topology_edges\s*\(\s*generation_identity\s*,\s*source_symbol_identity\s*\)/i
);
assert.match(
  sql,
  /create\s+index\s+code_topology_edges_reverse\s+on\s+code_topology_edges\s*\(\s*generation_identity\s*,\s*target_symbol_identity\s*\)/i
);
assert.match(
  sql,
  /grant\s+execute\s+on\s+function\s+promote_code_topology_generation\s*\(\s*uuid\s*,\s*text\s*,\s*text\s*\)\s+to\s+tieline_repository_sync/i,
  "the repository-sync role must publish only through the CAS promotion function"
);
const syncBroadGrant = sql.match(
  /grant\s+select\s*,\s*insert\s*,\s*update\s+on([\s\S]+?)to\s+tieline_repository_sync/i
);
assert.ok(syncBroadGrant);
assert.doesNotMatch(
  syncBroadGrant[1],
  /code_topology_/i,
  "immutable topology tables must not inherit broad update privileges"
);
assert.doesNotMatch(
  sql,
  /grant\s+(?:[^;]*\bupdate\b[^;]*|[^;]*\bdelete\b[^;]*)\s+on[^;]*code_topology_(?:generations|files|symbols|references|resolutions|edges|checkpoints)[^;]*to\s+tieline_repository_sync/i,
  "the sync role must not mutate or delete published topology facts directly"
);

assert.doesNotThrow(() => assertBaselineHistory([]));
assert.doesNotThrow(() =>
  assertBaselineHistory([{ filename: "0001_baseline.sql", checksum: "current" }], "current")
);
assert.throws(
  () => assertBaselineHistory([{ filename: "0009_mcp_writer_role_rls.sql", checksum: "old" }]),
  /recreate/i
);
assert.throws(
  () => assertBaselineHistory([{ filename: "0001_baseline.sql", checksum: "old" }], "current"),
  /drift/i
);

console.log("baseline migration contract passed");
