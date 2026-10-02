import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stableKeySchema } from "../../../src/contract/schema.js";
import {
  captureScreen,
  type SnapshotPage,
  type SnapshotTestInfo,
} from "../../../src/playwright/capture-screen.cjs";
import {
  CAPTURE_LIMITS,
  RUN_DIRECTORY_ENV,
  RUN_RECORD_FILE,
  SCREEN_ATTACHMENT,
  SCREENS_DIRECTORY,
  SELECTION_FILE,
  screenKeyProblem,
} from "../../../src/playwright/protocol.cjs";
import { CaptureRunRecorder } from "../../../src/playwright/run-recorder.cjs";
import { report, test } from "../../support/harness.js";
import { png } from "../../support/screen-capture-fakes.js";

const directories: string[] = [];
function runDirectory(keys: unknown = ["notes-list"]): string {
  const directory = mkdtempSync(join(tmpdir(), "tieline-fixture-test-"));
  directories.push(directory);
  writeFileSync(join(directory, SELECTION_FILE), JSON.stringify({ version: 1, keys }));
  return directory;
}

interface FakePage extends SnapshotPage<string> {
  readonly calls: string[];
}

/** A page whose screenshots come from a script, recording what was asked of it. */
function fakePage(shots: Buffer[], options: { aria?: string; browser?: boolean } = {}): FakePage {
  const calls: string[] = [];
  let shot = 0;
  return {
    calls,
    async waitForLoadState(state) {
      calls.push(`load:${state}`);
    },
    async waitForTimeout(timeout) {
      calls.push(`wait:${timeout}`);
    },
    async evaluate(expression) {
      if (expression.includes("document.fonts")) {
        calls.push("fonts");
        return true;
      }
      calls.push("settings");
      return {
        device_scale_factor: 1,
        color_scheme: "light",
        reduced_motion: "reduce",
        forced_colors: "none",
        contrast: "no-preference",
        locale: "en-US",
        timezone: "UTC",
        touch: false,
      };
    },
    async screenshot(screenshot) {
      calls.push(`screenshot:${JSON.stringify(screenshot)}`);
      const image = shots[Math.min(shot, shots.length - 1)]!;
      shot += 1;
      return image;
    },
    locator(selector) {
      return {
        async ariaSnapshot() {
          calls.push(`aria:${selector}`);
          return options.aria ?? '- heading "Your notes" [level=1]';
        },
      };
    },
    viewportSize() {
      return { width: 1280, height: 720 };
    },
    context() {
      return {
        browser() {
          return options.browser === false
            ? null
            : { browserType: () => ({ name: () => "chromium" }), version: () => "140.0.7339.16" };
        },
      };
    },
  };
}

function testInfo(tags: string[]): SnapshotTestInfo & { attachments: Array<{ name: string; body: string }> } {
  const attachments: Array<{ name: string; body: string }> = [];
  return {
    tags,
    attachments,
    async attach(name, options) {
      attachments.push({ name, body: options.body });
    },
  };
}

console.log("screens playwright: the fixture");

await test("checks the key and its @screen tag on every run, capturing nothing outside one", async () => {
  const page = fakePage([png("a")]);
  await assert.rejects(
    () => captureScreen(page, "../escape", testInfo(["@screen:../escape"]), {}, {}),
    /tielineSnapshot: screen key '\.\.\/escape' must start with a letter or digit/
  );
  await assert.rejects(
    () => captureScreen(page, "notes-list", testInfo(["@screen:notes-list-empty", "@fast"]), {}, {}),
    /tielineSnapshot\('notes-list'\) is called from a test that is not tagged @screen:notes-list; add \{ tag: "@screen:notes-list" \} to the test\./
  );
  const info = testInfo(["@screen:notes-list"]);
  await captureScreen(page, "notes-list", info, {}, {});
  assert.deepEqual(page.calls, []);
  assert.deepEqual(info.attachments, []);

  // A run that did not select the key leaves it alone too.
  const directory = runDirectory(["other"]);
  await captureScreen(page, "notes-list", info, {}, { [RUN_DIRECTORY_ENV]: directory });
  assert.deepEqual(page.calls, []);
  assert.equal(existsSync(join(directory, SCREENS_DIRECTORY)), false);
});

await test("waits for the page to settle, then writes the screenshot, ARIA snapshot, and settings", async () => {
  const directory = runDirectory(["notes-list"]);
  const page = fakePage([png("moving"), png("settled"), png("settled")], { aria: '- heading "Your notes" [level=1]\n- list' });
  const info = testInfo(["@screen:notes-list"]);
  await captureScreen(page, "notes-list", info, { mask: ["locator('.avatar')"], fullPage: true }, { [RUN_DIRECTORY_ENV]: directory });
  const screenshot = `screenshot:${JSON.stringify({ animations: "disabled", caret: "hide", scale: "css", fullPage: true, mask: ["locator('.avatar')"] })}`;
  assert.deepEqual(page.calls, ["load:load", "fonts", screenshot, "wait:100", screenshot, "wait:250", screenshot, "aria:body", "settings"]);
  const screens = join(directory, SCREENS_DIRECTORY);
  assert.deepEqual(readdirSync(screens).sort(), ["notes-list.json", "notes-list.png", "notes-list.yml"]);
  assert.deepEqual(readFileSync(join(screens, "notes-list.png")), png("settled"));
  assert.equal(readFileSync(join(screens, "notes-list.yml"), "utf8"), '- heading "Your notes" [level=1]\n- list\n');
  assert.deepEqual(JSON.parse(readFileSync(join(screens, "notes-list.json"), "utf8")), {
    version: 1,
    key: "notes-list",
    browser: { name: "chromium", version: "140.0.7339.16" },
    page: {
      viewport: { width: 1280, height: 720 },
      device_scale_factor: 1,
      color_scheme: "light",
      reduced_motion: "reduce",
      forced_colors: "none",
      contrast: "no-preference",
      locale: "en-US",
      timezone: "UTC",
      touch: false,
    },
    snapshot: { full_page: true, animations: "disabled", caret: "hide", scale: "css", masks: ["locator('.avatar')"] },
    settle_attempts: 3,
  });
  assert.deepEqual(info.attachments, [{ name: SCREEN_ATTACHMENT, body: "notes-list" }]);
});

await test("fails a capture whose page never settles or whose output is too large, writing nothing", async () => {
  const directory = runDirectory(["notes-list"]);
  const environment = { [RUN_DIRECTORY_ENV]: directory };
  const restless = fakePage(Array.from({ length: 10 }, (_, index) => png(`frame ${index}`)));
  const info = testInfo(["@screen:notes-list"]);
  await assert.rejects(
    () => captureScreen(restless, "notes-list", info, {}, environment),
    /Screen 'notes-list' did not settle: 5 screenshots in a row differed\. Freeze what moves \(animations, clocks, carousels\) or mask it\./
  );
  assert.equal(restless.calls.filter((call) => call.startsWith("screenshot:")).length, CAPTURE_LIMITS.settleAttempts);
  const huge = fakePage([Buffer.alloc(CAPTURE_LIMITS.imageBytes + 1)]);
  await assert.rejects(() => captureScreen(huge, "notes-list", info, {}, environment), /the screenshot is 26214401 bytes; the limit is 26214400/);
  const wordy = fakePage([png("a"), png("a")], { aria: "x".repeat(CAPTURE_LIMITS.textBytes + 1) });
  await assert.rejects(() => captureScreen(wordy, "notes-list", info, {}, environment), /the ARIA snapshot is larger than 1048576 bytes/);
  assert.equal(existsSync(join(directory, SCREENS_DIRECTORY)), false);
  assert.deepEqual(info.attachments, []);
});

await test("refuses a selection file that is not one Tieline wrote", async () => {
  const info = testInfo(["@screen:notes-list"]);
  for (const selection of [{ version: 2, keys: [] }, { version: 1, keys: [1] }, { version: 1 }]) {
    const directory = runDirectory();
    writeFileSync(join(directory, SELECTION_FILE), JSON.stringify(selection));
    await assert.rejects(
      () => captureScreen(fakePage([png("a")]), "notes-list", info, {}, { [RUN_DIRECTORY_ENV]: directory }),
      /is not a version 1 selection/
    );
  }
});

await test("matches the catalog's key rule", () => {
  for (const key of ["notes-list", "a", "A.b_c-9", "x".repeat(160), "", "-lead", ".dot", "has space", "slash/key", "x".repeat(161), "ünïcode"]) {
    assert.equal(screenKeyProblem(key) === null, stableKeySchema.safeParse(key).success, key);
  }
});

console.log("screens playwright: the run record");

await test("records each test's last attempt and writes the run record atomically", () => {
  const directory = runDirectory();
  const recorder = new CaptureRunRecorder(directory);
  recorder.begin("1.63.0");
  const attempt = { id: "t1", file: "/repo/e2e/a.spec.ts", line: 4, title: "a", project: "screens", keys: [] as string[] };
  recorder.testEnded({ ...attempt, status: "failed", error: "flaky" });
  recorder.testEnded({ ...attempt, status: "passed", keys: ["notes-list"], error: null });
  recorder.testEnded({ ...attempt, id: "t2", status: "failed", error: "x".repeat(CAPTURE_LIMITS.errorChars + 50) });
  for (let index = 0; index < CAPTURE_LIMITS.errors + 5; index += 1) recorder.error(`error ${index}`);
  recorder.end("failed");
  const written = JSON.parse(readFileSync(join(directory, RUN_RECORD_FILE), "utf8"));
  assert.equal(written.version, 1);
  assert.equal(written.playwright, "1.63.0");
  assert.equal(written.status, "failed");
  assert.deepEqual(written.tests[0], { ...attempt, status: "passed", keys: ["notes-list"], error: null });
  assert.equal(written.tests[1].error.length, CAPTURE_LIMITS.errorChars + 1);
  assert.equal(written.errors.length, CAPTURE_LIMITS.errors);
  assert.deepEqual(readdirSync(directory).sort(), [RUN_RECORD_FILE, SELECTION_FILE]);

  // Outside a capture run the reporter records nothing.
  const outside = new CaptureRunRecorder(null);
  outside.begin("1.63.0");
  outside.end("passed");
  assert.equal(outside.record("passed").tests.length, 0);
});

for (const directory of directories) rmSync(directory, { recursive: true, force: true });
report();
