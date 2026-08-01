import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  ContractValidationError,
  loadAcceptedContract,
  validateAcceptedContractDocuments,
} from "../src/contract/index.js";
import {
  planningStorySchema,
  renderUserStory,
  type AcceptedContractDocument,
} from "../src/contract/schema.js";
import { computeRepositoryMappingCoverage } from "../src/contract/coverage.js";
import { compileContractManifest } from "../src/contract/manifest.js";

let passed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (error) {
    console.error(`  not ok - ${name}`);
    throw error;
  }
}

function document(overrides: Partial<AcceptedContractDocument> = {}): AcceptedContractDocument {
  return {
    version: 1,
    capability: {
      key: "AUTH",
      name: "Semantic authoring",
      description: "Maintainers can keep product intent with code.",
      stories: [
        {
          key: "AUTH-001",
          title: "Reconcile product intent",
          actor: "maintainer",
          goal: "review semantic changes with implementation",
          benefit: "the accepted contract stays current",
          lifecycle: "production",
          aliases: ["review product meaning"],
          acceptance_criteria: [
            {
              key: "AUTH-001-AC1",
              criterion: "Tieline must reject repository paths that escape the checkout.",
              links: [
                {
                  relation: "tests",
                  target: {
                    kind: "test",
                    repository: "tieline",
                    path: "scripts/test-contract.ts",
                    framework_hint: "custom-script",
                  },
                },
              ],
            },
          ],
        },
      ],
    },
    ...overrides,
  };
}

console.log("shared Story/AC model");

await test("renders familiar Agile story text from structured fields", () => {
  assert.equal(
    renderUserStory({
      actor: "support specialist",
      goal: "find the behavior behind a ticket",
      benefit: "I can answer with production context",
    }),
    "As a support specialist, I want to find the behavior behind a ticket, so that I can answer with production context."
  );
});

await test("accepts an incomplete backlog Story through the planning schema", () => {
  const parsed = planningStorySchema.parse({
    key: "AUTH-PLANNING-001",
    title: "Explore semantic reconciliation",
    lifecycle: "backlog",
  });
  assert.equal(parsed.lifecycle, "backlog");
  assert.deepEqual(parsed.acceptance_criteria, []);
});

console.log("accepted YAML loading and validation");

await test("loads strict YAML and preserves locator arrays and scalar values", () => {
  const root = mkdtempSync(resolve(tmpdir(), "tieline-contract-"));
  try {
    mkdirSync(resolve(root, ".tieline/spec"), { recursive: true });
    writeFileSync(
      resolve(root, ".tieline/spec/authoring.yaml"),
      `version: 1
capability:
  key: AUTH
  name: Semantic authoring
  description: Maintainers can keep product intent with code.
  stories:
    - key: AUTH-001
      title: Reconcile product intent
      actor: maintainer
      goal: review semantic changes with implementation
      benefit: the accepted contract stays current
      lifecycle: production
      applies_to:
        regions: [ca, us]
      acceptance_criteria:
        - key: AUTH-001-AC1
          criterion: Tieline must accept framework-agnostic test locators.
          links:
            - relation: tests
              target:
                kind: test
                repository: tieline
                path: scripts/test-contract.ts
                selector: custom script proof
                framework_hint: custom-script
`
    );
    const loaded = loadAcceptedContract(root);
    assert.equal(loaded.documents.length, 1);
    assert.deepEqual(
      loaded.documents[0]?.capability.stories[0]?.applies_to,
      { regions: ["ca", "us"] }
    );
    assert.equal(
      loaded.documents[0]?.capability.stories[0]?.acceptance_criteria[0]?.links[0]?.target.path,
      "scripts/test-contract.ts"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("rejects backlog and incomplete Stories in accepted documents", () => {
  const invalid = document();
  const story = invalid.capability.stories[0] as unknown as Record<string, unknown>;
  story.lifecycle = "backlog";
  delete story.actor;
  assert.throws(
    () => validateAcceptedContractDocuments([{ path: "invalid.yaml", document: invalid }]),
    ContractValidationError
  );
});

await test("rejects duplicate IDs, broken supersession, and escaping paths", () => {
  const first = document();
  first.capability.stories[0]!.supersedes = "AUTH-DOES-NOT-EXIST";
  first.capability.stories[0]!.acceptance_criteria[0]!.links = [
    {
      relation: "implements",
      target: { kind: "code", repository: "tieline", path: "../outside.ts" },
    },
  ];
  const second = document({
    capability: {
      ...document().capability,
      key: "AUTH-SECOND",
    },
  });
  assert.throws(
    () =>
      validateAcceptedContractDocuments([
        { path: "first.yaml", document: first },
        { path: "second.yaml", document: second },
      ]),
    (error: unknown) => {
      assert.ok(error instanceof ContractValidationError);
      assert.match(error.message, /duplicate stable ID/i);
      assert.match(error.message, /supersedes unknown/i);
      assert.match(error.message, /repository-relative/i);
      return true;
    }
  );
});

await test("warns without failing when AC text normalizes to an existing criterion", () => {
  const first = document();
  const second = document({
    capability: {
      key: "SEARCH",
      name: "Search",
      description: "Search behavior.",
      stories: [
        {
          ...document().capability.stories[0]!,
          key: "SEARCH-001",
          acceptance_criteria: [
            {
              key: "SEARCH-001-AC1",
              criterion: "  TIELINE must reject repository paths that escape the checkout! ",
            },
          ],
        },
      ],
    },
  });
  const result = validateAcceptedContractDocuments([
    { path: "first.yaml", document: first },
    { path: "second.yaml", document: second },
  ]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /equivalent criterion text/i);
});

await test("prunes ignored directories before resolving their contents", () => {
  const root = mkdtempSync(resolve(tmpdir(), "tieline-coverage-"));
  const outside = mkdtempSync(resolve(tmpdir(), "tieline-outside-"));
  try {
    mkdirSync(resolve(root, ".tieline/spec"), { recursive: true });
    mkdirSync(resolve(root, "src"), { recursive: true });
    writeFileSync(resolve(root, "src/covered.ts"), "export const covered = true;\n");
    writeFileSync(resolve(outside, "external.ts"), "export const external = true;\n");
    symlinkSync(
      outside,
      resolve(root, "src/ignored"),
      process.platform === "win32" ? "junction" : "dir"
    );
    writeFileSync(
      resolve(root, ".tieline/spec/coverage.yaml"),
      `version: 1
capability:
  key: COVERAGE
  name: Coverage
  description: Coverage ignores excluded repository paths.
  stories:
    - key: COVERAGE-001
      title: Prune ignored directories
      actor: maintainer
      goal: measure only eligible files
      benefit: ignored dependencies cannot break coverage scans
      lifecycle: production
      acceptance_criteria:
        - key: COVERAGE-001-AC1
          criterion: Tieline must prune ignored paths before resolving symlinks.
          links:
            - relation: implements
              target:
                kind: code
                repository: tieline
                path: src/covered.ts
`
    );
    const coverage = computeRepositoryMappingCoverage(
      compileContractManifest({
        repositoryRoot: root,
        repositoryKey: "tieline",
        commit: "coverage-test",
      }),
      {
        repositoryRoot: root,
        sourceRoots: ["src"],
        ignore: ["src/ignored"],
      }
    );
    assert.deepEqual(coverage, {
      status: "measured",
      source_roots: ["src"],
      eligible_files: 1,
      mapped_files: 1,
      unmapped_files: [],
      excluded_files: 1,
      percentage: 100,
      confidence: {
        hash_comparison_available: true,
        execution_corroboration_available: false,
        counts: { asserted: 0, hash_current: 1, execution_corroborated: 0 },
        percentages: {
          asserted: 0,
          hash_current: 100,
          execution_corroborated: 0,
        },
        paths: {
          asserted: [],
          hash_current: ["src/covered.ts"],
          execution_corroborated: [],
        },
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

await test("does not describe an empty source scope as 100% covered", () => {
  const root = mkdtempSync(resolve(tmpdir(), "tieline-empty-coverage-"));
  try {
    mkdirSync(resolve(root, ".tieline/spec"), { recursive: true });
    mkdirSync(resolve(root, "src"), { recursive: true });
    const coverage = computeRepositoryMappingCoverage(
      {
        schema_version: 1,
        repository: { key: "tieline", commit: "empty" },
        inputs: [],
        capabilities: [],
      },
      {
        repositoryRoot: root,
        sourceRoots: ["src"],
      }
    );
    assert.deepEqual(coverage, {
      status: "no_eligible_files",
      source_roots: ["src"],
      eligible_files: 0,
      mapped_files: 0,
      unmapped_files: [],
      excluded_files: 0,
      percentage: null,
      confidence: {
        hash_comparison_available: true,
        execution_corroboration_available: false,
        counts: { asserted: 0, hash_current: 0, execution_corroborated: 0 },
        percentages: {
          asserted: null,
          hash_current: null,
          execution_corroborated: null,
        },
        paths: {
          asserted: [],
          hash_current: [],
          execution_corroborated: [],
        },
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, 0 failed`);
