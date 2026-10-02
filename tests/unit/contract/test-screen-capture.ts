import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { runCli } from "../../../src/cli.js";
import {
  readCaptureEnvironment,
  resolvePlaywright,
  runScreensAuditCaptureCommand,
  runScreensCaptureCommand,
  screenGrep,
  spawnPlaywright,
  type PlaywrightRunOutcome,
  type ScreensCaptureOptions,
} from "../../../src/commands/screens-capture.js";
import {
  applyCaptureOutputs,
  captureFingerprint,
  planCaptureOutputs,
  readCapturedScreens,
  readCaptureRunRecord,
  ScreenCaptureError,
  SCREEN_CAPTURE_RUN_LIMITS,
  type CapturedScreen,
} from "../../../src/contract/screen-capture-run.js";
import {
  readScreenCatalogSources,
  screenSettingsForRepository,
  validateScreenCatalogDocuments,
  type ScreenEntry,
} from "../../../src/contract/screen-catalog.js";
import { readScreenTextDirectory, screenTextDigest } from "../../../src/contract/screen-text.js";
import {
  RUN_DIRECTORY_ENV,
  RUN_RECORD_FILE,
  SCREENS_DIRECTORY,
  type RunRecord,
} from "../../../src/playwright/protocol.cjs";
import { report, test } from "../../support/harness.js";
import {
  captureDependencies,
  captureSettings,
  ENVIRONMENT,
  fakePlaywrightRun,
  png,
  type FakeRunBehavior,
} from "../../support/screen-capture-fakes.js";
import {
  captureIO,
  createScreensWorkspace,
  type ScreensWorkspace,
} from "../../support/screen-fixtures.js";

const workspaces: ScreensWorkspace[] = [];
const temporaryDirectories: string[] = [];

function screen(key: string, overrides: Partial<ScreenEntry> = {}): ScreenEntry {
  return { key, title: `Screen ${key}`, route: "/notes", kind: "page", when: "A member opens Notes.", ...overrides };
}

const NOTES_YAML = `version: 1
capability: NOTES
# Screens of the notes area, reviewed with the notes Stories.
screens:
  - key: notes-list
    title: Notes list
    route: /notes
    kind: page
    when: A member opens Notes. # the default landing page
    image:
      url: https://images.example.test/notes-list.png
  - key: notes-list-empty
    title: Notes list, no notes yet
    route: /notes
    kind: state
    when: A member without notes opens Notes.
`;

function notesWorkspace(screens: unknown = { enabled: true }): ScreensWorkspace {
  const ws = createScreensWorkspace({
    git: true,
    screens,
    catalog: {
      ".tieline/screens/NOTES.yaml": NOTES_YAML,
      ".tieline/screens/SHARING.yaml": stringify({ version: 1, capability: "SHARING", screens: [screen("notes-share-denied")] }),
    },
  });
  workspaces.push(ws);
  return ws;
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "tieline-capture-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function read(ws: ScreensWorkspace, path: string): string {
  return readFileSync(resolve(ws.root, path), "utf8");
}

/** Every file under the workspace's .tieline directory, for "nothing was written" checks. */
function tielineFiles(ws: ScreensWorkspace): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string, prefix: string): void => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(join(directory, entry.name), `${path}/`);
      else files[path] = readFileSync(join(directory, entry.name)).toString("base64");
    }
  };
  walk(resolve(ws.root, ".tieline"), ".tieline/");
  return files;
}

async function capture(
  ws: ScreensWorkspace,
  options: Omit<ScreensCaptureOptions, "repository">,
  behavior: FakeRunBehavior = {},
  overrides: Parameters<typeof captureDependencies>[1] = {}
): Promise<{ exit: number; output: string; run: ReturnType<typeof fakePlaywrightRun> }> {
  const io = captureIO();
  const run = fakePlaywrightRun(behavior);
  const exit = await runScreensCaptureCommand({ ...options, repository: ws.root }, io.io, captureDependencies(run, overrides));
  return { exit, output: io.output(), run };
}

async function captureFails(
  ws: ScreensWorkspace,
  options: Omit<ScreensCaptureOptions, "repository">,
  behavior: FakeRunBehavior,
  expected: RegExp
): Promise<void> {
  const before = tielineFiles(ws);
  await assert.rejects(() => capture(ws, options, behavior), expected);
  assert.deepEqual(tielineFiles(ws), before, "a failed capture writes nothing");
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

console.log("screens capture: fingerprints");

await test("fingerprints every pixel-affecting setting, not the screen or its settle attempts", () => {
  const base = captureFingerprint(captureSettings("a"), "1.63.0", ENVIRONMENT);
  assert.match(base, /^[a-f0-9]{64}$/);
  assert.equal(captureFingerprint(captureSettings("b", { settle_attempts: 4 }), "1.63.0", ENVIRONMENT), base);
  const settings = captureSettings("a");
  const variants = [
    captureFingerprint(settings, "1.63.1", ENVIRONMENT),
    captureFingerprint({ ...settings, browser: { name: "chromium", version: "141.0.0.0" } }, "1.63.0", ENVIRONMENT),
    captureFingerprint({ ...settings, page: { ...settings.page, device_scale_factor: 2 } }, "1.63.0", ENVIRONMENT),
    captureFingerprint({ ...settings, page: { ...settings.page, color_scheme: "dark" } }, "1.63.0", ENVIRONMENT),
    captureFingerprint({ ...settings, page: { ...settings.page, timezone: "Europe/Paris" } }, "1.63.0", ENVIRONMENT),
    captureFingerprint({ ...settings, page: { ...settings.page, viewport: { width: 390, height: 844 } } }, "1.63.0", ENVIRONMENT),
    captureFingerprint({ ...settings, snapshot: { ...settings.snapshot, masks: ["locator('.avatar')"] } }, "1.63.0", ENVIRONMENT),
    captureFingerprint(settings, "1.63.0", { ...ENVIRONMENT, fonts: null }),
    captureFingerprint(settings, "1.63.0", { ...ENVIRONMENT, platform: "darwin" }),
    captureFingerprint(settings, "1.63.0", { ...ENVIRONMENT, image: null }),
  ];
  assert.equal(new Set([base, ...variants]).size, variants.length + 1);
});

console.log("screens capture: run records");

function runDirectoryWith(record: unknown, screens: Record<string, { image?: Buffer; text?: string; settings?: unknown }> = {}): string {
  const directory = temporaryDirectory();
  writeFileSync(join(directory, RUN_RECORD_FILE), typeof record === "string" ? record : JSON.stringify(record));
  mkdirSync(join(directory, SCREENS_DIRECTORY));
  for (const [key, files] of Object.entries(screens)) {
    writeFileSync(join(directory, SCREENS_DIRECTORY, `${key}.png`), files.image ?? png(key));
    writeFileSync(join(directory, SCREENS_DIRECTORY, `${key}.yml`), files.text ?? `- heading "${key}"\n`);
    writeFileSync(join(directory, SCREENS_DIRECTORY, `${key}.json`), JSON.stringify(files.settings ?? captureSettings(key)));
  }
  return directory;
}

function record(tests: Array<Partial<RunRecord["tests"][number]> & { keys: string[] }>, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    version: 1,
    playwright: "1.63.0",
    status: "passed",
    tests: tests.map((entry, index) => ({
      id: `t${index}`,
      file: "/repo/e2e/notes.screens.ts",
      line: 1,
      title: `test ${index}`,
      project: "screens",
      status: "passed",
      error: null,
      ...entry,
    })),
    errors: [],
    ...overrides,
  };
}

function readRun(directory: string, selected: string[], limits?: Parameters<typeof readCapturedScreens>[0]["limits"]) {
  const parsed = readCaptureRunRecord(directory);
  assert.ok(parsed);
  return readCapturedScreens({ runDirectory: directory, repositoryRoot: "/repo", record: parsed, selected, environment: ENVIRONMENT, ...(limits ? { limits } : {}) });
}

await test("refuses a run record that is missing, malformed, oversized, or not of this version", () => {
  assert.equal(readCaptureRunRecord(temporaryDirectory()), null);
  assert.throws(() => readCaptureRunRecord(runDirectoryWith("{not json")), /The capture run record is not valid JSON/);
  assert.throws(
    () => readCaptureRunRecord(runDirectoryWith({ ...record([]), version: 2 })),
    (error: unknown) => error instanceof ScreenCaptureError && /not one this version of Tieline wrote\.\n- version: Invalid literal value/.test(error.message)
  );
  assert.throws(
    () => readCaptureRunRecord(runDirectoryWith({ ...record([]), extra: true })),
    /Unrecognized key\(s\) in object: 'extra'/
  );
  assert.throws(
    () => readCaptureRunRecord(runDirectoryWith(`${JSON.stringify(record([]))}${" ".repeat(SCREEN_CAPTURE_RUN_LIMITS.recordBytes)}`)),
    /larger than the 16777216-byte limit/
  );
});

await test("reads complete captures, re-hashed, with the test file relative to the repository", () => {
  const directory = runDirectoryWith(record([{ keys: ["a"] }, { keys: ["b", "unselected"] }]), {
    a: { text: "- heading \"a\"\r\n- list" },
    b: {},
    unselected: {},
  });
  const captured = readRun(directory, ["b", "a"]);
  assert.deepEqual(captured.map((screen) => [screen.key, screen.test]), [["a", "e2e/notes.screens.ts"], ["b", "e2e/notes.screens.ts"]]);
  assert.equal(captured[0]!.image_sha256, sha256(png("a")));
  // Committed snapshots use LF line endings and end with a newline.
  assert.equal(captured[0]!.text, "- heading \"a\"\n- list\n");
  assert.equal(captured[0]!.text_sha256, screenTextDigest("- heading \"a\"\n- list\n"));
  assert.equal(captured[0]!.fingerprint, captureFingerprint(captureSettings("a"), "1.63.0", ENVIRONMENT));
});

await test("refuses runs with failed tests, run errors, missing, or doubly captured screens", () => {
  const failed = runDirectoryWith(
    record([{ keys: ["a"] }, { keys: [], status: "timedOut", title: "slow page", error: "Test timeout of 30000ms exceeded.\nmore" }], {
      errors: ["Error in global setup: database seed failed\nstack"],
    }),
    { a: {} }
  );
  assert.throws(() => readRun(failed, ["a"]), (error: unknown) => {
    assert.ok(error instanceof ScreenCaptureError);
    assert.deepEqual(error.issues, [
      "slow page (/repo/e2e/notes.screens.ts:1, project screens) timedOut: Test timeout of 30000ms exceeded.",
      "run error: Error in global setup: database seed failed",
    ]);
    return /2 test\(s\) or run step\(s\) failed, so nothing was written\./.test(error.message);
  });

  const incomplete = runDirectoryWith(
    record([
      { keys: ["dup"], title: "first" },
      { keys: ["dup"], title: "second", project: "mobile" },
      { keys: ["twice", "twice"], title: "repeats" },
      { keys: ["skipped"], status: "skipped" },
    ]),
    { dup: {}, twice: {} }
  );
  assert.throws(() => readRun(incomplete, ["dup", "missing", "twice", "skipped"]), (error: unknown) => {
    assert.ok(error instanceof ScreenCaptureError);
    assert.deepEqual(error.issues, [
      "'dup' was captured by 2 tests (first [screens]; second [mobile]); capture each screen in exactly one test and one project",
      "'missing' was not captured: no passing test tagged @screen:missing called tielineSnapshot(page, 'missing')",
      "'twice' was captured 2 times by repeats; capture it once",
      "'skipped' was not captured: no passing test tagged @screen:skipped called tielineSnapshot(page, 'skipped')",
    ]);
    return true;
  });
});

await test("refuses capture files that are not what the fixture writes", () => {
  const cases: Array<[Record<string, { image?: Buffer; text?: string; settings?: unknown }>, string, RegExp]> = [
    [{ a: { image: Buffer.from("GIF89a") } }, "/repo/e2e/a.spec.ts", /the screenshot of 'a' is not a PNG file/],
    [{ a: { text: "\u0000" } }, "/repo/e2e/a.spec.ts", /the ARIA snapshot of 'a' contains a NUL byte/],
    [{ a: { settings: "not json" } }, "/repo/e2e/a.spec.ts", /the capture settings of 'a' are invalid: : Expected object, received string/],
    [{ a: { settings: captureSettings("b") } }, "/repo/e2e/a.spec.ts", /the capture settings of 'a' name 'b'/],
    [{ a: { settings: { ...captureSettings("a"), page: { ...captureSettings("a").page, color_scheme: "sepia" } } } }, "/repo/e2e/a.spec.ts", /the capture settings of 'a' are invalid: page\.color_scheme/],
    [{ a: {} }, "/elsewhere/a.spec.ts", /'a' was captured by a test outside the repository \(\/elsewhere\/a\.spec\.ts\)/],
    [{ a: {} }, "relative/a.spec.ts", /'a' was captured by a test outside the repository/],
  ];
  for (const [screens, file, expected] of cases) {
    const directory = runDirectoryWith(record([{ keys: ["a"], file }]), screens);
    assert.throws(() => readRun(directory, ["a"]), expected, expected.source);
  }
  const invalidUtf8 = runDirectoryWith(record([{ keys: ["a"] }]), { a: {} });
  writeFileSync(join(invalidUtf8, SCREENS_DIRECTORY, "a.yml"), Buffer.from([0xff, 0xfe]));
  assert.throws(() => readRun(invalidUtf8, ["a"]), /the ARIA snapshot of 'a' is not valid UTF-8/);
  const missingFile = runDirectoryWith(record([{ keys: ["a"] }]), {});
  assert.throws(() => readRun(missingFile, ["a"]), /Cannot open screenshot/);
});

await test("bounds each capture file and the run's screenshots in total", () => {
  const limits = { imageBytes: 64, totalImageBytes: 30, textBytes: 16, settingsBytes: 4_096 };
  const big = runDirectoryWith(record([{ keys: ["a"] }]), { a: { image: png("x".repeat(80)) } });
  assert.throws(() => readRun(big, ["a"], limits), /is larger than the 64-byte limit/);
  const total = runDirectoryWith(record([{ keys: ["a", "b"] }]), { a: { image: png("x".repeat(10)) }, b: { image: png("y".repeat(10)) } });
  assert.throws(() => readRun(total, ["a", "b"], limits), /the run's screenshots exceed the 30-byte total; capture in smaller batches/);
  const text = runDirectoryWith(record([{ keys: ["a"] }]), { a: { text: "- ".repeat(20) } });
  assert.throws(() => readRun(text, ["a"], limits), /ARIA snapshot .* is larger than the 16-byte limit/);
  assert.equal(SCREEN_CAPTURE_RUN_LIMITS.imageBytes, 25 * 1024 * 1024);
  assert.equal(SCREEN_CAPTURE_RUN_LIMITS.textBytes, 1024 * 1024);
});

console.log("screens capture: writing outputs");

await test("captures every screen into the catalog, ARIA snapshots, and captures directory", async () => {
  const ws = notesWorkspace({ enabled: true, capture: { playwright_config: "e2e/playwright.config.ts", project: "screens", timeout_minutes: 7 } });
  const { exit, output, run } = await capture(ws, { all: true });
  assert.equal(exit, 0);
  assert.match(output, /^Captured 3 screen\(s\) with Playwright 1\.63\.0: 3 new, 0 updated, 0 unchanged\.\n/);
  assert.match(output, /Run `tieline contract compile \.` to refresh the manifest and review page, then commit the catalog and ARIA snapshots\.\n$/);

  // Playwright ran once, for every screen test, with Tieline's reporter.
  assert.equal(run.calls.length, 1);
  const call = run.calls[0]!;
  assert.equal(call.cli, "/fake/node_modules/@playwright/test/cli.js");
  assert.equal(call.cwd, ws.root);
  assert.equal(call.timeoutMs, 7 * 60_000);
  assert.deepEqual(call.args.slice(0, 7), ["test", "--config", "e2e/playwright.config.ts", "--project", "screens", "--grep", "@screen:"]);
  assert.equal(call.args[7], "--reporter");
  assert.equal(call.args[8], fileURLToPath(new URL("../../../src/playwright/reporter.cjs", import.meta.url)));
  assert.deepEqual(run.selections, [{ version: 1, keys: ["notes-list", "notes-list-empty", "notes-share-denied"] }]);
  // The temporary run directory is gone.
  assert.equal(existsSync(call.env[RUN_DIRECTORY_ENV]!), false);

  const notes = read(ws, ".tieline/screens/NOTES.yaml");
  // Edited in place: comments and untouched fields survive.
  assert.match(notes, /^version: 1\ncapability: NOTES\n# Screens of the notes area, reviewed with the notes Stories\.\n/);
  assert.match(notes, /when: A member opens Notes\. # the default landing page\n/);
  const fingerprint = captureFingerprint(captureSettings("notes-list"), "1.63.0", ENVIRONMENT);
  assert.match(
    notes,
    new RegExp(
      `  - key: notes-list\\n[\\s\\S]*?    image:\\n      path: notes-list\\.png\\n      sha256: ${sha256(png("picture of notes-list"))}\\n    capture:\\n      fingerprint: ${fingerprint}\\n      text_sha256: ${screenTextDigest('- heading "notes-list" [level=1]\n')}\\n      test: e2e/notes\\.screens\\.ts\\n`
    )
  );
  assert.equal(read(ws, ".tieline/screen-text/notes-list.yml"), '- heading "notes-list" [level=1]\n');
  assert.deepEqual(readFileSync(resolve(ws.root, ".tieline/captures/notes-list.png")), png("picture of notes-list"));
  assert.equal(read(ws, ".tieline/captures/.gitignore"), "# Screenshots referenced by the Tieline screen catalog are not committed.\n*\n!.gitignore\n");

  // The audit now finds nothing missing but the scene tests' files.
  const audit = captureIO();
  assert.equal(await runCli(["screens", "audit", "--repository", ws.root, "--json"], audit.io, {}), 0);
  const findings = JSON.parse(audit.output()) as { incomplete: Array<{ missing: string[] }>; text_mismatch: string[] };
  assert.ok(findings.incomplete.every((gap) => gap.missing.join() === "scene"));
  assert.deepEqual(findings.text_mismatch, []);

  // Capturing again changes nothing.
  const again = await capture(ws, { all: true });
  assert.match(again.output, /: 0 new, 0 updated, 3 unchanged\.\n/);
  assert.doesNotMatch(again.output, /contract compile/);
});

await test("reports what changed on re-capture and removes ARIA snapshots of retired screens", async () => {
  const ws = notesWorkspace();
  await capture(ws, { all: true });
  ws.write(".tieline/screen-text/retired-screen.yml", "- text: gone\n");
  const { output } = await capture(
    ws,
    { screens: ["notes-list", "notes-list-empty"] },
    {
      screens: () => ({
        "notes-list": { image: png("new picture") },
        "notes-list-empty": { settings: { page: { ...captureSettings("x").page, device_scale_factor: 2 } }, text: "- text: Write your first note\n" },
      }),
      testFile: (key, cwd) => resolve(cwd, key === "notes-list" ? "e2e/moved.screens.ts" : "e2e/notes.screens.ts"),
    }
  );
  assert.match(output, /: 0 new, 2 updated, 0 unchanged\.\n/);
  assert.match(output, /  updated   notes-list \(image, test\)\n/);
  assert.match(output, /  updated   notes-list-empty \(environment, text\)\n/);
  assert.match(output, /  removed   \.tieline\/screen-text\/retired-screen\.yml: no catalogued screen has this key\n/);
  assert.equal(existsSync(resolve(ws.root, ".tieline/screen-text/retired-screen.yml")), false);
  assert.doesNotMatch(output, /different environment/);
  assert.equal(read(ws, ".tieline/screen-text/notes-list-empty.yml"), "- text: Write your first note\n");

  // A capture made elsewhere than the rest of the catalog says so at once.
  const elsewhere = await capture(
    ws,
    { screens: ["notes-share-denied"] },
    { screens: () => ({ "notes-share-denied": { settings: { browser: { name: "chromium", version: "999.0" } } } }) }
  );
  assert.match(
    elsewhere.output,
    /  note  2 other screen\(s\) were captured in a different environment; `--verify` compares only captures made in the same one\.\n/
  );
});

await test("restores every committed output when writing the catalog fails part-way", async () => {
  const ws = notesWorkspace();
  await capture(ws, { all: true });
  const before = tielineFiles(ws);
  const settings = screenSettingsForRepository(ws.root)!;
  const read = readScreenCatalogSources(ws.root, settings);
  const capabilityKeys = new Set(["NOTES", "SHARING"]);
  const catalog = validateScreenCatalogDocuments(read.sources, capabilityKeys, []);
  const fresh = (key: string): CapturedScreen => ({
    key,
    image: png(`recaptured ${key}`),
    image_sha256: sha256(png(`recaptured ${key}`)),
    text: `- text: recaptured ${key}\n`,
    text_sha256: screenTextDigest(`- text: recaptured ${key}\n`),
    fingerprint: "e".repeat(64),
    test: "e2e/notes.screens.ts",
  });
  const plan = planCaptureOutputs({
    repositoryRoot: ws.root,
    settings,
    sources: read.sources,
    catalog,
    capabilityKeys,
    text: readScreenTextDirectory(settings),
    captured: [fresh("notes-list"), fresh("notes-share-denied")],
  });
  assert.deepEqual(plan.texts.map((text) => [text.path, text.status]), [
    [".tieline/screen-text/notes-list.yml", "updated"],
    [".tieline/screen-text/notes-share-denied.yml", "updated"],
  ]);
  const failing = {
    mkdirSync: (path: string, options: { recursive: true }) => void mkdirSync(path, options),
    createFileSync: (path: string, content: string) => writeFileSync(path, content, { flag: "wx" }),
    renameSync: (from: string, to: string) => {
      if (to.endsWith("SHARING.yaml")) throw new Error("disk full");
      renameSync(from, to);
    },
    rmSync: (path: string, options: { force: true }) => rmSync(path, options),
  };
  assert.throws(
    () => applyCaptureOutputs(ws.root, settings, plan, failing),
    /Writing '\.tieline\/screens\/SHARING\.yaml' failed \(disk full\); the 1 file\(s\) already written were restored/
  );
  // Screenshots are git-ignored and may be left behind; every committed output is as it was.
  const committed = (files: Record<string, string>) =>
    Object.fromEntries(Object.entries(files).filter(([path]) => !path.startsWith(".tieline/captures/")));
  assert.deepEqual(committed(tielineFiles(ws)), committed(before));

  // A catalog edited after the capture read it is never overwritten, and the
  // snapshots written before the catalog are restored with it.
  ws.write(".tieline/screens/SHARING.yaml", `${readFileSync(resolve(ws.root, ".tieline/screens/SHARING.yaml"), "utf8")}# edited meanwhile\n`);
  const edited = tielineFiles(ws);
  assert.throws(
    () => applyCaptureOutputs(ws.root, settings, plan),
    /The screen catalog changed after the import read it, so nothing was written[\s\S]*SHARING\.yaml was edited after the import read it/
  );
  assert.deepEqual(committed(tielineFiles(ws)), committed(edited));
});

await test("refuses to write while a screen import holds the catalog", async () => {
  const ws = notesWorkspace();
  ws.write(".tieline/screens-import.lock", `${JSON.stringify({ pid: 1, started_at: "2026-10-02T00:00:00.000Z" })}\n`);
  const before = tielineFiles(ws);
  await assert.rejects(() => capture(ws, { all: true }), /Another screen import is in progress: '\.tieline\/screens-import\.lock' exists/);
  assert.deepEqual(
    Object.fromEntries(Object.entries(tielineFiles(ws)).filter(([path]) => !path.startsWith(".tieline/captures/"))),
    Object.fromEntries(Object.entries(before).filter(([path]) => !path.startsWith(".tieline/captures/")))
  );
  // Verification writes nothing, so it does not need the lock.
  assert.equal((await capture(ws, { screens: ["notes-list"], verify: true })).exit, 1);
});

await test("says so when the captures .gitignore cannot be trusted to hide screenshots", async () => {
  const ws = notesWorkspace();
  ws.write(".tieline/captures/.gitignore", "*.log\n");
  const { output } = await capture(ws, { screens: ["notes-list"] });
  assert.match(output, /  note  \.tieline\/captures\/\.gitignore does not ignore everything in \.tieline\/captures .* make sure screenshots there are git-ignored\.\n/);
  assert.equal(read(ws, ".tieline/captures/.gitignore"), "*.log\n");
  const json = await capture(ws, { screens: ["notes-list"], json: true });
  assert.equal((JSON.parse(json.output) as { captures_gitignore: string }).captures_gitignore, "unverified");
});

await test("selects by escaped, bounded tags and runs nothing when nothing is selected", async () => {
  assert.equal(screenGrep(["notes.list", "a-b"], false), "@screen:(?:notes\\.list|a-b)(?![A-Za-z0-9._-])");
  const grep = new RegExp(screenGrep(["notes.list", "notes"], false));
  assert.ok(grep.test("lists notes @screen:notes.list"));
  assert.ok(grep.test("@screen:notes @fast"));
  assert.ok(!grep.test("@screen:notes-list"));
  assert.ok(!grep.test("@screen:notesXlist"));
  assert.equal(screenGrep(["a"], true), "@screen:");
  assert.equal(screenGrep(Array.from({ length: 201 }, (_, index) => `k${index}`), false), "@screen:");

  const ws = notesWorkspace();
  const one = await capture(ws, { screens: ["notes-list"] });
  assert.equal(one.run.calls[0]!.args[one.run.calls[0]!.args.indexOf("--grep") + 1], "@screen:(?:notes-list)(?![A-Za-z0-9._-])");
  ws.commit("captured");
  const refuse = (): never => {
    throw new Error("nothing was selected, so Playwright must not run");
  };
  const none = await capture(ws, { changed: true, base: "HEAD" }, {}, { playwright: refuse, run: refuse });
  assert.equal(
    none.output,
    "No screen was selected, so nothing was captured.\n  note  dependency rule incomplete: no topology in this test\n"
  );
});

console.log("screens capture: failures write nothing");

await test("writes nothing when a test fails, a screen is missing, or Playwright stops early", async () => {
  const ws = notesWorkspace();
  await captureFails(
    ws,
    { all: true },
    { extraTests: () => [{ id: "x", file: resolve(ws.root, "e2e/x.spec.ts"), line: 9, title: "share dialog", project: "screens", status: "failed", keys: [], error: "locator.click: Timeout 5000ms exceeded." }] },
    /1 test\(s\) or run step\(s\) failed, so nothing was written\.\n- share dialog \(.*e2e\/x\.spec\.ts:9, project screens\) failed: locator\.click: Timeout 5000ms exceeded\./
  );
  await captureFails(
    ws,
    { all: true },
    { screens: (selected) => Object.fromEntries(selected.filter((key) => key !== "notes-share-denied").map((key) => [key, {}])) },
    /The capture run is incomplete, so nothing was written\.\n- 'notes-share-denied' was not captured/
  );
  await captureFails(ws, { all: true }, { noRecord: true, outcome: { kind: "exited", code: 1, signal: null } }, /Playwright stopped \(exit code 1\) before the run finished, so nothing was written\./);
  await captureFails(ws, { all: true }, { outcome: { kind: "exited", code: 1, signal: null } }, /Playwright reported a failed run \(exit code 1, status passed\) although every selected screen was captured/);
  await captureFails(ws, { all: true }, { outcome: { kind: "timed_out" } }, /took longer than 30 minute\(s\) \(screens\.capture\.timeout_minutes\) and was stopped; nothing was written\./);
  await captureFails(ws, { all: true }, { outcome: { kind: "cancelled" } }, /The capture run was cancelled; nothing was written\./);
  await captureFails(ws, { all: true }, { outcome: { kind: "spawn_failed", detail: "spawn ENOENT" } }, /Playwright could not be started: spawn ENOENT/);
  await captureFails(ws, { all: true }, { screens: () => ({ "notes-list": { image: Buffer.from("not a png") }, "notes-list-empty": {}, "notes-share-denied": {} }) }, /the screenshot of 'notes-list' is not a PNG file/);
});

await test("passes cancellation through to the run", async () => {
  const ws = notesWorkspace();
  const controller = new AbortController();
  controller.abort();
  let sawAborted = false;
  await assert.rejects(
    () =>
      capture(ws, { all: true, signal: controller.signal }, {}, {
        async run(input): Promise<PlaywrightRunOutcome> {
          sawAborted = input.signal.aborted;
          return { kind: "cancelled" };
        },
      }),
    /cancelled; nothing was written/
  );
  assert.equal(sawAborted, true);
});

await test("refuses keys that collide on case-insensitive filesystems before running anything", async () => {
  const ws = notesWorkspace();
  ws.write(".tieline/screens/SHARING.yaml", stringify({ version: 1, capability: "SHARING", screens: [screen("Notes-List")] }));
  const refuse = (): never => {
    throw new Error("Playwright must not run");
  };
  await assert.rejects(
    () => capture(ws, { all: true }, {}, { playwright: refuse, run: refuse }),
    /differ only in letter case[\s\S]*- notes-list, Notes-List/
  );
});

console.log("screens capture: --verify");

await test("verifies committed outputs against a fresh capture without writing anything", async () => {
  const ws = notesWorkspace();
  await capture(ws, { all: true });
  ws.commit("captured");
  const before = tielineFiles(ws);
  const passed = await capture(ws, { all: true, verify: true });
  assert.equal(passed.exit, 0);
  assert.match(passed.output, /^Verified 3 screen\(s\) against a fresh capture: 0 mismatch\(es\), 0 orphaned ARIA snapshot\(s\)\.\n$/);

  const failed = await capture(
    ws,
    { changed: true, base: "HEAD", verify: true },
    {
      screens: () => ({
        "notes-list": { image: png("drifted") },
        "notes-list-empty": { text: "- text: changed copy\n" },
        "notes-share-denied": { settings: { browser: { name: "chromium", version: "999.0" } } },
      }),
    },
    {
      async dependents() {
        return { status: "unavailable", detail: "no topology in this test" };
      },
    }
  );
  // Nothing changed on the branch, so nothing was selected or verified.
  assert.equal(failed.exit, 0);
  assert.match(failed.output, /^Verified 0 screen\(s\)/);

  const all = await capture(
    ws,
    { all: true, verify: true, json: true },
    {
      screens: () => ({
        "notes-list": { image: png("drifted") },
        "notes-list-empty": { text: "- text: changed copy\n" },
        "notes-share-denied": { settings: { browser: { name: "chromium", version: "999.0" } } },
      }),
    }
  );
  assert.equal(all.exit, 1);
  const result = JSON.parse(all.output) as { passed: boolean; mismatches: unknown; fix: string; verified: number };
  assert.equal(result.passed, false);
  assert.equal(result.verified, 3);
  assert.deepEqual(result.mismatches, [
    { key: "notes-list", causes: ["image"] },
    { key: "notes-list-empty", causes: ["text"] },
    { key: "notes-share-denied", causes: ["environment"] },
  ]);
  assert.equal(result.fix, "tieline screens capture --all");
  assert.deepEqual(tielineFiles(ws), before, "verification writes nothing");
});

await test("fails verification for hand edits, uncaptured screens, and orphaned snapshots, naming the fix", async () => {
  const ws = notesWorkspace();
  await capture(ws, { screens: ["notes-list"] });
  ws.write(".tieline/screen-text/notes-list.yml", "- text: edited by hand\n");
  ws.write(".tieline/screen-text/retired-screen.yml", "- text: gone\n");
  ws.commit("hand edits");
  const { exit, output } = await capture(ws, { screens: ["notes-list", "notes-share-denied"], verify: true });
  assert.equal(exit, 1);
  assert.match(output, /^Verified 2 screen\(s\) against a fresh capture: 2 mismatch\(es\), 1 orphaned ARIA snapshot\(s\)\.\n/);
  assert.match(output, /  mismatch  notes-list: ARIA snapshot differs\n/);
  assert.match(output, /  mismatch  notes-share-denied: no committed capture\n/);
  assert.match(output, /  orphaned  \.tieline\/screen-text\/retired-screen\.yml/);
  assert.match(output, /Run `tieline screens capture --screen notes-list --screen notes-share-denied` in the pinned capture environment and commit the result\.\n$/);
});

await test("audit --capture re-captures every screen and frames updates as drift", async () => {
  const ws = notesWorkspace();
  const io = captureIO();
  const run = fakePlaywrightRun();
  assert.equal(await runScreensAuditCaptureCommand({ repository: ws.root }, io.io, captureDependencies(run)), 0);
  assert.match(io.output(), /^Audit: re-capturing every screen\. Screens reported as updated changed without a branch selecting them/);
  assert.match(io.output(), /Captured 3 screen\(s\)/);
  assert.equal(run.calls[0]!.args[run.calls[0]!.args.indexOf("--grep") + 1], "@screen:");
});

await test("keeps dry runs and disabled repositories away from Playwright", async () => {
  const ws = notesWorkspace();
  const refuse = (): never => {
    throw new Error("Playwright must not run");
  };
  const dry = await capture(ws, { all: true, verify: true, dryRun: true }, {}, { playwright: refuse, run: refuse, environment: refuse });
  assert.match(dry.output, /^Would capture 3 of 3 screen\(s\) in the catalog\.\n/);
  const disabled = createScreensWorkspace({ git: true });
  workspaces.push(disabled);
  await assert.rejects(
    () => runScreensCaptureCommand({ all: true, repository: disabled.root }, captureIO().io, captureDependencies(fakePlaywrightRun(), { playwright: refuse, run: refuse })),
    /Screens are not enabled for this repository/
  );
});

console.log("screens capture: Playwright as an optional peer");

await test("finds the repository's own @playwright/test and refuses a missing or old one", () => {
  const repository = temporaryDirectory();
  assert.throws(() => resolvePlaywright(repository), /@playwright\/test is not installed in .*npm install --save-dev @playwright\/test/);
  const install = (version: string): void => {
    const directory = join(repository, "node_modules/@playwright/test");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name: "@playwright/test", version, exports: { "./cli": "./cli.js", "./package.json": "./package.json" } })
    );
    writeFileSync(join(directory, "cli.js"), "");
  };
  install("1.48.2");
  assert.throws(() => resolvePlaywright(repository), /needs @playwright\/test 1\.49 or a later 1\.x release; this repository has 1\.48\.2/);
  install("2.0.0");
  assert.throws(() => resolvePlaywright(repository), /this repository has 2\.0\.0/);
  install("1.63.0");
  assert.deepEqual(resolvePlaywright(repository), {
    cli: join(repository, "node_modules/@playwright/test/cli.js"),
    version: "1.63.0",
  });
});

await test("reads the platform, the pinned image, and installed fonts when they can be listed", () => {
  const environment = readCaptureEnvironment({ TIELINE_CAPTURE_IMAGE: "  mcr.microsoft.com/playwright:v1.63.0-noble  " });
  assert.equal(environment.platform, process.platform);
  assert.equal(environment.arch, process.arch);
  assert.equal(environment.image, "mcr.microsoft.com/playwright:v1.63.0-noble");
  assert.ok(environment.fonts === null || /^[a-f0-9]{64}$/.test(environment.fonts));
  assert.equal(readCaptureEnvironment({}).image, null);
  assert.equal(readCaptureEnvironment({ TIELINE_CAPTURE_IMAGE: "x".repeat(400) }).image!.length, 300);
});

const FAKE_CLI = fileURLToPath(new URL("../../fixtures/screens/fake-playwright-cli.mjs", import.meta.url));

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  assert.fail(`${path} never appeared`);
}

function within<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not finish within ${milliseconds}ms`)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

await test("runs Playwright as a child process with the run directory, and reports how it ended", async () => {
  const directory = temporaryDirectory();
  const reportPath = join(directory, "report.json");
  const env = { ...process.env, FAKE_PLAYWRIGHT_REPORT: reportPath, [RUN_DIRECTORY_ENV]: "/run/dir" };
  const signal = new AbortController().signal;
  const exited = await spawnPlaywright({ cli: FAKE_CLI, args: ["test", "--grep", "@screen:"], cwd: directory, env: { ...env, FAKE_PLAYWRIGHT_CODE: "3" }, timeoutMs: 60_000, signal });
  assert.deepEqual(exited, { kind: "exited", code: 3, signal: null });
  assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), { args: ["test", "--grep", "@screen:"], run: "/run/dir", cwd: directory });

  const timedOut = await within(
    spawnPlaywright({ cli: FAKE_CLI, args: [], cwd: directory, env: { ...env, FAKE_PLAYWRIGHT_MODE: "hang" }, timeoutMs: 200, signal }),
    20_000,
    "a hung run"
  );
  assert.deepEqual(timedOut, { kind: "timed_out" });

  // A run that ignores SIGTERM is killed after the grace period.
  rmSync(reportPath, { force: true });
  const controller = new AbortController();
  const stubborn = spawnPlaywright(
    { cli: FAKE_CLI, args: [], cwd: directory, env: { ...env, FAKE_PLAYWRIGHT_MODE: "stubborn" }, timeoutMs: 60_000, signal: controller.signal },
    100
  );
  await waitForFile(reportPath);
  controller.abort();
  assert.deepEqual(await within(stubborn, 20_000, "a run that ignores SIGTERM"), { kind: "cancelled" });

  const alreadyCancelled = new AbortController();
  alreadyCancelled.abort();
  assert.deepEqual(
    await within(
      spawnPlaywright({ cli: FAKE_CLI, args: [], cwd: directory, env: { ...env, FAKE_PLAYWRIGHT_MODE: "hang" }, timeoutMs: 60_000, signal: alreadyCancelled.signal }),
      20_000,
      "a cancelled run"
    ),
    { kind: "cancelled" }
  );
});

for (const created of workspaces) created.cleanup();
for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
report();
