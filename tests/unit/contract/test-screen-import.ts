import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { runCli } from "../../../src/cli.js";
import { loadAcceptedContractWithSources } from "../../../src/contract/load.js";
import {
  applyScreenImport,
  createCaptureDigester,
  parseScreenImport,
  planScreenImport,
  readScreenImportFile,
  ScreenImportError,
  SCREEN_IMPORT_LIMITS,
} from "../../../src/contract/screen-import.js";
import { report, test } from "../../support/harness.js";
import {
  captureIO,
  createScreensWorkspace,
  type ScreensWorkspace,
} from "../../support/screen-fixtures.js";
import {
  readScreenCatalogSources,
  screenSettingsForRepository,
  validateScreenCatalogDocuments,
} from "../../../src/contract/screen-catalog.js";

const workspaces: ScreensWorkspace[] = [];
function workspace(options: Parameters<typeof createScreensWorkspace>[0] = { screens: { enabled: true } }): ScreensWorkspace {
  const created = createScreensWorkspace(options);
  workspaces.push(created);
  return created;
}

function screen(key: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key,
    capability: "NOTES",
    title: `Screen ${key}`,
    route: "/notes",
    kind: "page",
    when: "A member opens Notes.",
    ...overrides,
  };
}

async function importScreens(
  ws: ScreensWorkspace,
  entries: unknown,
  flags: string[] = []
): Promise<{ exit: number; result: Record<string, unknown> }> {
  const file = resolve(ws.root, "import.json");
  writeFileSync(file, typeof entries === "string" ? entries : JSON.stringify(entries));
  const capture = captureIO();
  const exit = await runCli(["screens", "import", file, "--repository", ws.root, "--json", ...flags], capture.io, {});
  return { exit, result: JSON.parse(capture.output()) as Record<string, unknown> };
}

async function importFails(ws: ScreensWorkspace, entries: unknown, pattern: RegExp, flags: string[] = []): Promise<void> {
  const before = snapshot(ws);
  await assert.rejects(() => importScreens(ws, entries, flags), pattern);
  assert.deepEqual(snapshot(ws), before, "a refused import writes nothing");
}

function snapshot(ws: ScreensWorkspace): Record<string, string> {
  const directory = resolve(ws.root, ".tieline/screens");
  if (!existsSync(directory)) return {};
  return Object.fromEntries(
    readdirSync(directory).sort().map((name) => [name, readFileSync(resolve(directory, name), "utf8")])
  );
}

function catalog(ws: ScreensWorkspace, capability: string): string {
  return readFileSync(resolve(ws.root, `.tieline/screens/${capability}.yaml`), "utf8");
}

console.log("screens import: happy path");

await test("creates one catalog file per capability that the contract then loads", async () => {
  const ws = workspace();
  const { exit, result } = await importScreens(ws, [
    screen("notes-list", { group: "Browsing", applies_to: { role: ["member"] }, copy: ["Your notes"], image: "notes/list.png" }),
    screen("notes-share-denied", { capability: "SHARING", kind: "inline-error", image: { url: "https://cdn.example.test/denied.png" } }),
    screen("notes-loading", { kind: "loading" }),
  ]);
  assert.equal(exit, 0);
  assert.deepEqual(result.created, ["notes-list", "notes-share-denied", "notes-loading"]);
  assert.deepEqual(result.files, [
    { path: ".tieline/screens/NOTES.yaml", status: "created" },
    { path: ".tieline/screens/SHARING.yaml", status: "created" },
  ]);
  assert.equal(result.captures_gitignore, "created");
  assert.equal(
    catalog(ws, "NOTES"),
    `version: 1
capability: NOTES
screens:
  - key: notes-list
    title: Screen notes-list
    group: Browsing
    route: /notes
    kind: page
    when: A member opens Notes.
    applies_to:
      role:
        - member
    copy:
      - Your notes
    image:
      path: notes/list.png
  - key: notes-loading
    title: Screen notes-loading
    route: /notes
    kind: loading
    when: A member opens Notes.
`
  );
  const loaded = loadAcceptedContractWithSources(ws.root, ".tieline/spec");
  assert.deepEqual([...loaded.screens!.screens.keys()].sort(), ["notes-list", "notes-loading", "notes-share-denied"]);
  assert.equal(
    readFileSync(resolve(ws.root, ".tieline/captures/.gitignore"), "utf8"),
    "# Screenshots referenced by the Tieline screen catalog are not committed.\n*\n!.gitignore\n"
  );
});

await test("accepts the versioned envelope and the shipped synthetic example", async () => {
  const ws = workspace();
  ws.write(".tieline/spec/billing.yaml", `version: 1
capability:
  key: BILLING
  name: Billing
  description: Admins pay for a plan.
  stories:
    - key: BILLING-001
      title: Upgrade the plan
      actor: admin
      goal: move to the Team plan
      benefit: my team shares notes
      lifecycle: production
      acceptance_criteria:
        - key: BILLING-001-AC1
          criterion: An admin on the free plan must be able to start an upgrade.
`);
  const example = JSON.parse(readFileSync(resolve(process.cwd(), "docs/examples/screens/acme-notes.json"), "utf8"));
  assert.equal(parseScreenImport(example).length, 16);
  const { exit, result } = await importScreens(ws, example);
  assert.equal(exit, 0);
  assert.equal((result.created as string[]).length, 16);
  assert.equal(loadAcceptedContractWithSources(ws.root, ".tieline/spec").screens?.screens.size, 16);
});

console.log("screens import: idempotency and merge");

await test("re-importing the same file changes nothing and rewrites nothing", async () => {
  const ws = workspace();
  const entries = [screen("a", { copy: ["One"] }), screen("b", { capability: "SHARING" })];
  await importScreens(ws, entries);
  const before = snapshot(ws);
  const mtime = statSync(resolve(ws.root, ".tieline/screens/NOTES.yaml")).mtimeMs;
  const { result } = await importScreens(ws, entries);
  assert.deepEqual(result.created, []);
  assert.deepEqual(result.updated, []);
  assert.equal(result.unchanged, 2);
  assert.deepEqual((result.files as Array<{ status: string }>).map((file) => file.status), ["unchanged", "unchanged"]);
  assert.equal(result.captures_gitignore, "exists");
  assert.deepEqual(snapshot(ws), before);
  assert.equal(statSync(resolve(ws.root, ".tieline/screens/NOTES.yaml")).mtimeMs, mtime);
});

await test("updates by key: omitted optional fields are kept, null clears them", async () => {
  const ws = workspace();
  await importScreens(ws, [screen("a", { group: "G", copy: ["One"], image: "a.png", applies_to: { role: ["admin"] } })]);
  const { result } = await importScreens(ws, [screen("a", { title: "Renamed", image: null })]);
  assert.deepEqual(result.updated, ["a"]);
  const text = catalog(ws, "NOTES");
  assert.match(text, /title: Renamed/);
  assert.match(text, /group: G/);
  assert.match(text, /- One/);
  assert.match(text, /role:\n {8}- admin/);
  assert.doesNotMatch(text, /image:/);
  assert.equal((text.match(/- key: a$/gm) ?? []).length, 1, "never duplicates an entry");
});

await test("preserves hand-written comments and untouched entries in an updated file", async () => {
  const ws = workspace();
  ws.write(".tieline/screens/NOTES.yaml", `version: 1
capability: NOTES
# Reviewed by the design team.
screens:
  # The landing page.
  - key: landing
    title: Landing
    route: /
    kind: page
    when: A member signs in.
  - key: a
    title: Old title
    route: /notes
    kind: page
    when: A member opens Notes.
`);
  const { result } = await importScreens(ws, [screen("a")]);
  assert.deepEqual(result.updated, ["a"]);
  const text = catalog(ws, "NOTES");
  assert.match(text, /# Reviewed by the design team\./);
  assert.match(text, /# The landing page\.\n {2}- key: landing\n {4}title: Landing/);
  assert.match(text, /title: Screen a/);
});

await test("moves a screen whose capability changed instead of duplicating it", async () => {
  const ws = workspace();
  await importScreens(ws, [screen("a", { copy: ["Kept"] }), screen("b")]);
  const { result } = await importScreens(ws, [screen("a", { capability: "SHARING" })]);
  assert.deepEqual(result.moved, [{ key: "a", from: "NOTES", to: "SHARING" }]);
  assert.deepEqual(result.created, []);
  assert.doesNotMatch(catalog(ws, "NOTES"), /key: a$/m);
  assert.match(catalog(ws, "SHARING"), /key: a\n[\s\S]*- Kept/);
  assert.equal(loadAcceptedContractWithSources(ws.root, ".tieline/spec").screens?.screens.get("a")?.capability, "SHARING");
});

console.log("screens import: deletion only on request");

await test("never deletes without --prune, and prunes only the capabilities in the file", async () => {
  const ws = workspace();
  await importScreens(ws, [screen("a"), screen("b"), screen("c", { capability: "SHARING" })]);
  const kept = await importScreens(ws, [screen("a")]);
  assert.deepEqual(kept.result.pruned, []);
  assert.match(catalog(ws, "NOTES"), /key: b/);

  const dry = await importScreens(ws, [screen("a")], ["--prune", "--dry-run"]);
  assert.deepEqual(dry.result.pruned, ["b"]);
  assert.equal(dry.result.dry_run, true);
  assert.match(catalog(ws, "NOTES"), /key: b/, "a dry run writes nothing");

  const pruned = await importScreens(ws, [screen("a")], ["--prune"]);
  assert.deepEqual(pruned.result.pruned, ["b"]);
  assert.doesNotMatch(catalog(ws, "NOTES"), /key: b/);
  assert.match(catalog(ws, "SHARING"), /key: c/, "SHARING is not in the file, so it is untouched");
});

console.log("screens import: unknown capabilities");

await test("refuses entries for undeclared capabilities unless asked to skip them", async () => {
  const ws = workspace();
  const entries = [screen("a"), screen("billing-plans", { capability: "BILLING" })];
  await importFails(ws, entries, /1 screen\(s\) name capabilities the contract does not declare; nothing was written[\s\S]*unknown capability 'BILLING': billing-plans/);
  const { result } = await importScreens(ws, entries, ["--skip-unknown-capabilities"]);
  assert.deepEqual(result.created, ["a"]);
  assert.deepEqual(result.skipped_unknown_capability, [{ key: "billing-plans", capability: "BILLING" }]);
  assert.equal(existsSync(resolve(ws.root, ".tieline/screens/BILLING.yaml")), false);
});

console.log("screens import: untrusted input");

await test("rejects malformed documents and invalid entries with every issue named", async () => {
  const ws = workspace();
  await importFails(ws, "{ not json", /is not valid JSON/);
  await importFails(ws, { screens: [] }, /exactly \{ "version": 1, "screens": \[\.\.\.\] \}/);
  await importFails(ws, { version: 2, screens: [] }, /exactly \{ "version": 1/);
  await importFails(ws, { version: 1, screens: [], extra: true }, /exactly \{ "version": 1/);
  await importFails(ws, "\"just a string\"", /must be a JSON array/);
  await importFails(
    ws,
    [screen("a", { kind: "modal", title: "x".repeat(201) }), screen("a"), { key: 7 }, screen("b", { scene: "s.ts" })],
    /The screen import is invalid \(\d+ issue\(s\)\); nothing was written/
  );
  try {
    await importScreens(ws, [screen("a", { kind: "modal", title: "x".repeat(201) }), screen("a"), screen("b", { scene: "s.ts" })]);
    assert.fail("expected the import to fail");
  } catch (error) {
    assert.ok(error instanceof ScreenImportError);
    assert.deepEqual(
      error.issues.map((issue) => issue.replace(/Expected .*, received/, "Expected …, received")),
      [
        'screens[0] ("a") at title: String must contain at most 200 character(s)',
        "screens[0] (\"a\") at kind: Invalid enum value. Expected …, received 'modal'",
        'screens[2] ("b") at scene: \'scene\' is reserved for the script that reaches a screen in a later Tieline release and must be omitted',
      ]
    );
  }
  await importFails(ws, [screen("a"), screen("a")], /screens\[1\] \("a"\): duplicate key; first used by screens\[0\]/);
  await importFails(ws, [screen("a", { image: "../outside.png" })], /screens\[0\] \("a"\) at image/);
  await importFails(ws, [screen("a", { capability: "../NOTES" })], /at capability: must be a stable identifier/);
});

await test("bounds the file size and the entry count before parsing entries", async () => {
  const ws = workspace();
  const file = resolve(ws.root, "big.json");
  writeFileSync(file, JSON.stringify([screen("a")]));
  assert.throws(() => readScreenImportFile(file, 10), /larger than the 10-byte limit/);
  assert.deepEqual(readScreenImportFile(file), [screen("a")]);
  writeFileSync(file, Buffer.from([0x5b, 0xff, 0x5d]));
  assert.throws(() => readScreenImportFile(file), /not valid UTF-8/);
  assert.throws(() => readScreenImportFile(resolve(ws.root, "missing.json")), /Cannot open screen import file/);
  assert.throws(() => readScreenImportFile(ws.root), /is not a file/);
  const tooMany = Array.from({ length: SCREEN_IMPORT_LIMITS.entries + 1 }, () => 0);
  assert.throws(() => parseScreenImport(tooMany), /holds 10001 entries; the limit is 10000/);
  assert.equal(SCREEN_IMPORT_LIMITS.fileBytes, 16 * 1024 * 1024);
});

await test("refuses to merge into an invalid catalog or a repository that has not opted in", async () => {
  const ws = workspace();
  ws.write(".tieline/screens/NOTES.yaml", "version: 1\ncapability: NOTES\nscreens:\n  - key: a\n");
  await importFails(ws, [screen("b")], /The existing screen catalog is invalid; fix it before importing/);
  const orphan = workspace();
  orphan.write(".tieline/screens/GONE.yaml", "version: 1\ncapability: GONE\nscreens: []\n");
  await importFails(orphan, [screen("b")], /screen catalog names unknown capability 'GONE'/);
  const occupied = workspace();
  occupied.write(".tieline/screens/NOTES.yaml", "version: 1\ncapability: SHARING\nscreens: []\n");
  await importFails(occupied, [screen("b")], /'\.tieline\/screens\/NOTES\.yaml' already exists and is not that capability's catalog/);
  const disabled = workspace({});
  await assert.rejects(() => importScreens(disabled, [screen("a")]), /Screens are not enabled for this repository/);
});

await test("leaves a captures directory outside .tieline for the repository to ignore", async () => {
  const ws = workspace({ screens: { enabled: true, captures_directory: "../artifacts/screens" } });
  const { result } = await importScreens(ws, [screen("a")]);
  assert.equal(result.captures_gitignore, "not_managed");
  assert.equal(existsSync(resolve(ws.root, "artifacts/screens/.gitignore")), false);
  const capture = captureIO();
  writeFileSync(resolve(ws.root, "import.json"), JSON.stringify([screen("a", { title: "Changed" })]));
  assert.equal(await runCli(["screens", "import", resolve(ws.root, "import.json"), "--repository", ws.root], capture.io, {}), 0);
  assert.match(capture.output(), /Imported 1 screen\(s\) into \.tieline\/screens: 0 created, 1 updated/);
  assert.match(capture.output(), /note {2}artifacts\/screens is outside \.tieline\/; make sure screenshots there are git-ignored/);
  assert.match(capture.output(), /Run `tieline contract compile \.`/);
});

console.log("screens import: screenshot digests");

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

await test("records each readable screenshot's digest and keeps a reviewed one when the file is absent", async () => {
  const ws = workspace();
  ws.write(".tieline/captures/notes/list.png", "first capture");
  const first = await importScreens(ws, [screen("a", { image: "notes/list.png" }), screen("b", { image: "notes/missing.png" })]);
  assert.deepEqual(first.result.image_digests, { computed: 1, missing: ["b"] });
  assert.match(catalog(ws, "NOTES"), new RegExp(`path: notes/list.png\n {6}sha256: ${sha256("first capture")}`));
  assert.doesNotMatch(catalog(ws, "NOTES"), /missing\.png\n {6}sha256/);

  // A machine without the screenshot keeps the reviewed digest instead of erasing it.
  ws.remove(".tieline/captures/notes/list.png");
  const absent = await importScreens(ws, [screen("a", { image: "notes/list.png" })]);
  assert.deepEqual(absent.result.updated, []);
  assert.deepEqual(absent.result.image_digests, { computed: 0, missing: ["a"] });
  assert.match(catalog(ws, "NOTES"), new RegExp(`sha256: ${sha256("first capture")}`));

  // A re-capture changes the digest, so the reviewed diff shows the new picture.
  ws.write(".tieline/captures/notes/list.png", "second capture");
  const recaptured = await importScreens(ws, [screen("a", { image: "notes/list.png" })]);
  assert.deepEqual(recaptured.result.updated, ["a"]);
  assert.match(catalog(ws, "NOTES"), new RegExp(`sha256: ${sha256("second capture")}`));

  // A digest supplied by a capture tool is trusted as the record, not recomputed.
  const supplied = sha256("from the tool");
  await importScreens(ws, [screen("a", { image: { url: "https://cdn.example.test/a.png", sha256: supplied } })]);
  assert.match(catalog(ws, "NOTES"), new RegExp(`url: https://cdn.example.test/a.png\n {6}sha256: ${supplied}`));
  await importFails(ws, [screen("a", { image: { path: "a.png", sha256: "ABC" } })], /must be a lowercase hex SHA-256 digest/);
});

await test("refuses screenshots that escape the captures directory or exceed the size bound", () => {
  const ws = workspace();
  ws.write("secret.png", "outside");
  mkdirSync(resolve(ws.root, ".tieline/captures"), { recursive: true });
  symlinkSync(resolve(ws.root, "secret.png"), resolve(ws.root, ".tieline/captures/link.png"));
  ws.write(".tieline/captures/big.png", "x".repeat(64));
  const settings = screenSettingsForRepository(ws.root)!;
  assert.throws(
    () => createCaptureDigester(settings).digest("link.png", "a"),
    /Screenshot 'link.png' for screen 'a' resolves outside the captures directory '\.tieline\/captures'/
  );
  assert.throws(
    () => createCaptureDigester(settings, { fileBytes: 16, totalBytes: 1024 }).digest("big.png", "b"),
    /Screenshot '.*big\.png' is larger than the 16-byte limit/
  );
  assert.equal(SCREEN_IMPORT_LIMITS.captureBytes, 25 * 1024 * 1024);
  assert.equal(SCREEN_IMPORT_LIMITS.captureTotalBytes, 4 * 1024 * 1024 * 1024);
});

await test("reads each screenshot once and bounds the total it reads", () => {
  const ws = workspace();
  ws.write(".tieline/captures/one.png", "x".repeat(40));
  ws.write(".tieline/captures/two.png", "y".repeat(40));
  const settings = screenSettingsForRepository(ws.root)!;
  const digester = createCaptureDigester(settings, { fileBytes: 64, totalBytes: 100 });
  // Many entries naming one file cost one read.
  for (let index = 0; index < 50; index += 1) digester.digest("one.png", `screen-${index}`);
  assert.equal(digester.bytesRead, 40);
  assert.equal(digester.computed, 50);
  digester.digest("two.png", "second");
  assert.equal(digester.bytesRead, 80);
  ws.write(".tieline/captures/three.png", "z".repeat(40));
  assert.throws(
    () => digester.digest("three.png", "third"),
    /exceed the 100-byte total it may read; import in smaller batches/
  );
});

await test("re-reads a screenshot whose path the import keeps from the catalog", async () => {
  const ws = workspace();
  ws.write(".tieline/captures/notes/list.png", "first capture");
  await importScreens(ws, [screen("a", { image: "notes/list.png" })]);
  ws.write(".tieline/captures/notes/list.png", "second capture");
  // The re-import omits `image`, so the catalog's path is kept and re-read.
  const { result } = await importScreens(ws, [screen("a")]);
  assert.deepEqual(result.updated, ["a"]);
  assert.match(catalog(ws, "NOTES"), new RegExp(`path: notes/list.png\\n {6}sha256: ${sha256("second capture")}`));
});

await test("never reads screenshots of entries skipped for an unknown capability", async () => {
  const ws = workspace();
  ws.write("secret.png", "outside");
  mkdirSync(resolve(ws.root, ".tieline/captures"), { recursive: true });
  symlinkSync(resolve(ws.root, "secret.png"), resolve(ws.root, ".tieline/captures/escape.png"));
  const { exit, result } = await importScreens(
    ws,
    [screen("a"), screen("billing", { capability: "BILLING", image: "escape.png" })],
    ["--skip-unknown-capabilities"]
  );
  assert.equal(exit, 0);
  assert.deepEqual(result.created, ["a"]);
  assert.deepEqual(result.image_digests, { computed: 0, missing: [] });
  assert.deepEqual(result.skipped_unknown_capability, [{ key: "billing", capability: "BILLING" }]);
});

await test("refuses an import that would write an oversized catalog file", async () => {
  const ws = workspace();
  const copy = Array.from({ length: 50 }, (_, index) => `${index} ${"c".repeat(480)}`);
  const entries = Array.from({ length: 180 }, (_, index) => screen(`screen-${index}`, { copy }));
  await importFails(
    ws,
    entries,
    /The imported catalog would not validate; nothing was written\.\n- \.tieline\/screens\/NOTES\.yaml: the catalog would be \d+ bytes; the limit is 4194304/
  );
});

console.log("screens import: atomic writes");

function moveBetweenCatalogs(ws: ScreensWorkspace) {
  const settings = screenSettingsForRepository(ws.root)!;
  const read = readScreenCatalogSources(ws.root, settings);
  const issues: string[] = [];
  const catalog = validateScreenCatalogDocuments(read.sources, undefined, issues);
  assert.deepEqual(issues, []);
  const documents = new Map(catalog.files.map((file) => [file.path, file.document]));
  return planScreenImport(
    parseScreenImport([screen("a", { capability: "SHARING" })]),
    read.sources.map((source) => ({ source, document: documents.get(source.path)! })),
    {
      repositoryRoot: ws.root,
      settings,
      capabilityKeys: new Set(["NOTES", "SHARING"]),
      prune: false,
      skipUnknownCapabilities: false,
    }
  );
}

function failingRenames(failOn: number[]) {
  let renames = 0;
  return {
    mkdirSync: (path: string, options: { recursive: true }) => {
      mkdirSync(path, options);
    },
    writeFileSync: (path: string, content: string) => writeFileSync(path, content),
    rmSync: (path: string, options: { force: true }) => rmSync(path, options),
    renameSync: (from: string, to: string) => {
      renames += 1;
      if (failOn.includes(renames)) throw new Error("disk full");
      renameSync(from, to);
    },
  };
}

await test("restores every file already written when a later write fails", async () => {
  const ws = workspace();
  await importScreens(ws, [screen("a"), screen("b", { capability: "SHARING" })]);
  const before = snapshot(ws);
  const plan = moveBetweenCatalogs(ws);
  assert.deepEqual(plan.files.map((file) => file.status), ["updated", "updated"]);
  assert.throws(
    () => applyScreenImport(plan, failingRenames([2])),
    /Writing '\.tieline\/screens\/SHARING\.yaml' failed \(disk full\); the 1 file\(s\) already written were restored, so the catalog is unchanged\./
  );
  // Byte-identical, with no staged or restore files left behind.
  assert.deepEqual(snapshot(ws), before);
});

await test("names the files to restore from git when restoring fails too", async () => {
  const ws = workspace();
  await importScreens(ws, [screen("a"), screen("b", { capability: "SHARING" })]);
  try {
    applyScreenImport(moveBetweenCatalogs(ws), failingRenames([2, 3]));
    assert.fail("expected the import to fail");
  } catch (error) {
    assert.ok(error instanceof ScreenImportError);
    assert.match(error.message, /restoring the files already written also failed\. Restore them from git before importing again\./);
    assert.deepEqual(error.issues, [".tieline/screens/NOTES.yaml (disk full)"]);
  }
});

for (const created of workspaces) created.cleanup();
report();
