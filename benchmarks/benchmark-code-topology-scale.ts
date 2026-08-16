import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { buildCommittedTopologyReadModel } from "../src/contract/topology-generation.js";

const repositoryRoot = process.env.TIELINE_SCALE_REPOSITORY_ROOT;
const repository = process.env.TIELINE_SCALE_REPOSITORY;
const sourceRoot = process.env.TIELINE_SCALE_SOURCE_ROOT;
const revision = process.env.TIELINE_SCALE_REVISION ?? "HEAD";
if (!repositoryRoot || !repository || !sourceRoot) {
  throw new Error("isolated topology scale benchmark is missing repository inputs");
}
assert.equal(typeof global.gc, "function", "isolated topology scale benchmark requires --expose-gc");
global.gc?.();
const rssBefore = process.memoryUsage().rss;
let peakRssBytes = rssBefore;
const sampler = setInterval(() => {
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
}, 10);
const started = performance.now();
try {
  const result = await buildCommittedTopologyReadModel({
    repositoryRoot,
    repository,
    revision,
    sourceRoots: [sourceRoot],
  });
  if (result.status !== "complete") throw new Error(result.detail);
  assert.equal(result.status, "complete");
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  process.stdout.write(JSON.stringify({
    ...result.read_model.summary.counts,
    elapsed_ms: performance.now() - started,
    rss_growth_bytes: peakRssBytes - rssBefore,
  }));
} finally {
  clearInterval(sampler);
}
