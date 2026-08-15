import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const MIB = 1024 * 1024;
const CORPUS_FILES = 116;
const enforce = process.env.TIELINE_ENFORCE_RELEASE_BUDGETS === "1";
const pinnedEnvironment =
  process.platform === "linux" && process.arch === "x64" && process.versions.node.startsWith("20.");

function directoryBytes(path: string): number {
  return readdirSync(path, { withFileTypes: true }).reduce((total, entry) => {
    const child = resolve(path, entry.name);
    return total + (entry.isDirectory() ? directoryBytes(child) : statSync(child).size);
  }, 0);
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

const repositoryRoot = process.cwd();
const corpus = execFileSync(
  "git",
  ["ls-files", "-z", "src", "scripts"],
  { encoding: "buffer" }
)
  .toString("utf8")
  .split("\0")
  .filter((path) => /\.(?:[cm]?js|jsx|[cm]?ts|tsx|pyi?|rs|sql)$/i.test(path))
  .sort()
  .slice(0, CORPUS_FILES);
assert.equal(corpus.length, CORPUS_FILES, `benchmark requires ${CORPUS_FILES} supported source files`);

const projectRoot = mkdtempSync(resolve(tmpdir(), "tieline-parser-benchmark-"));
let tarballPath: string | null = null;
try {
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--ignore-scripts"], { encoding: "utf8" })
  ) as Array<{ filename: string; size: number; unpackedSize: number }>;
  const packageResult = packed[0]!;
  tarballPath = resolve(packageResult.filename);
  writeFileSync(resolve(projectRoot, "package.json"), '{"private":true,"type":"module"}\n');
  execFileSync(
    "npm",
    ["install", "--prefer-offline", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath],
    {
      cwd: projectRoot,
      stdio: "pipe",
      env: { ...process.env, npm_config_ignore_scripts: "true" },
    }
  );
  writeFileSync(resolve(projectRoot, "corpus.json"), `${JSON.stringify(corpus)}\n`);
  const childPath = resolve(projectRoot, "benchmark.mjs");
  writeFileSync(
    childPath,
    `import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { createJavaScriptAnalyzer } from "./node_modules/tieline/dist/contract/code-analysis/javascript.js";
import { createPythonAnalyzer } from "./node_modules/tieline/dist/contract/code-analysis/python.js";
import { createCodeParserRuntime } from "./node_modules/tieline/dist/contract/code-analysis/runtime.js";
import { createRustAnalyzer } from "./node_modules/tieline/dist/contract/code-analysis/rust.js";
import { createSqlAnalyzer } from "./node_modules/tieline/dist/contract/code-analysis/sql.js";
import { supportedCodeLanguages } from "./node_modules/tieline/dist/contract/code-analysis/languages.js";
import { createFilesystemSourceSnapshotReader } from "./node_modules/tieline/dist/contract/source-snapshot.js";
const repositoryRoot = process.env.TIELINE_BENCHMARK_REPOSITORY;
if (!repositoryRoot) throw new Error("missing benchmark repository");
const corpus = JSON.parse(readFileSync("corpus.json", "utf8"));
const started = performance.now();
const runtime = createCodeParserRuntime();
const analyzers = [createJavaScriptAnalyzer({ runtime }), createPythonAnalyzer({ runtime }), createRustAnalyzer({ runtime }), createSqlAnalyzer({ runtime })];
await runtime.initialize();
await Promise.all(supportedCodeLanguages.map((language) => runtime.withParser(language.id, (parser) => {
  const tree = parser.parse(language.smokeSource);
  if (!tree) throw new Error("grammar smoke parse failed: " + language.id);
  tree.delete();
})));
const initializedMs = performance.now() - started;
const reader = createFilesystemSourceSnapshotReader({ repositoryRoot });
const facts = [];
const corpusStarted = performance.now();
for (const path of corpus) {
  const read = reader.read(path);
  if (read.status !== "read" || read.snapshot.language === null) throw new Error(\`unreadable corpus source: \${path}\`);
  const analyzer = analyzers.find((candidate) => candidate.languages.has(read.snapshot.language));
  if (!analyzer) throw new Error(\`no analyzer for \${path}\`);
  const result = await analyzer.analyze(read.snapshot);
  facts.push({ path: result.path, language: result.language, sourceHash: result.sourceHash, symbols: result.symbols, references: result.references, diagnostics: result.diagnostics, truncated: result.truncated, compatibility: result.compatibility });
  reader.release?.(path);
}
const corpusMs = performance.now() - corpusStarted;
for (const analyzer of analyzers) await analyzer.dispose();
reader.dispose?.();
process.stdout.write(JSON.stringify({
  initializedMs,
  corpusMs,
  totalMs: performance.now() - started,
  factDigest: createHash("sha256").update(JSON.stringify(facts)).digest("hex"),
  files: facts.length,
  rssBytes: process.memoryUsage().rss,
}));
`
  );

  const runs = Array.from({ length: 5 }, () =>
    JSON.parse(
      execFileSync(process.execPath, [childPath], {
        cwd: projectRoot,
        encoding: "utf8",
        env: { ...process.env, TIELINE_BENCHMARK_REPOSITORY: repositoryRoot },
      })
    ) as {
      initializedMs: number;
      corpusMs: number;
      totalMs: number;
      factDigest: string;
      files: number;
      rssBytes: number;
    }
  );
  assert.equal(new Set(runs.map((run) => run.factDigest)).size, 1, "five child processes emit identical facts");

  const initialization = runs.map((run) => run.initializedMs).sort((a, b) => a - b);
  const corpusTimes = runs.map((run) => run.corpusMs).sort((a, b) => a - b);
  const parserAssetBytes = directoryBytes(
    resolve(projectRoot, "node_modules/tieline/assets/parsers/web-tree-sitter-0.26.12")
  );
  const installedParserBytes =
    parserAssetBytes + directoryBytes(resolve(projectRoot, "node_modules/web-tree-sitter"));
  const measurements = {
    node: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
    runs: runs.length,
    fact_digest: runs[0]!.factDigest,
    corpus_files: runs[0]!.files,
    parser_asset_bytes: parserAssetBytes,
    packed_tarball_bytes: packageResult.size,
    packed_unpacked_bytes: packageResult.unpackedSize,
    installed_parser_bytes: installedParserBytes,
    initialization_ms: initialization,
    initialization_median_ms: percentile(initialization, 0.5),
    initialization_worst_ms: percentile(initialization, 1),
    corpus_ms: corpusTimes,
    corpus_median_ms: percentile(corpusTimes, 0.5),
    corpus_worst_ms: percentile(corpusTimes, 1),
    peak_child_rss_bytes: Math.max(...runs.map((run) => run.rssBytes)),
    enforcement: enforce && pinnedEnvironment ? "enforced" : "measure_only",
  };

  process.stdout.write(`${JSON.stringify(measurements, null, 2)}\n`);
  if (enforce) {
    assert.ok(pinnedEnvironment, "release budget enforcement requires pinned Ubuntu x64 Node 20");
    assert.ok(parserAssetBytes <= 8 * MIB, "parser assets exceed 8 MiB");
    assert.ok(packageResult.size <= 7 * MIB, "packed package delta exceeds 7 MiB");
    assert.ok(installedParserBytes <= 13 * MIB, "production parser install exceeds 13 MiB");
    assert.ok(measurements.initialization_median_ms <= 2_000, "median parser load exceeds 2 seconds");
    assert.ok(measurements.initialization_worst_ms <= 4_000, "worst parser load exceeds 4 seconds");
    assert.ok(
      measurements.corpus_median_ms <= 1_500,
      "median 116-file corpus parse/query exceeds 1.5 seconds"
    );
    assert.ok(
      measurements.corpus_worst_ms <= 2_000,
      "worst 116-file corpus parse/query exceeds 2 seconds"
    );
  }
} finally {
  if (tarballPath) rmSync(tarballPath, { force: true });
  rmSync(projectRoot, { recursive: true, force: true });
}
