import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  RUN_DIRECTORY_ENV,
  RUN_PROTOCOL_VERSION,
  RUN_RECORD_FILE,
  SCREENS_DIRECTORY,
  SELECTION_FILE,
  type RunRecord,
} from "../../src/playwright/protocol.cjs";
import type {
  PlaywrightRunInput,
  PlaywrightRunOutcome,
  ScreensCaptureDependencies,
} from "../../src/commands/screens-capture.js";
import type { CaptureEnvironment, CaptureSettings } from "../../src/contract/screen-capture-run.js";

/**
 * Test doubles for a Playwright capture run. The fake run writes exactly what
 * the fixture and reporter write — `<key>.png`, `<key>.yml`, and `<key>.json`
 * per screen and a run record — so the command's handling of a run is
 * exercised without a browser.
 */

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function png(content: string): Buffer {
  return Buffer.concat([PNG_SIGNATURE, Buffer.from(content)]);
}

export function captureSettings(key: string, overrides: Partial<CaptureSettings> = {}): CaptureSettings {
  return {
    version: RUN_PROTOCOL_VERSION,
    key,
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
    snapshot: { full_page: false, animations: "disabled", caret: "hide", scale: "css", masks: [] },
    settle_attempts: 2,
    ...overrides,
  };
}

export const ENVIRONMENT: CaptureEnvironment = {
  platform: "linux",
  arch: "x64",
  fonts: "f".repeat(64),
  image: "mcr.microsoft.com/playwright:v1.63.0-noble",
};

/** What one fake test captures: its screens and how it ends. */
export interface FakeScreen {
  image?: Buffer;
  text?: string;
  settings?: Partial<CaptureSettings>;
}

export interface FakeRunBehavior {
  /** Screens the fake tests capture, by key; defaults to every selected key. */
  screens?: (selected: string[]) => Record<string, FakeScreen>;
  /** The test file each key is captured from, absolute; defaults inside the repository. */
  testFile?: (key: string, cwd: string) => string;
  /** Extra tests to record, such as failures or duplicates. */
  extraTests?: (selected: string[], cwd: string) => RunRecord["tests"];
  errors?: string[];
  status?: string;
  /** Skip writing the run record, as when Playwright stops early. */
  noRecord?: boolean;
  outcome?: PlaywrightRunOutcome;
}

export interface FakeRun {
  run(input: PlaywrightRunInput): Promise<PlaywrightRunOutcome>;
  readonly calls: PlaywrightRunInput[];
  /** The selection file each run received. */
  readonly selections: unknown[];
}

export function fakePlaywrightRun(behavior: FakeRunBehavior = {}): FakeRun {
  const calls: PlaywrightRunInput[] = [];
  const selections: unknown[] = [];
  return {
    calls,
    selections,
    async run(input) {
      calls.push(input);
      const runDirectory = input.env[RUN_DIRECTORY_ENV]!;
      const selection = JSON.parse(readFileSync(join(runDirectory, SELECTION_FILE), "utf8")) as { keys: string[] };
      selections.push(selection);
      if (behavior.outcome && behavior.outcome.kind !== "exited") return behavior.outcome;
      const screens: Record<string, FakeScreen> =
        behavior.screens?.(selection.keys) ??
        Object.fromEntries(selection.keys.map((key): [string, FakeScreen] => [key, {}]));
      const directory = join(runDirectory, SCREENS_DIRECTORY);
      mkdirSync(directory, { recursive: true });
      const tests: RunRecord["tests"] = [];
      for (const [key, screen] of Object.entries(screens)) {
        writeFileSync(join(directory, `${key}.png`), screen.image ?? png(`picture of ${key}`));
        writeFileSync(join(directory, `${key}.yml`), screen.text ?? `- heading "${key}" [level=1]\n`);
        writeFileSync(join(directory, `${key}.json`), JSON.stringify(captureSettings(key, screen.settings)));
        const file = behavior.testFile?.(key, input.cwd) ?? resolve(input.cwd, "e2e/notes.screens.ts");
        tests.push({ id: `test-${key}`, file, line: 3, title: `captures ${key}`, project: "screens", status: "passed", keys: [key], error: null });
      }
      tests.push(...(behavior.extraTests?.(selection.keys, input.cwd) ?? []));
      if (!behavior.noRecord) {
        const record: RunRecord = {
          version: RUN_PROTOCOL_VERSION,
          playwright: "1.63.0",
          status: behavior.status ?? "passed",
          tests,
          errors: behavior.errors ?? [],
        };
        writeFileSync(join(runDirectory, RUN_RECORD_FILE), JSON.stringify(record));
      }
      return behavior.outcome ?? { kind: "exited", code: 0, signal: null };
    },
  };
}

export function captureDependencies(
  run: FakeRun,
  overrides: Partial<ScreensCaptureDependencies> = {}
): ScreensCaptureDependencies {
  return {
    async dependents() {
      return { status: "unavailable", detail: "no topology in this test" };
    },
    playwright: () => ({ cli: "/fake/node_modules/@playwright/test/cli.js", version: "1.63.0" }),
    environment: () => ENVIRONMENT,
    run: (input) => run.run(input),
    ...overrides,
  };
}
