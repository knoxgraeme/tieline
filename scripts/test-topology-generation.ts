import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeCodeTopologyStore } from "../src/adapters/fakes/fake-code-topology-store.js";
import { ImmutableCodeTopologySnapshotStore } from "../src/contract/compact-code-topology-store.js";
import {
  EphemeralTopologyGenerationCache,
  EphemeralTopologyReadModelCache,
  buildCommittedTopologyReadModel,
  buildCommittedTopologyGeneration,
  buildPersistedBaseWorkspaceRoles,
  buildTopologyRoles,
  buildWorkspaceTopologyGeneration,
  buildWorkspaceTopologyReadModel,
  compareTopologyGenerations,
  loadPersistedTopologyGeneration,
  persistCommittedTopologyGeneration,
  type TopologyGenerationComparison,
} from "../src/contract/topology-generation.js";
import {
  codeTopologyGenerationIdentity,
  codeTopologySelectedInputDigest,
  type CompleteCodeTopologyGeneration,
} from "../src/domain/code-topology-store.js";
import { report, test } from "./lib/harness.js";

const root = mkdtempSync(join(tmpdir(), "tieline-topology-"));

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function write(path: string, source: string): void {
  const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (directory) mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, path), source);
}

function options() {
  return {
    repositoryRoot: root,
    repository: "fixture/repository",
    sourceRoots: ["src"],
    ignore: ["node_modules/**"],
  };
}

async function committed(revision = "HEAD"): Promise<CompleteCodeTopologyGeneration> {
  const result = await buildCommittedTopologyGeneration({ ...options(), revision });
  assert.equal(result.status, "complete");
  if (result.status !== "complete") throw new Error(result.detail);
  return result.generation;
}

async function workspace(): Promise<CompleteCodeTopologyGeneration> {
  const result = await buildWorkspaceTopologyGeneration(options());
  assert.equal(result.status, "complete");
  if (result.status !== "complete") throw new Error(result.detail);
  return result.generation;
}

try {
  git(["init", "-q"]);
  git(["config", "user.email", "topology@example.test"]);
  git(["config", "user.name", "Topology Test"]);
  write("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: "." } }));
  write(
    "src/main.ts",
    'import { value } from "./value";\nexport function run() { return value; }\n'
  );
  write("src/value.ts", "export const value = 1;\n");
  write("src/copy-one.ts", "export const identical = 1;\n");
  write("src/copy-two.ts", "export const identical = 1;\n");
  write("src/test_widget.py", "def test_widget():\n    assert True\n");
  write("src/__tests__/widget.ts", "export const widgetWorks = true;\n");
  write("src/unique.ts", "export const uniquelyRenamed = 1;\n");
  write(
    "src/owned.rs",
    "pub trait Service { fn run(&self); }\npub struct Worker;\nimpl Service for Worker { fn run(&self) {} }\n"
  );
  git(["add", "."]);
  git(["commit", "-qm", "fixture"]);

  let baseline!: CompleteCodeTopologyGeneration;

  await test("builds deterministic committed generations from selected inputs", async () => {
    baseline = await committed();
    const repeated = await committed();
    assert.notEqual(baseline.header.revision, git(["rev-parse", "HEAD^{tree}"]));
    assert.notEqual(baseline.header.revision, git(["rev-parse", "HEAD"]));
    assert.equal(
      baseline.header.revision,
      codeTopologySelectedInputDigest(baseline.header)
    );
    assert.equal(repeated.header.identity, baseline.header.identity);
    assert.deepEqual(repeated, baseline);
    assert.equal(compareTopologyGenerations(baseline, repeated).files.length, 0);
    assert.ok(baseline.edges.length > 0);
    assert.equal(baseline.references.length, baseline.resolutions.length);
    assert.equal(
      baseline.files.find((file) => file.path === "src/test_widget.py")?.kind,
      "test"
    );
    assert.equal(
      baseline.files.find((file) => file.path === "src/__tests__/widget.ts")?.kind,
      "test"
    );
  });

  await test("excludes generated topology bytes and enclosing trees from logical identity", async () => {
    const beforeTree = git(["rev-parse", "HEAD^{tree}"]);
    write(".tieline/topology/topology.json", '{"generated":true}\n');
    git(["add", ".tieline/topology/topology.json"]);
    git(["commit", "-qm", "generated topology only"]);
    assert.notEqual(git(["rev-parse", "HEAD^{tree}"]), beforeTree);
    const after = await committed();
    assert.equal(after.header.identity, baseline.header.identity);
    assert.equal(after.header.inventory_digest, baseline.header.inventory_digest);
  });

  await test("path-scopes identical facts and retains synthetic modules and impl owners", () => {
    const copies = baseline.symbols.filter(
      (symbol) =>
        symbol.name === "identical" &&
        (symbol.file_path === "src/copy-one.ts" || symbol.file_path === "src/copy-two.ts")
    );
    assert.equal(copies.length, 2);
    assert.notEqual(copies[0]!.identity, copies[1]!.identity);
    assert.equal(new Set(baseline.symbols.map((symbol) => symbol.identity)).size, baseline.symbols.length);
    assert.ok(
      baseline.symbols.some(
        (symbol) => symbol.file_path === "src/owned.rs" && symbol.native_kind === "impl_item"
      )
    );
    const implMethod = baseline.symbols.find(
      (symbol) =>
        symbol.file_path === "src/owned.rs" &&
        symbol.name === "run" &&
        symbol.owner_identity !== null
    );
    assert.ok(implMethod);
    assert.ok(baseline.symbols.some((symbol) => symbol.identity === implMethod.owner_identity));
    for (const file of baseline.files) {
      assert.ok(
        baseline.symbols.some(
          (symbol) => symbol.file_path === file.path && symbol.native_kind === "source_file"
        )
      );
    }
  });

  await test("direct read models preserve full-generation traversal facts without rich ranges", async () => {
    const result = await buildCommittedTopologyReadModel({
      ...options(),
      revision: "HEAD",
    });
    assert.equal(result.status, "complete");
    if (result.status !== "complete") return;
    const repeated = await buildCommittedTopologyReadModel({
      ...options(),
      revision: "HEAD",
    });
    assert.deepEqual(repeated, result);
    assert.equal(result.read_model.summary.header.identity, baseline.header.identity);
    assert.deepEqual(result.read_model.summary.counts, {
      files: baseline.files.length,
      symbols: baseline.symbols.length,
      references: baseline.references.length,
      resolutions: baseline.resolutions.length,
      edges: baseline.edges.length,
    });

    const rich = new ImmutableCodeTopologySnapshotStore([{
      ...baseline,
      facts_digest: "rich-fixture",
      counts: result.read_model.summary.counts,
      completed_at: "1970-01-01T00:00:00.000Z",
      pinned: false,
    }]);
    const thin = new ImmutableCodeTopologySnapshotStore();
    thin.addReadModel(result.read_model);
    const paths = baseline.files.map((file) => file.path);
    const richSymbols = await rich.listSymbolsByPaths({
      generation_identity: baseline.header.identity,
      paths,
    });
    const thinSymbols = await thin.listSymbolsByPaths({
      generation_identity: baseline.header.identity,
      paths,
    });
    assert.deepEqual(thinSymbols, richSymbols);
    const identities = richSymbols.map((symbol) => symbol.identity);
    assert.deepEqual(
      await thin.listForwardEdges({
        generation_identity: baseline.header.identity,
        source_symbol_identities: identities,
      }),
      await rich.listForwardEdges({
        generation_identity: baseline.header.identity,
        source_symbol_identities: identities,
      })
    );
    assert.deepEqual(
      await thin.listDependencyFrontiers({
        generation_identity: baseline.header.identity,
        source_symbol_identities: identities,
      }),
      await rich.listDependencyFrontiers({
        generation_identity: baseline.header.identity,
        source_symbol_identities: identities,
      })
    );
  });

  await test("persists only committed generations with independent CAS", async () => {
    const store = new FakeCodeTopologyStore();
    const committedResult = await buildCommittedTopologyGeneration({
      ...options(),
      revision: "HEAD",
    });
    const persisted = await persistCommittedTopologyGeneration({
      store,
      result: committedResult,
      expectedPreviousGenerationIdentity: null,
    });
    assert.equal(persisted.outcome, "inserted");
    const duplicate = await persistCommittedTopologyGeneration({
      store,
      result: committedResult,
      expectedPreviousGenerationIdentity: persisted.generation_identity,
    });
    assert.equal(duplicate.outcome, "existing");
    const ephemeral = await buildWorkspaceTopologyGeneration(options());
    await assert.rejects(
      persistCommittedTopologyGeneration({
        store,
        result: ephemeral,
        expectedPreviousGenerationIdentity: persisted.generation_identity,
      }),
      /must remain ephemeral/i
    );
    assert.equal(
      (await loadPersistedTopologyGeneration(store, "f".repeat(64))).status,
      "generation_unavailable"
    );
    const roles = await buildPersistedBaseWorkspaceRoles({
      store,
      baseGenerationIdentity: persisted.generation_identity,
      current: options(),
    });
    assert.equal(roles.status, "complete");
    const missingRoles = await buildPersistedBaseWorkspaceRoles({
      store,
      baseGenerationIdentity: "f".repeat(64),
      current: options(),
    });
    assert.equal(missingRoles.status, "generation_unavailable");
  });

  await test("models dirty modifications, additions, deletions, renames, and config changes", async () => {
    write("src/value.ts", "export const value = 2;\n");
    write("src/added.py", "def added():\n    return True\n");
    unlinkSync(join(root, "src/copy-two.ts"));
    renameSync(join(root, "src/unique.ts"), join(root, "src/renamed.ts"));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: "src" } }));
    const current = await workspace();
    const comparison = compareTopologyGenerations(baseline, current);
    const states = comparison.files.map((file) => `${file.status}:${file.path}`);
    assert.ok(states.includes("modified:src/value.ts"));
    assert.ok(states.includes("added:src/added.py"));
    assert.ok(states.includes("deleted:src/copy-two.ts"));
    assert.ok(states.includes("renamed:src/renamed.ts"));
    assert.equal(comparison.configuration_changed, true);
    assert.equal(comparison.compatibility, "compatible");
    assert.notEqual(current.header.revision, baseline.header.revision);
  });

  await test("builds base then current roles and marks incompatible bases explicitly", async () => {
    const roles = await buildTopologyRoles({
      base: { ...options(), revision: "HEAD" },
      current: options(),
      currentKind: "workspace",
    });
    assert.equal(roles.status, "complete");
    if (roles.status !== "complete") return;
    assert.equal(roles.base.header.identity, baseline.header.identity);
    const incompatible: CompleteCodeTopologyGeneration = structuredClone(roles.base);
    incompatible.header.parser_compatibility_digest = "a".repeat(64);
    const comparison: TopologyGenerationComparison = compareTopologyGenerations(
      incompatible,
      roles.current
    );
    assert.equal(comparison.compatibility, "incompatible");

    const legacy: CompleteCodeTopologyGeneration = structuredClone(roles.base);
    legacy.header.revision = git(["rev-parse", "HEAD~1^{tree}"]);
    legacy.header.resolver_implementation = "tieline-static-modules@1:legacy-fixture";
    legacy.header.identity = codeTopologyGenerationIdentity(legacy.header);
    for (const edge of legacy.edges) {
      edge.source.generation_identity = legacy.header.identity;
      edge.target.generation_identity = legacy.header.identity;
    }
    const legacyStore = new FakeCodeTopologyStore();
    await legacyStore.commitGeneration({
      generation: legacy,
      expected_previous_generation_identity: null,
    });
    assert.equal(
      (await loadPersistedTopologyGeneration(legacyStore, legacy.header.identity)).status,
      "available"
    );
    assert.equal(
      compareTopologyGenerations(legacy, roles.current).compatibility,
      "incompatible"
    );
  });

  await test("retries one workspace mutation then returns workspace_changed", async () => {
    let mutations = 0;
    const result = await buildWorkspaceTopologyGeneration({
      ...options(),
      afterBuildAttempt(attempt) {
        mutations += 1;
        write("src/value.ts", `export const value = ${10 + attempt};\n`);
      },
    });
    assert.equal(mutations, 2);
    assert.equal(result.status, "workspace_changed");
  });

  await test("read-model builds use the same exactly-once workspace retry", async () => {
    let mutations = 0;
    const result = await buildWorkspaceTopologyReadModel({
      ...options(),
      afterBuildAttempt(attempt) {
        mutations += 1;
        write("src/value.ts", `export const value = ${20 + attempt};\n`);
      },
    });
    assert.equal(mutations, 2);
    assert.equal(result.status, "workspace_changed");
  });

  await test("coalesces builds and evicts by entry, byte, and TTL caps", async () => {
    const fixture = await buildWorkspaceTopologyGeneration(options());
    assert.equal(fixture.status, "complete");
    if (fixture.status !== "complete") return;
    let builds = 0;
    let now = 0;
    const cache = new EphemeralTopologyGenerationCache({
      maxEntries: 1,
      maxBytes: fixture.retained_bytes * 2,
      ttlMs: 10,
      now: () => now,
    });
    const builder = async () => {
      builds += 1;
      await Promise.resolve();
      return fixture;
    };
    await Promise.all([
      cache.getOrBuild("same-workspace", builder),
      cache.getOrBuild("same-workspace", builder),
    ]);
    assert.equal(builds, 1);
    await cache.getOrBuild("same-workspace", builder);
    assert.equal(builds, 1);
    const second = structuredClone(fixture);
    second.generation.header.identity = "e".repeat(64);
    await cache.getOrBuild("different-workspace", async () => second);
    assert.equal(cache.stats().entries, 1);
    now = 11;
    assert.equal(cache.stats().entries, 0);
    cache.dispose();
    assert.deepEqual(cache.stats(), { entries: 0, bytes: 0, pending: 0 });
    await assert.rejects(cache.getOrBuild("after-dispose", builder), /disposed/i);

    let releaseBuild!: (value: typeof fixture) => void;
    const delayed = new Promise<typeof fixture>((resolveBuild) => {
      releaseBuild = resolveBuild;
    });
    const disposing = new EphemeralTopologyGenerationCache();
    const inflight = disposing.getOrBuild("inflight", () => delayed);
    disposing.dispose();
    releaseBuild(fixture);
    await inflight;
    assert.deepEqual(disposing.stats(), { entries: 0, bytes: 0, pending: 0 });
  });

  await test("coalesces and bounds the thin runtime projection independently", async () => {
    const fixture = await buildWorkspaceTopologyReadModel(options());
    assert.equal(fixture.status, "complete");
    if (fixture.status !== "complete") return;
    let builds = 0;
    const cache = new EphemeralTopologyReadModelCache({
      maxEntries: 1,
      maxBytes: fixture.retained_bytes * 2,
    });
    const builder = async () => {
      builds += 1;
      await Promise.resolve();
      return fixture;
    };
    const [first, second] = await Promise.all([
      cache.getOrBuild("same-workspace", builder),
      cache.getOrBuild("same-workspace", builder),
    ]);
    assert.equal(builds, 1);
    assert.equal(first.status, "complete");
    assert.equal(second.status, "complete");
    await cache.getOrBuild("same-workspace", builder);
    assert.equal(builds, 1);
    assert.deepEqual(cache.stats(), {
      entries: 1,
      bytes: fixture.retained_bytes,
      pending: 0,
    });
    cache.dispose();
    assert.deepEqual(cache.stats(), { entries: 0, bytes: 0, pending: 0 });
  });

  await test("returns named capacity outcomes", async () => {
    const result = await buildWorkspaceTopologyGeneration({
      ...options(),
      maxFiles: 1,
    });
    assert.equal(result.status, "capacity_exceeded");
    const unavailable = await buildCommittedTopologyGeneration({
      ...options(),
      revision: "missing-topology-revision",
    });
    assert.equal(unavailable.status, "source_unavailable");
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}

report();
