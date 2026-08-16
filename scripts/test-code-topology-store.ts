import assert from "node:assert/strict";
import {
  codeTopologyFactsDigest,
  codeTopologyGenerationIdentity,
  estimateCodeTopologyGenerationRetainedBytes,
  normalizeCompleteCodeTopologyGeneration,
  normalizeOwnedCompleteCodeTopologyGeneration,
  type CompleteCodeTopologyGeneration,
  type CodeTopologyGenerationHeader,
} from "../src/domain/code-topology-store.js";
import { FakeCodeTopologyStore } from "../src/adapters/fakes/fake-code-topology-store.js";
import { codeTopologyCopyChunks } from "../src/adapters/postgres/code-topology-repository.js";

const digest = (character: string): string => character.repeat(64);

const copyChunks = [...codeTopologyCopyChunks([
  ["alpha\tbeta", null, "line\nbreak"],
  ["oversized", "x".repeat(32)],
], 16)];
assert.ok(copyChunks.length > 1);
assert.ok(copyChunks.every((chunk) => chunk.length <= 16));
assert.equal(
  Buffer.concat(copyChunks).toString("utf8"),
  "alpha\\tbeta\t\\N\tline\\nbreak\noversized\t" + "x".repeat(32) + "\n"
);

function header(
  revision: string,
  overrides: Partial<CodeTopologyGenerationHeader> = {}
): CodeTopologyGenerationHeader {
  const identityFields = {
    repository: "acme/widget",
    revision: revision.repeat(40),
    inventory_digest: digest(revision === "a" ? "1" : "2"),
    parser_compatibility_digest: digest("3"),
    resolver_implementation: "tieline-static-modules@1",
    resolver_configuration_digest: digest("4"),
    topology_schema_version: 1,
    fact_policy_digest: digest("5"),
    ...overrides,
  };
  return {
    ...identityFields,
    identity: codeTopologyGenerationIdentity(identityFields),
  };
}

function generation(
  revision: string,
  overrides: Partial<CompleteCodeTopologyGeneration> = {}
): CompleteCodeTopologyGeneration {
  const generationHeader = header(revision);
  const symbolIdentity = `symbol:${revision}`;
  const referenceIdentity = `reference:${revision}`;
  const value: CompleteCodeTopologyGeneration = {
    header: generationHeader,
    files: [
      {
        path: "src/index.ts",
        kind: "code",
        framework_hint: null,
        language: "typescript",
        source_hash: digest("6"),
        parser_identity: "tree-sitter-typescript@pinned",
        diagnostics: [],
        symbols_truncated: false,
        references_truncated: false,
        diagnostics_truncated: false,
      },
    ],
    symbols: [
      {
        identity: symbolIdentity,
        file_path: "src/index.ts",
        name: "run",
        native_kind: "function_declaration",
        kind: "function",
        canonical_selector: "function:run",
        owner_identity: null,
        owner_chain: [],
        name_range: null,
        body_range: null,
        syntax_status: "exact",
      },
    ],
    references: [
      {
        identity: referenceIdentity,
        file_path: "src/index.ts",
        owner_symbol_identity: symbolIdentity,
        kind: "import",
        native_kind: "import_statement",
        module_specifier: "./dependency.js",
        module_specifier_range: null,
        statement_range: null,
        is_type_only: false,
        bindings: [],
      },
    ],
    resolutions: [
      {
        reference_identity: referenceIdentity,
        status: "unresolved",
        rule: "relative-file",
        resolver_configuration_digest:
          generationHeader.resolver_configuration_digest,
        target_file_path: null,
        target_symbol_identity: null,
        candidate_targets: [],
        diagnostics: ["fixture has no target"],
      },
    ],
    edges: [],
  };
  return { ...value, ...overrides };
}

function normalizeWithLocale(
  value: CompleteCodeTopologyGeneration,
  locale: string
): {
  normalized: CompleteCodeTopologyGeneration;
  ownedNormalized: CompleteCodeTopologyGeneration;
  factsDigest: string;
} {
  const localeCompare = String.prototype.localeCompare;
  const compare = new Intl.Collator(locale).compare;
  String.prototype.localeCompare = function (other: string): number {
    return compare(String(this), other);
  };
  try {
    const owned = structuredClone(value);
    return {
      normalized: normalizeCompleteCodeTopologyGeneration(value),
      ownedNormalized: normalizeOwnedCompleteCodeTopologyGeneration(owned),
      factsDigest: codeTopologyFactsDigest(value),
    };
  } finally {
    String.prototype.localeCompare = localeCompare;
  }
}

const store = new FakeCodeTopologyStore();
const first = generation("a");
const unordered = generation("0", {
  files: [
    { ...generation("0").files[0]!, path: "src/z.ts" },
    { ...generation("0").files[0]!, path: "src/a.ts" },
  ],
});
const defensivelyNormalized = normalizeCompleteCodeTopologyGeneration(unordered);
assert.notEqual(defensivelyNormalized, unordered);
assert.deepEqual(unordered.files.map((file) => file.path), ["src/z.ts", "src/a.ts"]);
assert.deepEqual(defensivelyNormalized.files.map((file) => file.path), ["src/a.ts", "src/z.ts"]);
const owned = structuredClone(unordered);
assert.equal(normalizeOwnedCompleteCodeTopologyGeneration(owned), owned);
assert.deepEqual(owned.files.map((file) => file.path), ["src/a.ts", "src/z.ts"]);

const localeLabels = ["Zeta", "alpha", "Ångström", "äther"];
const localeBase = generation("1");
const localeSensitive = generation("1", {
  files: localeLabels.map((label) => ({
    ...localeBase.files[0]!,
    path: `src/${label}.ts`,
  })),
  symbols: localeLabels.map((label) => ({
    ...localeBase.symbols[0]!,
    identity: `symbol:${label}`,
    file_path: `src/${label}.ts`,
  })),
  references: localeLabels.map((label) => ({
    ...localeBase.references[0]!,
    identity: `reference:${label}`,
    file_path: `src/${label}.ts`,
    owner_symbol_identity: `symbol:${label}`,
  })),
  resolutions: localeLabels.map((label) => ({
    ...localeBase.resolutions[0]!,
    reference_identity: `reference:${label}`,
  })),
  edges: localeLabels.map((label) => ({
    identity: `edge:${label}`,
    kind: "imports",
    source: {
      generation_identity: localeBase.header.identity,
      symbol_identity: `symbol:${label}`,
    },
    target: {
      generation_identity: localeBase.header.identity,
      symbol_identity: `symbol:${label}`,
    },
    reference_identity: `reference:${label}`,
  })),
});
const englishNormalization = normalizeWithLocale(localeSensitive, "en-US");
const swedishNormalization = normalizeWithLocale(localeSensitive, "sv-SE");
assert.deepEqual(
  englishNormalization.normalized,
  swedishNormalization.normalized,
  "persisted topology normalization must not depend on the process locale"
);
assert.deepEqual(
  englishNormalization.ownedNormalized,
  swedishNormalization.ownedNormalized,
  "owned topology normalization must not depend on the process locale"
);
assert.equal(
  englishNormalization.factsDigest,
  swedishNormalization.factsDigest,
  "persisted topology facts digests must not depend on the process locale"
);
assert.ok(
  estimateCodeTopologyGenerationRetainedBytes(first) >
    Buffer.byteLength(JSON.stringify(first)),
  "cache estimate conservatively exceeds serialized wire bytes"
);
const firstCommit = await store.commitGeneration({
  generation: first,
  expected_previous_generation_identity: null,
});
assert.equal(firstCommit.outcome, "inserted");
assert.equal(
  await store.getCurrentGenerationIdentity(first.header.repository),
  first.header.identity
);

const duplicate = await store.commitGeneration({
  generation: first,
  expected_previous_generation_identity: first.header.identity,
});
assert.equal(duplicate.outcome, "existing");

const second = generation("b");
await assert.rejects(
  store.commitGeneration({
    generation: second,
    expected_previous_generation_identity: null,
  }),
  /checkpoint changed/i
);
assert.equal(await store.getGeneration(second.header.identity), null);

const secondCommit = await store.commitGeneration({
  generation: second,
  expected_previous_generation_identity: first.header.identity,
});
assert.equal(secondCommit.outcome, "inserted");

const currentDelete = await store.deleteGenerations({
  repository: second.header.repository,
  generation_identities: [second.header.identity],
});
assert.deepEqual(currentDelete, {
  deleted_generation_identities: [],
  protected_generation_identities: [second.header.identity],
});

assert.equal(
  await store.setGenerationPinned({
    repository: first.header.repository,
    generation_identity: first.header.identity,
    pinned: true,
  }),
  true
);
assert.deepEqual(
  await store.deleteGenerations({
    repository: first.header.repository,
    generation_identities: [first.header.identity],
  }),
  {
    deleted_generation_identities: [],
    protected_generation_identities: [first.header.identity],
  }
);
await store.setGenerationPinned({
  repository: first.header.repository,
  generation_identity: first.header.identity,
  pinned: false,
});
const oldDelete = await store.deleteGenerations({
  repository: first.header.repository,
  generation_identities: [first.header.identity],
});
assert.deepEqual(oldDelete, {
  deleted_generation_identities: [first.header.identity],
  protected_generation_identities: [],
});
assert.equal(await store.getGeneration(first.header.identity), null);

const duplicateResolution = generation("c");
duplicateResolution.resolutions = [
  ...duplicateResolution.resolutions,
  duplicateResolution.resolutions[0],
];
await assert.rejects(
  store.commitGeneration({
    generation: duplicateResolution,
    expected_previous_generation_identity: second.header.identity,
  }),
  /duplicate resolution/i
);

const crossGeneration = generation("d");
crossGeneration.edges = [
  {
    identity: "edge:cross-generation",
    kind: "imports",
    source: {
      generation_identity: crossGeneration.header.identity,
      symbol_identity: crossGeneration.symbols[0].identity,
    },
    target: {
      generation_identity: second.header.identity,
      symbol_identity: second.symbols[0].identity,
    },
    reference_identity: crossGeneration.references[0].identity,
  },
];
await assert.rejects(
  store.commitGeneration({
    generation: crossGeneration,
    expected_previous_generation_identity: second.header.identity,
  }),
  /cross-generation edge/i
);

const mismatched = generation("e");
mismatched.header = {
  ...mismatched.header,
  inventory_digest: digest("9"),
};
await assert.rejects(
  store.commitGeneration({
    generation: mismatched,
    expected_previous_generation_identity: second.header.identity,
  }),
  /identity does not match/i
);

for (const failurePoint of [
  "generation",
  "files",
  "symbols",
  "references",
  "resolutions",
  "edges",
  "promotion",
] as const) {
  const failingStore = new FakeCodeTopologyStore({ failurePoint });
  const candidate = generation("f");
  await assert.rejects(
    failingStore.commitGeneration({
      generation: candidate,
      expected_previous_generation_identity: null,
    }),
    new RegExp(`injected failure after ${failurePoint}`, "i")
  );
  assert.equal(await failingStore.getGeneration(candidate.header.identity), null);
  assert.equal(
    await failingStore.getCurrentGenerationIdentity(candidate.header.repository),
    null
  );
}

console.log("code topology store contract passed");
