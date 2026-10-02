/**
 * What `tieline screens capture` and the Playwright side of a capture run
 * share: the run directory layout, the attachment that ties a test to the
 * screens it captured, and the bounds both sides enforce. The command treats
 * everything in the run directory as untrusted and validates it again.
 *
 * This module is CommonJS so that the fixture and reporter load in every test
 * project Playwright runs, whichever module system it compiles tests to.
 */

/** Names the run directory of the current `tieline screens capture` run. */
export const RUN_DIRECTORY_ENV = "TIELINE_SCREENS_RUN";

/** The keys the run selected, written by the command before Playwright starts. */
export const SELECTION_FILE = "selection.json";

/** Written by the reporter when the run ends. */
export const RUN_RECORD_FILE = "run.json";

/** Holds `<key>.png`, `<key>.yml`, and `<key>.json` for each captured screen. */
export const SCREENS_DIRECTORY = "screens";

/** The test attachment whose body is the key of a screen the test captured. */
export const SCREEN_ATTACHMENT = "tieline-screen";

/** The tag that links a test to a screen it captures. */
export const SCREEN_TAG_PREFIX = "@screen:";

export const RUN_PROTOCOL_VERSION = 1;

/** Matches the catalog's stable key schema. */
export const SCREEN_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const SCREEN_KEY_MAX_CHARS = 160;

export const CAPTURE_LIMITS = {
  /** Largest screenshot kept, matching the importer's bound. */
  imageBytes: 25 * 1024 * 1024,
  /** Largest ARIA snapshot kept. */
  textBytes: 1024 * 1024,
  /** Largest selection file read by the fixture. */
  selectionBytes: 4 * 1024 * 1024,
  /** Screenshots taken while waiting for two in a row to match. */
  settleAttempts: 5,
  /** Longest error message the reporter records per test. */
  errorChars: 2_000,
  /** Most run-level errors the reporter records. */
  errors: 100,
} as const;

/** Waits before each settle attempt, in milliseconds. */
export const SETTLE_DELAYS_MS: readonly number[] = [0, 100, 250, 500, 1_000];

export interface CaptureSelectionFile {
  version: typeof RUN_PROTOCOL_VERSION;
  keys: string[];
}

/** What the fixture observed about a capture, in `<key>.json`. */
export interface CaptureSettingsFile {
  version: typeof RUN_PROTOCOL_VERSION;
  key: string;
  browser: { name: string; version: string };
  page: {
    viewport: { width: number; height: number } | null;
    device_scale_factor: unknown;
    color_scheme: unknown;
    reduced_motion: unknown;
    forced_colors: unknown;
    contrast: unknown;
    locale: unknown;
    timezone: unknown;
    touch: unknown;
  };
  snapshot: {
    full_page: boolean;
    animations: "disabled";
    caret: "hide";
    scale: "css";
    masks: string[];
  };
  settle_attempts: number;
}

export interface RunRecordTest {
  id: string;
  /** Absolute path of the test file, as Playwright reports it. */
  file: string;
  line: number;
  title: string;
  project: string;
  status: string;
  /** Screens the test's final attempt captured. */
  keys: string[];
  error: string | null;
}

/** Written by the reporter when the run ends, in `run.json`. */
export interface RunRecord {
  version: typeof RUN_PROTOCOL_VERSION;
  playwright: string;
  status: string;
  tests: RunRecordTest[];
  errors: string[];
}

/** Why a screen key cannot be captured, or null. */
export function screenKeyProblem(key: string): string | null {
  if (key.length === 0 || key.length > SCREEN_KEY_MAX_CHARS) {
    return `must contain 1 to ${SCREEN_KEY_MAX_CHARS} characters`;
  }
  return SCREEN_KEY_PATTERN.test(key)
    ? null
    : "must start with a letter or digit and contain only letters, digits, '.', '_', and '-'";
}
