import {
  assertEmbeddingDimension,
  fetchWithRetry,
  mapWithConcurrency,
  safeResponseText,
  OpenAIEmbedder,
} from "../src/embeddings.js";
import {
  contractEmbeddingDocuments,
  documentsNeedingEmbedding,
  observationEmbeddingDocument,
} from "../src/derived/embedding-documents.js";
import type { ContractStoryRecord } from "../src/domain/contract-read-store.js";
import type { ObservationRecord } from "../src/domain/evidence-write-store.js";
import { prepareObservation } from "../src/domain/evidence-write-store.js";
import { check, report } from "./lib/harness.js";

async function withFetch(
  implementation: typeof fetch,
  run: () => Promise<void>
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

async function main(): Promise<void> {
  console.log("retry policy");
  let calls = 0;
  const sleeps: number[] = [];
  await withFetch(async () => {
    calls++;
    return calls === 1
      ? new Response("rate limited", { status: 429, headers: { "retry-after": "1" } })
      : new Response("ok", { status: 200 });
  }, async () => {
    const response = await fetchWithRetry("https://example.invalid", {}, {
      sleep: async (ms) => void sleeps.push(ms),
      random: () => 0,
    });
    check("429 retries then succeeds", response.ok && calls === 2);
    check("Retry-After is honored and bounded", sleeps[0] === 1000, String(sleeps[0]));
  });

  calls = 0;
  await withFetch(async () => {
    calls++;
    return new Response("bad request", { status: 400 });
  }, async () => {
    const response = await fetchWithRetry("https://example.invalid", {});
    check("400 is not retried", response.status === 400 && calls === 1);
  });

  calls = 0;
  await withFetch(async () => {
    calls++;
    if (calls < 3) throw new TypeError("network unavailable");
    return new Response("ok", { status: 200 });
  }, async () => {
    const response = await fetchWithRetry("https://example.invalid", {}, { sleep: async () => {} });
    check("network failures retry within bound", response.ok && calls === 3);
  });

  console.log("timeouts + dimensions");
  await withFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  }), async () => {
    let timedOut = false;
    try {
      await fetchWithRetry("https://example.invalid", {}, {
        timeoutMs: 5,
        maxAttempts: 1,
      });
    } catch {
      timedOut = true;
    }
    check("hung request is aborted", timedOut);
  });

  check("384 dimensions accepted", assertEmbeddingDimension(new Array(384).fill(0)).length === 384);
  let wrongDimensionRejected = false;
  try {
    assertEmbeddingDimension(new Array(383).fill(0));
  } catch {
    wrongDimensionRejected = true;
  }
  check("wrong dimensions rejected", wrongDimensionRejected);

  const secret = "test-secret-token";
  const safeText = await safeResponseText(
    new Response(`${secret}:${"x".repeat(1200)}`),
    [secret]
  );
  check("provider error body redacts credentials", !safeText.includes(secret) && safeText.includes("[REDACTED]"));
  check("provider error body is capped", safeText.length <= 1000);

  console.log("bounded concurrency");
  let active = 0;
  let maxActive = 0;
  const values = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (value) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
    return value * 2;
  });
  check("concurrency ceiling respected", maxActive === 2, String(maxActive));
  check("result order preserved", JSON.stringify(values) === JSON.stringify([2, 4, 6, 8, 10, 12]));

  console.log("hierarchical canonical documents");
  const story: ContractStoryRecord = {
    id: "00000000-0000-4000-8000-000000000001",
    repository: "tieline",
    repository_commit: "secret-commit",
    capability: {
      stable_id: "CAP-SEARCH",
      name: "Semantic search",
      description: "Find organizational knowledge",
    },
    stable_id: "US-SEARCH-001",
    title: "Find relevant behavior",
    actor: "support teammate",
    goal: "find the behavior related to a customer report",
    benefit: "I can answer with production context",
    rendered_story:
      "As a support teammate, I want to find the behavior related to a customer report, so that I can answer with production context.",
    lifecycle: "production",
    authority: "repository",
    revision: 3,
    aliases: ["Locate a matching feature"],
    applies_to: null,
    effective_applies_to: { plan: ["pro"] },
    motivated_by: [],
    direct_links: [],
    acceptance_criteria: [
      {
        id: "00000000-0000-4000-8000-000000000002",
        stable_id: "AC-SEARCH-001",
        criterion: "Search results must identify their matched semantic level",
        rationale: "Callers need to distinguish broad intent from edge cases",
        position: 0,
        active: true,
        authority: "repository",
        aliases: ["Expose match granularity"],
        applies_to: null,
        effective_applies_to: { plan: ["pro"] },
        scenarios: [
          {
            id: "00000000-0000-4000-8000-000000000003",
            stable_id: "SC-SEARCH-001",
            name: "Specific edge case",
            given: "a query matches a scenario",
            when: "results are returned",
            then: "the parent AC and Story are included",
            position: 0,
            active: true,
          },
        ],
        direct_links: [],
        fallback_story_links: [],
        freshness: "stale",
        superseded_by: null,
      },
      {
        id: "00000000-0000-4000-8000-000000000004",
        stable_id: "AC-SEARCH-002",
        criterion: "Profile filters must narrow candidate retrieval",
        rationale: null,
        position: 1,
        active: true,
        authority: "repository",
        aliases: [],
        applies_to: null,
        effective_applies_to: {},
        scenarios: [],
        direct_links: [],
        fallback_story_links: [],
        freshness: "current",
        superseded_by: null,
      },
    ],
    footprint: { code_paths: ["src/secret.ts"], help: [] },
    coverage: { implementation: "complete", test: "partial", help: "none" },
    freshness: "stale",
    superseded_by: null,
  };
  const docs = contractEmbeddingDocuments([story]);
  check("Story, AC, and Scenario each receive a document", docs.length === 4);
  const allText = docs.map((entry) => entry.canonical_text).join("\n");
  check(
    "canonical text excludes retrieval metadata and locators",
    !allText.includes("US-SEARCH-001") &&
      !allText.includes("Lifecycle:") &&
      !allText.includes("Authority:") &&
      !allText.includes("stale") &&
      !allText.includes("complete") &&
      !allText.includes("src/secret.ts")
  );
  check(
    "canonical text preserves aliases, rationale, and applicability",
    allText.includes("Expose match granularity") &&
      allText.includes("Callers need to distinguish") &&
      allText.includes("plan: pro")
  );
  const previous = new Map(
    docs.map((entry) => [
      `${entry.entity_kind}:${entry.entity_id}:${entry.document_kind}`,
      entry.source_text_hash,
    ])
  );
  const metadataOnly: ContractStoryRecord = {
    ...story,
    lifecycle: "retired",
    freshness: "current",
  };
  check(
    "metadata-only changes do not require re-embedding",
    documentsNeedingEmbedding(
      contractEmbeddingDocuments([metadataOnly]),
      previous
    ).length === 0
  );
  const retiredDocuments = contractEmbeddingDocuments([metadataOnly]);
  check(
    "retired Story descendants are inactive retrieval documents",
    retiredDocuments.every(
      (entry) => entry.filter_metadata.active === false
    )
  );
  const changedCriterion: ContractStoryRecord = {
    ...story,
    acceptance_criteria: story.acceptance_criteria.map((criterion, index) =>
      index === 0
        ? { ...criterion, criterion: `${criterion.criterion} clearly` }
        : criterion
    ),
  };
  const changed = documentsNeedingEmbedding(
    contractEmbeddingDocuments([changedCriterion]),
    previous
  );
  check(
    "one AC change regenerates that AC and its Scenario only",
    changed.length === 2 &&
      changed.some((entry) => entry.document_kind === "acceptance_criterion") &&
      changed.some((entry) => entry.document_kind === "scenario")
  );

  const preparedSensitiveObservation = prepareObservation({
    kind: "bug",
    schema_key: "bug",
    schema_version: 1,
    summary: "Customer customer@example.test cannot find results",
    source: "intercom",
    external_url: "https://secret.invalid/ticket",
    observed_at: "2026-07-29T00:00:00.000Z",
    payload: {
      expected_behavior: "Results appear without token=provider-secret-value.",
      actual_behavior: "Call +1 604-555-0199 for details.",
    },
  });
  const observation: ObservationRecord = {
    ...preparedSensitiveObservation,
    id: "00000000-0000-4000-8000-000000000005",
    external_id: "ticket-secret",
    recorded_at: "2026-07-29T00:00:01.000Z",
    outcome: "created",
  };
  const observationDoc = observationEmbeddingDocument(observation);
  check(
    "observation documents contain only sanitized search text",
    observationDoc.canonical_text.includes("[redacted-email]") &&
      observationDoc.canonical_text.includes("[redacted-phone]") &&
      observationDoc.canonical_text.includes("[redacted-credential]") &&
      !observationDoc.canonical_text.includes("ticket-secret") &&
      !observationDoc.canonical_text.includes("secret.invalid") &&
      !observationDoc.canonical_text.includes("customer@example.test") &&
      !observationDoc.canonical_text.includes("604-555-0199") &&
      !observationDoc.canonical_text.includes("provider-secret-value")
  );
  let remoteBody = "";
  await withFetch(async (_url, init) => {
    remoteBody = String(init?.body ?? "");
    return Response.json({
      data: [{ embedding: new Array(384).fill(0.01) }],
    });
  }, async () => {
    const remote = new OpenAIEmbedder(
      384,
      "https://embeddings.invalid/v1",
      "test-model",
      "provider-secret",
      true
    );
    await remote.embed(observationDoc.canonical_text);
  });
  check(
    "remote request contains canonical text and excludes raw metadata",
    remoteBody.includes(observationDoc.canonical_text) &&
      !remoteBody.includes("ticket-secret") &&
      !remoteBody.includes("secret.invalid") &&
      !remoteBody.includes("customer@example.test") &&
      !remoteBody.includes("604-555-0199") &&
      !remoteBody.includes("provider-secret-value") &&
      !remoteBody.includes("provider-secret")
  );

  report();
}

void main();
