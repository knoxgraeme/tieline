import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  EvidenceValidationError,
  prepareObservation,
} from "../../../src/domain/evidence-write-store.js";
import { setSemanticMatcher } from "../../../src/semantic-matching.js";
import { setStore } from "../../../src/store.js";
import { registerBacklogItemTools } from "../../../src/tools/backlog-items.js";
import { recordObservationThenMatch } from "../../../src/tools/observations.js";

console.log("versioned observation schemas");

const request = prepareObservation({
  kind: "request",
  schema_key: "request",
  schema_version: 1,
  summary: "Customers want to query accepted behavior by AC.",
  source: "intercom",
  external_id: "conversation-123",
  external_url: "https://example.test/private/conversation-123",
  observed_at: "2026-07-29T12:00:00.000Z",
  payload: {
    requested_change: "Return direct acceptance-criterion evidence.",
    context: "A support workflow needs precise behavioral context.",
    priority_signal: "Repeated request",
  },
});
assert.equal(
  request.search_text,
  [
    "Customers want to query accepted behavior by AC.",
    "Return direct acceptance-criterion evidence.",
    "A support workflow needs precise behavioral context.",
    "Repeated request",
  ].join("\n")
);
assert.ok(!request.search_text.includes("https://"));

const sensitiveRequest = prepareObservation({
  kind: "request",
  schema_key: "request",
  schema_version: 1,
  summary:
    "Contact customer@example.test at +1 604-555-0199 about card 4111 1111 1111 1111.",
  source: "intercom",
  observed_at: "2026-07-29T12:00:00.000Z",
  payload: {
    requested_change:
      "Review https://private.example.test/ticket?token=secret and password=hunter2.",
    context: "Provider key sk-1234567890abcdef must stay local.",
  },
});
for (const sensitiveValue of [
  "customer@example.test",
  "604-555-0199",
  "4111 1111 1111 1111",
  "private.example.test",
  "hunter2",
  "sk-1234567890abcdef",
]) {
  assert.ok(!sensitiveRequest.search_text.includes(sensitiveValue));
}
assert.match(sensitiveRequest.search_text, /\[redacted-email\]/);
assert.match(sensitiveRequest.search_text, /\[redacted-credential\]/);

const bug = prepareObservation({
  kind: "bug",
  schema_key: "bug",
  schema_version: 1,
  summary: "A retired AC still appears active.",
  source: "github",
  observed_at: "2026-07-29T12:00:00.000Z",
  payload: {
    expected_behavior: "The AC is inactive.",
    actual_behavior: "The AC is shown as active.",
    reproduction: ["Sync once", "Remove the AC", "Sync again"],
    environment: "local integration",
  },
});
assert.match(bug.search_text, /Sync once\nRemove the AC\nSync again/);

const question = prepareObservation({
  kind: "question",
  schema_key: "question",
  schema_version: 1,
  summary: "Which lifecycle is authoritative?",
  source: "slack",
  observed_at: "2026-07-29T12:00:00.000Z",
  payload: {
    question: "Does repository YAML own production definitions?",
    context: "A maintainer is reconciling a branch.",
    audience: "engineering",
  },
});
assert.match(question.search_text, /repository YAML/);

assert.throws(
  () =>
    prepareObservation({
      kind: "request",
      schema_key: "request",
      schema_version: 1,
      summary: "Reject undeclared fields.",
      source: "test",
      observed_at: "2026-07-29T12:00:00.000Z",
      payload: {
        requested_change: "Keep intake flexible through versioned schemas.",
        raw_private_thread: "must not be accepted by request v1",
      },
    }),
  (error: unknown) => {
    assert.ok(error instanceof EvidenceValidationError);
    assert.match(error.message, /raw_private_thread/);
    assert.ok(!error.message.includes("must not be accepted"));
    return true;
  }
);

console.log("post-persistence matching");
let persisted = false;
const committed = {
  id: "00000000-0000-4000-8000-000000000101",
  kind: request.kind,
  schema_key: request.schema_key,
  schema_version: request.schema_version,
  summary: request.summary,
  source: request.source,
  external_id: request.external_id ?? null,
  external_url: request.external_url ?? null,
  observed_at: request.observed_at,
  recorded_at: "2026-07-29T12:00:01.000Z",
  search_text: request.search_text,
  supersedes_observation_id: null,
  outcome: "created" as const,
};
const failedMatch = await recordObservationThenMatch(
  request,
  {
    async recordObservation() {
      persisted = true;
      return committed;
    },
  } as never,
  {
    async matchObservation() {
      assert.equal(persisted, true);
      throw new Error("matcher unavailable");
    },
    async advisePlanningCreate() {
      return [];
    },
    async indexBacklogItem() {},
    async indexPlanningStory() {},
  }
);
assert.equal(persisted, true);
assert.equal(failedMatch.observation.id, committed.id);
assert.deepEqual(failedMatch.suggestions, []);
assert.match("matching_error" in failedMatch ? failedMatch.matching_error : "", /matcher unavailable/);

assert.throws(
  () =>
    prepareObservation({
      kind: "bug",
      schema_key: "request",
      schema_version: 1,
      summary: "Kinds and schemas must agree.",
      source: "test",
      observed_at: "2026-07-29T12:00:00.000Z",
      payload: {},
    }),
  /declares kind 'request'/i
);

assert.throws(
  () =>
    prepareObservation({
      kind: "question",
      schema_key: "question",
      schema_version: 1,
      summary: "🙂".repeat(1_001),
      source: "test",
      observed_at: "2026-07-29T12:00:00.000Z",
      payload: {},
    }),
  /4,000 UTF-8 bytes/i
);

assert.throws(
  () =>
    prepareObservation({
      kind: "request",
      schema_key: "request",
      schema_version: 1,
      summary: "Payload size is bounded.",
      source: "test",
      observed_at: "2026-07-29T12:00:00.000Z",
      payload: { context: "x".repeat(256 * 1024) },
    }),
  /256 KiB/i
);

console.log("backlog update indexing");
const indexedBacklogIds: string[] = [];
const updatedBacklog = {
  id: "00000000-0000-4000-8000-000000000201",
  stable_id: "BL-INDEX-001",
  title: "Keep changed planning records searchable",
  summary: "Re-index semantic text after a Backlog Item update.",
  stage: "planned" as const,
  revision: 1,
  superseded_by: null,
  created_at: "2026-07-29T12:00:00.000Z",
  updated_at: "2026-07-29T12:05:00.000Z",
};
setStore({
  async updateBacklogItem() {
    return { outcome: "applied" as const, item: updatedBacklog };
  },
} as never);
setSemanticMatcher({
  async matchObservation() {
    return [];
  },
  async advisePlanningCreate() {
    return [];
  },
  async indexBacklogItem(item) {
    indexedBacklogIds.push(item.id);
  },
  async indexPlanningStory() {},
});
const backlogServer = new McpServer({
  name: "backlog-index-test",
  version: "0.0.0",
});
registerBacklogItemTools(backlogServer);
const [backlogClientTransport, backlogServerTransport] =
  InMemoryTransport.createLinkedPair();
await backlogServer.connect(backlogServerTransport);
const backlogClient = new Client({
  name: "backlog-index-client",
  version: "0.0.0",
});
await backlogClient.connect(backlogClientTransport);
try {
  const updateResult = (await backlogClient.callTool({
    name: "update_backlog_item",
    arguments: {
      stable_id: updatedBacklog.stable_id,
      expected_revision: 0,
      title: updatedBacklog.title,
    },
  })) as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  };
  assert.equal(updateResult.isError, undefined);
  assert.equal(updateResult.structuredContent?.outcome, "applied");
  assert.deepEqual(indexedBacklogIds, [updatedBacklog.id]);
} finally {
  await backlogClient.close();
  await backlogServer.close();
  setSemanticMatcher(null);
}

console.log("evidence validation tests passed");
