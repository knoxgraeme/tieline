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
  "create extension if not exists pg_trgm",
  "create role tieline_reader",
  "create role tieline_planning_writer",
  "create role tieline_repository_sync",
  "enable row level security",
  "create view observation_search",
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
