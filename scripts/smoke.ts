process.env.EMBEDDING_PROVIDER = "hash";
delete process.env.DATABASE_URL;
delete process.env.DATABASE_URL_WRITE;

import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FakeKnowledgeStore } from "../src/domain/testing/fake-knowledge-store.js";
import { setEmbedder } from "../src/embeddings.js";
import { createServer } from "../src/server.js";
import { setStore } from "../src/store.js";

const server = createServer();
const [clientTransport, serverTransport] =
  InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: "smoke-client", version: "0.0.0" });
await client.connect(clientTransport);

try {
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "create_backlog_item",
    "create_planning_story",
    "decide_attribution",
    "decide_attribution_suggestion",
    "find_help",
    "find_related",
    "get_backlog_item",
    "get_governing_criteria",
    "get_help_article",
    "list_attribution_suggestions",
    "list_handoff_conflicts",
    "query_stories",
    "record_observation",
    "search_knowledge",
    "set_backlog_item_links",
    "update_backlog_item",
    "update_planning_story",
  ]);
  const readOnly = new Set([
    "find_help",
    "find_related",
    "get_backlog_item",
    "get_governing_criteria",
    "get_help_article",
    "list_attribution_suggestions",
    "list_handoff_conflicts",
    "query_stories",
    "search_knowledge",
  ]);
  assert.ok(
    tools.tools
      .filter((tool) => readOnly.has(tool.name))
      .every((tool) => tool.annotations?.readOnlyHint === true)
  );
  assert.ok(
    tools.tools
      .filter((tool) => !readOnly.has(tool.name))
      .every((tool) => tool.annotations?.readOnlyHint === false)
  );
  assert.ok(tools.tools.every((tool) => tool.inputSchema));

  const unknownDestructiveField = (await client.callTool({
    name: "set_backlog_item_links",
    arguments: {
      stable_id: "BL-STRICT-001",
      expected_revision: 0,
      acceptance_criterias: [],
    },
  })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  assert.equal(unknownDestructiveField.isError, true);
  assert.match(
    unknownDestructiveField.content[0]?.text ?? "",
    /unrecognized|unknown|acceptance_criterias/i
  );

  const resources = await client.listResources();
  assert.deepEqual(
    resources.resources.map((resource) => resource.uri),
    ["docs://tieline-contract"]
  );
  const guide = await client.readResource({
    uri: "docs://tieline-contract",
  });
  assert.match(String(guide.contents[0]?.text), /Authority and lifecycle/);

  const prompts = await client.listPrompts();
  assert.deepEqual(
    prompts.prompts.map((prompt) => prompt.name),
    ["tieline_author"]
  );
  const authorPrompt = await client.getPrompt({ name: "tieline_author" });
  assert.match(
    String(authorPrompt.messages[0]?.content.type === "text"
      ? authorPrompt.messages[0].content.text
      : ""),
    /\.tieline\/config\.json[\s\S]*Search before creating/
  );

  const omittedProfile = (await client.callTool({
    name: "search_knowledge",
    arguments: { query: "how behavior is accepted" },
  })) as { isError?: boolean };
  assert.equal(omittedProfile.isError, true);

  const exactRead = (await client.callTool({
    name: "query_stories",
    arguments: { lifecycle: ["production"] },
  })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  assert.equal(exactRead.isError, true);
  assert.match(exactRead.content[0]?.text ?? "", /DATABASE_URL/);

  const semanticRead = (await client.callTool({
    name: "find_related",
    arguments: { context: "how behavior is accepted" },
  })) as { isError?: boolean };
  assert.equal(semanticRead.isError, true);
} finally {
  await client.close();
  await server.close();
}

let capturedSearchContext: unknown;
setEmbedder({
  provider: "local",
  dim: 384,
  async embed() {
    throw new Error("embedding provider unavailable");
  },
});
class ContextualSearchStore extends FakeKnowledgeStore {
  override async resolveRetrievalProfile(profile: string) {
    return {
      key: profile,
      version: 1,
      definition: { include: ["acceptance_criterion"] },
    };
  }

  override async searchSemantic(
    input: Parameters<FakeKnowledgeStore["searchSemantic"]>[0]
  ) {
    capturedSearchContext = input.context;
    return [
      {
        document_id: "00000000-0000-4000-8000-000000000010",
        entity_kind: "acceptance_criterion" as const,
        entity_id: "00000000-0000-4000-8000-000000000011",
        matched_level: "acceptance_criterion" as const,
        canonical_text: "Contextually grounded acceptance criterion",
        vector_score: 0,
        lexical_score: 0.8,
        alias_match: false,
        artifact_overlap: 1,
        graph_proximity: 0.5,
        applicable: true,
        story_id: "00000000-0000-4000-8000-000000000012",
        story_stable_id: "SEARCH-001",
        acceptance_criterion_id:
          "00000000-0000-4000-8000-000000000011",
        acceptance_criterion_stable_id: "SEARCH-001-AC1",
        metadata: {
          repository: "tieline",
          authority: "repository",
          lifecycle: "production",
          active: true,
          coverage: "direct",
          freshness: "current",
        },
      },
    ];
  }
}
setStore(new ContextualSearchStore());
const contextualServer = createServer();
const [contextualClientTransport, contextualServerTransport] =
  InMemoryTransport.createLinkedPair();
await contextualServer.connect(contextualServerTransport);
const contextualClient = new Client({
  name: "contextual-search-client",
  version: "0.0.0",
});
await contextualClient.connect(contextualClientTransport);
try {
  const context = {
    anchor: {
      kind: "observation",
      id: "00000000-0000-4000-8000-000000000001",
    },
    artifacts: [
      {
        kind: "code",
        repository: "tieline",
        path: "src/tools/search-knowledge.ts",
      },
    ],
  };
  const contextualSearch = (await contextualClient.callTool({
    name: "search_knowledge",
    arguments: {
      query: "find behavior grounded by this observation",
      profile: "engineering",
      context,
    },
  })) as {
    isError?: boolean;
    content?: unknown;
    structuredContent?: Record<string, unknown>;
  };
  assert.equal(
    contextualSearch.isError,
    undefined,
    JSON.stringify(contextualSearch.content)
  );
  assert.deepEqual(capturedSearchContext, context);
  const contextualResults = contextualSearch.structuredContent
    ?.results as Array<Record<string, unknown>>;
  assert.deepEqual(
    (contextualResults[0]?.features as Record<string, unknown>)?.artifact,
    1
  );
  assert.deepEqual(contextualSearch.structuredContent?.signals, {
    lexical: "applied",
    embedding: "unavailable",
  });
  assert.match(
    ((contextualResults[0]?.why as string[]) ?? []).join(" "),
    /lexical.*artifact/i
  );
  assert.deepEqual(contextualResults[0]?.context_anchor, {
    kind: "acceptance_criterion",
    repository: "tieline",
    stable_id: "SEARCH-001-AC1",
  });
} finally {
  await contextualClient.close();
  await contextualServer.close();
}

console.log("MCP smoke tests passed");
