import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { report, test } from "./lib/harness.js";
import { languageForPath, supportedCodeLanguages } from "../src/contract/code-analysis/languages.js";
import { createCodeParserRuntime } from "../src/contract/code-analysis/runtime.js";

function directoryBytes(path: string): number {
  return readdirSync(path, { withFileTypes: true }).reduce((total, entry) => {
    const child = resolve(path, entry.name);
    return total + (entry.isDirectory() ? directoryBytes(child) : statSync(child).size);
  }, 0);
}

console.log("packaged parser compatibility set");

await test("recognizes every supported source extension", () => {
  assert.deepEqual(
    ["source.js", "view.jsx", "source.ts", "view.tsx", "source.py", "source.rs"].map(
      languageForPath
    ),
    ["javascript", "jsx", "typescript", "tsx", "python", "rust"]
  );
});

await test("loads and parses every language from checked-in Wasm assets", async () => {
  const runtime = createCodeParserRuntime();
  const roots = await Promise.all(
    supportedCodeLanguages.map((language) =>
      runtime.withParser(language.id, (parser) => {
        const tree = parser.parse(language.smokeSource);
        assert.ok(tree, `${language.id} produced a syntax tree`);
        try {
          assert.equal(tree.rootNode.hasError, false, `${language.id} parses its smoke source`);
          return tree.rootNode.type;
        } finally {
          tree.delete();
        }
      })
    )
  );
  assert.deepEqual(roots, ["program", "program", "program", "program", "module", "source_file"]);
});

await test("limits concurrent parser ownership and supports repeat use", async () => {
  const runtime = createCodeParserRuntime();
  let active = 0;
  let peak = 0;
  const roots = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      runtime.withParser(supportedCodeLanguages[index % supportedCodeLanguages.length]!.id, async (parser) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolveWaiter) => setTimeout(resolveWaiter, 5));
        const tree = parser.parse("const ready = true;\n");
        assert.ok(tree);
        try {
          return tree.rootNode.type;
        } finally {
          tree.delete();
          active -= 1;
        }
      })
    )
  );
  assert.equal(roots.length, 12);
  assert.ok(peak > 1, "independent parsers can run concurrently");
  assert.ok(peak <= 4, `parser concurrency stayed at four, received ${peak}`);
});

await test("fails closed when a parser asset is missing", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "tieline-parser-assets-"));
  try {
    const runtime = createCodeParserRuntime({ assetRoot: root });
    await assert.rejects(runtime.withParser("typescript", () => undefined), /asset|manifest/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("fails closed for corrupt assets and incompatible ABI manifests", async () => {
  const source = resolve("assets/parsers/web-tree-sitter-0.26.12");
  const corruptRoot = mkdtempSync(resolve(tmpdir(), "tieline-parser-corrupt-"));
  const abiRoot = mkdtempSync(resolve(tmpdir(), "tieline-parser-abi-"));
  try {
    cpSync(source, corruptRoot, { recursive: true });
    writeFileSync(resolve(corruptRoot, "tree-sitter-typescript.wasm"), "corrupt");
    await assert.rejects(
      createCodeParserRuntime({ assetRoot: corruptRoot }).withParser("typescript", () => undefined),
      /integrity mismatch/i
    );

    cpSync(source, abiRoot, { recursive: true });
    const manifestPath = resolve(abiRoot, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.abi.maximum = 99;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(
      createCodeParserRuntime({ assetRoot: abiRoot }).initialize(),
      /ABI.*outside runtime/i
    );
  } finally {
    rmSync(corruptRoot, { recursive: true, force: true });
    rmSync(abiRoot, { recursive: true, force: true });
  }
});

await test("ships an offline-installable parser set without native grammar packages", () => {
  const projectRoot = mkdtempSync(resolve(tmpdir(), "tieline-parser-install-"));
  let tarballPath: string | undefined;
  try {
    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--json", "--ignore-scripts"], { encoding: "utf8" })
    ) as Array<{ filename: string; size: number; files: Array<{ path: string; size: number }> }>;
    const result = packed[0]!;
    tarballPath = resolve(result.filename);
    assert.ok(result.size <= 7 * 1024 * 1024, `tarball is ${result.size} bytes`);
    for (const language of supportedCodeLanguages) {
      const asset = language.artifact === "javascript" ? "tree-sitter-javascript.wasm" : `tree-sitter-${language.artifact}.wasm`;
      assert.ok(
        result.files.some((file) => file.path.endsWith(`/parsers/web-tree-sitter-0.26.12/${asset}`)),
        `${asset} is present in the tarball`
      );
    }
    assert.equal(
      result.files.some((file) => /node_modules|prebuild|\.node$/.test(file.path)),
      false,
      "the package contains no native prebuild collection"
    );

    writeFileSync(resolve(projectRoot, "package.json"), '{"private":true,"type":"module"}\n');
    execFileSync(
      "npm",
      ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath],
      { cwd: projectRoot, stdio: "pipe" }
    );
    const sourceRoot = resolve(projectRoot, "sources");
    mkdirSync(sourceRoot);
    for (const [index, language] of supportedCodeLanguages.entries()) {
      const extension = language.extensions[0]!;
      writeFileSync(resolve(sourceRoot, `source-${index}${extension}`), language.smokeSource);
    }
    const smokePath = resolve(projectRoot, "smoke.mjs");
    writeFileSync(
      smokePath,
      `import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createJavaScriptAnalyzer } from "./node_modules/tieline/dist/contract/code-analysis/javascript.js";
import { createPythonAnalyzer } from "./node_modules/tieline/dist/contract/code-analysis/python.js";
import { createRustAnalyzer } from "./node_modules/tieline/dist/contract/code-analysis/rust.js";
import { createFilesystemSourceSnapshotReader } from "./node_modules/tieline/dist/contract/source-snapshot.js";
const root = resolve("sources");
const reader = createFilesystemSourceSnapshotReader({ repositoryRoot: root });
const analyzers = [createJavaScriptAnalyzer(), createPythonAnalyzer(), createRustAnalyzer()];
const facts = [];
for (const path of readdirSync(root).sort()) {
  const read = reader.read(path);
  if (read.status !== "read" || read.snapshot.language === null) throw new Error("unreadable fixture: " + path);
  const analyzer = analyzers.find((candidate) => candidate.languages.has(read.snapshot.language));
  if (!analyzer) throw new Error("unsupported fixture: " + path);
  facts.push(await analyzer.analyze(read.snapshot));
  reader.release?.(path);
}
for (const analyzer of analyzers) await analyzer.dispose();
reader.dispose?.();
const digest = createHash("sha256").update(JSON.stringify(facts)).digest("hex");
process.stdout.write(JSON.stringify({ digest, languages: facts.map((fact) => fact.language), node: process.versions.node }));
`
    );
    const runs = Array.from({ length: 5 }, () =>
      JSON.parse(execFileSync(process.execPath, [smokePath], {
        cwd: projectRoot,
        encoding: "utf8",
        env: { ...process.env, npm_config_offline: "true" },
      })) as { digest: string; languages: string[]; node: string }
    );
    assert.equal(new Set(runs.map((run) => run.digest)).size, 1, "five installed-package fact runs agree");
    assert.deepEqual(runs[0]!.languages.sort(), supportedCodeLanguages.map((language) => language.id).sort());

    const parserAssetBytes = directoryBytes(
      resolve(projectRoot, "node_modules/tieline/assets/parsers/web-tree-sitter-0.26.12")
    );
    const installedParserBytes =
      parserAssetBytes + directoryBytes(resolve(projectRoot, "node_modules/web-tree-sitter"));
    assert.ok(parserAssetBytes <= 7 * 1024 * 1024, `parser assets are ${parserAssetBytes} bytes`);
    assert.ok(
      installedParserBytes <= 10 * 1024 * 1024,
      `installed parser footprint is ${installedParserBytes} bytes`
    );
    const parserAssetEntryBytes = result.files
      .filter((file) => file.path.startsWith("assets/parsers/"))
      .reduce((total, file) => total + file.size, 0);
    assert.ok(parserAssetEntryBytes > 0, "packed parser asset entries were measured");
    assert.ok(parserAssetEntryBytes <= 7 * 1024 * 1024, `packed parser asset entries are ${parserAssetEntryBytes} bytes`);
    console.log(JSON.stringify({
      node: process.versions.node,
      fact_digest: runs[0]!.digest,
      repeated_runs: runs.length,
      packed_tarball_bytes: result.size,
      parser_asset_entry_bytes: parserAssetEntryBytes,
      parser_asset_bytes: parserAssetBytes,
      installed_parser_bytes: installedParserBytes,
    }));
  } finally {
    if (tarballPath) rmSync(tarballPath, { force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

report();
