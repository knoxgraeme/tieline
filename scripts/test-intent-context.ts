import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runCli, type TielineCliIO } from "../src/cli.js";
import {
  IntentContextError,
  lookupAcceptanceCriterionIntentContext,
  lookupAssetIntentContext,
} from "../src/contract/intent-context.js";
import {
  compileContractManifest,
  writeContractManifest,
} from "../src/contract/manifest.js";
import { buildContractIntentIndex } from "../src/contract/reconciliation.js";
import { setStore, type KnowledgeStore } from "../src/store.js";
import {
  registerIntentContextTools,
  resolveManifestIntentContext,
} from "../src/tools/intent-context.js";
import { workspaceFromConfig } from "../src/tieline/workspace.js";
import type { ToolResult } from "../src/tools/shared.js";
import { tielineConfigJson } from "./lib/fixtures.js";
import { report, test } from "./lib/harness.js";

const REPOSITORY = "intent-context-fixture";

await test("keeps configured repository roots inside the workspace owner", () => {
  const root = mkdtempSync(resolve(tmpdir(), "tieline-workspace-root-"));
  const outside = mkdtempSync(resolve(tmpdir(), "tieline-workspace-outside-"));
  const configPath = resolve(root, ".tieline/config.json");
  try {
    mkdirSync(resolve(root, ".tieline"), { recursive: true });
    mkdirSync(resolve(root, "package"), { recursive: true });
    symlinkSync(outside, resolve(root, "external"));

    const writeConfig = (repositoryRoot: string): void => {
      const config = JSON.parse(
        tielineConfigJson({
          name: "Workspace root fixture",
          repoName: "workspace-root-fixture",
        })
      ) as { repository: { root: string } };
      config.repository.root = repositoryRoot;
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    };

    writeConfig("../package");
    assert.equal(
      workspaceFromConfig(configPath).root,
      resolve(root, "package")
    );

    for (const escapingRoot of [outside, "../..", "../external"]) {
      writeConfig(escapingRoot);
      assert.throws(
        () => workspaceFromConfig(configPath),
        /repository root.*escapes.*workspace/i
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

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
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: intent-context-fixture
                path: src//canonical.ts
                selector: function:canonicalFeature
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
  writeFileSync(
    resolve(root, "src/canonical.ts"),
    "export function canonicalFeature() {}\n"
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
  writeFileSync(
    resolve(root, ".tieline/config.json"),
    tielineConfigJson({
      name: "Intent context fixture",
      repoName: REPOSITORY,
      ignore: [".git", ".tieline"],
      specDirectory: "spec",
    })
  );
  writeContractManifest(resolve(root, ".tieline/manifest"), {
    manifest,
    sources: new Map([
      [manifest.capabilities[0]!.stable_id, manifest.inputs[0]!],
    ]),
  });
  return {
    root,
    repositoryRoot: root,
    manifest,
    index: buildContractIntentIndex(manifest),
  };
}

await test("rejects duplicate stable IDs before exact context reads", () => {
  const fixture = createFixture();
  try {
    const manifestDirectory = resolve(fixture.root, ".tieline/manifest");
    const original = JSON.parse(
      readFileSync(resolve(manifestDirectory, "INTENT.json"), "utf8")
    ) as {
      input: { path: string };
      capability: {
        stable_id: string;
        stories: Array<{ stable_id: string }>;
      };
    };
    const duplicate = structuredClone(original);
    duplicate.input.path = ".tieline/spec/duplicate.yaml";
    duplicate.capability.stable_id = "DUPLICATE";
    duplicate.capability.stories[0]!.stable_id = "DUPLICATE-001";
    writeFileSync(
      resolve(manifestDirectory, "DUPLICATE.json"),
      `${JSON.stringify(duplicate, null, 2)}\n`
    );

    const resolution = resolveManifestIntentContext(fixture.root);
    assert.equal(resolution.status, "no_manifest");
    assert.match(resolution.message, /duplicate stable ID/i);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

await test("matches exact selectors plus file claims and excludes sibling selectors", async () => {
  const fixture = createFixture();
  try {
    const context = await lookupAssetIntentContext({
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

await test("preserves all path claims and filters optional kind honestly", async () => {
  const fixture = createFixture();
  try {
    const pathOnly = await lookupAssetIntentContext({
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
    const testKind = await lookupAssetIntentContext({
      ...fixture,
      locator: { path: "src/shared.ts", kind: "test" },
    });
    assert.equal(testKind.status, "no_criteria");
    assert.deepEqual(testKind.matching_claims, []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

await test("canonicalizes authored claim paths exactly like asset queries", async () => {
  const fixture = createFixture();
  try {
    const context = await lookupAssetIntentContext({
      ...fixture,
      locator: { path: "./src//canonical.ts" },
    });
    assert.equal(context.status, "has_context");
    assert.equal(context.locator.path, "src/canonical.ts");
    assert.deepEqual(
      context.matching_claims.map((claim) => [
        claim.acceptance_criterion_stable_id,
        claim.target.path,
        claim.target.selector,
      ]),
      [
        [
          "INTENT-001-AC2",
          "src/canonical.ts",
          "function:canonicalFeature",
        ],
      ]
    );
    assert.equal(
      context.matching_claims[0]?.assurance.locator_resolution,
      "resolved"
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

await test("expands Story fallback one hop to each criterion's direct evidence", async () => {
  const fixture = createFixture();
  try {
    const context = await lookupAssetIntentContext({
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

await test("returns complete AC context with separate assurance dimensions", async () => {
  const fixture = createFixture();
  try {
    const context = await lookupAcceptanceCriterionIntentContext({
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
    assert.equal(current?.assurance.freshness, "current");
    assert.equal(current?.assurance.locator_resolution, "resolved");
    assert.equal(current?.assurance.semantic_support, "not_assessed");
    assert.equal(current?.assurance.locator_matches.length, 1);
    assert.equal(current?.assurance.source_evidence?.canonical_selector, "function:first");
    assert.equal(
      current?.assurance.source_evidence?.analyzed_content_hash,
      current?.reviewed_content_hash
    );
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
    assert.equal(
      external?.assurance.freshness_reason,
      "cross_repository"
    );
    assert.equal(external?.assurance.locator_reason, "cross_repository");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

await test("distinguishes negative results and malformed locators", async () => {
  const fixture = createFixture();
  try {
    assert.equal(
      (await lookupAssetIntentContext({
        ...fixture,
        locator: { path: "src/unlinked.ts", selector: "const:unlinked" },
      })).status,
      "no_criteria"
    );
    assert.equal(
      (await lookupAssetIntentContext({
        ...fixture,
        locator: { path: "src/not-here.ts" },
      })).status,
      "not_found"
    );
    await assert.rejects(
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
    assert.equal(
      (await lookupAssetIntentContext({
        ...fixture,
        locator: { path: "src/shared.ts/" },
      })).locator.path,
      "src/shared.ts",
      "canonical path normalization preserves the established trailing-slash behavior"
    );
    await assert.rejects(
      () =>
        lookupAssetIntentContext({
          ...fixture,
          locator: { path: "../outside.ts" },
        }),
      (error: unknown) =>
        error instanceof IntentContextError && error.code === "invalid_path"
    );
    const unknown = await lookupAcceptanceCriterionIntentContext({
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

await test("validates selector kinds against the repository vocabulary", async () => {
  const fixture = createFixture();
  try {
    await assert.rejects(
      () =>
        lookupAssetIntentContext({
          ...fixture,
          locator: { path: "src/shared.ts", selector: "func:first" },
        }),
      (error: unknown) =>
        error instanceof IntentContextError &&
        error.code === "malformed_selector" &&
        /unknown selector kind 'func'/i.test(error.message)
    );

    const configPath = resolve(fixture.root, ".tieline/config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    config.selectors = { kinds: [{ name: "route" }] };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const custom = await lookupAssetIntentContext({
      ...fixture,
      locator: {
        path: "src/shared.ts",
        selector: "Route:GET /shared",
      },
    });
    assert.equal(custom.status, "has_context");
    assert.equal(custom.locator.selector, "route:GET /shared");
    assert.deepEqual(
      custom.matching_claims.map((claim) => [
        claim.target.selector,
        claim.match_precision,
      ]),
      [[null, "file_level"]]
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

await test("keeps missing claimed assets as not-found broken context", async () => {
  const fixture = createFixture();
  try {
    const context = await lookupAssetIntentContext({
      ...fixture,
      locator: {
        path: "src/missing.ts",
        kind: "code",
        selector: "function:missingFeature",
      },
    });
    assert.equal(context.status, "not_found");
    assert.equal(context.exists, false);
    assert.equal(context.matching_claims.length, 1);
    assert.equal(context.intent_neighborhood.length, 1);
    assert.deepEqual(context.matching_claims[0]?.assurance, {
      freshness: "broken",
      freshness_reason: null,
      broken_cause: "missing",
      locator_resolution: "not_checked",
      locator_reason: "file_missing",
      locator_matches: [],
      source_evidence: null,
      semantic_support: "not_assessed",
    });
    assert.match(context.answer, /manifest-backed intent neighborhood/i);
    assert.equal(
      context.intent_neighborhood[0]?.direct_claims.some(
        (claim) =>
          claim.target.path === "src/missing.ts" &&
          claim.assurance.broken_cause === "missing"
      ),
      true
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

await test("enforces one stable-ID contract in the library and CLI", async () => {
  const fixture = createFixture();
  let output = "";
  const io: TielineCliIO = {
    write(message) {
      output += message;
    },
    error(message) {
      throw new Error(message);
    },
    async question() {
      throw new Error("intent context must not prompt");
    },
  };
  try {
    assert.equal(
      (await lookupAcceptanceCriterionIntentContext({
        ...fixture,
        stableId: "A".repeat(160),
      })).status,
      "not_found"
    );
    for (const stableId of ["bad id", "A".repeat(161)]) {
      await assert.rejects(
        () =>
          lookupAcceptanceCriterionIntentContext({
            ...fixture,
            stableId,
          }),
        (error: unknown) =>
          error instanceof IntentContextError &&
          error.code === "invalid_stable_id"
      );
      output = "";
      await assert.rejects(
        runCli(
          [
            "contract",
            "context",
            "--repository",
            fixture.root,
            "--ac",
            stableId,
            "--json",
          ],
          io,
          {}
        ),
        /stable ID must be 1-160 characters/i
      );
      assert.equal(output, "");
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

await test("deduplicates and orders byte-equivalent bounded results", async () => {
  const fixture = createFixture();
  try {
    const first = await lookupAcceptanceCriterionIntentContext({
      ...fixture,
      stableId: "INTENT-001-AC1",
    });
    const second = await lookupAcceptanceCriterionIntentContext({
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

await test("registers primitive offline MCP context reads with strict parity", async () => {
  const fixture = createFixture();
  const originalWorkspace = process.env.TIELINE_WORKSPACE;
  try {
    const toolSource = readFileSync(
      resolve(process.cwd(), "src/tools/intent-context.ts"),
      "utf8"
    );
    assert.doesNotMatch(toolSource, /get(Read|Evidence|Planning)?Store\s*\(/);
    setStore(
      new Proxy(
        {},
        {
          get(_target, property) {
            throw new Error(
              `intent context tools must not use the knowledge store (accessed '${String(property)}')`
            );
          },
        }
      ) as unknown as KnowledgeStore
    );

    type RegisteredTool = {
      name: string;
      config: {
        description: string;
        inputSchema: Record<string, z.ZodTypeAny>;
        outputSchema: Record<string, z.ZodTypeAny>;
        annotations?: Record<string, unknown>;
      };
      handler: (input: Record<string, unknown>) => Promise<ToolResult>;
    };
    const registered: RegisteredTool[] = [];
    const fakeServer = {
      registerTool(
        name: string,
        config: RegisteredTool["config"],
        handler: RegisteredTool["handler"]
      ) {
        registered.push({ name, config, handler });
      },
    } as unknown as McpServer;

    registerIntentContextTools(fakeServer);
    assert.deepEqual(
      registered.map((tool) => tool.name),
      ["get_asset_intent_context", "get_acceptance_criterion_context"]
    );
    for (const tool of registered) {
      assert.deepEqual(tool.config.annotations, {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      assert.match(tool.config.description, /intent neighborhood/i);
      assert.match(tool.config.description, /contract coupling/i);
      assert.match(tool.config.description, /without (?:Postgres|a database)/i);
    }

    const assetTool = registered[0]!;
    const assetSchema = z.object(assetTool.config.inputSchema).strict();
    assert.equal(assetSchema.safeParse({ path: "" }).success, false);
    assert.equal(assetSchema.safeParse({ path: "../outside.ts" }).success, false);
    assert.equal(assetSchema.safeParse({ path: "/tmp/outside.ts" }).success, false);
    assert.equal(
      assetSchema.safeParse({
        path: "src/shared.ts",
        selector: "function:first()",
      }).success,
      false
    );
    assert.equal(
      assetSchema.safeParse({ path: "src/shared.ts", unexpected: true }).success,
      false
    );
    const acTool = registered[1]!;
    const acSchema = z.object(acTool.config.inputSchema).strict();
    assert.equal(acSchema.safeParse({ stable_id: "" }).success, false);
    assert.equal(acSchema.safeParse({ stable_id: "bad id" }).success, false);
    assert.equal(
      acSchema.safeParse({ stable_id: "A".repeat(160) }).success,
      true
    );
    assert.equal(
      acSchema.safeParse({ stable_id: "A".repeat(161) }).success,
      false
    );
    assert.equal(acSchema.safeParse({}).success, false);

    process.env.TIELINE_WORKSPACE = fixture.root;
    const assetResult = await assetTool.handler({
      path: "src/shared.ts",
      kind: "code",
      selector: "function:first",
    });
    assert.notEqual(assetResult.isError, true);
    assert.deepEqual(
      assetResult.structuredContent,
      await lookupAssetIntentContext({
        manifest: fixture.manifest,
        repositoryRoot: fixture.root,
        locator: {
          path: "src/shared.ts",
          kind: "code",
          selector: "function:first",
        },
      })
    );
    const assetText = JSON.parse(assetResult.content[0]!.text) as Record<string, unknown>;
    if (assetText._truncated === true) {
      assert.equal(assetText._note !== undefined, true);
      assert.equal(typeof assetText._truncated_field, "string");
      assert.equal(typeof assetText._total_available, "number");
    } else {
      assert.deepEqual(assetText, assetResult.structuredContent);
    }
    z.object(assetTool.config.outputSchema)
      .strict()
      .parse(assetResult.structuredContent);

    const acResult = await acTool.handler({ stable_id: "INTENT-001-AC1" });
    assert.notEqual(acResult.isError, true);
    assert.deepEqual(
      acResult.structuredContent,
      await lookupAcceptanceCriterionIntentContext({
        manifest: fixture.manifest,
        repositoryRoot: fixture.root,
        stableId: "INTENT-001-AC1",
      })
    );
    z.object(acTool.config.outputSchema)
      .strict()
      .parse(acResult.structuredContent);

    const stray = mkdtempSync(resolve(tmpdir(), "tieline-intent-no-workspace-"));
    try {
      process.env.TIELINE_WORKSPACE = stray;
      const missingWorkspace = await assetTool.handler({ path: "src/shared.ts" });
      assert.equal(missingWorkspace.isError, true);
      assert.match(
        missingWorkspace.content[0]?.text ?? "",
        /No Tieline workspace[\s\S]*tieline init/
      );
      const resolution = resolveManifestIntentContext(stray);
      assert.equal(resolution.status, "no_workspace");
    } finally {
      rmSync(stray, { recursive: true, force: true });
    }

    const noManifest = mkdtempSync(
      resolve(tmpdir(), "tieline-intent-no-manifest-")
    );
    try {
      mkdirSync(resolve(noManifest, ".tieline/spec"), { recursive: true });
      writeFileSync(
        resolve(noManifest, ".tieline/config.json"),
        tielineConfigJson({
          name: "No manifest",
          repoName: "no-manifest",
          ignore: [".git", ".tieline"],
          specDirectory: "spec",
        })
      );
      process.env.TIELINE_WORKSPACE = noManifest;
      const unreadableManifest = await acTool.handler({
        stable_id: "INTENT-001-AC1",
      });
      assert.equal(unreadableManifest.isError, true);
      assert.match(
        unreadableManifest.content[0]?.text ?? "",
        /manifest[\s\S]*missing or unreadable[\s\S]*contract compile/
      );
    } finally {
      rmSync(noManifest, { recursive: true, force: true });
    }
  } finally {
    if (originalWorkspace === undefined) delete process.env.TIELINE_WORKSPACE;
    else process.env.TIELINE_WORKSPACE = originalWorkspace;
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

report();
