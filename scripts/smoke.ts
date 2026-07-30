/**
 * In-process end-to-end smoke test of the MCP wiring (no Supabase needed).
 * Connects a real MCP Client to the real server over an in-memory transport and
 * exercises: initialize handshake, tools/list, resources/list, input validation,
 * and graceful error handling when the DB is absent.
 *
 * Run: npm run build && node dist-smoke   (or: tsx scripts/smoke.ts)
 */

process.env.EMBEDDING_PROVIDER = "hash"; // offline embeddings
delete process.env.DATABASE_URL; // force the no-DB error path
delete process.env.SUPABASE_DB_URL; // (legacy fallback name)

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  ok  - ${name}`);
  } else {
    failed++;
    console.error(`  FAIL- ${name} ${detail}`);
  }
}

async function main(): Promise<void> {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "smoke-client", version: "0.0.0" });
  await client.connect(clientTransport);

  console.log("handshake + discovery");
  const tools = await client.listTools();
  const toolNames = tools.tools.map((t) => t.name).sort();
  check("15 base tools registered", tools.tools.length === 15, JSON.stringify(toolNames));
  check(
    "tool names correct",
    JSON.stringify(toolNames) ===
      JSON.stringify([
        "create_feature_request",
        "create_user_story",
        "find_crossover",
        "find_help",
        "find_related",
        "get_feature_request",
        "get_help_article",
        "get_story_history",
        "link_feature_request",
        "list_story_change_proposals",
        "query_stories",
        "set_feature_request_story_links",
        "suggest_story_help_links",
        "update_story_relationships",
        "update_user_story",
      ])
  );
  const readOnlyTools = new Set([
    "find_crossover",
    "find_help",
    "find_related",
    "get_feature_request",
    "get_help_article",
    "get_story_history",
    "list_story_change_proposals",
    "query_stories",
    "suggest_story_help_links",
  ]);
  const writeTools = new Set([
    "create_feature_request",
    "create_user_story",
    "link_feature_request",
    "set_feature_request_story_links",
    "update_story_relationships",
    "update_user_story",
  ]);
  check(
    "read tools annotated readOnlyHint=true",
    tools.tools.filter((t) => readOnlyTools.has(t.name)).every((t) => t.annotations?.readOnlyHint === true)
  );
  check(
    "write tools annotated readOnlyHint=false",
    tools.tools.filter((t) => writeTools.has(t.name)).every((t) => t.annotations?.readOnlyHint === false)
  );
  check(
    "every tool has inputSchema",
    tools.tools.every((t) => t.inputSchema && typeof t.inputSchema === "object")
  );

  const resources = await client.listResources();
  const uris = resources.resources.map((r) => r.uri).sort();
  check("2 resources registered", resources.resources.length === 2, JSON.stringify(uris));
  check(
    "resource uris correct",
    JSON.stringify(uris) === JSON.stringify(["docs://how-to-query", "schema://taxonomy"])
  );

  console.log("input validation");
  // find_crossover requires section_key OR story_key.
  let validationErrored = false;
  try {
    await client.callTool({ name: "find_crossover", arguments: { limit: 5 } });
  } catch {
    validationErrored = true;
  }
  // Depending on SDK, invalid args either throw or return isError; accept either.
  const crossNoKey = validationErrored
    ? { isError: true }
    : await client.callTool({ name: "find_crossover", arguments: { limit: 5 } as never });
  check("find_crossover with no key is rejected", Boolean((crossNoKey as { isError?: boolean }).isError));
  let bothKeysRejected = false;
  try {
    const both = await client.callTool({
      name: "find_crossover",
      arguments: { section_key: "one", story_key: "two", limit: 5 },
    });
    bothKeysRejected = Boolean((both as { isError?: boolean }).isError);
  } catch {
    bothKeysRejected = true;
  }
  check("find_crossover with both keys is rejected", bothKeysRejected);

  console.log("graceful DB-absent error paths");
  const q = (await client.callTool({
    name: "query_stories",
    arguments: { filters: { status: ["in_progress"] } },
  })) as { isError?: boolean; content: { type: string; text: string }[] };
  check("query_stories returns isError (no DB)", q.isError === true);
  check(
    "error message is actionable",
    /DATABASE_URL/.test(q.content[0]?.text ?? ""),
    q.content[0]?.text
  );

  // find_related: exercises the embedding path (hash) then fails at DB cleanly.
  const fr = (await client.callTool({
    name: "find_related",
    arguments: { context: "invite a teammate to a project" },
  })) as { isError?: boolean; content: { type: string; text: string }[] };
  check("find_related returns isError (no DB, embedding ran)", fr.isError === true);

  console.log("resource read (docs is static, no DB)");
  const howto = await client.readResource({ uri: "docs://how-to-query" });
  const howtoContent = howto.contents[0];
  check(
    "docs://how-to-query returns markdown",
    howtoContent !== undefined &&
      "text" in howtoContent &&
      howtoContent.text.includes("Five primary read verbs")
  );

  await client.close();
  await server.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke failed:", err);
  process.exit(1);
});
