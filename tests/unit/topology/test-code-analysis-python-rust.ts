import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createPythonAnalyzer } from "../../../src/contract/code-analysis/python.js";
import { createRustAnalyzer } from "../../../src/contract/code-analysis/rust.js";
import { parserCompatibilitySet, type SupportedCodeLanguage } from "../../../src/contract/code-analysis/languages.js";
import type { LanguageAnalysisResult, LanguageAnalyzer } from "../../../src/contract/code-analysis/types.js";
import { parseSelector } from "../../../src/contract/selector.js";
import { createFilesystemSourceSnapshotReader, type SourceSnapshot } from "../../../src/contract/source-snapshot.js";
import { report, test } from "../../support/harness.js";

const repositoryRoot = resolve(".");
const reader = createFilesystemSourceSnapshotReader({ repositoryRoot });

function fixtureSnapshot(name: string): SourceSnapshot {
  const result = reader.read(`tests/fixtures/code-analysis/${name}`);
  assert.equal(result.status, "read");
  if (result.status !== "read") throw new Error(`fixture ${name} was not readable`);
  return result.snapshot;
}

function assertCrossLanguageContract(
  result: LanguageAnalysisResult,
  snapshot: SourceSnapshot,
  language: SupportedCodeLanguage
): void {
  assert.equal(result.path, snapshot.path);
  assert.equal(result.language, language);
  assert.equal(result.sourceHash, snapshot.sha256);
  assert.equal(result.compatibility.parser, parserCompatibilitySet);
  assert.match(result.compatibility.identity, /web-tree-sitter-0\.26\.12/);
  assert.equal(new Set(result.symbols.map((symbol) => symbol.identity)).size, result.symbols.length);
  assert.equal(new Set(result.references.map((reference) => reference.identity)).size, result.references.length);
  assert.equal(new Set(result.diagnostics.map((diagnostic) => diagnostic.identity)).size, result.diagnostics.length);

  for (const symbol of result.symbols) {
    assert.ok(Object.isFrozen(symbol));
    assert.equal(symbol.bodyRange.start.utf16Offset, symbol.bodyRange.utf16.start);
    assert.equal(symbol.bodyRange.start.utf8ByteOffset, symbol.bodyRange.utf8Bytes.start);
    assert.ok(symbol.bodyRange.utf16.end >= symbol.bodyRange.utf16.start);
    assert.ok(symbol.bodyRange.utf8Bytes.end >= symbol.bodyRange.utf8Bytes.start);
    if (symbol.selector !== null) assert.equal(parseSelector(symbol.selector).ok, true);
    for (const owner of symbol.ownerChain) {
      assert.ok(Object.isFrozen(owner));
      assert.ok(owner.bodyRange.utf16.start <= symbol.bodyRange.utf16.start);
      assert.ok(owner.bodyRange.utf16.end >= symbol.bodyRange.utf16.end);
      if (owner.selector !== null) assert.equal(parseSelector(owner.selector).ok, true);
    }
  }
  assert.ok(result.references.every((reference) => reference.resolution === "unresolved"));
}

async function deterministic(
  analyzer: LanguageAnalyzer,
  snapshot: SourceSnapshot
): Promise<LanguageAnalysisResult> {
  const first = await analyzer.analyze(snapshot);
  assert.deepEqual(await analyzer.analyze(snapshot), first);
  return first;
}

await test("emits deterministic Python definitions, owners, exports, and imports", async () => {
  const analyzer = createPythonAnalyzer();
  const snapshot = fixtureSnapshot("python.py");
  const result = await deterministic(analyzer, snapshot);
  assertCrossLanguageContract(result, snapshot, "python");

  assert.ok(result.symbols.some((symbol) => symbol.selector === "function:top_level"));
  assert.ok(result.symbols.some((symbol) => symbol.selector === "class:Other/method:same"));
  assert.ok(
    result.symbols.some(
      (symbol) =>
        symbol.selector === "function:top_level/class:Nested/method:execute" &&
        symbol.ownerChain.map((owner) => owner.name).join("/") === "top_level/Nested"
    )
  );
  const unicodeClass = result.symbols.find((symbol) => symbol.name === "Café");
  assert.ok(unicodeClass);
  assert.equal(unicodeClass.selector, "class:Café", "NFC Unicode identifiers are canonical selectors");
  assert.ok(unicodeClass.nameRange);
  assert.equal(
    unicodeClass.nameRange.utf8Bytes.end - unicodeClass.nameRange.utf8Bytes.start,
    Buffer.byteLength("Café")
  );
  assert.equal(
    snapshot.text.slice(unicodeClass.nameRange.utf16.start, unicodeClass.nameRange.utf16.end),
    "Café"
  );
  assert.ok(
    result.symbols.some(
      (symbol) =>
        symbol.name === "nested_in_method" &&
        symbol.kind === "function" &&
        symbol.ownerChain.map((owner) => owner.name).join("/") === "Café/run"
    ),
    "a nested function is not mislabeled as a class method"
  );

  assert.deepEqual(
    result.references
      .filter((reference) => reference.kind === "import")
      .map((reference) => [reference.moduleSpecifier, reference.bindings.map((binding) => [binding.imported, binding.local])]),
    [
      ["__future__", [["annotations", "annotations"]]],
      ["os", [[null, "os"]]],
      ["package.tool", [[null, "tool"]]],
      [".pkg", [["thing", "alias"], ["other", "other"]]],
      ["..", [["parent", "parent"]]],
    ]
  );
  const exports = result.references.filter((reference) => reference.kind === "export");
  assert.ok(exports.some((reference) => reference.bindings[0]?.exported === "top_level"));
  assert.ok(exports.some((reference) => reference.bindings[0]?.exported === "Café"));
  assert.ok(!exports.some((reference) => reference.bindings[0]?.exported === "_private_helper"));
  await analyzer.dispose();
});

await test("emits Rust type, trait, impl-owner, function, constant, module, and use facts", async () => {
  const analyzer = createRustAnalyzer();
  const snapshot = fixtureSnapshot("rust.rs");
  const result = await deterministic(analyzer, snapshot);
  assertCrossLanguageContract(result, snapshot, "rust");

  assert.ok(result.symbols.some((symbol) => symbol.selector === "type:Service"));
  assert.ok(result.symbols.some((symbol) => symbol.selector === "type:State"));
  assert.ok(result.symbols.some((symbol) => symbol.selector === "type:Alias"));
  assert.ok(result.symbols.some((symbol) => symbol.selector === "const:READY"));
  assert.ok(result.symbols.some((symbol) => symbol.kind === "variable" && symbol.name === "GLOBAL"));
  assert.ok(result.symbols.some((symbol) => symbol.selector === "type:Worker/method:run"));
  assert.ok(result.symbols.some((symbol) => symbol.selector === "type:Service/method:match"));
  assert.ok(result.symbols.some((symbol) => symbol.selector === "type:First/method:same"));
  assert.ok(result.symbols.some((symbol) => symbol.selector === "type:Second/method:same"));

  const traitImplMethod = result.symbols.find(
    (symbol) => symbol.name === "run" && symbol.ownerChain.some((owner) => owner.nativeKind === "impl_item")
  );
  assert.ok(traitImplMethod);
  assert.equal(traitImplMethod.selector, null, "trait impl methods are not assigned an ambiguous locator");
  assert.equal(traitImplMethod.ownerChain.at(-1)?.name, "Worker for Service");

  const rawIdentifier = result.symbols.find((symbol) => symbol.name === "match");
  assert.ok(rawIdentifier?.nameRange);
  assert.equal(
    snapshot.text.slice(rawIdentifier.nameRange.utf16.start, rawIdentifier.nameRange.utf16.end),
    "r#match"
  );
  const nestedUnicode = result.symbols.find((symbol) => symbol.name === "Café");
  assert.ok(nestedUnicode);
  assert.equal(nestedUnicode.selector, null);

  assert.deepEqual(
    result.references
      .filter((reference) => reference.kind === "import" || reference.kind === "reexport")
      .map((reference) => [reference.kind, reference.moduleSpecifier]),
    [
      ["import", "crate::support"],
      ["import", "crate::deep"],
      ["import", "external::single::Thing"],
      ["reexport", "super::shared::Item"],
      ["import", "external_module"],
    ]
  );
  for (const reference of result.references.filter((item) => item.moduleSpecifier !== null)) {
    assert.ok(reference.moduleSpecifierRange);
    assert.equal(
      snapshot.text
        .slice(reference.moduleSpecifierRange.utf16.start, reference.moduleSpecifierRange.utf16.end)
        .replace(/\s+/g, ""),
      reference.moduleSpecifier
    );
  }
  const grouped = result.references.find((reference) => reference.moduleSpecifier === "crate::support");
  assert.deepEqual(grouped?.bindings, [
    { imported: "self", local: "support", exported: null, isTypeOnly: false },
    { imported: "Helper", local: "RenamedHelper", exported: null, isTypeOnly: false },
    { imported: "*", local: "*", exported: null, isTypeOnly: false },
  ]);
  const nestedGroup = result.references.find((reference) => reference.moduleSpecifier === "crate::deep");
  assert.deepEqual(nestedGroup?.bindings, [
    { imported: "nested::Item", local: "DeepItem", exported: null, isTypeOnly: false },
    { imported: "nested::*", local: "*", exported: null, isTypeOnly: false },
  ]);
  assert.ok(
    result.references.some(
      (reference) => reference.kind === "export" && reference.bindings[0]?.exported === "top_level"
    )
  );
  await analyzer.dispose();
});

await test("retains safe Python and Rust captures around localized parser recovery", async () => {
  const python = createPythonAnalyzer();
  const pythonResult = await python.analyze(fixtureSnapshot("python-recovered.py"));
  assert.ok(pythonResult.diagnostics.length > 0);
  assert.ok(pythonResult.symbols.some((symbol) => symbol.selector === "function:before"));
  assert.ok(pythonResult.symbols.some((symbol) => symbol.selector === "function:after"));
  await python.dispose();

  const rust = createRustAnalyzer();
  const rustResult = await rust.analyze(fixtureSnapshot("rust-recovered.rs"));
  assert.ok(rustResult.diagnostics.length > 0);
  assert.ok(rustResult.symbols.some((symbol) => symbol.selector === "function:before"));
  assert.ok(rustResult.symbols.some((symbol) => symbol.selector === "function:after"));
  await rust.dispose();
});

await test("bounds Python and Rust facts and explicitly releases compiled queries", async () => {
  for (const [factory, fixture] of [
    [createPythonAnalyzer, "python.py"],
    [createRustAnalyzer, "rust.rs"],
  ] as const) {
    const analyzer = factory({ maxSymbols: 2, maxReferences: 1, maxDiagnostics: 0 });
    const result = await analyzer.analyze(fixtureSnapshot(fixture));
    assert.equal(result.symbols.length, 2);
    assert.equal(result.references.length, 1);
    assert.equal(result.diagnostics.length, 0);
    assert.deepEqual(result.truncated, { symbols: true, references: true, diagnostics: false });
    await analyzer.dispose();
    await analyzer.dispose();
    await assert.rejects(analyzer.analyze(fixtureSnapshot(fixture)), /disposed/i);
  }
});

report();
