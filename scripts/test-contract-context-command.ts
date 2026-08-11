import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runCli, type TielineCliIO } from "../src/cli.js";
import { readContractManifest } from "../src/contract/manifest.js";
import {
  lookupAcceptanceCriterionIntentContext,
  lookupAssetIntentContext,
} from "../src/contract/intent-context.js";

const root = mkdtempSync(resolve(tmpdir(), "tieline-contract-context-command-"));
let output = "";
const io: TielineCliIO = {
  write(message) {
    output += message;
  },
  error(message) {
    throw new Error(message);
  },
  async question() {
    throw new Error("contract context commands must not prompt");
  },
};

try {
  const contextRoot = resolve(root, "context-fixture");
  mkdirSync(resolve(contextRoot, ".tieline/spec"), { recursive: true });
  mkdirSync(resolve(contextRoot, "src"), { recursive: true });
  mkdirSync(resolve(contextRoot, "test"), { recursive: true });
  writeFileSync(
    resolve(contextRoot, "src/shared.ts"),
    "export function first() {}\nexport function second() {}\n"
  );
  writeFileSync(
    resolve(contextRoot, "src/story.ts"),
    "export function storyFeature() {}\n"
  );
  writeFileSync(
    resolve(contextRoot, "test/shared.test.ts"),
    "export function firstBehavior() {}\n"
  );
  writeFileSync(resolve(contextRoot, "src/missing.ts"), "export const missing = true;\n");
  writeFileSync(resolve(contextRoot, "src/unlinked.ts"), "export const unlinked = true;\n");
  writeFileSync(
    resolve(contextRoot, ".tieline/spec/context.yaml"),
    `version: 1
capability:
  key: CONTEXT
  name: Exact contract context
  description: Maintainers inspect an intent neighborhood without a database.
  applies_to:
    editions: [cloud]
  stories:
    - key: CONTEXT-001
      title: Inspect exact contract coupling
      actor: maintainer
      goal: retrieve reviewed intent from an exact locator
      benefit: code changes retain accepted behavior
      lifecycle: production
      applies_to:
        regions: [ca]
      links:
        - relation: implements
          provenance: authored
          target:
            kind: code
            repository: context-command-test
            path: src/story.ts
            selector: function:storyFeature
      acceptance_criteria:
        - key: CONTEXT-001-AC1
          criterion: Tieline must include file-level contract coupling for exact selectors.
          rationale: Symbols in one file must remain distinct.
          applies_to:
            roles: [maintainer]
          scenarios:
            - name: Exact selector
              given: Two symbols share a source file.
              when: The first selector is requested.
              then: File-level and exact claims are returned without the second selector.
            - given: An acceptance scenario has no name.
              when: Its Acceptance Criterion context is rendered as prose.
              then: The steps remain readable without a synthetic label.
          links:
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: context-command-test
                path: src/shared.ts
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: context-command-test
                path: src/shared.ts
                selector: function:first
            - relation: tests
              provenance: authored
              target:
                kind: test
                repository: context-command-test
                path: test/shared.test.ts
                selector: function:firstBehavior
                framework_hint: node-assert
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: context-command-test
                path: src/missing.ts
        - key: CONTEXT-001-AC2
          criterion: Tieline must preserve every selector-qualified claim in path-only context.
          links:
            - relation: implements
              provenance: inferred
              target:
                kind: code
                repository: context-command-test
                path: src/shared.ts
                selector: function:second
`
  );

  output = "";
  assert.equal(
    await runCli(
      [
        "contract",
        "compile",
        contextRoot,
        "--repo",
        "context-command-test",
        "--json",
      ],
      io,
      {}
    ),
    0
  );
  rmSync(resolve(contextRoot, "src/missing.ts"));
  const contextManifest = readContractManifest(
    resolve(contextRoot, ".tieline/manifest")
  );

  output = "";
  assert.equal(
    await runCli(
      [
        "contract",
        "context",
        "--repository",
        contextRoot,
        "--path",
        "src/shared.ts",
        "--json",
      ],
      io,
      {}
    ),
    0
  );
  const pathContext = JSON.parse(output);
  assert.deepEqual(
    pathContext,
    await lookupAssetIntentContext({
      manifest: contextManifest,
      repositoryRoot: contextRoot,
      locator: { path: "src/shared.ts" },
    }),
    "CLI JSON must be the exact U3 domain result"
  );
  assert.deepEqual(
    pathContext.matching_claims.map(
      (claim: { target: { selector: string | null } }) => claim.target.selector
    ),
    [null, "function:first", "function:second"]
  );

  output = "";
  assert.equal(
    await runCli(
      [
        "contract",
        "context",
        "--repository",
        contextRoot,
        "--path",
        "src/shared.ts",
        "--kind",
        "code",
        "--selector",
        "function:first",
        "--json",
      ],
      io,
      {}
    ),
    0
  );
  const selectorContext = JSON.parse(output);
  assert.deepEqual(
    selectorContext.matching_claims.map(
      (claim: { target: { selector: string | null }; match_precision: string }) => [
        claim.target.selector,
        claim.match_precision,
      ]
    ),
    [
      [null, "file_level"],
      ["function:first", "exact_selector"],
    ]
  );

  output = "";
  assert.equal(
    await runCli(
      [
        "contract",
        "context",
        "--repository",
        contextRoot,
        "--ac",
        "CONTEXT-001-AC1",
        "--json",
      ],
      io,
      {}
    ),
    0
  );
  const criterionContext = JSON.parse(output);
  assert.deepEqual(
    criterionContext,
    await lookupAcceptanceCriterionIntentContext({
      manifest: contextManifest,
      repositoryRoot: contextRoot,
      stableId: "CONTEXT-001-AC1",
    }),
    "AC JSON must preserve the exact U3 ancestry and asset membership"
  );
  assert.equal(criterionContext.intent_neighborhood.capability.stable_id, "CONTEXT");
  assert.equal(criterionContext.intent_neighborhood.story.lifecycle, "production");
  assert.equal(
    criterionContext.intent_neighborhood.acceptance_criterion.scenarios[0].name,
    "Exact selector"
  );
  assert.equal(criterionContext.intent_neighborhood.direct_claims.length, 4);
  assert.equal(criterionContext.intent_neighborhood.story_fallback_claims.length, 1);

  output = "";
  assert.equal(
    await runCli(
      [
        "contract",
        "context",
        "--repository",
        contextRoot,
        "--path",
        "src/shared.ts",
        "--selector",
        "function:first",
      ],
      io,
      {}
    ),
    0
  );
  assert.match(output, /intent neighborhood/i);
  assert.match(output, /contract coupling/i);
  assert.match(output, /match precision.*exact_selector/i);
  assert.match(output, /provenance.*authored/i);
  assert.match(output, /link scope.*direct/i);
  assert.match(output, /freshness.*current/i);
  assert.match(output, /freshness reason.*none/i);
  assert.match(output, /broken cause.*none/i);
  assert.match(output, /locator resolution.*resolved/i);
  assert.match(output, /locator reason.*none/i);
  assert.match(output, /semantic support.*not_assessed/i);
  assert.match(output, /does not establish runtime dependency or semantic proof/i);

  output = "";
  await runCli(
    [
      "contract",
      "context",
      "--repository",
      contextRoot,
      "--ac",
      "CONTEXT-001-AC1",
    ],
    io,
    {}
  );
  assert.match(output, /Capability: CONTEXT/);
  assert.match(output, /Story: CONTEXT-001/);
  assert.match(output, /Lifecycle: production/);
  assert.match(output, /Rationale: Symbols in one file must remain distinct/);
  assert.match(output, /Direct claims/);
  assert.match(output, /Story-fallback claims/);
  assert.match(output, /freshness.*broken/i);
  assert.match(output, /broken cause.*missing/i);
  assert.match(
    output,
    /given An acceptance scenario has no name\.; when Its Acceptance Criterion context is rendered as prose\.; then The steps remain readable without a synthetic label\./
  );
  assert.doesNotMatch(output, /^\s*undefined:/m);

  for (const args of [
    ["contract", "context", "--repository", contextRoot],
    [
      "contract",
      "context",
      "--repository",
      contextRoot,
      "--path",
      "src/shared.ts",
      "--ac",
      "CONTEXT-001-AC1",
    ],
  ]) {
    await assert.rejects(runCli(args, io, {}), /exactly one of --path or --ac/i);
  }
  await assert.rejects(
    runCli(
      [
        "contract",
        "context",
        "--repository",
        contextRoot,
        "--ac",
        "CONTEXT-001-AC1",
        "--kind",
        "code",
      ],
      io,
      {}
    ),
    /--kind.*--selector.*apply only with.*--path/i
  );
  await assert.rejects(
    runCli(
      [
        "contract",
        "context",
        "--repository",
        contextRoot,
        "--ac",
        "CONTEXT-001-AC1",
        "--selector",
        "function:first",
      ],
      io,
      {}
    ),
    /--kind.*--selector.*apply only with.*--path/i
  );
  await assert.rejects(
    runCli(
      [
        "contract",
        "context",
        "--repository",
        contextRoot,
        "--path",
        "src/shared.ts",
        "--kind",
        "prose",
      ],
      io,
      {}
    ),
    /Asset kind 'prose' is invalid; expected 'code' or 'test'/
  );

  for (const [path, status] of [
    ["src/unlinked.ts", "no_criteria"],
    ["src/not-here.ts", "not_found"],
  ] as const) {
    output = "";
    assert.equal(
      await runCli(
        [
          "contract",
          "context",
          "--repository",
          contextRoot,
          "--path",
          path,
          "--json",
        ],
        io,
        {}
      ),
      0
    );
    const negative = JSON.parse(output);
    assert.equal(negative.status, status);
    assert.match(
      negative.answer,
      new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    );
  }

  output = "";
  assert.equal(
    await runCli(
      [
        "contract",
        "context",
        "--repository",
        contextRoot,
        "--ac",
        "CONTEXT-404-AC1",
        "--json",
      ],
      io,
      {}
    ),
    0
  );
  assert.equal(JSON.parse(output).status, "not_found");
  assert.match(JSON.parse(output).answer, /Check the stable ID and manifest workspace/);

  const missingManifestRoot = resolve(root, "missing-manifest");
  mkdirSync(missingManifestRoot, { recursive: true });
  await assert.rejects(
    runCli(
      [
        "contract",
        "context",
        "--repository",
        missingManifestRoot,
        "--path",
        "src/anything.ts",
      ],
      io,
      {}
    ),
    /Cannot inspect intent context.*contract manifest.*tieline contract compile/si
  );

} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("contract context command tests passed");
