import assert from "node:assert/strict";
import { FakeCodeTopologyStore } from "../../support/fakes/fake-code-topology-store.js";
import {
  codeTopologyGenerationIdentity,
  type CompleteCodeTopologyGeneration,
} from "../../../src/domain/code-topology-store.js";
import {
  traceCodeTopology,
  traceCodeTopologyBatch,
  type CodeTopologyLocator,
} from "../../../src/contract/code-topology.js";
import { report, test } from "../../support/harness.js";

const digest = (value: string) => value.repeat(64).slice(0, 64);

function fixture(): CompleteCodeTopologyGeneration {
  const fields = {
    repository: "acme/widget",
    revision: "a".repeat(40),
    inventory_digest: digest("1"),
    parser_compatibility_digest: digest("2"),
    resolver_implementation: "fixture@1",
    resolver_configuration_digest: digest("3"),
    topology_schema_version: 1,
    fact_policy_digest: digest("4"),
  };
  const identity = codeTopologyGenerationIdentity(fields);
  const paths = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"];
  const symbols = paths.map((path, index) => ({
    identity: `symbol:${index}`,
    file_path: path,
    name: path.slice(4, 5).toUpperCase(),
    native_kind: "function_declaration",
    kind: "function" as const,
    canonical_selector: index === 3 ? "function:duplicate" : `function:${path.slice(4, 5)}`,
    owner_identity: null,
    owner_chain: [],
    name_range: null,
    body_range: null,
    syntax_status: "exact" as const,
  }));
  symbols.push({ ...symbols[3]!, identity: "symbol:duplicate" });
  const references = [0, 1, 2, 3].map((index) => ({
    identity: `reference:${index}`,
    file_path: paths[index === 3 ? 2 : index]!,
    owner_symbol_identity: `symbol:${index === 3 ? 2 : index}`,
    kind: "import" as const,
    native_kind: "import_statement",
    module_specifier: index === 3 ? "missing" : `./${index + 1}`,
    module_specifier_range: null,
    statement_range: null,
    is_type_only: false,
    bindings: [],
  }));
  return {
    header: { ...fields, identity },
    files: paths.map((path) => ({
      path,
      kind: "code" as const,
      framework_hint: null,
      language: "typescript" as const,
      source_hash: digest("5"),
      parser_identity: "fixture",
      diagnostics: [],
      symbols_truncated: false,
      references_truncated: false,
      diagnostics_truncated: false,
    })),
    symbols,
    references,
    resolutions: references.map((reference, index) => ({
      reference_identity: reference.identity,
      status: index === 3 ? "unresolved" as const : "resolved" as const,
      rule: "relative-file",
      resolver_configuration_digest: fields.resolver_configuration_digest,
      target_file_path: index === 3 ? null : paths[(index + 1) % 3]!,
      target_symbol_identity: index === 3 ? null : `symbol:${(index + 1) % 3}`,
      candidate_targets: [],
      diagnostics: index === 3 ? ["missing"] : [],
    })),
    edges: [
      ["symbol:0", "symbol:1"],
      ["symbol:1", "symbol:2"],
      ["symbol:2", "symbol:0"],
      ["symbol:0", "symbol:2"],
    ].map(([source, target], index) => ({
      identity: `edge:${index}`,
      kind: "imports",
      source: { generation_identity: identity, symbol_identity: source! },
      target: { generation_identity: identity, symbol_identity: target! },
      reference_identity: `reference:${Math.min(index, 2)}`,
    })),
  };
}

function diamondFixture(): CompleteCodeTopologyGeneration {
  const generation = fixture();
  const paths = [
    "src/root.ts",
    "src/left.ts",
    "src/right.ts",
    "src/join.ts",
    "src/tail.ts",
  ];
  const graph = [
    [0, 1],
    [0, 2],
    [1, 3],
    [2, 3],
    [3, 4],
  ] as const;
  generation.files = paths.map((path) => ({ ...generation.files[0]!, path }));
  generation.symbols = paths.map((path, index) => ({
    ...generation.symbols[0]!,
    identity: `diamond-symbol:${index}`,
    file_path: path,
    name: path.slice(4, -3),
    canonical_selector: `function:${path.slice(4, -3)}`,
  }));
  generation.references = graph.map(([source, target], index) => ({
    ...generation.references[0]!,
    identity: `diamond-reference:${index}`,
    file_path: paths[source]!,
    owner_symbol_identity: `diamond-symbol:${source}`,
    module_specifier: `./${paths[target]!.slice(4, -3)}`,
  }));
  generation.resolutions = graph.map(([, target], index) => ({
    ...generation.resolutions[0]!,
    reference_identity: `diamond-reference:${index}`,
    status: "resolved",
    target_file_path: paths[target]!,
    target_symbol_identity: `diamond-symbol:${target}`,
    diagnostics: [],
  }));
  generation.edges = graph.map(([source, target], index) => ({
    identity: `diamond-edge:${index}`,
    kind: "imports",
    source: {
      generation_identity: generation.header.identity,
      symbol_identity: `diamond-symbol:${source}`,
    },
    target: {
      generation_identity: generation.header.identity,
      symbol_identity: `diamond-symbol:${target}`,
    },
    reference_identity: `diamond-reference:${index}`,
  }));
  return generation;
}

const locator = (path: string, selector: string | null): CodeTopologyLocator => ({
  repository: "acme/widget",
  kind: "code",
  path,
  selector,
  framework_hint: null,
});

const generation = fixture();
const store = new FakeCodeTopologyStore();
await store.commitGeneration({ generation, expected_previous_generation_identity: null });

await test("traverses cycles once in deterministic frontier batches with role-bearing paths", async () => {
  const result = await traceCodeTopology({
    store,
    generation_identity: generation.header.identity,
    generation_role: "current",
    locator: locator("src/a.ts", "function:a"),
    direction: "dependencies",
  });
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.deepEqual(result.visited.map((node) => node.locator.path), ["src/a.ts", "src/b.ts", "src/c.ts"]);
  assert.equal(result.paths.length, 3);
  assert.equal(result.paths.filter((path) => path.nodes.at(-1)?.locator.path === "src/c.ts").length, 2);
  assert.ok(result.paths.every((path) => path.nodes.every((node) => node.generation_role === "current")));
  assert.ok(result.paths.every((path) => path.edges.every((edge) => edge.generation_role === "current")));
  assert.deepEqual(result.truncation.reasons, []);
});

await test("defaults blast traversal callers can reverse dependencies", async () => {
  const result = await traceCodeTopology({
    store,
    generation_identity: generation.header.identity,
    generation_role: "base",
    locator: locator("src/c.ts", "function:c"),
    direction: "dependents",
  });
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.deepEqual(result.visited.map((node) => node.locator.path), ["src/c.ts", "src/b.ts", "src/a.ts"]);
});

await test("reverse traversal ignores outgoing dependency gaps under a tight edge limit", async () => {
  const reverseGeneration = fixture();
  const reverseStore = new FakeCodeTopologyStore();
  await reverseStore.commitGeneration({
    generation: reverseGeneration,
    expected_previous_generation_identity: null,
  });
  let frontierCalls = 0;
  const listDependencyFrontiers = reverseStore.listDependencyFrontiers.bind(reverseStore);
  reverseStore.listDependencyFrontiers = async (...args) => {
    frontierCalls += 1;
    return listDependencyFrontiers(...args);
  };
  const input = {
    store: reverseStore,
    generation_identity: reverseGeneration.header.identity,
    generation_role: "current" as const,
    direction: "dependents" as const,
    limits: { edges: 1 },
  };
  const [single, batch] = await Promise.all([
    traceCodeTopology({ ...input, locator: locator("src/c.ts", "function:c") }),
    traceCodeTopologyBatch({ ...input, locators: [locator("src/c.ts", "function:c")] }),
  ]);
  assert.equal(single.status, "complete");
  assert.equal(batch.status, "complete");
  if (single.status !== "complete" || batch.status !== "complete") return;
  assert.equal(frontierCalls, 0);
  assert.deepEqual(single.frontiers, []);
  assert.deepEqual(single.visited.map((node) => node.locator.path), ["src/c.ts", "src/b.ts"]);
  assert.equal(single.paths.length, 1);
  assert.deepEqual(batch.visited, single.visited);
  assert.deepEqual(batch.paths, single.paths);
  assert.deepEqual(batch.frontiers, single.frontiers);
});

await test("continues every reconvergent route through a diamond tail", async () => {
  const diamondGeneration = diamondFixture();
  const diamondStore = new FakeCodeTopologyStore();
  await diamondStore.commitGeneration({
    generation: diamondGeneration,
    expected_previous_generation_identity: null,
  });
  const input = {
    store: diamondStore,
    generation_identity: diamondGeneration.header.identity,
    generation_role: "current" as const,
    direction: "dependencies" as const,
  };
  const [single, batch] = await Promise.all([
    traceCodeTopology({ ...input, locator: locator("src/root.ts", "function:root") }),
    traceCodeTopologyBatch({ ...input, locators: [locator("src/root.ts", "function:root")] }),
  ]);
  assert.equal(single.status, "complete");
  assert.equal(batch.status, "complete");
  if (single.status !== "complete" || batch.status !== "complete") return;
  const tailRoutes = single.paths
    .filter((path) => path.nodes.at(-1)?.locator.path === "src/tail.ts")
    .map((path) => path.nodes.map((node) => node.locator.path));
  assert.deepEqual(tailRoutes, [
    ["src/root.ts", "src/left.ts", "src/join.ts", "src/tail.ts"],
    ["src/root.ts", "src/right.ts", "src/join.ts", "src/tail.ts"],
  ]);
  assert.deepEqual(batch.visited, single.visited);
  assert.deepEqual(batch.paths, single.paths);
  assert.deepEqual(batch.truncation, single.truncation);
});

await test("reports ambiguous exact locators without choosing a symbol", async () => {
  const result = await traceCodeTopology({
    store,
    generation_identity: generation.header.identity,
    locator: locator("src/d.ts", "function:duplicate"),
  });
  assert.equal(result.status, "ambiguous_start");
  if (result.status === "ambiguous_start") assert.equal(result.matches.length, 2);
});

await test("retains dependency frontiers and applies every limit independently", async () => {
  const frontier = await traceCodeTopology({
    store,
    generation_identity: generation.header.identity,
    locator: locator("src/a.ts", "function:a"),
  });
  assert.equal(frontier.status, "complete");
  if (frontier.status === "complete") {
    assert.equal(frontier.frontiers[0]?.status, "unresolved");
    assert.equal(frontier.frontiers[0]?.module_specifier, "missing");
  }
  for (const [dimension, limits] of [
    ["depth", { depth: 1 }],
    ["nodes", { nodes: 1 }],
    ["edges", { edges: 1 }],
    ["paths", { paths: 1 }],
  ] as const) {
    const limited = await traceCodeTopology({
      store,
      generation_identity: generation.header.identity,
      locator: locator("src/a.ts", "function:a"),
      direction: "dependencies",
      limits,
    });
    assert.equal(limited.status, "complete");
    if (limited.status === "complete") {
      assert.ok(limited.truncation.reasons.includes(dimension), `${dimension} truncation is explicit`);
      assert.ok(limited.truncation[dimension].omitted > 0);
    }
  }
});

await assert.rejects(
  traceCodeTopology({
    store,
    generation_identity: generation.header.identity,
    locator: locator("src/a.ts", "function:a"),
    limits: { depth: 9 },
  }),
  /hard maximum/i
);

await test("batches multiple starts without N+1 locator, symbol, or frontier reads", async () => {
  const batchedStore = new FakeCodeTopologyStore();
  await batchedStore.commitGeneration({ generation, expected_previous_generation_identity: null });
  const calls = { paths: 0, symbols: 0, forward: 0, frontiers: 0 };
  for (const [method, key] of [
    ["listSymbolsByPaths", "paths"],
    ["listSymbolsByIdentities", "symbols"],
    ["listForwardEdges", "forward"],
    ["listDependencyFrontiers", "frontiers"],
  ] as const) {
    const original = batchedStore[method].bind(batchedStore) as (...args: any[]) => Promise<any>;
    (batchedStore[method] as any) = async (...args: any[]) => {
      calls[key] += 1;
      return original(...args);
    };
  }
  const result = await traceCodeTopologyBatch({
    store: batchedStore,
    generation_identity: generation.header.identity,
    locators: [
      locator("src/a.ts", "function:a"),
      locator("src/b.ts", "function:b"),
      locator("src/d.ts", "function:duplicate"),
    ],
  });
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.equal(calls.paths, 1);
  assert.equal(calls.symbols, 1);
  assert.equal(calls.forward, calls.frontiers);
  assert.ok(calls.forward <= result.limits.depth + 1);
  assert.equal(result.start_outcomes.find((outcome) => outcome.locator.path === "src/d.ts")?.status, "ambiguous");
});

await test("keeps single-start and one-item batch traversal semantically identical", async () => {
  const input = {
    store,
    generation_identity: generation.header.identity,
    generation_role: "current" as const,
    direction: "dependencies" as const,
  };
  const [single, batch] = await Promise.all([
    traceCodeTopology({ ...input, locator: locator("src/a.ts", "function:a") }),
    traceCodeTopologyBatch({ ...input, locators: [locator("src/a.ts", "function:a")] }),
  ]);
  assert.equal(single.status, "complete");
  assert.equal(batch.status, "complete");
  if (single.status !== "complete" || batch.status !== "complete") return;
  assert.deepEqual(batch.starts, [single.start]);
  assert.deepEqual(batch.visited, single.visited);
  assert.deepEqual(batch.paths, single.paths);
  assert.deepEqual(batch.frontiers, single.frontiers);
  assert.deepEqual(batch.truncation, single.truncation);
});

await test("shares the edge limit across accepted edges and later dependency frontiers", async () => {
  const input = {
    store,
    generation_identity: generation.header.identity,
    generation_role: "current" as const,
    direction: "dependencies" as const,
    limits: { edges: 2 },
  };
  const [single, batch] = await Promise.all([
    traceCodeTopology({ ...input, locator: locator("src/a.ts", "function:a") }),
    traceCodeTopologyBatch({ ...input, locators: [locator("src/a.ts", "function:a")] }),
  ]);
  assert.equal(single.status, "complete");
  assert.equal(batch.status, "complete");
  if (single.status !== "complete" || batch.status !== "complete") return;
  const acceptedEdges = new Set(batch.paths.flatMap((path) => path.edges.map((edge) => edge.identity)));
  assert.ok(acceptedEdges.size + batch.frontiers.length <= input.limits.edges);
  assert.deepEqual(batch.paths, single.paths);
  assert.deepEqual(batch.frontiers, single.frontiers);
  assert.deepEqual(batch.truncation, single.truncation);
});

await test("reports resolved starting locators omitted by the batch node limit", async () => {
  const result = await traceCodeTopologyBatch({
    store,
    generation_identity: generation.header.identity,
    locators: [
      locator("src/a.ts", "function:a"),
      locator("src/b.ts", "function:b"),
    ],
    limits: { nodes: 1 },
  });
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.equal(result.starts.length, 1);
  assert.equal(result.omitted_starts.length, 1);
  assert.equal(result.omitted_starts[0]?.selector, "function:b");
  assert.ok(result.truncation.nodes.omitted >= result.omitted_starts.length);
});

report();
