import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  SourceInventoryError,
  createSourceInventory,
} from "../src/contract/source-inventory.js";
import {
  createFilesystemSourceSnapshotReader,
  type SourceFileMetadata,
} from "../src/contract/source-snapshot.js";
import { report, test } from "./lib/harness.js";

await test("shares deterministic source-root, ignore, symlink, and repository-boundary inventory rules", () => {
  const root = mkdtempSync(resolve(tmpdir(), "tieline-inventory-"));
  const outside = mkdtempSync(resolve(tmpdir(), "tieline-inventory-outside-"));
  try {
    mkdirSync(resolve(root, "src/nested"), { recursive: true });
    writeFileSync(resolve(root, "src/z.ts"), "export const z = true;\n");
    writeFileSync(resolve(root, "src/nested/a.py"), "a = True\n");
    writeFileSync(resolve(root, "src/nested/ignored.ts"), "ignored\n");
    symlinkSync(resolve(root, "src"), resolve(root, "src/nested/loop"), "dir");
    symlinkSync(outside, resolve(root, "src/ignored-outside"), "dir");

    const inventory = createSourceInventory({
      repositoryRoot: root,
      sourceRoots: ["src"],
      ignore: ["src/nested/ignored.ts", "src/ignored-outside"],
    });
    assert.deepEqual(
      inventory.files.map((file) => [file.path, file.language]),
      [
        ["src/nested/a.py", "python"],
        ["src/z.ts", "typescript"],
      ]
    );
    assert.deepEqual(inventory.excludedPaths, [
      "src/ignored-outside",
      "src/nested/ignored.ts",
    ]);
    assert.match(inventory.digest, /^[a-f0-9]{64}$/);
    assert.deepEqual(
      createSourceInventory({
        repositoryRoot: root,
        sourceRoots: ["src"],
        ignore: ["src/nested/ignored.ts", "src/ignored-outside"],
      }),
      inventory,
      "the same checkout produces a deterministic inventory"
    );

    assert.throws(
      () =>
        createSourceInventory({
          repositoryRoot: root,
          sourceRoots: ["src/ignored-outside"],
        }),
      (error: unknown) => {
        assert.ok(error instanceof SourceInventoryError);
        assert.equal(error.outcome, "repository_escape");
        return true;
      }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

await test("reads one immutable snapshot with hash, metadata, language, and explicit coordinates", () => {
  const root = mkdtempSync(resolve(tmpdir(), "tieline-snapshot-unicode-"));
  try {
    mkdirSync(resolve(root, "src"), { recursive: true });
    const source = "const astral = '😀';\r\nconst combined = 'e\u0301';\n";
    writeFileSync(resolve(root, "src/unicode.ts"), source);
    const inventory = createSourceInventory({
      repositoryRoot: root,
      sourceRoots: ["src"],
    });
    const reader = createFilesystemSourceSnapshotReader({
      repositoryRoot: root,
      inventory,
    });
    const result = reader.read("./src/unicode.ts");
    assert.equal(result.status, "read");
    if (result.status !== "read") return;
    const snapshot = result.snapshot;
    assert.equal(snapshot.path, "src/unicode.ts");
    assert.equal(snapshot.text, source);
    assert.equal(snapshot.language, "typescript");
    assert.equal(snapshot.inventoryDigest, inventory.digest);
    assert.match(snapshot.sha256, /^[a-f0-9]{64}$/);
    assert.equal(snapshot.originalBytes().toString("utf8"), source);
    const emojiUtf16 = source.indexOf("😀");
    const emojiBytes = Buffer.byteLength(source.slice(0, emojiUtf16));
    assert.deepEqual(snapshot.coordinates.atUtf16Offset(emojiUtf16), {
      utf16Offset: emojiUtf16,
      utf8ByteOffset: emojiBytes,
      line: 0,
      utf16Column: emojiUtf16,
      utf8ByteColumn: emojiBytes,
    });
    assert.deepEqual(
      snapshot.coordinates.atUtf8ByteOffset(emojiBytes),
      snapshot.coordinates.atUtf16Offset(emojiUtf16)
    );
    assert.throws(
      () => snapshot.coordinates.atUtf16Offset(emojiUtf16 + 1),
      /code-point boundary/i
    );
    assert.throws(
      () => snapshot.coordinates.atUtf8ByteOffset(emojiBytes + 1),
      /code-point boundary/i
    );
    const secondLine = source.indexOf("const combined");
    const secondPosition = snapshot.coordinates.atUtf16Offset(secondLine);
    assert.deepEqual(
      { line: secondPosition.line, column: secondPosition.utf16Column },
      { line: 1, column: 0 },
      "CRLF is one line break"
    );
    const end = secondLine + "const combined = 'e\u0301';".length;
    const range = snapshot.coordinates.rangeFromUtf16(secondLine, end);
    assert.equal(snapshot.text.slice(range.utf16.start, range.utf16.end), "const combined = 'e\u0301';");
    assert.equal(
      snapshot.originalBytes().subarray(range.utf8Bytes.start, range.utf8Bytes.end).toString("utf8"),
      "const combined = 'e\u0301';"
    );
    assert.strictEqual(
      reader.read("src/unicode.ts"),
      result,
      "request-local reads return the same immutable result"
    );
    assert.ok(Object.isFrozen(snapshot));
    const copy = snapshot.originalBytes();
    copy[0] = 0;
    assert.equal(snapshot.text[0], "c", "callers cannot mutate retained source bytes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("returns named outcomes for unsafe or unusable source inputs", () => {
  const root = mkdtempSync(resolve(tmpdir(), "tieline-snapshot-outcomes-"));
  const outside = mkdtempSync(resolve(tmpdir(), "tieline-snapshot-escape-"));
  try {
    mkdirSync(resolve(root, "src"), { recursive: true });
    writeFileSync(resolve(root, "src/binary.ts"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(resolve(root, "src/large.ts"), "123456789");
    mkdirSync(resolve(root, "src/directory.ts"));
    writeFileSync(resolve(outside, "external.ts"), "export const external = true;\n");
    symlinkSync(resolve(outside, "external.ts"), resolve(root, "src/external.ts"));
    writeFileSync(resolve(root, "src/unreadable.ts"), "secret\n");
    chmodSync(resolve(root, "src/unreadable.ts"), 0o000);

    const reader = createFilesystemSourceSnapshotReader({
      repositoryRoot: root,
      maxSourceBytes: 8,
      readBytes(path) {
        if (path.endsWith("unreadable.ts")) {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        }
        return readFileSync(path);
      },
    });
    assert.equal(reader.read("src/missing.ts").status, "missing");
    assert.equal(reader.read("src/binary.ts").status, "binary");
    assert.equal(reader.read("src/large.ts").status, "oversized");
    assert.equal(reader.read("src/directory.ts").status, "not_file");
    assert.equal(reader.read("src/unreadable.ts").status, "unreadable");
    assert.equal(reader.read("src/external.ts").status, "repository_escape");
    assert.equal(reader.read("../outside.ts").status, "repository_escape");
  } finally {
    chmodSync(resolve(root, "src/unreadable.ts"), 0o600);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

await test("detects a file changing between pre-read and post-read metadata", () => {
  const root = mkdtempSync(resolve(tmpdir(), "tieline-snapshot-race-"));
  try {
    mkdirSync(resolve(root, "src"), { recursive: true });
    writeFileSync(resolve(root, "src/changing.rs"), "fn before() {}\n");
    let inspections = 0;
    const base: SourceFileMetadata = {
      size: 15,
      modifiedTimeMs: 1,
      changedTimeMs: 1,
      device: "1",
      inode: "2",
      mode: 0o100644,
      kind: "file",
    };
    const reader = createFilesystemSourceSnapshotReader({
      repositoryRoot: root,
      inspectFile() {
        inspections += 1;
        return {
          ...base,
          modifiedTimeMs: inspections === 1 ? 1 : 2,
        };
      },
      readBytes() {
        return Buffer.from("fn before() {}\n");
      },
    });
    assert.equal(reader.read("src/changing.rs").status, "changed_during_read");
    assert.equal(inspections, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("refuses a stable read when the file changed after inventory capture", () => {
  const root = mkdtempSync(resolve(tmpdir(), "tieline-snapshot-inventory-race-"));
  try {
    mkdirSync(resolve(root, "src"), { recursive: true });
    const path = resolve(root, "src/changing.py");
    writeFileSync(path, "before = True\n");
    const inventory = createSourceInventory({
      repositoryRoot: root,
      sourceRoots: ["src"],
    });
    writeFileSync(path, "after = False\n");
    const reader = createFilesystemSourceSnapshotReader({
      repositoryRoot: root,
      inventory,
    });
    assert.equal(reader.read("src/changing.py").status, "changed_during_read");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

report();
