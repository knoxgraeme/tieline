import assert from "node:assert/strict";
import {
  groupSemanticHitsAroundAcceptanceCriteria,
  rankSemanticDocuments,
} from "../src/ranking.js";
import { narrowSemanticFilters } from "../src/adapters/postgres/semantic-repository.js";
import { parseRetrievalProfileDefinition } from "../src/adapters/postgres/profile-repository.js";
import {
  createBacklogItemSchema,
  createPlanningStorySchema,
  searchKnowledgeSchema,
} from "../src/schemas.js";

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ok  - ${name}`);
}

console.log("hierarchical semantic ranking");

test("applicability breaks a close semantic tie", () => {
  const ranked = rankSemanticDocuments([
    {
      document_id: "inapplicable",
      entity_kind: "acceptance_criterion",
      entity_id: "ac-1",
      canonical_text: "inapplicable AC",
      matched_level: "acceptance_criterion",
      acceptance_criterion_id: "ac-1",
      vector_score: 0.9,
      lexical_score: 0.5,
      applicable: false,
      metadata: {},
    },
    {
      document_id: "applicable",
      entity_kind: "acceptance_criterion",
      entity_id: "ac-2",
      canonical_text: "applicable AC",
      matched_level: "acceptance_criterion",
      acceptance_criterion_id: "ac-2",
      vector_score: 0.87,
      lexical_score: 0.5,
      applicable: true,
      metadata: {},
    },
  ]);
  assert.equal(ranked[0]?.document_id, "applicable");
});

test("artifact and graph context break a close semantic tie", () => {
  const ranked = rankSemanticDocuments([
    {
      document_id: "semantic-only",
      entity_kind: "acceptance_criterion",
      entity_id: "ac-semantic",
      canonical_text: "slightly stronger semantic match",
      matched_level: "acceptance_criterion",
      vector_score: 0.83,
      lexical_score: 0.5,
      artifact_overlap: 0,
      graph_proximity: 0,
      metadata: {},
    },
    {
      document_id: "contextual",
      entity_kind: "acceptance_criterion",
      entity_id: "ac-contextual",
      canonical_text: "contextually grounded match",
      matched_level: "acceptance_criterion",
      vector_score: 0.8,
      lexical_score: 0.5,
      artifact_overlap: 1,
      graph_proximity: 0.75,
      metadata: {},
    },
  ]);
  assert.equal(ranked[0]?.document_id, "contextual");
  assert.equal(ranked[0]?.features.artifact, 1);
  assert.equal(ranked[0]?.features.graph, 0.75);
});

test("RRF rewards candidates supported by both lexical and vector signals", () => {
  const ranked = rankSemanticDocuments([
    {
      document_id: "consistent",
      entity_kind: "acceptance_criterion",
      entity_id: "ac-consistent",
      canonical_text: "consistent across retrieval signals",
      matched_level: "acceptance_criterion",
      acceptance_criterion_id: "ac-consistent",
      vector_score: 0.8,
      lexical_score: 0.9,
      metadata: {},
    },
    {
      document_id: "vector-only",
      entity_kind: "acceptance_criterion",
      entity_id: "ac-vector",
      canonical_text: "best vector only",
      matched_level: "acceptance_criterion",
      acceptance_criterion_id: "ac-vector",
      vector_score: 0.9,
      lexical_score: 0,
      metadata: {},
    },
  ]);
  assert.equal(ranked[0]?.document_id, "consistent");
  assert.ok(ranked[0]?.features.rrf > 0);
  assert.match(ranked[0]?.why.join(" ") ?? "", /vector.*lexical/i);
});

test("lexical-only candidates remain useful without an embedding", () => {
  const ranked = rankSemanticDocuments([
    {
      document_id: "lexical",
      entity_kind: "acceptance_criterion",
      entity_id: "ac-lexical",
      canonical_text: "identifier-only match",
      matched_level: "acceptance_criterion",
      acceptance_criterion_id: "ac-lexical",
      vector_score: 0,
      lexical_score: 0.8,
      metadata: {},
    },
  ]);
  assert.ok((ranked[0]?.score ?? 0) > 0);
  assert.equal(ranked[0]?.features.vector, 0);
  assert.match(ranked[0]?.why.join(" ") ?? "", /lexical/i);
});

test("Scenario and AC hits collapse around the same AC", () => {
  const grouped = groupSemanticHitsAroundAcceptanceCriteria(
    rankSemanticDocuments([
      {
        document_id: "ac",
        entity_kind: "acceptance_criterion",
        entity_id: "ac-3",
        canonical_text: "acceptance criterion",
        matched_level: "acceptance_criterion",
        acceptance_criterion_id: "ac-3",
        vector_score: 0.8,
        lexical_score: 0.4,
        metadata: {},
      },
      {
        document_id: "scenario",
        entity_kind: "scenario",
        entity_id: "scenario-3",
        canonical_text: "scenario",
        matched_level: "scenario",
        acceptance_criterion_id: "ac-3",
        vector_score: 0.95,
        lexical_score: 0.6,
        metadata: {},
      },
    ])
  );
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0]?.matched_level, "scenario");
});

test("caller filters can narrow but not broaden a profile", () => {
  const narrowed = narrowSemanticFilters(
    {
      authorities: ["repository"],
      lifecycles: ["production"],
      include: ["story", "acceptance_criterion"],
      include_inactive: false,
    },
    {
      authorities: ["repository", "planning"],
      document_kinds: ["acceptance_criterion", "observation"],
      include_inactive: true,
    }
  );
  assert.deepEqual(narrowed.authorities, ["repository"]);
  assert.deepEqual(narrowed.document_kinds, ["acceptance_criterion"]);
  assert.equal(narrowed.include_inactive, false);

  const allowedInactive = narrowSemanticFilters(
    { include_inactive: true }
  );
  assert.equal(allowedInactive.include_inactive, true);
  assert.equal(
    narrowSemanticFilters(
      { include_inactive: true },
      { include_inactive: false }
    ).include_inactive,
    false
  );
  assert.equal(
    searchKnowledgeSchema.parse({
      query: "production behavior",
      profile: "engineering",
    }).include_inactive,
    undefined
  );
});

test("empty retrieval filters and profile predicates are rejected", () => {
  assert.equal(
    searchKnowledgeSchema.safeParse({
      query: "production behavior",
      profile: "support",
      authority: [],
    }).success,
    false
  );
  assert.throws(
    () => parseRetrievalProfileDefinition({ authorities: [] }),
    /array/i
  );
  assert.equal(
    parseRetrievalProfileDefinition({ include_inactive: false })
      .include_inactive,
    false
  );
});

test("knowledge search accepts bounded typed retrieval context", () => {
  const parsed = searchKnowledgeSchema.parse({
    query: "find the affected production behavior",
    profile: "engineering",
    context: {
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
        {
          kind: "help",
          source: "intercom",
          external_id: "article-123",
        },
      ],
    },
  });
  assert.equal(parsed.context?.artifacts?.length, 2);
  assert.equal(
    searchKnowledgeSchema.safeParse({
      query: "find the affected production behavior",
      profile: "engineering",
      context: {},
    }).success,
    false
  );
  assert.equal(
    searchKnowledgeSchema.safeParse({
      query: "find the affected production behavior",
      profile: "engineering",
      context: {
        artifacts: Array.from({ length: 51 }, (_, index) => ({
          kind: "code",
          repository: "tieline",
          path: `src/context-${index}.ts`,
        })),
      },
    }).success,
    false
  );
});

test("create schemas accept machine candidate selection tokens", () => {
  const token = "candidate:00000000-0000-4000-8000-000000000001";
  assert.equal(
    createBacklogItemSchema.safeParse({
      title: "Reuse related planning work",
      summary: "Select the machine candidate instead of creating a duplicate.",
      selected_suggestion_id: token,
    }).success,
    true
  );
  assert.equal(
    createPlanningStorySchema.safeParse({
      repository: "tieline",
      title: "Reuse related behavior",
      selected_suggestion_id: token,
    }).success,
    true
  );
});

console.log(`\n${passed} passed, 0 failed`);
