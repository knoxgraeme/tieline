import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  CODE_TOPOLOGY_ARTIFACT_INDEX,
  artifactReadModel,
  codeTopologyArtifactDigest,
  parseCodeTopologyArtifact,
  serializeCodeTopologyArtifact,
  topologyArtifactFromReadModel,
} from "../src/contract/code-topology-artifact.js";
import { ImmutableCodeTopologySnapshotStore } from "../src/contract/compact-code-topology-store.js";
import { canonicalCodeTopologyJson, codeTopologyArtifactProjectionDigest } from "../src/domain/code-topology-artifact.js";
import { codeTopologyDerivedEdgeIdentity, codeTopologyGenerationIdentity } from "../src/domain/code-topology-store.js";
import type { CodeTopologyArtifactEnvelope } from "../src/domain/code-topology-artifact.js";
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
  value.projection_digest = codeTopologyArtifactProjectionDigest({
    files: value.files,
    symbols: value.symbols,
    edges: value.edges,
    frontiers: value.frontiers,
  });
  return value;
}

const logical = fixture();

function advanceGeneration(
  value: CodeTopologyReadModelGeneration,
  revision: string
): void {
  value.summary.header.revision = revision;
  value.summary.header.identity = codeTopologyGenerationIdentity(value.summary.header);
}

function shardIndexByPath(serialized: ReturnType<typeof serializeCodeTopologyArtifact>): Map<string, any> {
  const index = JSON.parse(serialized.files.get(CODE_TOPOLOGY_ARTIFACT_INDEX)!.toString("utf8"));
  return new Map(index.shards.map((entry: any) => [entry.file_path, entry]));
}

function serializeIndex(index: any): Buffer {
  const fields = Object.entries(index)
    .filter(([key]) => key !== "shards")
    .sort(([left], [right]) => left.localeCompare(right));
  const lines = ["{"];
  for (const [key, value] of fields) {
    lines.push(`${JSON.stringify(key)}:${canonicalCodeTopologyJson(value)},`);
  }
  lines.push(`${JSON.stringify("shards")}:[`);
  index.shards.forEach((shard: any, offset: number) => {
    lines.push(`${canonicalCodeTopologyJson(shard)}${offset + 1 < index.shards.length ? "," : ""}`);
  });
  lines.push("]", "}");
  return Buffer.from(`${lines.join("\n")}\n`);
}

function withLegacyShardGenerationIdentity(
  serialized: ReturnType<typeof serializeCodeTopologyArtifact>,
  generationIdentity: string
): ReadonlyMap<string, Buffer> {
  const files = new Map(serialized.files);
  const index = JSON.parse(files.get(CODE_TOPOLOGY_ARTIFACT_INDEX)!.toString("utf8"));
  for (const entry of index.shards) {
    const oldName = entry.name;
    const shard = JSON.parse(files.get(oldName)!.toString("utf8"));
    shard.generation_identity = generationIdentity;
    const bytes = Buffer.from(`${canonicalCodeTopologyJson(shard)}\n`);
    const shardDigest = createHash("sha256").update(bytes).digest("hex");
    entry.name = `files/${shardDigest}.json`;
    entry.digest = shardDigest;
    entry.bytes = bytes.byteLength;
    files.delete(oldName);
    files.set(entry.name, bytes);
  }
  files.set(CODE_TOPOLOGY_ARTIFACT_INDEX, serializeIndex(index));
  return files;
}

await test("canonical artifact round-trips the provider-neutral traversal projection", async () => {
  const artifact = topologyArtifactFromReadModel(logical);
  const writes = Array.from({ length: 5 }, () => serializeCodeTopologyArtifact(artifact));
  assert.ok(writes.every((value) =>
    [...value.files].every(([name, bytes]) => bytes.equals(writes[0]!.files.get(name)!))
  ));
  const firstShard = [...writes[0]!.files]
    .find(([name]) => name.startsWith("files/"))![1];
  assert.equal("generation_identity" in JSON.parse(firstShard.toString("utf8")), false);
  const parsed = parseCodeTopologyArtifact(writes[0]!.files);
  assert.equal(parsed.status, "complete", "detail" in parsed ? parsed.detail : undefined);
  if (parsed.status !== "complete") return;
  assert.equal(parsed.artifact.artifact_digest, codeTopologyArtifactDigest(parsed.artifact));
  assert.deepEqual(artifactReadModel(parsed.artifact), { ...logical, retained_bytes: 0 });
  assert.equal("retained_bytes" in (parsed.artifact as unknown as object), false);
  assert.equal(JSON.stringify(parsed.artifact).includes("acceptance_criteria"), false);
  assert.equal(JSON.stringify(parsed.artifact).includes("body_range"), false);
});

await test("artifact reader rejects incompatible and corrupt envelopes", () => {
  const artifact = topologyArtifactFromReadModel(logical);
  const serialized = serializeCodeTopologyArtifact(artifact);
  const mutateIndex = (mutate: (index: any) => void) => {
    const files = new Map(serialized.files);
    const index = JSON.parse(files.get(CODE_TOPOLOGY_ARTIFACT_INDEX)!.toString("utf8"));
    mutate(index);
    files.set(CODE_TOPOLOGY_ARTIFACT_INDEX, serializeIndex(index));
    return files;
  };
  assert.equal(parseCodeTopologyArtifact(mutateIndex((index) => { index.schema_version = 999; })).status, "incompatible");
  assert.equal(parseCodeTopologyArtifact(mutateIndex((index) => { index.producer.identity = "unknown_provider"; })).status, "incompatible");
  assert.equal(parseCodeTopologyArtifact(mutateIndex((index) => { index.counts.files += 1; })).status, "invalid");
  assert.equal(parseCodeTopologyArtifact(mutateIndex((index) => { index.artifact_digest = digest("0"); })).status, "invalid");

  const corruptShard = new Map(serialized.files);
  const shardName = [...corruptShard.keys()].find((name) => name.startsWith("files/"))!;
  corruptShard.set(shardName, Buffer.from("{}\n"));
  assert.equal(parseCodeTopologyArtifact(corruptShard).status, "invalid");

  const duplicate = structuredClone(logical);
  duplicate.symbols.push(duplicate.symbols[0]!);
  assert.throws(() => serializeCodeTopologyArtifact(topologyArtifactFromReadModel(duplicate)), /duplicate artifact symbol/i);

  assert.equal(parseCodeTopologyArtifact(mutateIndex((index) => {
    index.generation.identity = digest("f");
  })).status, "invalid", "root generation changes must invalidate the logical artifact digest");

  const legacy = parseCodeTopologyArtifact(withLegacyShardGenerationIdentity(
    serialized,
    artifact.generation.identity
  ));
  assert.equal(legacy.status, "complete", "legacy v1 shards with generation_identity remain readable");
});

await test("artifact-backed store traverses candidate bytes directly", async () => {
  const parsed = parseCodeTopologyArtifact(serializeCodeTopologyArtifact(topologyArtifactFromReadModel(logical)).files);
  assert.equal(parsed.status, "complete", "detail" in parsed ? parsed.detail : undefined);
  if (parsed.status !== "complete") return;
  const store = new ImmutableCodeTopologySnapshotStore();
  store.addReadModel(artifactReadModel(parsed.artifact));
  assert.deepEqual(await store.listForwardEdges({ generation_identity: logical.summary.header.identity, source_symbol_identities: ["symbol:main"] }), [{
    identity: codeTopologyDerivedEdgeIdentity({ referenceIdentity: "reference:resolved", sourceIdentity: "symbol:main", targetIdentity: "symbol:worker" }),
    kind: "imports",
    source: { generation_identity: logical.summary.header.identity, symbol_identity: "symbol:main" },
    target: { generation_identity: logical.summary.header.identity, symbol_identity: "symbol:worker" },
    reference_identity: "reference:resolved",
  }]);
  assert.deepEqual(
    await store.listDependencyFrontiers({
      generation_identity: logical.summary.header.identity,
      source_symbol_identities: ["symbol:unicode", "symbol:rust"],
    }),
    logical.frontiers
  );
});

await test("stable file shards keep edits and renames local", () => {
  const before = serializeCodeTopologyArtifact(topologyArtifactFromReadModel(logical));
  const beforeShards = shardIndexByPath(before);
  const edited = structuredClone(logical);
  edited.files.find((file) => file.path === "src/worker.py")!.source_hash = digest("b");
  advanceGeneration(edited, digest("c"));
  edited.projection_digest = codeTopologyArtifactProjectionDigest({
    files: edited.files, symbols: edited.symbols, edges: edited.edges, frontiers: edited.frontiers,
  });
  const afterEdit = serializeCodeTopologyArtifact(topologyArtifactFromReadModel(edited));
  const afterEditShards = shardIndexByPath(afterEdit);
  for (const path of ["src/lib.rs", "src/main.ts", "src/unicode.js"]) {
    assert.deepEqual(afterEditShards.get(path), beforeShards.get(path), `edit churned untouched shard '${path}'`);
  }
  const changed = new Set([...before.files.keys(), ...afterEdit.files.keys()].filter((name) =>
    !before.files.get(name)?.equals(afterEdit.files.get(name) ?? Buffer.alloc(0))
  ));
  assert.equal(changed.size, 3, "old/new immutable shards plus the root index change");
  assert.ok([...changed].reduce((bytes, name) =>
    bytes + (before.files.get(name)?.byteLength ?? 0) + (afterEdit.files.get(name)?.byteLength ?? 0), 0
  ) < 2 * 1024 * 1024);

  const renamed = structuredClone(logical);
  renamed.files.find((file) => file.path === "src/worker.py")!.path = "src/renamed.py";
  renamed.symbols.find((symbol) => symbol.file_path === "src/worker.py")!.file_path = "src/renamed.py";
  advanceGeneration(renamed, digest("d"));
  renamed.projection_digest = codeTopologyArtifactProjectionDigest({
    files: renamed.files, symbols: renamed.symbols, edges: renamed.edges, frontiers: renamed.frontiers,
  });
  const afterRename = serializeCodeTopologyArtifact(topologyArtifactFromReadModel(renamed));
  const afterRenameShards = shardIndexByPath(afterRename);
  for (const path of ["src/lib.rs", "src/unicode.js"]) {
    assert.deepEqual(afterRenameShards.get(path), beforeShards.get(path), `rename churned untouched shard '${path}'`);
  }
  const touched = new Set([...before.files.keys(), ...afterRename.files.keys()].filter((name) =>
    !before.files.get(name)?.equals(afterRename.files.get(name) ?? Buffer.alloc(0))
  ));
  assert.equal(touched.size, 5, "old/new renamed and edge shards plus the root index change");
  assert.ok(touched.size <= 8);
});

await test("edge and frontier records share one 250,000-record cap", () => {
  const oversized = structuredClone(logical);
  oversized.edges = Array.from({ length: 250_000 }, (_, index) => ({
    ...logical.edges[0]!, reference_identity: `reference:${index}`,
  }));
  assert.throws(() => topologyArtifactFromReadModel(oversized), /shared edge\/frontier limit/i);
});

report();
