process.env.EMBEDDING_PROVIDER = "hash";
delete process.env.DATABASE_URL;
delete process.env.DATABASE_URL_WRITE;

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FakeKnowledgeStore } from "../support/fakes/fake-knowledge-store.js";
import type { ResolvedRetrievalProfile } from "../../src/domain/semantic-search-store.js";
import { setEmbedder } from "../../src/embeddings.js";
import { createServer } from "../../src/server.js";
import { setStore } from "../../src/store.js";

const server = createServer({ workspaceRoot: process.cwd() });
const [clientTransport, serverTransport] =
  InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: "smoke-client", version: "0.0.0" });
await client.connect(clientTransport);

function resourceText(resource: { text: string } | { blob: string }): string {
  return "text" in resource ? resource.text : "";
}

try {
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "analyze_code_blast_radius",
    "create_backlog_item",
    "create_planning_story",
    "find_help",
    "find_related",
    "get_acceptance_criterion_context",
    "get_asset_intent_context",
    "get_backlog_item",
    "get_help_articles",
    "get_path_criteria",
    "list_attribution_suggestions",
    "list_handoff_conflicts",
    "query_stories",
    "record_observation",
    "review_semantic_suggestion",
    "search_knowledge",
    "set_backlog_item_links",
    "set_observation_attribution",
    "trace_code_dependencies",
    "update_backlog_item",
    "update_planning_story",
  ]);
  const readOnly = new Set([
    "analyze_code_blast_radius",
    "find_help",
    "find_related",
    "get_acceptance_criterion_context",
    "get_asset_intent_context",
    "get_backlog_item",
    "get_help_articles",
    "get_path_criteria",
    "list_attribution_suggestions",
    "list_handoff_conflicts",
    "query_stories",
    "search_knowledge",
    "trace_code_dependencies",
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
  assert.ok(tools.tools.every((tool) => tool.outputSchema));
  assert.equal(
    tools.tools.find((tool) => tool.name === "record_observation")
      ?.annotations?.idempotentHint,
    false
  );
  for (const name of ["find_related", "find_help"]) {
    assert.match(
      tools.tools.find((tool) => tool.name === name)?.description ?? "",
      /deprecated.*search_knowledge/i
    );
  }
  for (const name of [
    "get_asset_intent_context",
    "get_acceptance_criterion_context",
  ]) {
    const tool = tools.tools.find((candidate) => candidate.name === name);
    assert.deepEqual(tool?.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    assert.match(tool?.description ?? "", /intent neighborhood/i);
    assert.match(tool?.description ?? "", /contract coupling/i);
    assert.match(tool?.description ?? "", /before search_knowledge/i);
  }
  const instructions = client.getInstructions() ?? "";
  assert.match(instructions, /get_asset_intent_context/);
  assert.match(instructions, /get_acceptance_criterion_context/);
  assert.match(instructions, /before semantic search/i);
  assert.match(instructions, /intent neighborhood/i);
  assert.match(instructions, /contract coupling/i);
  assert.match(instructions, /trace_code_dependencies/);
  assert.match(instructions, /analyze_code_blast_radius/);
  assert.match(instructions, /derived_code_dependency/);

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
  assert.match(resourceText(guide.contents[0] ?? { blob: "" }), /Authority and lifecycle/);
  assert.match(resourceText(guide.contents[0] ?? { blob: "" }), /get_asset_intent_context/);
  assert.match(
    resourceText(guide.contents[0] ?? { blob: "" }),
    /get_acceptance_criterion_context/
  );
  assert.match(resourceText(guide.contents[0] ?? { blob: "" }), /before semantic search/i);
  assert.match(resourceText(guide.contents[0] ?? { blob: "" }), /intent neighborhood/i);
  assert.match(resourceText(guide.contents[0] ?? { blob: "" }), /contract coupling/i);
  assert.match(resourceText(guide.contents[0] ?? { blob: "" }), /trace_code_dependencies/);
  assert.match(resourceText(guide.contents[0] ?? { blob: "" }), /analyze_code_blast_radius/);
  assert.match(resourceText(guide.contents[0] ?? { blob: "" }), /semantic_support: not_assessed/);

  const prompts = await client.listPrompts();
  assert.deepEqual(
    prompts.prompts.map((prompt) => prompt.name),
    ["tieline", "tieline_author"]
  );
  const tielinePromptMetadata = prompts.prompts.find(
    (prompt) => prompt.name === "tieline"
  );
  assert.match(tielinePromptMetadata?.title ?? "", /close out branch semantics/i);
  assert.match(
    tielinePromptMetadata?.description ?? "",
    /before implementation handoff, commit, push, or pull-request publication/i
  );
  const tielinePrompt = await client.getPrompt({ name: "tieline" });
  const promptText = String(
    tielinePrompt.messages[0]?.content.type === "text"
      ? tielinePrompt.messages[0].content.text
      : ""
  );
  const expectedPromptText = [
    "SKILL.md",
    "references/onboarding.md",
    "references/contract.md",
    "references/provisioning.md",
    "references/grading.md",
    "references/report.md",
  ]
    .map((path) =>
      readFileSync(resolve(process.cwd(), "skills/tieline", path), "utf8")
    )
    .join("\n\n");
  assert.ok(
    promptText.endsWith(expectedPromptText),
    "the MCP prompt must expose the complete installed Tieline workflow"
  );
  assert.match(
    promptText,
    /^# Active Tieline invocation\n\nContract state: `contract_present`\./,
    "the MCP prompt must tell the agent when normal contract work is available"
  );
  assert.ok(
    promptText.indexOf("## Set expectations first") <
      promptText.indexOf("# Authoring contract"),
    "the MCP prompt must present first-run onboarding before normal contract authoring"
  );

  const emptyWorkspace = mkdtempSync(
    resolve(tmpdir(), "tieline-empty-prompt-")
  );
  mkdirSync(resolve(emptyWorkspace, ".tieline/spec"), { recursive: true });
  writeFileSync(
    resolve(emptyWorkspace, ".tieline/config.json"),
    `${JSON.stringify({
      version: 1,
      product: { name: "Empty Prompt", repo_name: "empty-prompt" },
      repository: {
        root: "..",
        source_roots: ["src"],
        ignore: [".git", ".tieline", "node_modules", "dist", "coverage"],
      },
      context: { sources: [] },
      runtime: {
        default_embedding_provider: "hash",
        default_database_mode: "offline",
      },
      files: { spec_directory: "spec", manifest: "manifest" },
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    }, null, 2)}\n`
  );
  const onboardingServer = createServer({ workspaceRoot: emptyWorkspace });
  const [onboardingClientTransport, onboardingServerTransport] =
    InMemoryTransport.createLinkedPair();
  await onboardingServer.connect(onboardingServerTransport);
  const onboardingClient = new Client({
    name: "onboarding-prompt-client",
    version: "0.0.0",
  });
  await onboardingClient.connect(onboardingClientTransport);
  try {
    const onboardingPrompt = await onboardingClient.getPrompt({
      name: "tieline",
    });
    const onboardingPromptText = String(
      onboardingPrompt.messages[0]?.content.type === "text"
        ? onboardingPrompt.messages[0].content.text
        : ""
    );
    assert.match(
      onboardingPromptText,
      /^# Active Tieline invocation\n\nContract state: `onboarding_required`\.[\s\S]*first visible response must be the verbatim product orientation/i,
      "an empty contract must make onboarding the explicit MCP prompt state"
    );
    assert.ok(
      onboardingPromptText.endsWith(expectedPromptText),
      "first-run routing must retain the complete workflow for autonomous continuation"
    );
  } finally {
    await onboardingClient.close();
    await onboardingServer.close();
    rmSync(emptyWorkspace, { recursive: true, force: true });
  }
  const legacyPrompt = await client.getPrompt({ name: "tieline_author" });
  assert.equal(
    legacyPrompt.messages[0]?.content.type === "text"
      ? legacyPrompt.messages[0].content.text
      : "",
    promptText,
    "the legacy MCP prompt name must remain a content-identical alias"
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
let capturedHelpSearch: unknown;
let semanticSearchCalls = 0;
setEmbedder({
  provider: "local",
  dim: 384,
  async embed() {
    await new Promise<void>((resolve) => setImmediate(resolve));
    throw new Error("embedding provider unavailable");
  },
});
class ContextualSearchStore extends FakeKnowledgeStore {
  override async resolveRetrievalProfile(
    profile: string
  ): Promise<ResolvedRetrievalProfile> {
    const include =
      profile === "help-only"
        ? (["help_article"] as const)
        : profile === "excluded-help"
          ? (["acceptance_criterion"] as const)
          : (["acceptance_criterion", "help_article"] as const);
    return {
      key: profile,
      version: 1,
      definition: {
        include: [...include],
        authorities: ["repository"],
        lifecycles: ["in_progress", "production"],
        include_inactive: false,
      },
    };
  }

  override async searchSemantic(
    input: Parameters<FakeKnowledgeStore["searchSemantic"]>[0]
  ) {
    semanticSearchCalls += 1;
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

  override async searchHelpArticles(
    input: Parameters<FakeKnowledgeStore["searchHelpArticles"]>[0]
  ) {
    capturedHelpSearch = input;
    if (input.query.includes("reject help")) {
      throw new Error("help search unavailable");
    }
    return [
      {
        id: "00000000-0000-4000-8000-000000000020",
        source: "intercom",
        external_id: "retrieval-profiles",
        title: "Choose a retrieval profile",
        url: "https://help.example.test/retrieval-profiles",
        summary: "How support and engineering retrieval differ.",
        lexical_score: 0.7,
        graph_proximity: 0.75,
        linked_story_count: 1,
        linked_acceptance_criterion_count: 2,
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
      authority: ["repository"],
      lifecycle: ["production"],
      repository: ["tieline"],
      include_inactive: true,
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
  assert.deepEqual(capturedHelpSearch, {
    query: "find behavior grounded by this observation",
    sources: undefined,
    authorities: ["repository"],
    lifecycles: ["production"],
    repositories: ["tieline"],
    include_inactive: false,
    context,
    limit: 40,
  });
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
  const helpResult = contextualResults.find(
    (result) => result.entity_kind === "help_article"
  );
  assert.equal(
    (helpResult?.features as Record<string, unknown>)?.graph,
    0.75
  );
  assert.deepEqual(helpResult?.context_anchor, {
    kind: "help_article",
    source: "intercom",
    external_id: "retrieval-profiles",
  });
  assert.deepEqual(helpResult?.help_article, {
    source: "intercom",
    external_id: "retrieval-profiles",
    title: "Choose a retrieval profile",
    url: "https://help.example.test/retrieval-profiles",
    summary: "How support and engineering retrieval differ.",
    linked_story_count: 1,
    linked_acceptance_criterion_count: 2,
  });
  const incompatibleHelpFilter = (await contextualClient.callTool({
    name: "search_knowledge",
    arguments: {
      query: "find behavior grounded by this observation",
      profile: "engineering",
      document_kind: ["acceptance_criterion"],
      help_source: ["intercom"],
    },
  })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  assert.equal(incompatibleHelpFilter.isError, true);
  assert.match(
    incompatibleHelpFilter.content[0]?.text ?? "",
    /help_source requires document_kind to include help_article/i
  );

  const searchesBeforeHelpOnly = semanticSearchCalls;
  const helpOnlySearch = (await contextualClient.callTool({
    name: "search_knowledge",
    arguments: {
      query: "find only help articles",
      profile: "help-only",
    },
  })) as {
    isError?: boolean;
    content?: unknown;
    structuredContent?: Record<string, unknown>;
  };
  assert.equal(
    helpOnlySearch.isError,
    undefined,
    JSON.stringify(helpOnlySearch.content)
  );
  assert.equal(semanticSearchCalls, searchesBeforeHelpOnly);
  assert.deepEqual(
    (helpOnlySearch.structuredContent?.results as Array<Record<string, unknown>>)
      .map((result) => result.entity_kind),
    ["help_article"]
  );

  const helpSearchBeforeExcluded = capturedHelpSearch;
  const excludedHelpSearch = (await contextualClient.callTool({
    name: "search_knowledge",
    arguments: {
      query: "find excluded help articles",
      profile: "excluded-help",
      document_kind: ["help_article"],
    },
  })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  assert.equal(excludedHelpSearch.isError, true);
  assert.match(
    excludedHelpSearch.content[0]?.text ?? "",
    /document kind filter does not intersect/i
  );
  assert.equal(capturedHelpSearch, helpSearchBeforeExcluded);

  const rejectedHelpSearch = (await contextualClient.callTool({
    name: "search_knowledge",
    arguments: {
      query: "reject help immediately",
      profile: "engineering",
    },
  })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  assert.equal(rejectedHelpSearch.isError, true);
  assert.match(
    rejectedHelpSearch.content[0]?.text ?? "",
    /help search unavailable/i
  );
} finally {
  await contextualClient.close();
  await contextualServer.close();
}

console.log("MCP smoke tests passed");
