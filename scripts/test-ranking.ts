import assert from "node:assert/strict";
import {
  SEMANTIC_MAGNITUDE_FLOOR,
  clearsSemanticMagnitudeFloor,
  groupSemanticHitsAroundAcceptanceCriteria,
  rankSemanticDocuments,
} from "../src/ranking.js";
import {
  DefaultSemanticMatcher,
  installSemanticAdvisors,
  isPresentableSemanticMatch,
  setSemanticMatcher,
  type SemanticMatcherRepository,
} from "../src/semantic-matching.js";
import {
  adviseBacklogCreate,
  setBacklogCreateAdvisor,
} from "../src/backlog-advisor.js";
import { getEmbedder, setEmbedder } from "../src/embeddings.js";
import { narrowSemanticFilters } from "../src/adapters/postgres/semantic-repository.js";
import { parseRetrievalProfileDefinition } from "../src/adapters/postgres/profile-repository.js";
import {
  createBacklogItemSchema,
  createPlanningStorySchema,
  findRelatedShape,
  searchKnowledgeSchema,
} from "../src/schemas.js";
import { report, test } from "./lib/harness.js";

console.log("hierarchical semantic ranking");

await test("applicability breaks a close semantic tie", () => {
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

await test("artifact and graph context break a close semantic tie", () => {
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

await test("RRF rewards candidates supported by both lexical and vector signals", () => {
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

await test("lexical-only candidates remain useful without an embedding", () => {
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

await test(
  "planning advice admits a strong lexical-only candidate without an embedding",
  async () => {
    const previousEmbedder = getEmbedder();
    try {
      setEmbedder({
        provider: "hash",
        dim: 384,
        async embed() {
          throw new Error("embedding unavailable");
        },
      });
      const repository: SemanticMatcherRepository = {
        async resolveRetrievalProfile() {
          return { key: "discovery", version: 1, definition: {} };
        },
        async searchSemantic(input) {
          assert.equal(input.embedding, undefined);
          return [
            {
              document_id: "lexical",
              entity_kind: "acceptance_criterion",
              entity_id: "ac-lexical",
              canonical_text: "identifier-only match",
              matched_level: "acceptance_criterion",
              acceptance_criterion_id: "ac-lexical",
              vector_score: 0,
              lexical_score: 0.8,
              alias_match: false,
              artifact_overlap: 0,
              graph_proximity: 0,
              applicable: true,
              metadata: {},
            },
          ];
        },
        async upsertEmbeddingDocument() {
          throw new Error("not used by planning advice");
        },
        async saveAttributionSuggestion() {
          throw new Error("not used by planning advice");
        },
      };
      const matcher = new DefaultSemanticMatcher(repository);

      const candidates = await matcher.advisePlanningCreate({
        title: "Identifier-only match",
        summary: "Find the acceptance criterion through full-text search.",
      });

      assert.equal(candidates.length, 1);
      assert.equal(candidates[0]?.target_id, "ac-lexical");
      assert.equal(candidates[0]?.features.vector, 0);
      assert.deepEqual(candidates[0]?.admitted_by, ["lexical"]);

      setSemanticMatcher(matcher);
      installSemanticAdvisors();
      const advice = await adviseBacklogCreate({
        title: "Identifier-only match",
        summary: "Find the acceptance criterion through full-text search.",
      });
      assert.deepEqual(advice?.candidates[0]?.admitted_by, ["lexical"]);
      assert.equal(advice?.candidates[0]?.features.lexical, 0.8);
      assert.match(advice?.candidates[0]?.reason ?? "", /admitted by lexical/);
    } finally {
      setBacklogCreateAdvisor(null);
      setSemanticMatcher(null);
      setEmbedder(previousEmbedder);
    }
  }
);

await test(
  "an admissible lexical sibling survives same-criterion grouping",
  async () => {
    const previousEmbedder = getEmbedder();
    try {
      setEmbedder({
        provider: "hash",
        dim: 384,
        async embed() {
          return new Array<number>(384).fill(0);
        },
      });
      const repository: SemanticMatcherRepository = {
        async resolveRetrievalProfile() {
          return { key: "discovery", version: 1, definition: {} };
        },
        async searchSemantic(input) {
          assert.equal(input.embedding?.length, 384);
          return [
            {
              document_id: "weak-scenario",
              entity_kind: "scenario",
              entity_id: "scenario-weak",
              canonical_text: "two weak ranking signals",
              matched_level: "scenario",
              acceptance_criterion_id: "ac-shared",
              acceptance_criterion_stable_id: "MATCHING-001-AC4",
              vector_score: 0.49,
              lexical_score: 0.49,
              alias_match: false,
              artifact_overlap: 0,
              graph_proximity: 0,
              applicable: true,
              metadata: {},
            },
            {
              document_id: "strong-criterion",
              entity_kind: "acceptance_criterion",
              entity_id: "ac-shared",
              canonical_text: "strong full-text match",
              matched_level: "acceptance_criterion",
              acceptance_criterion_id: "ac-shared",
              acceptance_criterion_stable_id: "MATCHING-001-AC4",
              vector_score: 0,
              lexical_score: 0.8,
              alias_match: false,
              artifact_overlap: 0,
              graph_proximity: 0,
              applicable: true,
              metadata: {},
            },
          ];
        },
        async upsertEmbeddingDocument(document) {
          return {
            embedded: false,
            document_id: `${document.entity_kind}:${document.entity_id}`,
            embedding_status: "unavailable",
          };
        },
        async saveAttributionSuggestion(input) {
          return {
            id: `suggestion:${input.target_id}`,
            source_kind: input.source_kind,
            source_id: input.source_id,
            target_kind: input.target_kind,
            target_id: input.target_id,
            state: input.state,
            method: input.method,
            score: input.score ?? null,
            rationale: input.rationale ?? {},
          };
        },
      };
      const matcher = new DefaultSemanticMatcher(repository);

      const matches = await matcher.matchObservation({
        id: "observation-1",
        kind: "request",
        schema_key: "request",
        schema_version: 1,
        summary: "Find the acceptance criterion through full-text search.",
        source: "test",
        external_id: null,
        external_url: null,
        observed_at: "2026-08-05T00:00:00.000Z",
        recorded_at: "2026-08-05T00:00:00.000Z",
        search_text: "strong full-text match",
        supersedes_observation_id: null,
        outcome: "created",
      });

      assert.equal(matches.length, 1);
      assert.equal(matches[0]?.target_id, "ac-shared");
      assert.equal(matches[0]?.features.lexical, 0.8);
    } finally {
      setEmbedder(previousEmbedder);
    }
  }
);

await test("Scenario and AC hits collapse around the same AC", () => {
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

await test("a weak top-ranked candidate is withheld by raw magnitude", () => {
  const [weak] = rankSemanticDocuments([
    {
      document_id: "weak",
      entity_kind: "acceptance_criterion",
      entity_id: "ac-weak",
      canonical_text: "loosely related behavior",
      matched_level: "acceptance_criterion",
      acceptance_criterion_id: "ac-weak",
      vector_score: 0.3,
      lexical_score: 0.2,
      metadata: {},
    },
  ]);
  assert.equal(clearsSemanticMagnitudeFloor(weak!.features), false);
  assert.equal(isPresentableSemanticMatch(weak!), false);
});

await test("a weak candidate stays withheld when ranked behind stronger ones", () => {
  const ranked = rankSemanticDocuments([
    {
      document_id: "strong-a",
      entity_kind: "acceptance_criterion",
      entity_id: "ac-strong-a",
      canonical_text: "clearly the same behavior",
      matched_level: "acceptance_criterion",
      acceptance_criterion_id: "ac-strong-a",
      vector_score: 0.92,
      lexical_score: 0.9,
      metadata: {},
    },
    {
      document_id: "strong-b",
      entity_kind: "acceptance_criterion",
      entity_id: "ac-strong-b",
      canonical_text: "nearly the same behavior",
      matched_level: "acceptance_criterion",
      acceptance_criterion_id: "ac-strong-b",
      vector_score: 0.88,
      lexical_score: 0.85,
      metadata: {},
    },
    {
      document_id: "weak",
      entity_kind: "acceptance_criterion",
      entity_id: "ac-weak",
      canonical_text: "loosely related behavior",
      matched_level: "acceptance_criterion",
      acceptance_criterion_id: "ac-weak",
      vector_score: 0.3,
      lexical_score: 0.2,
      metadata: {},
    },
  ]);
  const presentable = ranked.filter(isPresentableSemanticMatch);
  // The blended score barely moves between "only option" and "clearly worst".
  assert.deepEqual(
    presentable.map((hit) => hit.document_id),
    ["strong-a", "strong-b"]
  );
});

await test("a strong candidate clears raw-magnitude admission", () => {
  const [strong] = rankSemanticDocuments([
    {
      document_id: "strong",
      entity_kind: "acceptance_criterion",
      entity_id: "ac-strong",
      canonical_text: "the same behavior in other words",
      matched_level: "acceptance_criterion",
      acceptance_criterion_id: "ac-strong",
      vector_score: 0.85,
      lexical_score: 0.7,
      metadata: {},
    },
  ]);
  assert.ok(strong!.features.vector >= SEMANTIC_MAGNITUDE_FLOOR.vector);
  assert.equal(isPresentableSemanticMatch(strong!), true);
});

await test("an exact alias match survives a low similarity score", () => {
  const ranked = rankSemanticDocuments([
    {
      document_id: "strong",
      entity_kind: "acceptance_criterion",
      entity_id: "ac-strong",
      canonical_text: "the same behavior in other words",
      matched_level: "acceptance_criterion",
      acceptance_criterion_id: "ac-strong",
      vector_score: 0.9,
      lexical_score: 0.85,
      metadata: {},
    },
    {
      document_id: "alias",
      entity_kind: "acceptance_criterion",
      entity_id: "ac-alias",
      canonical_text: "recorded under an alternate name",
      matched_level: "acceptance_criterion",
      acceptance_criterion_id: "ac-alias",
      vector_score: 0.2,
      lexical_score: 0.1,
      alias_match: true,
      metadata: {},
    },
  ]);
  const alias = ranked.find((hit) => hit.document_id === "alias")!;
  // Deterministic identifier match, so magnitude never disqualifies it.
  assert.ok(alias.features.vector < SEMANTIC_MAGNITUDE_FLOOR.vector);
  assert.ok(alias.features.lexical < SEMANTIC_MAGNITUDE_FLOOR.lexical);
  assert.equal(isPresentableSemanticMatch(alias), true);
  assert.match(alias.why.join(" "), /alias/i);
});

await test("the magnitude floor removes candidates without reordering survivors", () => {
  const ranked = rankSemanticDocuments([
    {
      document_id: "weak",
      entity_kind: "acceptance_criterion",
      entity_id: "ac-weak",
      canonical_text: "loosely related behavior",
      matched_level: "acceptance_criterion",
      acceptance_criterion_id: "ac-weak",
      vector_score: 0.3,
      lexical_score: 0.2,
      metadata: {},
    },
    {
      document_id: "mid",
      entity_kind: "acceptance_criterion",
      entity_id: "ac-mid",
      canonical_text: "related behavior",
      matched_level: "acceptance_criterion",
      acceptance_criterion_id: "ac-mid",
      vector_score: 0.62,
      lexical_score: 0.4,
      metadata: {},
    },
    {
      document_id: "strong",
      entity_kind: "acceptance_criterion",
      entity_id: "ac-strong",
      canonical_text: "the same behavior in other words",
      matched_level: "acceptance_criterion",
      acceptance_criterion_id: "ac-strong",
      vector_score: 0.9,
      lexical_score: 0.85,
      metadata: {},
    },
    {
      document_id: "alias",
      entity_kind: "acceptance_criterion",
      entity_id: "ac-alias",
      canonical_text: "recorded under an alternate name",
      matched_level: "acceptance_criterion",
      acceptance_criterion_id: "ac-alias",
      vector_score: 0.2,
      lexical_score: 0.1,
      alias_match: true,
      metadata: {},
    },
  ]);
  const order = ranked.map((hit) => hit.document_id);
  const presentable = ranked
    .filter(isPresentableSemanticMatch)
    .map((hit) => hit.document_id);
  assert.deepEqual(presentable, ["strong", "mid", "alias"]);
  // Filtering is a subsequence of the ranked order: nothing is re-sorted.
  assert.deepEqual(
    order.filter((id) => presentable.includes(id)),
    presentable
  );
});

await test("caller filters can narrow but not broaden a profile", () => {
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

await test("find related defaults to the all scope", () => {
  assert.equal(findRelatedShape.profile.parse(undefined), "all");
});

await test("empty retrieval filters and profile predicates are rejected", () => {
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

await test("knowledge search accepts bounded typed retrieval context", () => {
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

await test("create schemas accept machine candidate selection tokens", () => {
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

report();
