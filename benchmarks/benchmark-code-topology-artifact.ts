import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { dirname, join } from "node:path";
import {
  CODE_TOPOLOGY_ARTIFACT_MAX_FILE_BYTES,
  artifactReadModel,
  parseCodeTopologyArtifact,
  serializeCodeTopologyArtifact,
  topologyArtifactFromReadModel,
} from "../src/contract/code-topology-artifact.js";
import {
  codeTopologyArtifactProjectionDigest,
} from "../src/domain/code-topology-artifact.js";
import {
  codeTopologyGenerationIdentity,
  type CodeTopologyReadModelGeneration,
} from "../src/domain/code-topology-store.js";

const MIB = 1024 * 1024;
const REVIEW_ENVELOPE_FILES = 1_500;
const REVIEW_ENVELOPE_SYMBOLS = 30_000;
const REVIEW_ENVELOPE_DEPENDENCIES = 75_000;
const enforce = process.env.TIELINE_ENFORCE_RELEASE_BUDGETS === "1";
const pinnedEnvironment = process.platform === "linux" && process.arch === "x64" && process.versions.node.startsWith("20.");
const scale = Number(process.env.TIELINE_ARTIFACT_BENCHMARK_SCALE ?? "1");
const benchmarkMode = process.env.TIELINE_ARTIFACT_BENCHMARK_MODE ?? "all";
if (!Number.isFinite(scale) || scale <= 0 || scale > 1) {
  throw new Error("TIELINE_ARTIFACT_BENCHMARK_SCALE must be greater than zero and at most one.");
}
if (!["size", "memory", "all"].includes(benchmarkMode)) {
  throw new Error("TIELINE_ARTIFACT_BENCHMARK_MODE must be 'size', 'memory', or 'all'.");
}
if (enforce) {
  assert.ok(pinnedEnvironment, "artifact release budgets require Ubuntu x64 Node 20");
  assert.equal(scale, 1, "artifact release budgets require the full fixture");
}

const digest = (value: string): string => value.padEnd(64, value).slice(0, 64);
const identity = (kind: string, value: number): string =>
  `${kind}:${value.toString(16).padStart(64, "0")}`;

type Distribution = "resolved-dense" | "frontier-heavy";
type ArtifactRole = "base" | "current";

interface IsolatedMemoryMeasurement {
  mode: "artifact" | "parse";
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

function fixture(
  distribution: Distribution,
  role: ArtifactRole = "base"
): CodeTopologyReadModelGeneration {
  const fileCount = Math.max(4, Math.round(REVIEW_ENVELOPE_FILES * scale));
  const symbolCount = Math.max(fileCount, Math.round(REVIEW_ENVELOPE_SYMBOLS * scale));
  const dependencyCount = Math.max(fileCount, Math.round(REVIEW_ENVELOPE_DEPENDENCIES * scale));
  const fields = {
    repository: `artifact-${distribution}`,
    revision: digest(distribution === "resolved-dense"
      ? role === "base" ? "1" : "2"
      : role === "base" ? "7" : "8"),
    inventory_digest: digest("3"),
    parser_compatibility_digest: digest("4"),
    resolver_implementation: "tieline-static-modules@benchmark",
    resolver_configuration_digest: digest("5"),
    topology_schema_version: 1,
    fact_policy_digest: digest("6"),
  };
  const generationIdentity = codeTopologyGenerationIdentity(fields);
  const languages = ["javascript", "typescript", "python", "rust"] as const;
  const files = Array.from({ length: fileCount }, (_, index) => ({
    path: `src/${languages[index % languages.length]}/module-${index.toString().padStart(5, "0")}.${["js", "ts", "py", "rs"][index % 4]}`,
    kind: "code" as const,
    framework_hint: null,
    language: languages[index % languages.length]!,
    source_hash: role === "current" && index === 0
      ? digest("9")
      : identity("", index).slice(1),
  }));
  const symbols = Array.from({ length: symbolCount }, (_, index) => ({
    identity: identity("symbol", index),
    file_path: files[index % fileCount]!.path,
    native_kind: index % 20 === 0 ? "source_file" : "function_declaration",
    canonical_selector: index % 20 === 0 ? null : `function:symbol${index % 20}`,
    asset_kind: "code" as const,
    framework_hint: null,
  })).sort((left, right) => left.identity.localeCompare(right.identity));
  const resolvedCount = distribution === "resolved-dense"
    ? dependencyCount
    : Math.floor(dependencyCount / 10);
  const edges = Array.from({ length: resolvedCount }, (_, index) => ({
    kind: "imports",
    source_symbol_identity: symbols[index % symbolCount]!.identity,
    target_symbol_identity: symbols[(index + 20) % symbolCount]!.identity,
    reference_identity: identity("reference", index),
  })).sort((left, right) => [
    left.source_symbol_identity, left.target_symbol_identity, left.reference_identity,
  ].join("\0").localeCompare([
    right.source_symbol_identity, right.target_symbol_identity, right.reference_identity,
  ].join("\0")));
  const frontiers = Array.from({ length: dependencyCount - resolvedCount }, (_, offset) => {
    const index = resolvedCount + offset;
    const source = symbols[index % symbolCount]!;
    return {
      reference_identity: identity("reference", index),
      source_symbol_identity: source.identity,
      file_path: source.file_path,
      kind: "import" as const,
      module_specifier: `external-${index % 100}`,
      status: index % 2 === 0 ? "external" as const : "unresolved" as const,
      rule: "benchmark",
      candidate_targets: [],
      diagnostics: [],
    };
  });
  const value: CodeTopologyReadModelGeneration = {
    summary: {
      header: { ...fields, identity: generationIdentity },
      counts: { files: fileCount, symbols: symbolCount, references: dependencyCount, resolutions: dependencyCount, edges: resolvedCount },
    },
    projection_digest: "",
    files,
    symbols,
    edges,
    frontiers,
    retained_bytes: 0,
  };
  value.projection_digest = codeTopologyArtifactProjectionDigest({ files, symbols, edges, frontiers });
  return value;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function sourceFor(
  distribution: Distribution,
  index: number,
  files: number,
  targetBytes: number
): string {
  const resolvedImports = distribution === "resolved-dense" ? 50 : 5;
  const imports = Array.from({ length: 50 }, (_, edge) => edge < resolvedImports
    ? `import { symbol0 as dependency${edge} } from "./module-${String((index + edge + 1) % files).padStart(5, "0")}";`
    : `import dependency${edge} from "external-${edge}";`
  ).join("\n");
  const declarations = Array.from(
    { length: 19 },
    (_, symbol) => `export const symbol${symbol} = ${index + symbol};`
  ).join("\n");
  const prefix = `${imports}\n${declarations}\n`;
  const remaining = targetBytes - Buffer.byteLength(prefix);
  if (remaining < 4) throw new Error(`memory fixture source budget is too small: ${targetBytes}`);
  return `${prefix}/*${"x".repeat(remaining - 4)}*/`;
}

function writeArtifactDirectory(
  root: string,
  serialized: ReturnType<typeof serializeCodeTopologyArtifact>
): void {
  for (const [name, content] of serialized.files) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

function runMemoryChild(
  environment: NodeJS.ProcessEnv
): IsolatedMemoryMeasurement {
  const helper = join(process.cwd(), "benchmarks/benchmark-code-topology-artifact-memory.ts");
  return JSON.parse(execFileSync(
    process.execPath,
    ["--expose-gc", "--import", "tsx", helper],
    {
      encoding: "utf8",
      env: { ...process.env, ...environment },
      maxBuffer: 10 * 1024 * 1024,
    }
  )) as IsolatedMemoryMeasurement;
}

function measureTwoRoleMemory(distribution: Distribution): {
  artifact_first: IsolatedMemoryMeasurement;
  parse_first: IsolatedMemoryMeasurement;
  peak_improvement_fraction: number;
  retained_improvement_fraction: number;
} {
  const root = mkdtempSync(join(tmpdir(), `tieline-artifact-memory-${distribution}-`));
  try {
    const repositoryRoot = join(root, "repository");
    const sourceRoot = join(repositoryRoot, "src");
    const baseArtifactRoot = join(root, "artifact-base");
    const currentArtifactRoot = join(root, "artifact-current");
    mkdirSync(sourceRoot, { recursive: true });
    const fileCount = Math.max(4, Math.round(REVIEW_ENVELOPE_FILES * scale));
    const sourceBytes = Math.max(64 * 1024, Math.round(50 * MIB * scale));
    const baseBytes = Math.floor(sourceBytes / fileCount);
    let remainder = sourceBytes % fileCount;
    for (let index = 0; index < fileCount; index += 1) {
      const bytes = baseBytes + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
      writeFileSync(
        join(sourceRoot, `module-${String(index).padStart(5, "0")}.ts`),
        sourceFor(distribution, index, fileCount, bytes)
      );
    }
    git(repositoryRoot, ["init", "-q"]);
    git(repositoryRoot, ["config", "user.email", "artifact-memory@example.test"]);
    git(repositoryRoot, ["config", "user.name", "Artifact Memory Benchmark"]);
    git(repositoryRoot, ["add", "src"]);
    git(repositoryRoot, ["commit", "-qm", "base memory fixture"]);
    const baseRevision = git(repositoryRoot, ["rev-parse", "HEAD"]);
    const changedPath = join(sourceRoot, "module-00000.ts");
    const source = readFileSync(changedPath, "utf8");
    const marker = source.lastIndexOf("x");
    assert.ok(marker >= 0, "memory fixture must retain a padding byte for the current role");
    writeFileSync(changedPath, `${source.slice(0, marker)}y${source.slice(marker + 1)}`);
    git(repositoryRoot, ["add", "src/module-00000.ts"]);
    git(repositoryRoot, ["commit", "-qm", "current memory fixture"]);
    const currentRevision = git(repositoryRoot, ["rev-parse", "HEAD"]);

    {
      const baseRole = fixture(distribution, "base");
      const serializedBase = serializeCodeTopologyArtifact(topologyArtifactFromReadModel(baseRole));
      writeArtifactDirectory(baseArtifactRoot, serializedBase);
    }
    global.gc?.();
    {
      const currentRole = fixture(distribution, "current");
      const serializedCurrent = serializeCodeTopologyArtifact(topologyArtifactFromReadModel(currentRole));
      writeArtifactDirectory(currentArtifactRoot, serializedCurrent);
    }
    global.gc?.();

    const artifactFirst = runMemoryChild({
      TIELINE_ARTIFACT_MEMORY_MODE: "artifact",
      TIELINE_ARTIFACT_MEMORY_BASE_ROOT: baseArtifactRoot,
      TIELINE_ARTIFACT_MEMORY_CURRENT_ROOT: currentArtifactRoot,
    });
    const parseFirst = runMemoryChild({
      TIELINE_ARTIFACT_MEMORY_MODE: "parse",
      TIELINE_ARTIFACT_MEMORY_REPOSITORY_ROOT: repositoryRoot,
      TIELINE_ARTIFACT_MEMORY_REPOSITORY: `artifact-${distribution}`,
      TIELINE_ARTIFACT_MEMORY_SOURCE_ROOT: "src",
      TIELINE_ARTIFACT_MEMORY_BASE_REVISION: baseRevision,
      TIELINE_ARTIFACT_MEMORY_CURRENT_REVISION: currentRevision,
    });
    const symbolCount = Math.max(fileCount, Math.round(REVIEW_ENVELOPE_SYMBOLS * scale));
    const dependencyCount = Math.max(fileCount, Math.round(REVIEW_ENVELOPE_DEPENDENCIES * scale));
    const expectedEdges = distribution === "resolved-dense"
      ? dependencyCount
      : Math.floor(dependencyCount / 10);
    const expectedFrontiers = dependencyCount - expectedEdges;
    for (const measurement of [artifactFirst, parseFirst]) {
      assert.equal(measurement.roles.length, 2);
      for (const role of measurement.roles) {
        assert.equal(role.files, fileCount);
        assert.equal(role.symbols, symbolCount);
        assert.equal(role.edges, expectedEdges);
        assert.equal(role.frontiers, expectedFrontiers);
      }
    }
    assert.ok(parseFirst.peak_rss_growth_bytes > 0, "parse-first peak growth must be measurable");
    assert.ok(parseFirst.retained_rss_growth_bytes > 0, "parse-first retained growth must be measurable");
    const peakImprovement = 1 - artifactFirst.peak_rss_growth_bytes / parseFirst.peak_rss_growth_bytes;
    const retainedImprovement = 1 - artifactFirst.retained_rss_growth_bytes / parseFirst.retained_rss_growth_bytes;
    if (enforce) {
      assert.ok(
        artifactFirst.peak_rss_growth_bytes <= 640 * MIB,
        `${distribution} artifact-first peak RSS growth ${artifactFirst.peak_rss_growth_bytes} exceeds 640 MiB`
      );
      assert.ok(
        artifactFirst.retained_rss_growth_bytes <= 512 * MIB,
        `${distribution} artifact-first retained RSS growth ${artifactFirst.retained_rss_growth_bytes} exceeds 512 MiB`
      );
    }
    return {
      artifact_first: artifactFirst,
      parse_first: parseFirst,
      peak_improvement_fraction: peakImprovement,
      retained_improvement_fraction: retainedImprovement,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const output: Record<string, unknown> = {
  environment: { node: process.version, platform: process.platform, arch: process.arch, scale, mode: benchmarkMode },
  protocol: {
    samples: 1,
    artifact: "graph.json",
    file_byte_cap: CODE_TOPOLOGY_ARTIFACT_MAX_FILE_BYTES,
    review_envelope: {
      files: REVIEW_ENVELOPE_FILES,
      symbols: REVIEW_ENVELOPE_SYMBOLS,
      dependency_records: REVIEW_ENVELOPE_DEPENDENCIES,
      selected_source_bytes: 50 * MIB,
    },
  },
  enforcement: enforce && pinnedEnvironment ? "enforced" : "measure_only",
  distributions: {},
};
if (benchmarkMode === "size" || benchmarkMode === "all") {
  for (const distribution of ["resolved-dense", "frontier-heavy"] as const) {
    const model = fixture(distribution);
    const artifact = topologyArtifactFromReadModel(model);
    const started = performance.now();
    let selected: ReturnType<typeof serializeCodeTopologyArtifact> | null = null;
    let selectedError: string | null = null;
    try { selected = serializeCodeTopologyArtifact(artifact); }
    catch (error) { selectedError = error instanceof Error ? error.message : String(error); }
    const compileMs = performance.now() - started;
    let validationMs: number | null = null;
    if (selected) {
      const validateStarted = performance.now();
      const parsed = parseCodeTopologyArtifact(selected.files);
      validationMs = performance.now() - validateStarted;
      assert.equal(parsed.status, "complete", "detail" in parsed ? parsed.detail : undefined);
      if (parsed.status === "complete") {
        assert.equal(artifactReadModel(parsed.artifact).projection_digest, model.projection_digest);
      }
      const repeated = serializeCodeTopologyArtifact(artifact);
      assert.deepEqual(
        [...repeated.files].map(([name, bytes]) => [name, bytes.toString("base64")]),
        [...selected.files].map(([name, bytes]) => [name, bytes.toString("base64")])
      );
      if (enforce) {
        assert.ok(
          selected.total_bytes <= CODE_TOPOLOGY_ARTIFACT_MAX_FILE_BYTES,
          `${distribution} graph.json exceeds the file byte limit`
        );
        assert.equal(selected.files.size, 1, `${distribution} artifact must remain one graph.json`);
        assert.ok(
          compileMs <= 60_000,
          `${distribution} compile ${compileMs.toFixed(1)}ms exceeds 60 seconds`
        );
        assert.ok(
          validationMs <= 10_000,
          `${distribution} validation ${validationMs.toFixed(1)}ms exceeds 10 seconds`
        );
      }
    }
    (output.distributions as Record<string, unknown>)[distribution] = {
      fixture: model.summary.counts,
      frontiers: model.frontiers.length,
      dependency_records: model.edges.length + model.frontiers.length,
      graph_json: selected ? {
          bytes: selected.total_bytes,
          files: selected.files.size,
          largest_file_bytes: Math.max(...[...selected.files.values()].map((file) => file.byteLength)),
          compile_ms: compileMs,
          validation_ms: validationMs,
          passes_64_mib: selected.total_bytes <= CODE_TOPOLOGY_ARTIFACT_MAX_FILE_BYTES,
        } : { error: selectedError },
    };
  }
}
if (benchmarkMode === "memory" || benchmarkMode === "all") {
  global.gc?.();
  for (const distribution of ["resolved-dense", "frontier-heavy"] as const) {
    const previous = (output.distributions as Record<string, Record<string, unknown>>)[distribution] ?? {};
    (output.distributions as Record<string, Record<string, unknown>>)[distribution] = {
      ...previous,
      memory: measureTwoRoleMemory(distribution),
    };
    global.gc?.();
  }
}
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
