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
import {
  EphemeralTopologyGenerationCache,
  buildCommittedTopologyGeneration,
  buildPersistedBaseWorkspaceRoles,
  buildTopologyRoles,
  buildWorkspaceTopologyGeneration,
  compareTopologyGenerations,
  loadPersistedTopologyGeneration,
  persistCommittedTopologyGeneration,
  type TopologyGenerationComparison,
} from "../src/contract/topology-generation.js";
import type { CompleteCodeTopologyGeneration } from "../src/domain/code-topology-store.js";
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
  write("src/unique.ts", "export const uniquelyRenamed = 1;\n");
  write(
    "src/owned.rs",
    "pub trait Service { fn run(&self); }\npub struct Worker;\nimpl Service for Worker { fn run(&self) {} }\n"
  );
  git(["add", "."]);
  git(["commit", "-qm", "fixture"]);

  let baseline!: CompleteCodeTopologyGeneration;

  await test("builds deterministic committed generations from the exact Git tree", async () => {
    baseline = await committed();
    const repeated = await committed();
    assert.equal(baseline.header.revision, git(["rev-parse", "HEAD^{tree}"]));
    assert.notEqual(baseline.header.revision, git(["rev-parse", "HEAD"]));
    assert.equal(repeated.header.identity, baseline.header.identity);
    assert.deepEqual(repeated, baseline);
    assert.equal(compareTopologyGenerations(baseline, repeated).files.length, 0);
    assert.ok(baseline.edges.length > 0);
    assert.equal(baseline.references.length, baseline.resolutions.length);
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
