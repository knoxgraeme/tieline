import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  IntentContextError,
  lookupAcceptanceCriterionIntentContext,
  lookupAssetIntentContext,
} from "../src/contract/intent-context.js";
import { compileContractManifest } from "../src/contract/manifest.js";
import { buildContractIntentIndex } from "../src/contract/reconciliation.js";
import { report, test } from "./lib/harness.js";

const REPOSITORY = "intent-context-fixture";

const SPEC = `version: 1
capability:
  key: INTENT
  name: Precise intent context
  description: Exact asset and criterion reads expose bounded accepted intent.
  applies_to:
    editions: [cloud]
  stories:
    - key: INTENT-001
      title: Inspect an intent neighborhood
      actor: implementing agent
      goal: inspect accepted behavior from an exact locator
      benefit: changes retain their contract coupling
      lifecycle: production
      applies_to:
        regions: [ca]
      links:
        - relation: implements
          provenance: authored
          target:
            kind: code
            repository: intent-context-fixture
            path: src/story.ts
            selector: function:storyFeature
      acceptance_criteria:
        - key: INTENT-001-AC1
          criterion: Tieline must return exact and file-level claims for one selector.
          rationale: A symbol query must not inherit claims for another symbol.
          applies_to:
            roles: [maintainer]
          scenarios:
            - name: Exact selector
              given: Two symbols share one source file.
              when: One exact selector is queried.
              then: The other selector is excluded.
          links:
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: intent-context-fixture
                path: src/shared.ts
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: intent-context-fixture
                path: src/shared.ts
                selector: function:first
            - relation: enforces
              provenance: inferred
              target:
                kind: code
                repository: intent-context-fixture
                path: src/shared.ts
                selector: function:first
            - relation: tests
              provenance: authored
              target:
                kind: test
                repository: intent-context-fixture
                path: test/intent.test.ts
                selector: function:firstBehavior
                framework_hint: node-assert
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: intent-context-fixture
                path: src/unsupported.rb
                selector: class:UnsupportedFeature
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: intent-context-fixture
                path: src/missing.ts
                selector: function:missingFeature
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: another-repository
                path: src/external.ts
                selector: function:externalFeature
        - key: INTENT-001-AC2
          criterion: Tieline must preserve every selector in a path-only result.
          links:
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: intent-context-fixture
                path: src/shared.ts
                selector: function:second
            - relation: tests
              provenance: authored
              target:
                kind: test
                repository: intent-context-fixture
                path: test/intent.test.ts
                selector: function:secondBehavior
                framework_hint: node-assert
`;

function createFixture() {
  const root = mkdtempSync(resolve(tmpdir(), "tieline-intent-context-"));
  mkdirSync(resolve(root, ".tieline/spec"), { recursive: true });
  mkdirSync(resolve(root, "src"), { recursive: true });
  mkdirSync(resolve(root, "test"), { recursive: true });
  writeFileSync(resolve(root, ".tieline/spec/intent.yaml"), SPEC);
  writeFileSync(
    resolve(root, "src/shared.ts"),
    "export function first() {}\nexport function second() {}\n"
  );
  writeFileSync(
    resolve(root, "src/story.ts"),
    "export function storyFeature() {}\n"
  );
  writeFileSync(resolve(root, "src/unsupported.rb"), "class UnsupportedFeature\nend\n");
  writeFileSync(
    resolve(root, "test/intent.test.ts"),
    "export function firstBehavior() {}\nexport function secondBehavior() {}\n"
  );
  writeFileSync(resolve(root, "src/unlinked.ts"), "export const unlinked = true;\n");
  const manifest = compileContractManifest({
    repositoryRoot: root,
    repositoryKey: REPOSITORY,
    specDirectory: ".tieline/spec",
    onUnhashableArtifact: "omit_hash",
  });
  const links =
    manifest.capabilities[0]!.stories[0]!.acceptance_criteria[0]!.links;
  const duplicate = links.find(
    (link) =>
      link.relation === "implements" &&
      link.target.kind === "code" &&
      link.target.path === "src/shared.ts" &&
      link.target.selector === "function:first"
  );
  assert.ok(duplicate);
  links.push(structuredClone(duplicate));
  return {
    root,
    repositoryRoot: root,
    manifest,
    index: buildContractIntentIndex(manifest),
  };
}

await test("matches exact selectors plus file claims and excludes sibling selectors", () => {
  const fixture = createFixture();
  try {
    const context = lookupAssetIntentContext({
      ...fixture,
      locator: { path: "./src/shared.ts", selector: " Function : first " },
    });
    assert.equal(context.status, "has_context");
    assert.deepEqual(context.locator, {
      repository: REPOSITORY,
      path: "src/shared.ts",
      kind: null,
      selector: "function:first",
    });
    assert.deepEqual(
      context.matching_claims.map((claim) => [
        claim.acceptance_criterion_stable_id,
        claim.target.selector,
        claim.relation,
        claim.match_precision,
      ]),
      [
        ["INTENT-001-AC1", "function:first", "enforces", "exact_selector"],
        ["INTENT-001-AC1", null, "implements", "file_level"],
        ["INTENT-001-AC1", "function:first", "implements", "exact_selector"],
      ]
    );
    assert.deepEqual(
      context.intent_neighborhood.map(
        (entry) => entry.acceptance_criterion.stable_id
      ),
      ["INTENT-001-AC1"]
    );
    assert.equal(
      context.matching_claims.some(
        (claim) => claim.target.selector === "function:second"
      ),
      false
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

await test("preserves all path claims and filters optional kind honestly", () => {
  const fixture = createFixture();
  try {
    const pathOnly = lookupAssetIntentContext({
      ...fixture,
      locator: { path: "src/shared.ts" },
    });
    assert.deepEqual(
      pathOnly.matching_claims.map((claim) => [
        claim.target.selector,
        claim.relation,
        claim.match_precision,
      ]),
      [
        ["function:first", "enforces", "path_only"],
        [null, "implements", "path_only"],
        ["function:first", "implements", "path_only"],
        ["function:second", "implements", "path_only"],
      ]
    );
    const testKind = lookupAssetIntentContext({
      ...fixture,
      locator: { path: "src/shared.ts", kind: "test" },
    });
    assert.equal(testKind.status, "no_criteria");
    assert.deepEqual(testKind.matching_claims, []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

await test("expands Story fallback one hop to each criterion's direct evidence", () => {
  const fixture = createFixture();
  try {
    const context = lookupAssetIntentContext({
      ...fixture,
      locator: { path: "src/story.ts", selector: "function:storyFeature" },
    });
    assert.deepEqual(
      context.matching_claims.map((claim) => [
        claim.acceptance_criterion_stable_id,
        claim.link_scope,
      ]),
      [
        ["INTENT-001-AC1", "story_fallback"],
        ["INTENT-001-AC2", "story_fallback"],
      ]
    );
    assert.deepEqual(
      context.intent_neighborhood.map((entry) => [
        entry.acceptance_criterion.stable_id,
        entry.direct_claims.filter((claim) => claim.target.kind === "test").length,
        entry.story_fallback_claims.length,
      ]),
      [
        ["INTENT-001-AC1", 1, 1],
        ["INTENT-001-AC2", 1, 1],
      ]
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

await test("returns complete AC context with separate assurance dimensions", () => {
  const fixture = createFixture();
  try {
    const context = lookupAcceptanceCriterionIntentContext({
      ...fixture,
      stableId: "INTENT-001-AC1",
    });
    assert.equal(context.status, "found");
    assert.equal(context.repository.key, REPOSITORY);
    assert.match(context.manifest_digest, /^[a-f0-9]{64}$/);
    assert.equal(context.intent_neighborhood?.capability.name, "Precise intent context");
    assert.equal(context.intent_neighborhood?.story.lifecycle, "production");
    assert.equal(
      context.intent_neighborhood?.acceptance_criterion.rationale,
      "A symbol query must not inherit claims for another symbol."
    );
    assert.deepEqual(
      context.intent_neighborhood?.acceptance_criterion.applies_to,
      { roles: ["maintainer"] }
    );
    assert.deepEqual(
      context.intent_neighborhood?.acceptance_criterion.scenarios.map(
        (scenario) => scenario.name
      ),
      ["Exact selector"]
    );
    assert.equal(context.intent_neighborhood?.direct_claims.length, 7);
    assert.equal(context.intent_neighborhood?.story_fallback_claims.length, 1);

    const current = context.intent_neighborhood?.direct_claims.find(
      (claim) => claim.target.selector === "function:first" && claim.relation === "implements"
    );
    assert.deepEqual(current?.assurance, {
      freshness: "current",
      broken_cause: null,
      locator_resolution: "resolved",
      locator_reason: null,
      semantic_support: "not_assessed",
    });
    assert.equal(current?.provenance, "authored");
    assert.equal(current?.link_scope, "direct");
    assert.match(current?.reviewed_content_hash ?? "", /^[a-f0-9]{64}$/);

    const unsupported = context.intent_neighborhood?.direct_claims.find(
      (claim) => claim.target.path === "src/unsupported.rb"
    );
    assert.equal(unsupported?.assurance.locator_resolution, "not_checked");
    assert.equal(unsupported?.assurance.locator_reason, "unsupported_language");
    const broken = context.intent_neighborhood?.direct_claims.find(
      (claim) => claim.target.path === "src/missing.ts"
    );
    assert.equal(broken?.assurance.freshness, "broken");
    assert.equal(broken?.assurance.broken_cause, "missing");
    const external = context.intent_neighborhood?.direct_claims.find(
      (claim) => claim.target.repository === "another-repository"
    );
    assert.equal(external?.assurance.freshness, "unknown");
    assert.equal(external?.assurance.locator_reason, "cross_repository");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

await test("distinguishes negative results and malformed locators", () => {
  const fixture = createFixture();
  try {
    assert.equal(
      lookupAssetIntentContext({
        ...fixture,
        locator: { path: "src/unlinked.ts", selector: "const:unlinked" },
      }).status,
      "no_criteria"
    );
    assert.equal(
      lookupAssetIntentContext({
        ...fixture,
        locator: { path: "src/not-here.ts" },
      }).status,
      "not_found"
    );
    assert.throws(
      () =>
        lookupAssetIntentContext({
          ...fixture,
          locator: { path: "src/shared.ts", selector: "function:first()" },
        }),
      (error: unknown) =>
        error instanceof IntentContextError &&
        error.code === "malformed_selector" &&
        /bare symbol/i.test(error.message)
    );
    assert.throws(
      () =>
        lookupAssetIntentContext({
          ...fixture,
          locator: { path: "../outside.ts" },
        }),
      (error: unknown) =>
        error instanceof IntentContextError && error.code === "invalid_path"
    );
    const unknown = lookupAcceptanceCriterionIntentContext({
      ...fixture,
      stableId: "INTENT-404-AC1",
    });
    assert.equal(unknown.status, "not_found");
    assert.equal(unknown.intent_neighborhood, null);
    assert.match(unknown.answer, /INTENT-404-AC1/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

await test("deduplicates and orders byte-equivalent bounded results", () => {
  const fixture = createFixture();
  try {
    const first = lookupAcceptanceCriterionIntentContext({
      ...fixture,
      stableId: "INTENT-001-AC1",
    });
    const second = lookupAcceptanceCriterionIntentContext({
      ...fixture,
      stableId: "INTENT-001-AC1",
    });
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.equal(
      first.intent_neighborhood?.direct_claims.filter(
        (claim) =>
          claim.target.path === "src/shared.ts" &&
          claim.target.selector === "function:first" &&
          claim.relation === "implements"
      ).length,
      1
    );
    assert.deepEqual(
      first.intent_neighborhood?.direct_claims.map((claim) => [
        claim.relation,
        claim.link_scope,
        claim.target.kind,
        claim.target.repository,
        claim.target.path,
        claim.target.selector,
      ]),
      [...(first.intent_neighborhood?.direct_claims ?? [])]
        .sort((left, right) =>
          [
            left.relation,
            left.link_scope,
            left.target.kind,
            left.target.repository,
            left.target.path,
            left.target.selector ?? "",
          ]
            .join("\0")
            .localeCompare(
              [
                right.relation,
                right.link_scope,
                right.target.kind,
                right.target.repository,
                right.target.path,
                right.target.selector ?? "",
              ].join("\0")
            )
        )
        .map((claim) => [
          claim.relation,
          claim.link_scope,
          claim.target.kind,
          claim.target.repository,
          claim.target.path,
          claim.target.selector,
        ])
    );
    const serialized = JSON.stringify(first);
    assert.doesNotMatch(serialized, /runtime[_ -]?dependenc/i);
    assert.doesNotMatch(serialized, /comprehensive[_ -]?blast[_ -]?radius/i);
    assert.match(serialized, /intent_neighborhood/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

report();
