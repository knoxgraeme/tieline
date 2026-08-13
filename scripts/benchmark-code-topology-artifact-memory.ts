import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { join } from "node:path";

type MemoryMode = "artifact" | "parse";

interface MemoryMeasurement {
  mode: MemoryMode;
  module_start_rss_bytes: number;
  post_module_load_rss_bytes: number;
  peak_rss_bytes: number;
  peak_rss_growth_bytes: number;
  retained_rss_bytes: number;
  retained_rss_growth_bytes: number;
  elapsed_ms: number;
  roles: Array<{
    generation_identity: string;
    files: number;
    symbols: number;
    edges: number;
    frontiers: number;
  }>;
}

const mode = process.env.TIELINE_ARTIFACT_MEMORY_MODE as MemoryMode | undefined;
if (mode !== "artifact" && mode !== "parse") {
  throw new Error("TIELINE_ARTIFACT_MEMORY_MODE must be 'artifact' or 'parse'.");
}
assert.equal(
  typeof global.gc,
  "function",
  "isolated artifact memory measurement requires Node --expose-gc"
);

async function collectGarbage(): Promise<void> {
  for (let iteration = 0; iteration < 3; iteration += 1) {
    global.gc!();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function readArtifactDirectory(root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const name of ["topology.json", ...readdirSync(join(root, "files"))
    .sort()
    .map((entry) => `files/${entry}`)]) {
    files.set(name, readFileSync(join(root, name)));
  }
  return files;
}

await collectGarbage();
const moduleStartRss = process.memoryUsage().rss;

const storeModule = await import("../src/contract/compact-code-topology-store.js");
const store = new storeModule.ImmutableCodeTopologySnapshotStore();
let loadArtifact: ((root: string) => Promise<MemoryMeasurement["roles"][number]>) | null = null;
let loadParseRole: ((revision: string) => Promise<MemoryMeasurement["roles"][number]>) | null = null;

if (mode === "artifact") {
  const artifactModule = await import("../src/contract/code-topology-artifact.js");
  loadArtifact = async (root) => {
    const parsed = artifactModule.readCodeTopologyArtifact(readArtifactDirectory(root));
    assert.equal(parsed.status, "complete", "detail" in parsed ? parsed.detail : undefined);
    if (parsed.status !== "complete") throw new Error(parsed.detail);
    const model = parsed.read_model;
    store.addReadModel(model);
    return {
      generation_identity: model.summary.header.identity,
      files: model.files.length,
      symbols: model.symbols.length,
      edges: model.edges.length,
      frontiers: model.frontiers.length,
    };
  };
} else {
  const topologyModule = await import("../src/contract/topology-generation.js");
  const repositoryRoot = process.env.TIELINE_ARTIFACT_MEMORY_REPOSITORY_ROOT;
  const repository = process.env.TIELINE_ARTIFACT_MEMORY_REPOSITORY;
  const sourceRoot = process.env.TIELINE_ARTIFACT_MEMORY_SOURCE_ROOT ?? "src";
  if (!repositoryRoot || !repository) {
    throw new Error("parse-first memory measurement is missing repository inputs.");
  }
  loadParseRole = async (revision) => {
    const result = await topologyModule.buildCommittedTopologyReadModel({
      repositoryRoot,
      repository,
      revision,
      sourceRoots: [sourceRoot],
    });
    assert.equal(result.status, "complete", result.status === "complete" ? undefined : result.detail);
    if (result.status !== "complete") throw new Error(result.detail);
    store.addReadModel(result.read_model);
    return {
      generation_identity: result.read_model.summary.header.identity,
      files: result.read_model.files.length,
      symbols: result.read_model.symbols.length,
      edges: result.read_model.edges.length,
      frontiers: result.read_model.frontiers.length,
    };
  };
}

await collectGarbage();
const postModuleLoadRss = process.memoryUsage().rss;
let peakRss = postModuleLoadRss;
const sample = (): void => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
};
const sampler = setInterval(sample, 5);
const started = performance.now();
const roles: MemoryMeasurement["roles"] = [];
try {
  if (mode === "artifact") {
    const baseRoot = process.env.TIELINE_ARTIFACT_MEMORY_BASE_ROOT;
    const currentRoot = process.env.TIELINE_ARTIFACT_MEMORY_CURRENT_ROOT;
    if (!baseRoot || !currentRoot || !loadArtifact) {
      throw new Error("artifact-first memory measurement is missing artifact roots.");
    }
    roles.push(await loadArtifact(baseRoot));
    sample();
    roles.push(await loadArtifact(currentRoot));
  } else {
    const baseRevision = process.env.TIELINE_ARTIFACT_MEMORY_BASE_REVISION;
    const currentRevision = process.env.TIELINE_ARTIFACT_MEMORY_CURRENT_REVISION;
    if (!baseRevision || !currentRevision || !loadParseRole) {
      throw new Error("parse-first memory measurement is missing revision inputs.");
    }
    roles.push(await loadParseRole(baseRevision));
    sample();
    roles.push(await loadParseRole(currentRevision));
  }
  sample();
} finally {
  clearInterval(sampler);
}

await collectGarbage();
sample();
const retainedRss = process.memoryUsage().rss;
const platformHighWaterBytes = process.resourceUsage().maxRSS * 1024;
peakRss = Math.max(peakRss, platformHighWaterBytes);
const measurement: MemoryMeasurement = {
  mode,
  module_start_rss_bytes: moduleStartRss,
  post_module_load_rss_bytes: postModuleLoadRss,
  peak_rss_bytes: peakRss,
  peak_rss_growth_bytes: Math.max(0, peakRss - postModuleLoadRss),
  retained_rss_bytes: retainedRss,
  retained_rss_growth_bytes: Math.max(0, retainedRss - postModuleLoadRss),
  elapsed_ms: performance.now() - started,
  roles,
};
process.stdout.write(`${JSON.stringify(measurement)}\n`);
