import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import postgres from "postgres";
import { PostgresCodeTopologyRepository } from "../src/adapters/postgres/code-topology-repository.js";
import { migrateDatabase } from "../src/commands/migrate.js";
import { analyzeCodeBlastRadius } from "../src/contract/code-blast-radius.js";
import { traceCodeTopology, type CodeTopologyLocator } from "../src/contract/code-topology.js";
import { ImmutableCodeTopologySnapshotStore } from "../src/contract/compact-code-topology-store.js";
import {
  buildCommittedTopologyReadModel,
  EphemeralTopologyReadModelCache,
  buildCommittedTopologyGeneration,
  persistCommittedTopologyGeneration,
} from "../src/contract/topology-generation.js";
import { compileContractManifest } from "../src/contract/manifest.js";
import {
  type CompleteCodeTopologyGeneration,
} from "../src/domain/code-topology-store.js";

const MIB = 1024 * 1024;
const FULL_FILES = 5_000;
const FULL_BYTES = 50 * MIB;
const SYMBOLS_PER_FILE = 20; // 19 declarations plus the synthetic file module.
const EDGES_PER_FILE = 50;
const PERSISTENCE_BUDGET_MS = 150_000;
const enforce = process.env.TIELINE_ENFORCE_RELEASE_BUDGETS === "1";
const pinnedEnvironment =
  process.platform === "linux" && process.arch === "x64" && process.versions.node.startsWith("20.");
const requestedScale = Number(process.env.TIELINE_TOPOLOGY_BENCHMARK_SCALE ?? (enforce ? "1" : "0.02"));
assert.equal(
  typeof global.gc,
  "function",
  "topology benchmark requires Node --expose-gc so scaling samples cannot contaminate RSS gates"
);
if (!Number.isFinite(requestedScale) || requestedScale <= 0 || requestedScale > 1) {
  throw new Error("TIELINE_TOPOLOGY_BENCHMARK_SCALE must be greater than zero and at most one.");
}
if (enforce) {
  assert.ok(pinnedEnvironment, "topology release budget enforcement requires Ubuntu x64 Node 20");
  assert.equal(requestedScale, 1, "topology release budget enforcement requires the full fixture");
}

interface Level {
  name: "1x" | "2x" | "4x";
  fraction: number;
  files: number;
  bytes: number;
  root: string;
}

interface TimedBuild {
  generation: CompleteCodeTopologyGeneration;
  retainedBytes: number;
  elapsedMs: number;
  peakRssBytes: number;
  rssGrowthBytes: number;
}

interface TimedReadBuild {
  readModel: import("../src/domain/code-topology-store.js").CodeTopologyReadModelGeneration;
  elapsedMs: number;
  peakRssBytes: number;
  rssGrowthBytes: number;
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function sourceFor(index: number, files: number, targetBytes: number): string {
  const imports = Array.from({ length: EDGES_PER_FILE }, (_, edge) => {
    const target = (index + edge + 1) % files;
    return `import { symbol0 as dependency${edge} } from "./module-${String(target).padStart(5, "0")}";`;
  }).join("\n");
  const declarations = Array.from(
    { length: SYMBOLS_PER_FILE - 1 },
    (_, symbol) => `export const symbol${symbol} = ${index + symbol};`
  ).join("\n");
  const prefix = `${imports}\n${declarations}\n`;
  const remaining = targetBytes - Buffer.byteLength(prefix);
  if (remaining < 4) throw new Error(`fixture source budget is too small: ${targetBytes}`);
  return `${prefix}/*${"x".repeat(remaining - 4)}*/`;
}

function writeLevel(repositoryRoot: string, level: Level): void {
  const sourceRoot = join(repositoryRoot, level.root);
  mkdirSync(sourceRoot, { recursive: true });
  const baseBytes = Math.floor(level.bytes / level.files);
  let remainder = level.bytes % level.files;
  for (let index = 0; index < level.files; index += 1) {
    const bytes = baseBytes + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
    writeFileSync(
      join(sourceRoot, `module-${String(index).padStart(5, "0")}.ts`),
      sourceFor(index, level.files, bytes)
    );
  }
}

async function timedBuild(input: {
  repositoryRoot: string;
  repository: string;
  revision: string;
  sourceRoot: string;
}): Promise<TimedBuild> {
  const rssBefore = process.memoryUsage().rss;
  let peakRssBytes = rssBefore;
  const sampler = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }, 10);
  const started = performance.now();
  try {
    const result = await buildCommittedTopologyGeneration({
      repositoryRoot: input.repositoryRoot,
      repository: input.repository,
      revision: input.revision,
      sourceRoots: [input.sourceRoot],
    });
    assert.equal(result.status, "complete");
    if (result.status !== "complete") throw new Error(result.detail);
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    return {
      generation: result.generation,
      retainedBytes: result.retained_bytes,
      elapsedMs: performance.now() - started,
      peakRssBytes,
      rssGrowthBytes: peakRssBytes - rssBefore,
    };
  } finally {
    clearInterval(sampler);
  }
}

async function timedReadBuild(input: {
  repositoryRoot: string;
  repository: string;
  revision: string;
  sourceRoot: string;
}): Promise<TimedReadBuild> {
  const rssBefore = process.memoryUsage().rss;
  let peakRssBytes = rssBefore;
  const sampler = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }, 10);
  const started = performance.now();
  try {
    const result = await buildCommittedTopologyReadModel({
      repositoryRoot: input.repositoryRoot,
      repository: input.repository,
      revision: input.revision,
      sourceRoots: [input.sourceRoot],
    });
    assert.equal(result.status, "complete");
    if (result.status !== "complete") throw new Error(result.detail);
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    return {
      readModel: result.read_model,
      elapsedMs: performance.now() - started,
      peakRssBytes,
      rssGrowthBytes: peakRssBytes - rssBefore,
    };
  } finally {
    clearInterval(sampler);
  }
}

async function populateWorkspaceCache(
  cache: EphemeralTopologyReadModelCache,
  input: {
    repositoryRoot: string;
    repository: string;
    revision: string;
    sourceRoot: string;
  }
): Promise<void> {
  const result = await buildCommittedTopologyReadModel({
    repositoryRoot: input.repositoryRoot,
    repository: input.repository,
    revision: input.revision,
    sourceRoots: [input.sourceRoot],
  });
  if (result.status !== "complete") throw new Error(result.detail);
  await cache.getOrBuild("eviction-fixture", async () => ({
    ...result,
    source_kind: "workspace",
  }));
}

const repositoryRoot = mkdtempSync(join(tmpdir(), "tieline-topology-benchmark-"));
const repository = "topology-release-fixture";
const levels: Level[] = [
  { name: "1x", fraction: 0.25, files: 0, bytes: 0, root: "scale-1/src" },
  { name: "2x", fraction: 0.5, files: 0, bytes: 0, root: "scale-2/src" },
  { name: "4x", fraction: 1, files: 0, bytes: 0, root: "scale-4/src" },
].map((level) => ({
  ...level,
  files: Math.max(4, Math.round(FULL_FILES * requestedScale * level.fraction)),
  bytes: Math.max(64 * 1024, Math.round(FULL_BYTES * requestedScale * level.fraction)),
}));

let sql: ReturnType<typeof postgres> | null = null;
try {
  for (const level of levels) writeLevel(repositoryRoot, level);
  mkdirSync(join(repositoryRoot, ".tieline/spec"), { recursive: true });
  const full = levels[2]!;
  const densePath = `${full.root}/module-00000.ts`;
  writeFileSync(join(repositoryRoot, ".tieline/spec/topology.yaml"), `version: 1
capability:
  key: BENCHMARK
  name: Topology benchmark
  description: Deterministic traversal and intent-join fixture.
  stories:
    - key: BENCHMARK-001
      title: Measure bounded topology
      actor: release engineer
      goal: verify topology budgets
      benefit: regressions are visible before release
      lifecycle: production
      acceptance_criteria:
        - key: BENCHMARK-001-AC1
          criterion: Tieline must return a bounded advisory traversal for the benchmark locator.
          links:
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: ${repository}
                path: ${densePath}
                selector: const:symbol0
`);
  git(repositoryRoot, ["init", "-q"]);
  git(repositoryRoot, ["config", "user.email", "topology-benchmark@example.test"]);
  git(repositoryRoot, ["config", "user.name", "Topology Benchmark"]);
  git(repositoryRoot, ["add", "."]);
  git(repositoryRoot, ["commit", "-qm", "base fixture"]);

  const scaling: Array<{ name: string; files: number; bytes: number; symbols: number; edges: number; elapsed_ms: number; rss_growth_bytes: number }> = [];
  for (const level of levels.slice(0, 2)) {
    const measured = JSON.parse(execFileSync(
      process.execPath,
      ["--expose-gc", "--import", "tsx", join(process.cwd(), "scripts/benchmark-code-topology-scale.ts")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          TIELINE_SCALE_REPOSITORY_ROOT: repositoryRoot,
          TIELINE_SCALE_REPOSITORY: repository,
          TIELINE_SCALE_SOURCE_ROOT: level.root,
          TIELINE_SCALE_REVISION: "HEAD",
        },
      }
    )) as { files: number; symbols: number; edges: number; elapsed_ms: number; rss_growth_bytes: number };
    scaling.push({
      name: level.name,
      files: measured.files,
      bytes: level.bytes,
      symbols: measured.symbols,
      edges: measured.edges,
      elapsed_ms: measured.elapsed_ms,
      rss_growth_bytes: measured.rss_growth_bytes,
    });
  }
  global.gc();
  await new Promise((resolveWaiter) => setTimeout(resolveWaiter, 10));
  const baseCurrentRssBaseline = process.memoryUsage().rss;
  let base: TimedReadBuild | null = await timedReadBuild({
    repositoryRoot,
    repository,
    revision: "HEAD",
    sourceRoot: full.root,
  });
  const baseCounts = base.readModel.summary.counts;
  const baseProjectionDigest = base.readModel.projection_digest;
  const baseElapsedMs = base.elapsedMs;
  const basePeakRssBytes = base.peakRssBytes;
  const baseRssGrowthBytes = base.rssGrowthBytes;
  const readStore = new ImmutableCodeTopologySnapshotStore();
  readStore.addReadModel(base.readModel);
  let rolePeakRssBytes = Math.max(basePeakRssBytes, process.memoryUsage().rss);
  scaling.push({
    name: full.name,
    files: baseCounts.files,
    bytes: full.bytes,
    symbols: baseCounts.symbols,
    edges: baseCounts.edges,
    elapsed_ms: baseElapsedMs,
    rss_growth_bytes: baseRssGrowthBytes,
  });
  global.gc();
  await new Promise((resolveWaiter) => setTimeout(resolveWaiter, 10));
  const baseRetainedMemory = process.memoryUsage();
  assert.equal(base.readModel.files.length, full.files);
  assert.equal(base.readModel.symbols.length, full.files * SYMBOLS_PER_FILE);
  assert.equal(base.readModel.edges.length, full.files * EDGES_PER_FILE);
  base = null;
  global.gc();
  await new Promise((resolveWaiter) => setTimeout(resolveWaiter, 10));

  const changedFile = join(repositoryRoot, full.root, "module-00000.ts");
  const changedSource = readFileSync(changedFile, "utf8");
  const marker = changedSource.lastIndexOf("x");
  assert.ok(marker >= 0);
  writeFileSync(changedFile, `${changedSource.slice(0, marker)}y${changedSource.slice(marker + 1)}`);
  git(repositoryRoot, ["add", changedFile]);
  git(repositoryRoot, ["commit", "-qm", "current fixture"]);
  let current: TimedReadBuild | null = await timedReadBuild({ repositoryRoot, repository, revision: "HEAD", sourceRoot: full.root });
  assert.equal(current.readModel.symbols.length, full.files * SYMBOLS_PER_FILE);
  assert.equal(current.readModel.edges.length, full.files * EDGES_PER_FILE);
  const currentProjectionDigest = current.readModel.projection_digest;
  const currentIdentity = current.readModel.summary.header.identity;
  const currentElapsedMs = current.elapsedMs;
  const currentRetainedBytes = current.readModel.retained_bytes;
  const currentPeakRssBytes = current.peakRssBytes;
  readStore.addReadModel(current.readModel);
  rolePeakRssBytes = Math.max(rolePeakRssBytes, currentPeakRssBytes, process.memoryUsage().rss);
  global.gc();
  await new Promise((resolveWaiter) => setTimeout(resolveWaiter, 10));
  const pairRetainedMemory = process.memoryUsage();

  const manifest = compileContractManifest({
    repositoryRoot,
    repositoryKey: repository,
    specDirectory: ".tieline/spec",
  });
  const denseLocator: CodeTopologyLocator = {
    repository,
    kind: "code",
    path: densePath,
    selector: "const:symbol0",
    framework_hint: null,
  };
  const sparseLocator: CodeTopologyLocator = { ...denseLocator, selector: "const:symbol18" };
  const traversalTimes: number[] = [];
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const started = performance.now();
    const [dense, sparse] = await Promise.all([
      analyzeCodeBlastRadius({
        current: { store: readStore, generation_identity: currentIdentity },
        manifest,
        changes: [{ status: "modified", locator: denseLocator }],
      }),
      traceCodeTopology({
        store: readStore,
        generation_identity: currentIdentity,
        locator: sparseLocator,
        direction: "dependents",
      }),
    ]);
    assert.equal(dense.status, "complete");
    assert.equal(sparse.status, "complete");
    if (dense.status === "complete") {
      assert.ok(dense.intent_impacts.some((impact) => impact.semantic_support === "not_assessed"));
    }
    traversalTimes.push(performance.now() - started);
  }
  traversalTimes.sort((left, right) => left - right);

  current = null;
  readStore.dispose();
  global.gc();
  await new Promise((resolveWaiter) => setTimeout(resolveWaiter, 10));
  const heapBeforeCache = process.memoryUsage().heapUsed;
  const cache = new EphemeralTopologyReadModelCache();
  await populateWorkspaceCache(cache, {
    repositoryRoot,
    repository,
    revision: "HEAD",
    sourceRoot: levels[0]!.root,
  });
  global.gc();
  await new Promise((resolveWaiter) => setTimeout(resolveWaiter, 10));
  const heapWithCache = process.memoryUsage().heapUsed;
  assert.equal(cache.stats().entries, 1);
  cache.dispose();
  global.gc?.();
  await new Promise((resolveWaiter) => setTimeout(resolveWaiter, 10));
  const heapAfterEviction = process.memoryUsage().heapUsed;

  let persistenceMs: number | null = null;
  let persistenceStatus = "skipped_missing_postgres";
  const adminUrl = process.env.DATABASE_URL_ADMIN;
  if (adminUrl) {
    await migrateDatabase(adminUrl);
    sql = postgres(adminUrl, { max: 1, prepare: false });
    await sql`insert into repositories (key, display_name) values (${repository}, ${repository}) on conflict (key) do nothing`;
    const topology = new PostgresCodeTopologyRepository(() => sql!, () => sql!, () => sql!);
    const persistenceBuild = await timedBuild({
      repositoryRoot,
      repository,
      revision: "HEAD",
      sourceRoot: full.root,
    });
    const started = performance.now();
    const result = await persistCommittedTopologyGeneration({
      store: topology,
      result: {
        status: "complete",
        source_kind: "committed",
        generation: persistenceBuild.generation,
        retained_bytes: persistenceBuild.retainedBytes,
      },
      expectedPreviousGenerationIdentity: null,
    });
    persistenceMs = performance.now() - started;
    if (enforce) assert.equal(result.outcome, "inserted", "fresh release persistence must write the complete generation");
    else assert.ok(result.outcome === "inserted" || result.outcome === "existing");
    persistenceStatus = "measured";
  }

  global.gc?.();
  await new Promise((resolveWaiter) => setTimeout(resolveWaiter, 10));

  const measurements = {
    node: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
    fixture_scale: requestedScale,
    fixture: {
      files: full.files,
      source_bytes: full.bytes,
      symbols: baseCounts.symbols,
      edges: baseCounts.edges,
      retained_graph_bytes: currentRetainedBytes,
    },
    base_projection_digest: baseProjectionDigest,
    current_projection_digest: currentProjectionDigest,
    generation_ms: baseElapsedMs,
    current_generation_ms: currentElapsedMs,
    sequential_base_current_ms: baseElapsedMs + currentElapsedMs,
    peak_rss_growth_bytes: rolePeakRssBytes - baseCurrentRssBaseline,
    base_current_rss_baseline_bytes: baseCurrentRssBaseline,
    generation_memory: {
      base_peak_rss_growth_bytes: basePeakRssBytes - baseCurrentRssBaseline,
      base_retained_rss_growth_bytes: baseRetainedMemory.rss - baseCurrentRssBaseline,
      base_retained_heap_bytes: baseRetainedMemory.heapUsed,
      base_retained_external_bytes: baseRetainedMemory.external,
      base_retained_array_buffer_bytes: baseRetainedMemory.arrayBuffers,
      base_transient_rss_bytes: Math.max(0, basePeakRssBytes - baseRetainedMemory.rss),
      pair_peak_rss_growth_bytes: currentPeakRssBytes - baseCurrentRssBaseline,
      pair_retained_rss_growth_bytes: pairRetainedMemory.rss - baseCurrentRssBaseline,
      pair_retained_heap_bytes: pairRetainedMemory.heapUsed,
      pair_retained_external_bytes: pairRetainedMemory.external,
      pair_retained_array_buffer_bytes: pairRetainedMemory.arrayBuffers,
      current_transient_rss_bytes: Math.max(0, currentPeakRssBytes - pairRetainedMemory.rss),
    },
    scaling,
    scaling_ratios: {
      four_to_one: scaling[2]!.elapsed_ms / scaling[0]!.elapsed_ms,
      four_to_two: scaling[2]!.elapsed_ms / scaling[1]!.elapsed_ms,
    },
    traversal: {
      samples: traversalTimes.length,
      median_ms: percentile(traversalTimes, 0.5),
      p95_ms: percentile(traversalTimes, 0.95),
      worst_ms: percentile(traversalTimes, 1),
    },
    cache_heap: {
      before_bytes: heapBeforeCache,
      with_entry_bytes: heapWithCache,
      after_eviction_bytes: heapAfterEviction,
      retained_growth_bytes: heapAfterEviction - heapBeforeCache,
      gc_available: typeof global.gc === "function",
    },
    persistence: { status: persistenceStatus, elapsed_ms: persistenceMs },
    enforcement: enforce && pinnedEnvironment ? "enforced" : "measure_only",
  };

  process.stdout.write(`${JSON.stringify(measurements, null, 2)}\n`);
  if (enforce) {
    assert.deepEqual(measurements.fixture, {
      files: 5_000,
      source_bytes: 50 * MIB,
      symbols: 100_000,
      edges: 250_000,
      retained_graph_bytes: currentRetainedBytes,
    });
    assert.ok(measurements.generation_ms <= 60_000, "one generation exceeds 60 seconds");
    assert.ok(measurements.sequential_base_current_ms <= 120_000, "base/current exceeds 120 seconds");
    assert.ok(measurements.peak_rss_growth_bytes <= 768 * MIB, "peak RSS growth exceeds 768 MiB");
    assert.ok(measurements.traversal.p95_ms <= 500, "traversal plus AC join p95 exceeds 500 ms");
    assert.ok(measurements.traversal.worst_ms <= 2_000, "traversal plus AC join worst exceeds 2 seconds");
    assert.equal(persistenceStatus, "measured", "pinned release gate requires same-host Postgres");
    assert.ok(
      (persistenceMs ?? Infinity) <= PERSISTENCE_BUDGET_MS,
      "bulk persistence exceeds 150 seconds"
    );
    assert.ok(measurements.scaling_ratios.four_to_one < 12, "1x-to-4x scaling trends quadratic");
    assert.ok(measurements.scaling_ratios.four_to_two < 3.5, "2x-to-4x scaling trends quadratic");
  }
} finally {
  if (sql) await sql.end({ timeout: 5 });
  rmSync(repositoryRoot, { recursive: true, force: true });
}
