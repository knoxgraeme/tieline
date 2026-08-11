import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { createJavaScriptAnalyzer } from "../src/contract/code-analysis/javascript.js";
import { parserCompatibilitySet } from "../src/contract/code-analysis/languages.js";
import { createCodeParserRuntime } from "../src/contract/code-analysis/runtime.js";
import { createSourceInventory } from "../src/contract/source-inventory.js";
import { createFilesystemSourceSnapshotReader } from "../src/contract/source-snapshot.js";
import { report, test } from "./lib/harness.js";

const repositoryRoot = resolve(".");
const reader = createFilesystemSourceSnapshotReader({ repositoryRoot });
const analyzer = createJavaScriptAnalyzer();

function fixtureSnapshot(name: string) {
  const result = reader.read(`scripts/fixtures/code-analysis/${name}`);
  assert.equal(result.status, "read");
  if (result.status !== "read") throw new Error(`fixture ${name} was not readable`);
  return result.snapshot;
}

await test("emits deterministic parent-aware JavaScript symbols and module linkage", async () => {
  const first = await analyzer.analyze(fixtureSnapshot("javascript.js"));
  const second = await analyzer.analyze(fixtureSnapshot("javascript.js"));
  assert.deepEqual(second, first);
  assert.equal(first.compatibility.parser, parserCompatibilitySet);
  assert.equal(first.language, "javascript");
  assert.match(first.sourceHash, /^[a-f0-9]{64}$/);

  assert.ok(first.symbols.some((symbol) => symbol.selector === "function:run"));
  assert.ok(first.symbols.some((symbol) => symbol.selector === "const:configured"));
  assert.ok(first.symbols.some((symbol) => symbol.kind === "variable" && symbol.name === "mutable"));
  assert.ok(
    first.symbols.some(
      (symbol) =>
        symbol.selector === "class:First/method:same" &&
        symbol.ownerChain.map((owner) => owner.name).join("/") === "First"
    )
  );
  assert.ok(first.symbols.some((symbol) => symbol.selector === "class:Second/method:same"));
  assert.ok(
    first.symbols.some(
      (symbol) =>
        symbol.selector === "function:outer/class:Nested/method:go" &&
        symbol.ownerChain.map((owner) => owner.name).join("/") === "outer/Nested" &&
        symbol.ownerChain[1]?.selector === "function:outer/class:Nested"
    )
  );
  const anonymous = first.symbols.find(
    (symbol) => symbol.nativeKind === "class" && symbol.name === null
  );
  assert.ok(anonymous, "anonymous default class remains represented");
  assert.equal(anonymous.selector, null, "anonymous source is not given a fabricated selector");
  assert.ok(
    first.symbols.some(
      (symbol) => symbol.name === "execute" && symbol.ownerChain[0]?.identity === anonymous.identity
    )
  );

  assert.deepEqual(
    first.references
      .filter((reference) => reference.moduleSpecifier !== null)
      .map((reference) => [reference.kind, reference.moduleSpecifier, reference.isTypeOnly]),
    [
      ["import", "./dependency.js", false],
      ["reexport", "./shared.js", false],
      ["reexport", "./everything.js", false],
      ["dynamic_import", "./lazy.js", false],
    ]
  );
  assert.ok(first.references.every((reference) => reference.resolution === "unresolved"));
  const runExport = first.references.find(
    (reference) => reference.kind === "export" && reference.statementRange.start.line === 4
  );
  assert.ok(runExport?.ownerIdentity, "a declaration export points to its structural owner");
});

await test("supports JSX, TSX, TypeScript types, overloads, Unicode, and type-only linkage", async () => {
  const jsx = await analyzer.analyze(fixtureSnapshot("component.jsx"));
  const tsx = await analyzer.analyze(fixtureSnapshot("component.tsx"));
  const typescript = await analyzer.analyze(fixtureSnapshot("typescript.ts"));

  assert.equal(jsx.language, "jsx");
  assert.ok(jsx.symbols.some((symbol) => symbol.selector === "function:Component"));
  assert.equal(tsx.language, "tsx");
  assert.ok(tsx.symbols.some((symbol) => symbol.selector === "const:TypedComponent"));
  assert.ok(typescript.symbols.some((symbol) => symbol.selector === "type:Service"));
  assert.ok(typescript.symbols.some((symbol) => symbol.selector === "type:Result"));
  assert.ok(typescript.symbols.some((symbol) => symbol.selector === "type:State"));
  assert.ok(typescript.symbols.some((symbol) => symbol.selector === "const:café"));
  const unicode = typescript.symbols.find((symbol) => symbol.selector === "const:café")!;
  assert.ok(unicode.nameRange);
  assert.equal(
    unicode.nameRange.utf8Bytes.end - unicode.nameRange.utf8Bytes.start,
    Buffer.byteLength("café")
  );
  assert.equal(unicode.nameRange.utf16.end - unicode.nameRange.utf16.start, "café".length);

  const overloads = typescript.symbols.filter(
    (symbol) => symbol.selector === "class:Handler/method:execute"
  );
  assert.equal(overloads.length, 3);
  assert.equal(new Set(overloads.map((symbol) => symbol.identity)).size, 3);
  assert.ok(overloads.every((symbol) => symbol.ownerChain[0]?.selector === "class:Handler"));
  assert.deepEqual(
    typescript.references
      .filter((reference) => reference.kind === "import" || reference.kind === "reexport")
      .map((reference) => [reference.moduleSpecifier, reference.isTypeOnly]),
    [
      ["./input.js", true],
      ["./database.js", false],
      ["./output.js", true],
      ["./runtime.js", false],
    ]
  );
  assert.ok(
    typescript.symbols.some(
      (symbol) => symbol.selector === "function:tagged" && symbol.syntaxStatus === "recovered"
    ),
    "generic tagged-template recovery retains its surrounding declaration"
  );
  assert.ok(typescript.diagnostics.length > 0);
});

await test("keeps safe captures around localized syntax damage with explicit coordinates", async () => {
  const result = await analyzer.analyze(fixtureSnapshot("recovered.ts"));
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.kind === "error"));
  assert.ok(result.symbols.some((symbol) => symbol.selector === "function:before"));
  assert.ok(result.symbols.some((symbol) => symbol.selector === "function:after"));
  for (const symbol of result.symbols) {
    assert.equal(symbol.bodyRange.start.utf16Offset, symbol.bodyRange.utf16.start);
    assert.equal(symbol.bodyRange.start.utf8ByteOffset, symbol.bodyRange.utf8Bytes.start);
    assert.ok(symbol.bodyRange.end.line >= symbol.bodyRange.start.line);
  }

  const malformed = await analyzer.analyze(fixtureSnapshot("malformed.ts"));
  assert.ok(malformed.diagnostics.length > 0);
  assert.ok(malformed.symbols.some((symbol) => symbol.selector === "function:intact"));
});

await test("bounds facts and reports truncation without changing deterministic prefixes", async () => {
  const snapshot = fixtureSnapshot("javascript.js");
  const bounded = await createJavaScriptAnalyzer({
    maxSymbols: 3,
    maxReferences: 2,
    maxDiagnostics: 1,
  }).analyze(snapshot);
  const complete = await analyzer.analyze(snapshot);
  assert.deepEqual(bounded.symbols, complete.symbols.slice(0, 3));
  assert.deepEqual(bounded.references, complete.references.slice(0, 2));
  assert.deepEqual(bounded.truncated, {
    symbols: true,
    references: true,
    diagnostics: false,
  });
});

await test("explicitly releases compiled compatibility queries", async () => {
  const disposable = createJavaScriptAnalyzer();
  await disposable.analyze(fixtureSnapshot("component.jsx"));
  await disposable.dispose();
  await disposable.dispose();
  await assert.rejects(
    disposable.analyze(fixtureSnapshot("component.jsx")),
    /disposed/i
  );
});

await test("analyzes the full Tieline JS/TS corpus within the post-init release budget", async () => {
  const inventory = createSourceInventory({
    repositoryRoot,
    sourceRoots: ["src", "scripts"],
  });
  const runtime = createCodeParserRuntime();
  await runtime.initialize();
  const corpusAnalyzer = createJavaScriptAnalyzer({ runtime });
  const corpusReader = createFilesystemSourceSnapshotReader({ repositoryRoot, inventory });
  let files = 0;
  let bytes = 0;
  let symbols = 0;
  const started = performance.now();
  for (const file of inventory.files) {
    if (!file.language || !corpusAnalyzer.languages.has(file.language)) continue;
    const snapshot = corpusReader.read(file.path);
    assert.equal(snapshot.status, "read", `${file.path} remains snapshot-readable`);
    if (snapshot.status !== "read") continue;
    const result = await corpusAnalyzer.analyze(snapshot.snapshot);
    files += 1;
    bytes += snapshot.snapshot.metadata.size;
    symbols += result.symbols.length;
  }
  const elapsedMs = performance.now() - started;
  assert.ok(files > 100, `expected the Tieline corpus, received ${files} files`);
  assert.ok(symbols > 100, `expected structural facts, received ${symbols}`);
  assert.ok(
    elapsedMs <= 1_000,
    `post-init analysis of ${files} files / ${bytes} bytes took ${elapsedMs.toFixed(1)}ms`
  );
  console.log(
    `       corpus: ${files} files, ${bytes} bytes, ${symbols} symbols, ${elapsedMs.toFixed(1)}ms`
  );
  await corpusAnalyzer.dispose();
});

await analyzer.dispose();
report();
