import assert from "node:assert/strict";
import {
  CODE_TOPOLOGY_ARTIFACT_FILE,
  artifactReadModel,
  codeTopologyArtifactDigest,
  parseCodeTopologyArtifact,
  serializeCodeTopologyArtifact,
  topologyArtifactFromReadModel,
} from "../src/contract/code-topology-artifact.js";
import { ImmutableCodeTopologySnapshotStore } from "../src/contract/compact-code-topology-store.js";
import { codeTopologyArtifactProjectionDigest } from "../src/domain/code-topology-artifact.js";
import { codeTopologyDerivedEdgeIdentity, codeTopologyGenerationIdentity } from "../src/domain/code-topology-store.js";
import type { CodeTopologyReadModelGeneration } from "../src/domain/code-topology-store.js";
import { report, test } from "./lib/harness.js";

const digest = (value: string): string => value.repeat(64);

function fixture(): CodeTopologyReadModelGeneration {
  const fields = {
    repository: "fixture/repository",
    revision: digest("1"),
    inventory_digest: digest("2"),
    parser_compatibility_digest: digest("3"),
    resolver_implementation: "fixture-resolver@1",
    resolver_configuration_digest: digest("4"),
    topology_schema_version: 1,
    fact_policy_digest: digest("5"),
  };
  const identity = codeTopologyGenerationIdentity(fields);
  const value: CodeTopologyReadModelGeneration = {
    summary: {
      header: { ...fields, identity },
      counts: { files: 4, symbols: 4, references: 3, resolutions: 3, edges: 1 },
    },
    projection_digest: "",
    files: [
      { path: "src/main.ts", kind: "code", framework_hint: null, language: "typescript", source_hash: digest("7") },
      { path: "src/unicode.js", kind: "code", framework_hint: null, language: "javascript", source_hash: digest("8") },
      { path: "src/worker.py", kind: "code", framework_hint: null, language: "python", source_hash: digest("9") },
      { path: "src/lib.rs", kind: "code", framework_hint: null, language: "rust", source_hash: digest("a") },
    ],
    symbols: [
      { identity: "symbol:main", file_path: "src/main.ts", native_kind: "function_declaration", canonical_selector: "function:main", asset_kind: "code", framework_hint: null },
      { identity: "symbol:unicode", file_path: "src/unicode.js", native_kind: "function_declaration", canonical_selector: "function:你好", asset_kind: "code", framework_hint: null },
      { identity: "symbol:worker", file_path: "src/worker.py", native_kind: "function_definition", canonical_selector: "function:worker", asset_kind: "code", framework_hint: null },
      { identity: "symbol:rust", file_path: "src/lib.rs", native_kind: "function_item", canonical_selector: "function:run", asset_kind: "code", framework_hint: null },
    ],
    edges: [{ kind: "imports", source_symbol_identity: "symbol:main", target_symbol_identity: "symbol:worker", reference_identity: "reference:resolved" }],
    frontiers: [
      { reference_identity: "reference:ambiguous", source_symbol_identity: "symbol:unicode", file_path: "src/unicode.js", kind: "import", module_specifier: "./maybe", status: "ambiguous", rule: "relative", candidate_targets: ["src/a.js#symbol:a", "src/b.js#symbol:b"], diagnostics: [] },
      { reference_identity: "reference:external", source_symbol_identity: "symbol:rust", file_path: "src/lib.rs", kind: "import", module_specifier: "crate", status: "external", rule: "crate", candidate_targets: [], diagnostics: ["external dependency"] },
    ],
    retained_bytes: 999_999,
  };
  value.files.sort((left, right) => left.path.localeCompare(right.path));
  value.symbols.sort((left, right) => left.identity.localeCompare(right.identity));
  value.frontiers.sort((left, right) => left.reference_identity.localeCompare(right.reference_identity));
  value.projection_digest = codeTopologyArtifactProjectionDigest(value);
  return value;
}

const logical = fixture();

function mutateGraph(
  serialized: ReturnType<typeof serializeCodeTopologyArtifact>,
  mutate: (graph: any) => void
): ReadonlyMap<string, Buffer> {
  const graph = JSON.parse(serialized.files.get(CODE_TOPOLOGY_ARTIFACT_FILE)!.toString("utf8"));
  mutate(graph);
  return new Map([[CODE_TOPOLOGY_ARTIFACT_FILE, Buffer.from(`${JSON.stringify(graph)}\n`)]]);
}

function advanceGeneration(value: CodeTopologyReadModelGeneration, revision: string): void {
  value.summary.header.revision = revision;
  value.summary.header.identity = codeTopologyGenerationIdentity(value.summary.header);
}

await test("one canonical graph.json round-trips the provider-neutral traversal projection", () => {
  const artifact = topologyArtifactFromReadModel(logical);
  const writes = Array.from({ length: 5 }, () => serializeCodeTopologyArtifact(artifact));
  assert.deepEqual([...writes[0]!.files.keys()], ["graph.json"]);
  assert.ok(writes.every((value) =>
    value.files.get(CODE_TOPOLOGY_ARTIFACT_FILE)!.equals(writes[0]!.files.get(CODE_TOPOLOGY_ARTIFACT_FILE)!)
  ));
  const graph = JSON.parse(writes[0]!.files.get(CODE_TOPOLOGY_ARTIFACT_FILE)!.toString("utf8"));
  assert.deepEqual(graph.edges[0], logical.edges[0], "edge endpoints use stable symbol identities, not generation-scoped wrappers");
  const parsed = parseCodeTopologyArtifact(writes[0]!.files);
  assert.equal(parsed.status, "complete", "detail" in parsed ? parsed.detail : undefined);
  if (parsed.status !== "complete") return;
  assert.equal(parsed.artifact.artifact_digest, codeTopologyArtifactDigest(parsed.artifact));
  assert.deepEqual(artifactReadModel(parsed.artifact), { ...logical, retained_bytes: 0 });
  assert.equal("retained_bytes" in (parsed.artifact as unknown as object), false);
  assert.equal(JSON.stringify(parsed.artifact).includes("acceptance_criteria"), false);
  assert.equal(JSON.stringify(parsed.artifact).includes("body_range"), false);
});

await test("graph reader rejects incompatible, corrupt, and unexpected physical inputs", () => {
  const serialized = serializeCodeTopologyArtifact(topologyArtifactFromReadModel(logical));
  assert.equal(parseCodeTopologyArtifact(mutateGraph(serialized, (graph) => { graph.schema_version = 999; })).status, "incompatible");
  assert.equal(parseCodeTopologyArtifact(mutateGraph(serialized, (graph) => { graph.producer.identity = "unknown_provider"; })).status, "incompatible");
  assert.equal(parseCodeTopologyArtifact(mutateGraph(serialized, (graph) => { graph.counts.files += 1; })).status, "invalid");
  assert.equal(parseCodeTopologyArtifact(mutateGraph(serialized, (graph) => { graph.artifact_digest = digest("0"); })).status, "invalid");
  assert.equal(parseCodeTopologyArtifact(new Map([
    ...serialized.files,
    ["unexpected.json", Buffer.from("{}\n")],
  ])).status, "invalid");
  assert.equal(parseCodeTopologyArtifact(new Map([[CODE_TOPOLOGY_ARTIFACT_FILE, Buffer.from("{}\n")]])).status, "invalid");

  const duplicate = structuredClone(logical);
  duplicate.symbols.push(duplicate.symbols[0]!);
  duplicate.summary.counts.symbols += 1;
  assert.throws(() => serializeCodeTopologyArtifact(topologyArtifactFromReadModel(duplicate)), /duplicate artifact symbol/i);
});

await test("graph reader validates every record before constructing the read model", () => {
  const serialized = serializeCodeTopologyArtifact(topologyArtifactFromReadModel(logical));
  const cases: Array<{ label: string; mutate: (graph: any) => void; detail: RegExp }> = [
    { label: "file metadata", mutate: (graph) => { graph.files[0].source_hash = 7; }, detail: /invalid file record/i },
    { label: "symbol metadata", mutate: (graph) => { graph.symbols[0].identity = false; }, detail: /invalid symbol record/i },
    { label: "edge metadata", mutate: (graph) => { graph.edges[0].reference_identity = ["invalid"]; }, detail: /invalid edge record/i },
    { label: "frontier metadata", mutate: (graph) => { graph.frontiers[0].candidate_targets = [7]; }, detail: /invalid frontier record/i },
    { label: "persistence-only symbol metadata", mutate: (graph) => { graph.symbols[0].body_range = null; }, detail: /unsupported fields/i },
  ];
  for (const candidate of cases) {
    const parsed = parseCodeTopologyArtifact(mutateGraph(serialized, candidate.mutate));
    assert.equal(parsed.status, "invalid", candidate.label);
    assert.match("detail" in parsed ? parsed.detail : "", candidate.detail, candidate.label);
  }
});

await test("artifact-backed store traverses graph.json directly", async () => {
  const parsed = parseCodeTopologyArtifact(serializeCodeTopologyArtifact(topologyArtifactFromReadModel(logical)).files);
  assert.equal(parsed.status, "complete", "detail" in parsed ? parsed.detail : undefined);
  if (parsed.status !== "complete") return;
  const store = new ImmutableCodeTopologySnapshotStore();
  store.addReadModel(artifactReadModel(parsed.artifact));
  assert.deepEqual(await store.listForwardEdges({
    generation_identity: logical.summary.header.identity,
    source_symbol_identities: ["symbol:main"],
  }), [{
    identity: codeTopologyDerivedEdgeIdentity({ referenceIdentity: "reference:resolved", sourceIdentity: "symbol:main", targetIdentity: "symbol:worker" }),
    kind: "imports",
    source: { generation_identity: logical.summary.header.identity, symbol_identity: "symbol:main" },
    target: { generation_identity: logical.summary.header.identity, symbol_identity: "symbol:worker" },
    reference_identity: "reference:resolved",
  }]);
  assert.deepEqual(await store.listDependencyFrontiers({
    generation_identity: logical.summary.header.identity,
    source_symbol_identities: ["symbol:unicode", "symbol:rust"],
  }), logical.frontiers);
});

await test("source edits keep unchanged graph records byte-identical", () => {
  const before = serializeCodeTopologyArtifact(topologyArtifactFromReadModel(logical));
  const edited = structuredClone(logical);
  edited.files.find((file) => file.path === "src/worker.py")!.source_hash = digest("b");
  advanceGeneration(edited, digest("c"));
  edited.projection_digest = codeTopologyArtifactProjectionDigest(edited);
  const after = serializeCodeTopologyArtifact(topologyArtifactFromReadModel(edited));
  assert.deepEqual([...after.files.keys()], [CODE_TOPOLOGY_ARTIFACT_FILE]);
  const beforeLines = new Set(before.files.get(CODE_TOPOLOGY_ARTIFACT_FILE)!.toString("utf8").split("\n"));
  const afterLines = new Set(after.files.get(CODE_TOPOLOGY_ARTIFACT_FILE)!.toString("utf8").split("\n"));
  for (const path of ["src/lib.rs", "src/main.ts", "src/unicode.js"]) {
    assert.ok([...beforeLines].some((line) => line.includes(`\"path\":\"${path}\"`) && afterLines.has(line)));
  }
});

await test("edge and frontier records share one 250,000-record cap", () => {
  const oversized = structuredClone(logical);
  oversized.edges = Array.from({ length: 250_000 }, (_, index) => ({
    ...logical.edges[0]!, reference_identity: `reference:${index}`,
  }));
  assert.throws(() => topologyArtifactFromReadModel(oversized), /shared edge\/frontier limit/i);
});

report();
