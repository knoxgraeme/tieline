import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
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
    ) as Array<{ filename: string; size: number; files: Array<{ path: string }> }>;
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
    const smokePath = resolve(projectRoot, "smoke.mjs");
    writeFileSync(
      smokePath,
      `import assert from "node:assert/strict";
import { createCodeParserRuntime } from "./node_modules/tieline/dist/contract/code-analysis/runtime.js";
import { supportedCodeLanguages } from "./node_modules/tieline/dist/contract/code-analysis/languages.js";
const runtime = createCodeParserRuntime();
for (const language of supportedCodeLanguages) {
  await runtime.withParser(language.id, (parser) => {
    const tree = parser.parse(language.smokeSource);
    assert.ok(tree);
    tree.delete();
  });
}
process.stdout.write("installed parser smoke passed\\n");
`
    );
    assert.match(execFileSync(process.execPath, [smokePath], { encoding: "utf8" }), /passed/);

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
  } finally {
    if (tarballPath) rmSync(tarballPath, { force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

report();
