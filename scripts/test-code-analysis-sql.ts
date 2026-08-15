import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createSqlAnalyzer } from "../src/contract/code-analysis/sql.js";
import { parserCompatibilitySet } from "../src/contract/code-analysis/languages.js";
import {
  createFilesystemSourceSnapshotReader,
  createSourceSnapshotFromBytes,
  type SourceFileMetadata,
  type SourceSnapshot,
} from "../src/contract/source-snapshot.js";
import { report, test } from "./lib/harness.js";

const repositoryRoot = resolve(".");
const reader = createFilesystemSourceSnapshotReader({ repositoryRoot });

function fixtureSnapshot(): SourceSnapshot {
  const result = reader.read("scripts/fixtures/code-analysis/sql.sql");
  assert.equal(result.status, "read");
  if (result.status !== "read") throw new Error("SQL fixture was not readable");
  return result.snapshot;
}

function sourceSnapshot(source: string): SourceSnapshot {
  const bytes = Buffer.from(source);
  const metadata: SourceFileMetadata = {
    size: bytes.byteLength,
    modifiedTimeMs: 0,
    changedTimeMs: 0,
    device: "0",
    inode: "0",
    mode: 0o100644,
    kind: "file",
  };
  const result = createSourceSnapshotFromBytes({ path: "fixture.sql", bytes, metadata });
  assert.equal(result.status, "read");
  if (result.status !== "read") throw new Error("inline SQL fixture was not readable");
  return result.snapshot;
}

await test("emits deterministic conservative SQL declaration facts", async () => {
  const analyzer = createSqlAnalyzer();
  const snapshot = fixtureSnapshot();
  const first = await analyzer.analyze(snapshot);
  assert.deepEqual(await analyzer.analyze(snapshot), first);

  assert.equal(first.path, snapshot.path);
  assert.equal(first.language, "sql");
  assert.equal(first.sourceHash, snapshot.sha256);
  assert.equal(first.compatibility.parser, parserCompatibilitySet);
  assert.equal(first.compatibility.query, "sql-structure-v1");
  assert.deepEqual(first.references, []);
  assert.equal(first.symbols.length, 7, "only the scoped top-level SQL declarations are emitted");
  assert.equal(new Set(first.symbols.map((symbol) => symbol.identity)).size, first.symbols.length);

  assert.ok(
    first.symbols.some(
      (symbol) =>
        symbol.nativeKind === "create_table" &&
        symbol.kind === "type" &&
        symbol.selector === "type:accounts"
    )
  );
  assert.ok(
    first.symbols.some(
      (symbol) =>
        symbol.nativeKind === "create_view" &&
        symbol.kind === "type" &&
        symbol.selector === "type:active_accounts"
    )
  );
  assert.ok(
    first.symbols.some(
      (symbol) =>
        symbol.nativeKind === "create_function" &&
        symbol.kind === "function" &&
        symbol.selector === "function:refresh_accounts"
    )
  );

  const qualified = first.symbols.find((symbol) => symbol.name === "qualified_accounts");
  assert.ok(qualified);
  assert.equal(qualified.selector, null, "qualified SQL names do not receive lossy selectors");
  const quoted = first.symbols.find((symbol) => symbol.name === '"Quoted View"');
  assert.ok(quoted);
  assert.equal(quoted.selector, null, "quoted SQL names preserve spelling without fabricated selectors");
  const overloaded = first.symbols.filter((symbol) => symbol.name === "overloaded");
  assert.equal(overloaded.length, 2);
  assert.ok(
    overloaded.every((symbol) => symbol.selector === null),
    "overloaded SQL functions require signature-aware selectors"
  );

  for (const symbol of first.symbols) {
    assert.deepEqual(symbol.ownerChain, []);
    assert.ok(symbol.nameRange);
    assert.equal(
      snapshot.text.slice(symbol.nameRange.utf16.start, symbol.nameRange.utf16.end),
      symbol.name
    );
    assert.equal(symbol.bodyRange.start.utf16Offset, symbol.bodyRange.utf16.start);
    assert.equal(symbol.bodyRange.start.utf8ByteOffset, symbol.bodyRange.utf8Bytes.start);
    assert.ok(symbol.bodyRange.utf16.start <= symbol.nameRange.utf16.start);
    assert.ok(symbol.bodyRange.utf16.end >= symbol.nameRange.utf16.end);
    assert.ok(Object.isFrozen(symbol));
  }
  await analyzer.dispose();
});

await test("retains safe SQL declarations around localized parser recovery", async () => {
  const analyzer = createSqlAnalyzer();
  const result = await analyzer.analyze(sourceSnapshot(`
CREATE TABLE before_damage (id INTEGER);
SELECT 1 + ;
CREATE VIEW after_damage AS SELECT id FROM before_damage;
`));
  assert.ok(result.diagnostics.length > 0);
  assert.ok(result.symbols.some((symbol) => symbol.selector === "type:before_damage"));
  assert.ok(result.symbols.some((symbol) => symbol.selector === "type:after_damage"));

  const recovered = await analyzer.analyze(sourceSnapshot(`
CREATE TABLE recovered_table (
  id INTEGER,
);
`));
  assert.ok(recovered.diagnostics.length > 0);
  const recoveredTable = recovered.symbols.find((symbol) => symbol.name === "recovered_table");
  assert.ok(recoveredTable);
  assert.equal(recoveredTable.syntaxStatus, "recovered");
  assert.equal(recoveredTable.selector, null, "recovered SQL declarations are not selectable");
  await analyzer.dispose();
});

await test("bounds SQL facts and explicitly releases compiled queries", async () => {
  const analyzer = createSqlAnalyzer({
    maxSymbols: 2,
    maxReferences: 0,
    maxDiagnostics: 0,
  });
  const result = await analyzer.analyze(fixtureSnapshot());
  assert.equal(result.symbols.length, 2);
  assert.deepEqual(result.references, []);
  assert.equal(result.diagnostics.length, 0);
  assert.deepEqual(result.truncated, {
    symbols: true,
    references: false,
    diagnostics: false,
  });
  await analyzer.dispose();
  await analyzer.dispose();
  await assert.rejects(analyzer.analyze(fixtureSnapshot()), /disposed/i);
});

reader.dispose?.();
report();
