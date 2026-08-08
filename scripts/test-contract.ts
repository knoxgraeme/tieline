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
import { loadAcceptedContract } from "../src/contract/load.js";
import {
  contractLinkSchema,
  planningStorySchema,
  renderUserStory,
  type AcceptedContractDocument,
} from "../src/contract/schema.js";
import { computeRepositoryMappingCoverage } from "../src/contract/coverage.js";
import { compileContractManifest } from "../src/contract/manifest.js";
import {
  ContractValidationError,
  selectorVocabularyForRepository,
  validateAcceptedContractDocuments,
} from "../src/contract/validate.js";
import { readSelectorConfig } from "../src/config.js";
import {
  createSelectorVocabulary,
  indexSourceSymbols,
  normalizeSelector,
  parseSelector,
  resolveSelector,
  SelectorError,
  validateSelector,
} from "../src/contract/selector.js";
import { report, test } from "./lib/harness.js";

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
                  provenance: "authored",
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

await test("requires explicit provenance and accepts every stable claim origin", () => {
  const target = {
    kind: "code" as const,
    repository: "tieline",
    path: "src/contract/schema.ts",
  };
  assert.equal(
    contractLinkSchema.safeParse({ relation: "implements", target }).success,
    false,
    "a missing origin must never be guessed"
  );
  for (const provenance of ["authored", "inferred", "materialized"] as const) {
    assert.equal(
      contractLinkSchema.safeParse({ relation: "implements", provenance, target })
        .success,
      true,
      `${provenance} should be a valid stable provenance`
    );
  }
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
              provenance: authored
              target:
                kind: test
                repository: tieline
                path: scripts/test-contract.ts
                selector: "function:  test "
                framework_hint: custom-script
`
    );
    const loaded = loadAcceptedContract(root);
    assert.equal(loaded.documents.length, 1);
    assert.deepEqual(
      loaded.documents[0]?.capability.stories[0]?.applies_to,
      { regions: ["ca", "us"] }
    );
    const target =
      loaded.documents[0]?.capability.stories[0]?.acceptance_criteria[0]?.links[0]
        ?.target;
    assert.equal(target?.path, "scripts/test-contract.ts");
    assert.equal(
      target && "selector" in target ? target.selector : undefined,
      "function:test"
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
      provenance: "authored",
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

await test("rejects duplicate link identity even when provenance conflicts", () => {
  const invalid = document();
  const criterion = invalid.capability.stories[0]!.acceptance_criteria[0]!;
  criterion.links = [
    criterion.links[0]!,
    { ...criterion.links[0]!, provenance: "inferred" },
  ];
  assert.throws(
    () =>
      validateAcceptedContractDocuments([
        { path: "duplicate-links.yaml", document: invalid },
      ]),
    (error: unknown) => {
      assert.ok(error instanceof ContractValidationError);
      assert.match(error.message, /same 'tests' link target/i);
      assert.match(error.message, /conflicting provenance 'authored' and 'inferred'/i);
      return true;
    }
  );
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
              provenance: authored
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
        counts: { asserted: 0, hash_current: 1 },
        percentages: {
          asserted: 0,
          hash_current: 100,
        },
        paths: {
          asserted: [],
          hash_current: ["src/covered.ts"],
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
        schema_version: 2,
        repository: { key: "tieline" },
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
        counts: { asserted: 0, hash_current: 0 },
        percentages: {
          asserted: null,
          hash_current: null,
        },
        paths: {
          asserted: [],
          hash_current: [],
        },
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log("link selector grammar");

/** A document whose one criterion link carries the given selector. */
function documentWithSelector(selector: string): AcceptedContractDocument {
  const base = document();
  base.capability.stories[0]!.acceptance_criteria[0]!.links = [
    {
      relation: "implements",
      provenance: "authored",
      target: {
        kind: "code",
        repository: "tieline",
        path: "src/contract/selector.ts",
        selector,
      },
    },
  ];
  return base;
}

function selectorOf(parsed: AcceptedContractDocument): string | undefined {
  const target =
    parsed.capability.stories[0]!.acceptance_criteria[0]!.links[0]!.target;
  return "selector" in target ? target.selector : undefined;
}

await test("accepts every core kind and preserves the symbol name verbatim", () => {
  for (const selector of [
    "function:analyzeContractImpact",
    "method:searchSemantic",
    "class:PostgresStore",
    "type:ContractManifest",
    "const:CORE_SELECTOR_KINDS",
  ]) {
    const result = validateSelector(selector);
    assert.ok(result.ok, `${selector} should be valid`);
    assert.equal(result.selector.canonical, selector);
  }
});

await test("qualifies a member with '/' and keeps a slash inside a declared name", () => {
  const qualified = parseSelector("class:PostgresStore/method:searchSemantic");
  assert.ok(qualified.ok);
  assert.deepEqual(qualified.selector.segments, [
    { kind: "class", name: "PostgresStore" },
    { kind: "method", name: "searchSemantic" },
  ]);

  // A '/' only starts a new part when a '<kind>:' prefix follows it, so a route
  // path stays one segment instead of being torn in half.
  const route = parseSelector("route:GET /health");
  assert.ok(route.ok);
  assert.deepEqual(route.selector.segments, [
    { kind: "route", name: "GET /health" },
  ]);
});

await test("canonicalizes kind case while keeping symbol case distinct", () => {
  assert.equal(normalizeSelector("Function: Foo"), "function:Foo");
  assert.equal(normalizeSelector("FUNCTION:Foo"), "function:Foo");
  assert.equal(normalizeSelector("  function:Foo  "), "function:Foo");
  assert.notEqual(normalizeSelector("function:foo"), normalizeSelector("function:Foo"));
  assert.equal(normalizeSelector("Route: GET   /health"), "route:GET /health");
  // Canonicalization is idempotent, or an identity key would drift on re-parse.
  assert.equal(
    normalizeSelector(normalizeSelector("Class: Foo / Method: bar")),
    "class:Foo/method:bar"
  );
});

await test("rejects malformed selectors with an error naming the problem", () => {
  const malformed: Array<[string, RegExp]> = [
    [":analyzeContractImpact", /empty kind/i],
    ["function:", /empty name/i],
    ["   ", /cannot be empty/i],
    ["analyzeContractImpact", /must be written as '<kind>:<name>'/],
    ["function:foo/", /stray or doubled/i],
    ["/function:foo", /empty part/i],
    ["function:foo//method:bar", /stray or doubled/i],
    ["function:analyzeContractImpact()", /bare symbol/i],
    ["function:foo:bar", /cannot contain ':'/],
    ["1function:foo", /must start with a letter/],
  ];
  for (const [selector, expected] of malformed) {
    const result = parseSelector(selector);
    assert.equal(result.ok, false, `${JSON.stringify(selector)} should be rejected`);
    if (!result.ok) assert.match(result.error, expected);
  }
  assert.throws(() => normalizeSelector("func:foo/"), SelectorError);
});

await test("rejects an unknown kind so a typo cannot fork an asset identity", () => {
  assert.throws(
    () =>
      validateAcceptedContractDocuments([
        { path: "typo.yaml", document: documentWithSelector("func:analyzeContractImpact") },
      ]),
    (error: unknown) => {
      assert.ok(error instanceof ContractValidationError);
      assert.match(error.message, /unknown selector kind 'func'/);
      assert.match(error.message, /Known kinds: class, const, function, method, type/);
      assert.match(error.message, /selectors\.kinds/);
      return true;
    }
  );
});

await test("accepts a kind the repository declares in .tieline/config.json", () => {
  const root = mkdtempSync(resolve(tmpdir(), "tieline-selector-config-"));
  try {
    mkdirSync(resolve(root, ".tieline"), { recursive: true });
    writeFileSync(
      resolve(root, ".tieline/config.json"),
      `${JSON.stringify({
        version: 1,
        selectors: {
          kinds: [
            { name: "route", description: "HTTP route" },
            { name: "Command", resolvable: false },
          ],
        },
      })}\n`
    );
    const vocabulary = selectorVocabularyForRepository(root);
    assert.deepEqual(
      [...vocabulary.names],
      ["class", "command", "const", "function", "method", "route", "type"]
    );

    const validated = validateAcceptedContractDocuments(
      [{ path: "declared.yaml", document: documentWithSelector("Route: GET /health") }],
      { repositoryRoot: root }
    );
    assert.equal(selectorOf(validated.documents[0]!), "route:GET /health");

    // Closed vocabulary: the same document fails without the declaration.
    assert.throws(
      () =>
        validateAcceptedContractDocuments([
          { path: "declared.yaml", document: documentWithSelector("route:GET /health") },
        ]),
      /unknown selector kind 'route'/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("defaults declared kinds to unresolvable and rejects redeclaring core", () => {
  assert.deepEqual(readSelectorConfig({ version: 1 }), { kinds: [] });
  assert.deepEqual(readSelectorConfig(undefined), { kinds: [] });
  assert.deepEqual(readSelectorConfig({ selectors: { kinds: [{ name: "route" }] } }), {
    kinds: [{ name: "route", resolvable: false }],
  });
  assert.throws(
    () => readSelectorConfig({ selectors: { kinds: [{ name: "not a kind" }] } }),
    /Invalid 'selectors' block/
  );
  assert.throws(
    () => createSelectorVocabulary([{ name: "Function" }]),
    /already a core kind/
  );
  assert.throws(
    () => createSelectorVocabulary([{ name: "route" }, { name: "ROUTE" }]),
    /declared twice/
  );
});

console.log("link selector resolution");

const SELECTOR_FIXTURE = `// A fixture, not production code.
import { readFileSync } from "node:fs";

export const RETRY_LIMIT = 3;

export function analyzeContractImpact(input: string): string {
  return input;
}

export const renderReport = (rows: string[]): string => rows.join("");

export interface ReportRow {
  label: string;
}

export type ReportMode = "strict" | "advisory";

export class PostgresStore {
  private readonly cache = new Map<string, string>();

  searchSemantic(query: string): string {
    return query;
  }

  readonly warmCache = (key: string): void => {
    this.cache.set(key, key);
  };
}

// "renameMe" appears only inside a comment and a string, never as a declaration.
const banner = "renameMe";
`;

function fixtureRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), "tieline-selector-resolve-"));
  mkdirSync(resolve(root, "src"), { recursive: true });
  writeFileSync(resolve(root, "src/fixture.ts"), SELECTOR_FIXTURE);
  writeFileSync(resolve(root, "src/fixture.rb"), "class PostgresStore\nend\n");
  return root;
}

await test("indexes declared symbols by kind, ignoring comments and strings", () => {
  const index = indexSourceSymbols(SELECTOR_FIXTURE);
  assert.ok(index.kinds.function.includes("analyzeContractImpact"));
  assert.ok(index.kinds.function.includes("renderReport"));
  assert.ok(index.kinds.class.includes("PostgresStore"));
  assert.ok(index.kinds.const.includes("RETRY_LIMIT"));
  assert.ok(index.kinds.type.includes("ReportRow"));
  assert.ok(index.kinds.type.includes("ReportMode"));
  assert.ok(index.kinds.method.includes("searchSemantic"));
  assert.ok(index.kinds.method.includes("warmCache"));
  assert.ok(!index.all.includes("renameMe"));
});

await test("resolves core-kind selectors against the file the link targets", () => {
  const root = fixtureRoot();
  try {
    for (const selector of [
      "function:analyzeContractImpact",
      "function:renderReport",
      "class:PostgresStore",
      "const:RETRY_LIMIT",
      "type:ReportMode",
      "class:PostgresStore/method:searchSemantic",
    ]) {
      const resolution = resolveSelector({
        repositoryRoot: root,
        path: "src/fixture.ts",
        selector,
      });
      assert.equal(resolution.status, "resolved", `${selector}: ${resolution.detail}`);
      assert.equal(resolution.reason, null);
      assert.equal(resolution.missing.length, 0);
      assert.equal(resolution.selector, selector);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("reports unresolved only for a file the extractor understood", () => {
  const root = fixtureRoot();
  try {
    const gone = resolveSelector({
      repositoryRoot: root,
      path: "src/fixture.ts",
      selector: "function:renameMe",
    });
    assert.equal(gone.status, "unresolved");
    assert.equal(gone.reason, null);
    assert.deepEqual(gone.missing, [{ kind: "function", name: "renameMe" }]);

    // A name that exists under a different kind is still unresolved, and the
    // detail says where it was actually found.
    const wrongKind = resolveSelector({
      repositoryRoot: root,
      path: "src/fixture.ts",
      selector: "class:analyzeContractImpact",
    });
    assert.equal(wrongKind.status, "unresolved");
    assert.match(wrongKind.detail, /not as a class/);

    // A qualified selector fails as a whole when any part is missing.
    const partial = resolveSelector({
      repositoryRoot: root,
      path: "src/fixture.ts",
      selector: "class:PostgresStore/method:renameMe",
    });
    assert.equal(partial.status, "unresolved");
    assert.deepEqual(partial.matched, [{ kind: "class", name: "PostgresStore" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("never reports not_checked as unresolved", () => {
  const root = fixtureRoot();
  const vocabulary = createSelectorVocabulary([
    { name: "route" },
    { name: "tool", resolvable: true },
  ]);
  try {
    const cases: Array<{
      path: string;
      selector: string;
      reason: string;
    }> = [
      // A declared kind that is not resolvable is validated and normalized, but
      // never symbol-checked.
      { path: "src/fixture.ts", selector: "route:GET /health", reason: "kind_not_resolvable" },
      // A language these regexes do not understand.
      { path: "src/fixture.rb", selector: "class:PostgresStore", reason: "unsupported_language" },
      // A file that is simply not there.
      { path: "src/absent.ts", selector: "function:analyzeContractImpact", reason: "file_missing" },
      // A directory where a file was expected.
      { path: "src", selector: "function:analyzeContractImpact", reason: "unsupported_language" },
      // A resolvable declared kind whose name is not a symbol at all.
      { path: "src/fixture.ts", selector: "tool:contract reconcile", reason: "name_not_identifier" },
    ];
    for (const entry of cases) {
      const resolution = resolveSelector({
        repositoryRoot: root,
        path: entry.path,
        selector: entry.selector,
        vocabulary,
      });
      assert.equal(
        resolution.status,
        "not_checked",
        `${entry.selector} @ ${entry.path}: ${resolution.detail}`
      );
      assert.equal(resolution.reason, entry.reason);
      assert.equal(resolution.missing.length, 0);
    }

    // A file with no recognizable declaration teaches nothing either.
    const empty = mkdtempSync(resolve(tmpdir(), "tieline-selector-empty-"));
    try {
      writeFileSync(resolve(empty, "blank.ts"), "// nothing but a comment\n");
      const resolution = resolveSelector({
        repositoryRoot: empty,
        path: "blank.ts",
        selector: "function:analyzeContractImpact",
      });
      assert.equal(resolution.status, "not_checked");
      assert.equal(resolution.reason, "no_symbols_extracted");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }

    // A resolvable declared kind does get checked, kind-agnostically.
    const found = resolveSelector({
      repositoryRoot: root,
      path: "src/fixture.ts",
      selector: "tool:searchSemantic",
      vocabulary,
    });
    assert.equal(found.status, "resolved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("treats an unusable selector as not_checked rather than a missing symbol", () => {
  const root = fixtureRoot();
  try {
    const resolution = resolveSelector({
      repositoryRoot: root,
      path: "src/fixture.ts",
      selector: "func:analyzeContractImpact",
    });
    assert.equal(resolution.status, "not_checked");
    assert.equal(resolution.reason, "invalid_selector");
    assert.match(resolution.detail, /unknown selector kind 'func'/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

report();
