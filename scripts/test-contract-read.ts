import assert from "node:assert/strict";
import {
  buildContractGraph,
  computeStoryCoverage,
  effectiveApplicability,
  summarizeFreshness,
  type ContractAcceptanceCriterionRecord,
  type ContractEvidenceLink,
  type ContractStoryRecord,
} from "../src/domain/contract-read-store.js";
import { FakeKnowledgeStore } from "../src/domain/testing/fake-knowledge-store.js";

function codeLink(
  relation: "implements" | "enforces" | "tests",
  path: string,
  scope: "direct" | "story_fallback" = "direct"
): ContractEvidenceLink {
  return {
    relation,
    scope,
    target: {
      kind: relation === "tests" ? "test" : "code",
      repository: "tieline",
      path,
      selector: null,
      framework_hint: null,
    },
    reviewed_content_hash: "a".repeat(64),
    freshness: "current",
  };
}

function helpLink(
  scope: "direct" | "story_fallback" = "direct"
): ContractEvidenceLink {
  return {
    relation: "documents",
    scope,
    target: {
      kind: "help",
      source: "intercom",
      external_id: "article-1",
      title: "Living contract",
      url: null,
    },
    reviewed_content_hash: null,
    freshness: "not_applicable",
  };
}

function criterion(
  stableId: string,
  directLinks: ContractEvidenceLink[]
): ContractAcceptanceCriterionRecord {
  return {
    id: stableId,
    stable_id: stableId,
    criterion: `${stableId} must remain observable.`,
    rationale: null,
    position: 0,
    active: true,
    authority: "repository",
    aliases: [],
    applies_to: null,
    effective_applies_to: {},
    scenarios: [],
    direct_links: directLinks,
    fallback_story_links: [],
    freshness: summarizeFreshness(directLinks),
    superseded_by: null,
  };
}

console.log("AC-centered coverage and applicability");

const acOne = criterion("STORY-001-AC1", [
  codeLink("implements", "src/one.ts"),
  codeLink("tests", "scripts/one.test.ts"),
  helpLink(),
]);
const acTwo = criterion("STORY-001-AC2", [
  codeLink("tests", "scripts/two.test.ts"),
]);
const storyFallback = [
  codeLink("implements", "src/fallback.ts", "story_fallback"),
  helpLink("story_fallback"),
];

assert.deepEqual(
  computeStoryCoverage("repository", [acOne, acTwo]),
  {
    implementation: "partial",
    test: "complete",
    help: "partial",
  },
  "only direct AC links count; Story fallback links do not fill AC coverage"
);
assert.deepEqual(computeStoryCoverage("repository", [
  criterion("STORY-002-AC1", []),
]), {
  implementation: "none",
  test: "none",
  help: "none",
});
assert.deepEqual(computeStoryCoverage("planning", [acOne]), {
  implementation: "not_applicable",
  test: "not_applicable",
  help: "not_applicable",
});

assert.deepEqual(
  effectiveApplicability(
    { editions: ["cloud"], regions: ["ca", "us"] },
    { regions: ["ca"] },
    { roles: ["admin"] }
  ),
  { editions: ["cloud"], regions: ["ca"], roles: ["admin"] }
);
assert.equal(summarizeFreshness([]), "not_applicable");
assert.equal(
  summarizeFreshness([
    codeLink("tests", "scripts/current.test.ts"),
    { ...codeLink("tests", "scripts/stale.test.ts"), freshness: "stale" },
  ]),
  "stale"
);
assert.equal(
  summarizeFreshness([
    { ...codeLink("tests", "scripts/unknown.test.ts"), freshness: "unknown" },
    helpLink(),
  ]),
  "unknown"
);

console.log("fake AC graph traversal");

const story: ContractStoryRecord = {
  id: "story-id",
  repository: "tieline",
  repository_commit: "abc123",
  capability: {
    stable_id: "CONTRACT",
    name: "Living contract",
    description: "Accepted product behavior.",
  },
  stable_id: "STORY-001",
  title: "Read accepted behavior",
  actor: "maintainer",
  goal: "inspect an AC-centered graph",
  benefit: "the semantic contract stays explainable",
  rendered_story:
    "As a maintainer, I want to inspect an AC-centered graph, so that the semantic contract stays explainable.",
  lifecycle: "production",
  authority: "repository",
  revision: 1,
  aliases: [],
  applies_to: null,
  effective_applies_to: {},
  motivated_by: [],
  direct_links: storyFallback,
  acceptance_criteria: [
    {
      ...acOne,
      fallback_story_links: storyFallback,
      superseded_by: { stable_id: "STORY-001-AC2" },
    },
    { ...acTwo, position: 1, fallback_story_links: storyFallback },
  ],
  footprint: {
    code_paths: [
      "scripts/one.test.ts",
      "scripts/two.test.ts",
      "src/fallback.ts",
      "src/one.ts",
    ],
    help: [{ source: "intercom", external_id: "article-1" }],
  },
  coverage: {
    implementation: "partial",
    test: "complete",
    help: "partial",
  },
  freshness: "current",
  superseded_by: null,
};

const graph = buildContractGraph([story]);
assert.ok(
  graph.edges.some(
    (edge) =>
      edge.source === "ac:tieline:STORY-001-AC1" &&
      edge.relation === "tests"
  )
);
assert.ok(
  graph.edges.some(
    (edge) =>
      edge.source === "ac:tieline:STORY-001-AC1" &&
      edge.relation === "documents"
  )
);
assert.ok(
  graph.edges.some(
    (edge) =>
      edge.source === "ac:tieline:STORY-001-AC1" &&
      edge.target === "ac:tieline:STORY-001-AC2" &&
      edge.relation === "superseded_by"
  )
);

const fake = new FakeKnowledgeStore({ contractStories: [story] });
const fetched = await fake.getAcceptanceCriterion({
  repository: "tieline",
  stableId: "STORY-001-AC1",
});
assert.equal(fetched?.story.stable_id, "STORY-001");
assert.equal(fetched?.criterion.direct_links[0]?.scope, "direct");
const fakeGraph = await fake.contractGraph({ repositories: ["tieline"] });
assert.deepEqual(fakeGraph, graph);

console.log("contract read tests passed");
