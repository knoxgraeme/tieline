/** Live batch/import-ref behavior check against a disposable integration DB. */
import "../src/loadEnv.js";
import { importStories } from "../src/authoring/import.js";
import type { ImportPayload } from "../src/authoring/schema.js";
import { getEmbedder } from "../src/embeddings.js";
import { closeConnections, getIngestSql } from "../src/adapters/postgres/connections.js";

let passed = 0;
function check(name: string, condition: boolean): void {
  if (!condition) throw new Error(`FAIL - ${name}`);
  passed += 1;
  console.log(`ok - ${name}`);
}

function payload(source: string, count: number): ImportPayload {
  return {
    import_source: source,
    sections: [{ section_key: "import-scale", section_name: "Import scale" }],
    stories: Array.from({ length: count }, (_, index) => ({
      import_ref: `record-${index + 1}`,
      story_key: null,
      section_key: "import-scale",
      title: `Import scale story ${index + 1}`,
      story_text: `As an operator, I want batch record ${index + 1} imported safely.`,
      actor: "operator",
      status: "idea" as const,
      entity_slugs: ["import-scale"],
      code_paths: [],
    })),
  };
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL_INGEST && !process.env.SUPABASE_DB_URL_INGEST) {
    console.log("SKIP - DATABASE_URL_INGEST not set; import integration needs a writable database.");
    return;
  }
  const sql = getIngestSql();
  const embedder = getEmbedder();
  const source = `integration-scale-${Date.now()}`;
  const input = payload(source, 125);
  const first = await importStories(sql, embedder, input, { batchSize: 50 });
  check("125 records commit as three batches", first.batches?.length === 3);
  check("all first-run records are applied", first.batches?.reduce((n, batch) => n + batch.applied, 0) === 125);

  const revisionsBefore = await sql<{ count: number }[]>`
    select count(*)::int as count from story_revisions sr
    join story_import_refs sir on sir.story_id = sr.story_id
    where sir.import_source = ${source}`;
  const retry = await importStories(sql, embedder, input, { batchSize: 50 });
  const revisionsAfter = await sql<{ count: number }[]>`
    select count(*)::int as count from story_revisions sr
    join story_import_refs sir on sir.story_id = sr.story_id
    where sir.import_source = ${source}`;
  check("retry skips all completed refs", retry.batches?.reduce((n, batch) => n + batch.skipped, 0) === 125);
  check("retry creates no revision/event noise", revisionsAfter[0].count === revisionsBefore[0].count);

  let missingRefRejected = false;
  try {
    await importStories(sql, embedder, {
      import_source: "missing-ref-test",
      sections: input.sections,
      stories: [{ ...input.stories[0], import_ref: null }],
    });
  } catch {
    missingRefRejected = true;
  }
  check("keyless record without import_ref is rejected before batching", missingRefRejected);

  let duplicateRefRejected = false;
  try {
    await importStories(sql, embedder, {
      import_source: "duplicate-ref-test",
      sections: input.sections,
      stories: [input.stories[0], { ...input.stories[1], import_ref: input.stories[0].import_ref }],
    });
  } catch {
    duplicateRefRejected = true;
  }
  check("duplicate refs in one payload are rejected", duplicateRefRejected);

  const failureSource = `integration-failure-${Date.now()}`;
  const failing = payload(failureSource, 101);
  failing.stories[100] = { ...failing.stories[100], status: "not-a-status" as never };
  let laterBatchFailed = false;
  try {
    await importStories(sql, embedder, failing, { batchSize: 50 });
  } catch {
    laterBatchFailed = true;
  }
  const committed = await sql<{ count: number }[]>`
    select count(*)::int as count from story_import_refs where import_source = ${failureSource}`;
  check("invalid later batch fails", laterBatchFailed);
  check("earlier committed batches remain and failed batch rolls back", committed[0].count === 100);

  console.log(`\n${passed} passed, 0 failed`);
  await closeConnections();
}

main().catch(async (error) => {
  console.error(error);
  await closeConnections();
  process.exitCode = 1;
});
