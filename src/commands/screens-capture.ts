import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileContractManifest, type ContractManifest } from "../contract/manifest.js";
import { resolveComparisonBase } from "../contract/comparison-base.js";
import { readDeclaredCapabilityKeys } from "../contract/load.js";
import {
  applyCaptureOutputs,
  caseCollidingKeys,
  keepVerifiedScreenshots,
  planCaptureOutputs,
  readCapturedScreens,
  readCaptureRunRecord,
  ScreenCaptureError,
  verifyCapturedScreens,
  type CaptureEnvironment,
  type CaptureOutputResult,
  type CapturedScreen,
  type ScreenVerifyMismatch,
} from "../contract/screen-capture-run.js";
import {
  readScreenCatalogSources,
  screenSettingsForRepository,
  validateScreenCatalogDocuments,
  type ScreenCatalogSource,
  type ScreenSettings,
  type ValidatedScreenCatalog,
} from "../contract/screen-catalog.js";
import { scanScreenScenes } from "../contract/screen-scenes.js";
import { readScreenTextDirectory, screenTextFile } from "../contract/screen-text.js";
import {
  RUN_DIRECTORY_ENV,
  RUN_PROTOCOL_VERSION,
  SELECTION_FILE,
  type CaptureSelectionFile,
} from "../playwright/protocol.cjs";
import {
  excludeNotCaptured,
  selectRequestedScreens,
  selectScreensChangedSince,
  type ScreenDependents,
  type ScreenSelection,
  type ScreenSelectionReason,
  type ScreenSelectionScope,
} from "../contract/screen-capture-selection.js";
import { ScreenImportError, withScreenImportLock } from "../contract/screen-import.js";
import { executeChangeBlastRadius } from "./code-topology.js";
import {
  escapeTerminalText,
  resolveCommandContext,
  type CommandIO,
} from "./shared.js";

const NOT_ENABLED =
  'Screens are not enabled for this repository. Add "screens": { "enabled": true } to .tieline/config.json to opt in.';

export interface ScreensCaptureOptions {
  repository?: string;
  all?: boolean;
  changed?: boolean;
  base?: string;
  screens?: readonly string[];
  dryRun?: boolean;
  /** Compare a fresh capture with the committed outputs and write nothing. */
  verify?: boolean;
  /** Capture this many times and keep only screens every run captured identically. */
  repeat?: number;
  json?: boolean;
  /** Stops the capture run, as Ctrl-C does. */
  signal?: AbortSignal;
}

/** The app's own `@playwright/test`, found from the repository root. */
export interface PlaywrightInstallation {
  /** Absolute path of `@playwright/test/cli`. */
  cli: string;
  version: string;
}

export interface PlaywrightRunInput {
  cli: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal: AbortSignal;
}

export type PlaywrightRunOutcome =
  | { kind: "exited"; code: number | null; signal: string | null }
  | { kind: "timed_out" }
  | { kind: "cancelled" }
  | { kind: "spawn_failed"; detail: string };

/** What the capture command reads beyond the repository, injectable for tests. */
export interface ScreensCaptureDependencies {
  /** The code-topology blast radius of the branch's changes. */
  dependents(input: {
    repositoryRoot: string;
    repositoryKey: string;
    base: string;
  }): Promise<ScreenDependents>;
  /** Finds the app's Playwright, or throws saying how to install it. */
  playwright(repositoryRoot: string): PlaywrightInstallation;
  /** Where the capture runs: platform, fonts, and pinned image. */
  environment(): CaptureEnvironment;
  /** Runs Playwright to completion, a timeout, or cancellation. */
  run(input: PlaywrightRunInput): Promise<PlaywrightRunOutcome>;
}

/** The oldest Playwright with test tags, `page.clock`, and `ariaSnapshot()`. */
export const MINIMUM_PLAYWRIGHT_MINOR = 49;

/**
 * Finds `@playwright/test` the way the app's own tests would, from the
 * repository root. Tieline never imports it itself: it is an optional peer
 * dependency, needed only to capture.
 */
export function resolvePlaywright(repositoryRoot: string): PlaywrightInstallation {
  const requireFromRepository = createRequire(resolve(repositoryRoot, "package.json"));
  let manifestPath: string;
  try {
    manifestPath = requireFromRepository.resolve("@playwright/test/package.json");
  } catch {
    throw new Error(
      `Screen capture runs the repository's own Playwright tests, but @playwright/test is not installed in ${repositoryRoot}. Install it with \`npm install --save-dev @playwright/test\` (1.${MINIMUM_PLAYWRIGHT_MINOR} or later) and add a test tagged @screen:<key> for each screen.`
    );
  }
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  const version =
    manifest !== null && typeof manifest === "object" && typeof (manifest as { version?: unknown }).version === "string"
      ? (manifest as { version: string }).version
      : "";
  const match = /^(\d+)\.(\d+)\./.exec(version);
  if (!match || Number(match[1]) !== 1 || Number(match[2]) < MINIMUM_PLAYWRIGHT_MINOR) {
    throw new Error(
      `Screen capture needs @playwright/test 1.${MINIMUM_PLAYWRIGHT_MINOR} or a later 1.x release; this repository has ${version || "an unknown version"}.`
    );
  }
  return { cli: requireFromRepository.resolve("@playwright/test/cli"), version };
}

const FONT_LIST_LIMITS = { timeoutMs: 10_000, bytes: 16 * 1024 * 1024 } as const;

/**
 * Reads where a capture runs. Installed fonts change how text renders, so
 * their files are hashed when `fc-list` can list them (as it can in the
 * official Playwright image); elsewhere the fingerprint records them as
 * unknown. `TIELINE_CAPTURE_IMAGE` lets a CI job name the pinned image.
 */
export function readCaptureEnvironment(env: NodeJS.ProcessEnv = process.env): CaptureEnvironment {
  const listed = spawnSync("fc-list", ["--format", "%{file}\\n"], {
    encoding: "utf8",
    timeout: FONT_LIST_LIMITS.timeoutMs,
    maxBuffer: FONT_LIST_LIMITS.bytes,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const files =
    listed.status === 0 && !listed.error
      ? [...new Set(listed.stdout.split("\n").filter(Boolean))].sort()
      : null;
  const image = env.TIELINE_CAPTURE_IMAGE?.trim().slice(0, 300) || null;
  return {
    platform: process.platform,
    arch: process.arch,
    fonts: files ? createHash("sha256").update(files.join("\n")).digest("hex") : null,
    image,
  };
}

/** How long a stopped Playwright gets to exit before it is killed. */
const KILL_GRACE_MS = 10_000;

/**
 * Runs Playwright as a child process. Its output goes to stderr, so `--json`
 * output on stdout stays parseable. A run that exceeds its timeout, or whose
 * signal aborts, is sent SIGTERM and then SIGKILL after a grace period; every
 * timer and listener is released however the run ends.
 */
export function spawnPlaywright(
  input: PlaywrightRunInput,
  killGraceMs: number = KILL_GRACE_MS
): Promise<PlaywrightRunOutcome> {
  return new Promise((resolveOutcome) => {
    let stopped: "timed_out" | "cancelled" | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    const child = spawn(process.execPath, [input.cli, ...input.args], {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", 2, 2],
    });
    const stop = (reason: "timed_out" | "cancelled"): void => {
      if (stopped) return;
      stopped = reason;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
    };
    const timeout = setTimeout(() => stop("timed_out"), input.timeoutMs);
    const onAbort = (): void => stop("cancelled");
    if (input.signal.aborted) onAbort();
    else input.signal.addEventListener("abort", onAbort, { once: true });
    const finish = (outcome: PlaywrightRunOutcome): void => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      input.signal.removeEventListener("abort", onAbort);
      resolveOutcome(outcome);
    };
    child.once("error", (error) => finish({ kind: "spawn_failed", detail: error.message }));
    child.once("close", (code, signal) =>
      finish(stopped ? { kind: stopped } : { kind: "exited", code, signal })
    );
  });
}

/**
 * Follows the existing AC-aware blast radius from every file the branch
 * changed to the files that depend on it. Unavailable topology (missing,
 * stale, or absent at the branch point) is reported, never treated as "no
 * dependents".
 */
export async function topologyDependents(input: {
  repositoryRoot: string;
  repositoryKey: string;
  base: string;
}): Promise<ScreenDependents> {
  const result = await executeChangeBlastRadius({
    repositoryRoot: input.repositoryRoot,
    repository: input.repositoryKey,
    base: input.base,
    direction: "dependents",
  });
  if (result.status !== "complete") {
    const detail = "detail" in result ? `: ${result.detail}` : "";
    return {
      status: "unavailable",
      detail: `the code-topology blast radius is unavailable (${result.status})${detail}`,
    };
  }
  const files = new Map<string, { path: string; from: string }>();
  for (const path of result.paths) {
    const from = path.nodes[0]?.locator.path;
    if (from === undefined) continue;
    for (const node of path.nodes.slice(1)) {
      if (node.locator.path === from) continue;
      files.set(`${node.locator.path}\0${from}`, { path: node.locator.path, from });
    }
  }
  return {
    status: "complete",
    files: [...files.values()].sort(
      (left, right) => left.path.localeCompare(right.path) || left.from.localeCompare(right.from)
    ),
    truncated: result.truncation.truncated,
  };
}

const DEFAULT_DEPENDENCIES: ScreensCaptureDependencies = {
  dependents: topologyDependents,
  playwright: resolvePlaywright,
  environment: () => readCaptureEnvironment(),
  run: (input) => spawnPlaywright(input),
};

/** The reporter Playwright loads by path; it ships beside this command. */
export const SCREENS_REPORTER_PATH = fileURLToPath(new URL("../playwright/reporter.cjs", import.meta.url));

/**
 * Longest `--grep` passed to one Playwright run. A larger selection is split
 * into several runs, so the command line stays far below operating-system
 * argument limits however many screens a catalog holds.
 */
export const SCREEN_GREP_MAX_CHARS = 32_000;

function escapeKey(key: string): string {
  return key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The `--grep` that runs only tests tagged for the given screens. Keys are
 * escaped, and each must end where a key ends, so `@screen:notes` never runs
 * the test for `@screen:notes-list`. Naming every screen, rather than every
 * screen test, keeps a run from starting tests for screens it skips, such as
 * ones marked not captured because their test is unstable.
 */
export function screenGrep(keys: readonly string[]): string {
  return `@screen:(?:${keys.map(escapeKey).join("|")})(?![A-Za-z0-9._-])`;
}

/** Splits keys into batches whose `--grep` stays within `maxChars`. */
export function screenGrepBatches(
  keys: readonly string[],
  maxChars: number = SCREEN_GREP_MAX_CHARS
): string[][] {
  const overhead = screenGrep([]).length;
  const batches: string[][] = [];
  let batch: string[] = [];
  let length = overhead;
  for (const key of keys) {
    const added = escapeKey(key).length + (batch.length > 0 ? 1 : 0);
    if (batch.length > 0 && length + added > maxChars) {
      batches.push(batch);
      batch = [];
      length = overhead;
    }
    length += escapeKey(key).length + (batch.length > 0 ? 1 : 0);
    batch.push(key);
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function captureScope(options: ScreensCaptureOptions): ScreenSelectionScope {
  const screens = options.screens ?? [];
  const chosen = [options.all === true, options.changed === true, screens.length > 0].filter(Boolean);
  if (chosen.length !== 1) {
    throw new Error("Choose exactly one of --all, --changed --base <ref>, or --screen <key>.");
  }
  if (options.changed && !options.base) {
    throw new Error("--changed needs --base <ref>: the ref the branch is compared with.");
  }
  if (!options.changed && options.base) {
    throw new Error("--base applies only to --changed.");
  }
  if (options.all) return { kind: "all" };
  if (options.changed) return { kind: "changed", base: options.base! };
  return { kind: "screens", keys: [...new Set(screens)] };
}

interface CaptureCatalog {
  catalog: ValidatedScreenCatalog;
  sources: ScreenCatalogSource[];
  capabilityKeys: ReadonlySet<string>;
}

/** The working-tree catalog, validated against the spec's capabilities. */
function loadCaptureCatalog(root: string, specDirectory: string, settings: ScreenSettings): CaptureCatalog {
  const read = readScreenCatalogSources(root, settings);
  const issues = [...read.issues];
  const capabilityKeys = readDeclaredCapabilityKeys(root, specDirectory);
  const catalog = validateScreenCatalogDocuments(read.sources, capabilityKeys, issues);
  if (issues.length > 0) {
    throw new ScreenImportError("The screen catalog is invalid; fix it before capturing.", issues);
  }
  return { catalog, sources: read.sources, capabilityKeys };
}

export function describeSelectionReason(reason: ScreenSelectionReason): string {
  switch (reason.rule) {
    case "all":
      return "every screen (--all)";
    case "requested":
      return "requested with --screen";
    case "outputs":
      return `committed capture outputs changed in ${reason.path}`;
    case "catalog":
      return `catalog entry ${reason.change}`;
    case "scene":
      return `scene test ${reason.path} changed`;
    case "contract":
      return `${reason.owner} shows it and links ${reason.path}, which changed`;
    case "path":
      return `${reason.path} changed and matches its path ${reason.pattern}`;
    case "dependency":
      return "owner" in reason
        ? `${reason.path} depends on ${reason.from}, which changed, and ${reason.owner} shows it and links ${reason.path}`
        : `${reason.path} depends on ${reason.from}, which changed, and matches its path ${reason.pattern}`;
    case "global":
      return `global path ${reason.path} changed (${reason.pattern})`;
  }
}

function renderSelection(selection: ScreenSelection, catalogScreens: number, io: CommandIO): void {
  const scope =
    selection.base !== null
      ? `changed since ${escapeTerminalText(selection.base.ref)} (branch point ${selection.base.commit.slice(0, 12)}, ${selection.changed_files} changed file(s))`
      : selection.scope === "all"
        ? "in the catalog"
        : "requested";
  io.write(
    `Would capture ${selection.screens.length} of ${catalogScreens} screen(s) ${scope}.\n`
  );
  for (const screen of selection.screens) {
    io.write(`  ${escapeTerminalText(screen.key)} (${escapeTerminalText(screen.capability)})\n`);
    for (const reason of screen.reasons) {
      io.write(`    ${reason.rule.padEnd(10)} ${escapeTerminalText(describeSelectionReason(reason))}\n`);
    }
    if (screen.omitted_reasons > 0) {
      io.write(`    (and ${screen.omitted_reasons} more reason(s))\n`);
    }
  }
  for (const rule of selection.unavailable) {
    io.write(`  note  ${rule.rule} rule incomplete: ${escapeTerminalText(rule.detail)}\n`);
  }
}

function scopeFlags(scope: ScreenSelectionScope): string {
  if (scope.kind === "all") return "--all";
  if (scope.kind === "changed") return `--changed --base ${scope.base}`;
  return scope.keys.map((key) => `--screen ${key}`).join(" ");
}

function describeOutcome(outcome: Extract<PlaywrightRunOutcome, { kind: "exited" }>): string {
  return outcome.signal ? `signal ${outcome.signal}` : `exit code ${outcome.code}`;
}

/**
 * Runs Playwright for the selected screens and reads back a complete run.
 * The run directory is temporary and removed on every exit path; a timeout,
 * cancellation, failed test, or missing screen writes nothing.
 */
/**
 * Runs Playwright once for a batch of screens and reads back a complete run.
 * The run directory is temporary and removed on every exit path; a timeout,
 * cancellation, failed test, or missing screen captures nothing.
 */
async function captureBatch(input: {
  root: string;
  settings: ScreenSettings;
  keys: readonly string[];
  installation: PlaywrightInstallation;
  environment: CaptureEnvironment;
  dependencies: ScreensCaptureDependencies;
  signal: AbortSignal;
}): Promise<CapturedScreen[]> {
  const { root, settings, keys } = input;
  const runDirectory = mkdtempSync(join(tmpdir(), "tieline-screens-"));
  try {
    const selectionFile: CaptureSelectionFile = { version: RUN_PROTOCOL_VERSION, keys: [...keys] };
    writeFileSync(join(runDirectory, SELECTION_FILE), `${JSON.stringify(selectionFile)}\n`);
    const minutes = settings.capture.timeoutMinutes;
    const outcome = await input.dependencies.run({
      cli: input.installation.cli,
      args: [
        "test",
        ...(settings.capture.playwrightConfig ? ["--config", settings.capture.playwrightConfig] : []),
        ...(settings.capture.project ? ["--project", settings.capture.project] : []),
        "--grep",
        screenGrep(keys),
        // A key whose tag matches no test is reported as not captured below,
        // which says more than Playwright's "No tests found".
        "--pass-with-no-tests",
        "--reporter",
        SCREENS_REPORTER_PATH,
      ],
      cwd: root,
      env: { ...process.env, [RUN_DIRECTORY_ENV]: runDirectory },
      timeoutMs: minutes * 60_000,
      signal: input.signal,
    });
    if (outcome.kind === "timed_out") {
      throw new ScreenCaptureError(
        `The capture run took longer than ${minutes} minute(s) (screens.capture.timeout_minutes) and was stopped; nothing was written.`
      );
    }
    if (outcome.kind === "cancelled") {
      throw new ScreenCaptureError("The capture run was cancelled; nothing was written.");
    }
    if (outcome.kind === "spawn_failed") {
      throw new ScreenCaptureError(`Playwright could not be started: ${outcome.detail}`);
    }
    const record = readCaptureRunRecord(runDirectory);
    if (!record) {
      throw new ScreenCaptureError(
        `Playwright stopped (${describeOutcome(outcome)}) before the run finished, so nothing was written. Check its output above for a configuration or startup error.`
      );
    }
    const captured = readCapturedScreens({
      runDirectory,
      repositoryRoot: root,
      record,
      selected: keys,
      environment: input.environment,
    });
    if (outcome.code !== 0) {
      throw new ScreenCaptureError(
        `Playwright reported a failed run (${describeOutcome(outcome)}, status ${record.status}) although every selected screen was captured, so nothing was written.`
      );
    }
    return captured;
  } finally {
    rmSync(runDirectory, { recursive: true, force: true });
  }
}

/** Most times `--repeat` captures every screen to find unstable ones. */
export const MAX_CAPTURE_REPEATS = 5;

function sameCapture(left: CapturedScreen, right: CapturedScreen): boolean {
  return (
    left.image_sha256 === right.image_sha256 &&
    left.text_sha256 === right.text_sha256 &&
    left.fingerprint === right.fingerprint &&
    left.test === right.test
  );
}

/**
 * Captures the given screens `repeat` times, in batches, and keeps only the
 * screens every run captured identically; the rest are unstable. Ctrl-C, or
 * the caller's signal, stops the run in progress.
 */
async function captureScreens(input: {
  root: string;
  settings: ScreenSettings;
  keys: readonly string[];
  repeat: number;
  dependencies: ScreensCaptureDependencies;
  signal: AbortSignal | undefined;
}): Promise<{ captured: CapturedScreen[]; unstable: string[]; playwright: string }> {
  const installation = input.dependencies.playwright(input.root);
  const environment = input.dependencies.environment();
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  // Ctrl-C stops Playwright and its browsers before the command exits.
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  if (input.signal?.aborted) abort();
  else input.signal?.addEventListener("abort", abort, { once: true });
  try {
    const runs: CapturedScreen[][] = [];
    for (let run = 0; run < input.repeat; run += 1) {
      const captured: CapturedScreen[] = [];
      for (const keys of screenGrepBatches(input.keys)) {
        captured.push(
          ...(await captureBatch({
            root: input.root,
            settings: input.settings,
            keys,
            installation,
            environment,
            dependencies: input.dependencies,
            signal: controller.signal,
          }))
        );
      }
      runs.push(captured);
    }
    const [first = [], ...later] = runs;
    const unstable = first
      .filter((screen) =>
        later.some((run) => {
          const other = run.find((candidate) => candidate.key === screen.key);
          return !other || !sameCapture(screen, other);
        })
      )
      .map((screen) => screen.key);
    return {
      captured: first.filter((screen) => !unstable.includes(screen.key)),
      unstable,
      playwright: installation.version,
    };
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    input.signal?.removeEventListener("abort", abort);
  }
}

const CAUSE_LABELS: Record<ScreenVerifyMismatch["causes"][number], string> = {
  unstable: "differed between runs; fix what moves, or mark it not_captured (unstable)",
  not_captured: "no committed capture",
  environment: "captured in a different environment; re-capture in the pinned environment",
  image: "screenshot differs",
  text: "ARIA snapshot differs",
  test: "captured by a different test",
};

/**
 * `tieline screens capture`: selects the screens a run should capture, each
 * with its reasons, and captures them with the repository's own Playwright
 * tests. `--dry-run` only reports the selection; `--verify` compares a fresh
 * capture with the committed outputs and writes nothing.
 */
export async function runScreensCaptureCommand(
  options: ScreensCaptureOptions,
  io: CommandIO,
  dependencies: ScreensCaptureDependencies = DEFAULT_DEPENDENCIES
): Promise<number> {
  const scope = captureScope(options);
  const repeat = options.repeat ?? 1;
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > MAX_CAPTURE_REPEATS) {
    throw new Error(`--repeat must be a whole number from 1 to ${MAX_CAPTURE_REPEATS}.`);
  }
  const { root, repositoryKey, specDirectory } = resolveCommandContext(options);
  const settings = screenSettingsForRepository(root);
  if (!settings) throw new Error(NOT_ENABLED);
  const { catalog } = loadCaptureCatalog(root, specDirectory, settings);

  let selection: ScreenSelection;
  if (scope.kind === "changed") {
    // Changes are measured from where the branch left its base, like every
    // other `--base` comparison.
    const base = resolveComparisonBase(root, scope.base);
    let manifest: ContractManifest | null;
    try {
      manifest = compileContractManifest({ repositoryRoot: root, repositoryKey, specDirectory });
    } catch {
      manifest = null;
    }
    selection = selectScreensChangedSince({
      repositoryRoot: root,
      settings,
      current: catalog,
      base,
      manifest,
      dependents: await dependencies.dependents({
        repositoryRoot: root,
        repositoryKey,
        base: base.commit,
      }),
    });
  } else {
    const { screens, excluded } = excludeNotCaptured(catalog, selectRequestedScreens(catalog, scope));
    selection = { scope: scope.kind, base: null, screens, excluded, changed_files: 0, unavailable: [] };
  }
  // A gate that checks only the screens a branch may have changed must not
  // pass because a rule could not run and so missed some: verify every screen.
  if (options.verify && scope.kind === "changed" && selection.unavailable.length > 0) {
    const everything = excludeNotCaptured(catalog, selectRequestedScreens(catalog, { kind: "all" }));
    selection = {
      ...selection,
      screens: everything.screens,
      excluded: everything.excluded,
      widened: {
        reason: `the ${[...new Set(selection.unavailable.map((rule) => rule.rule))].join(", ")} selection rule(s) could not run`,
      },
    };
  }

  // A selected screen with no test tagged for it is not covered: it is
  // reported, not a failure, so coverage can grow screen by screen; the
  // strict audit is the gate. A screen named with --screen is always run, as
  // is every screen when the scan could not finish and so proves nothing.
  const scenes = scanScreenScenes(root, settings.sceneTests);
  const requested = scope.kind === "screens";
  const notCovered = selection.screens
    .map((screen) => screen.key)
    .filter((key) => !requested && scenes.status === "complete" && !scenes.tags.has(key));
  const keys = selection.screens.map((screen) => screen.key).filter((key) => !notCovered.includes(key));

  if (options.dryRun) {
    if (options.json) {
      io.write(
        `${JSON.stringify(
          { dry_run: true, catalog_screens: catalog.screens.size, selection, not_covered: notCovered },
          null,
          2
        )}\n`
      );
      return 0;
    }
    renderSelection(selection, catalog.screens.size, io);
    renderCoverage(selection, notCovered, io);
    return 0;
  }

  const collisions = caseCollidingKeys(catalog);
  if (collisions.length > 0) {
    throw new ScreenCaptureError(
      "Screen keys that differ only in letter case would overwrite each other's files on case-insensitive filesystems; rename them before capturing.",
      collisions.map((keys) => keys.join(", "))
    );
  }

  const text = readScreenTextDirectory(settings);
  const orphanedText = [...text.digests.keys()]
    .filter((key) => !catalog.screens.has(key))
    .sort((left, right) => left.localeCompare(right))
    .map((key) => screenTextFile(settings, key).path);
  const captured =
    keys.length === 0
      ? { captured: [], unstable: [], playwright: null }
      : await captureScreens({ root, settings, keys, repeat, dependencies, signal: options.signal });

  if (options.verify) {
    // With hosted screens on, the screenshots verified exactly stay in the
    // git-ignored captures directory, so the same job can publish them.
    const keptScreenshots = settings.hosted
      ? withScreenImportLock(root, () => keepVerifiedScreenshots(root, settings, catalog, captured.captured)).kept
      : null;
    const mismatches = [
      ...verifyCapturedScreens({ catalog, text, captured: captured.captured }),
      ...captured.unstable.map((key): ScreenVerifyMismatch => ({ key, causes: ["unstable"] })),
    ].sort((left, right) => left.key.localeCompare(right.key));
    const passed = mismatches.length === 0 && orphanedText.length === 0;
    // After widening, the mismatches can lie outside what --changed selects,
    // so the fix names them.
    const fix = selection.widened
      ? `tieline screens capture ${
          mismatches.length > 0 && mismatches.length <= 10
            ? mismatches.map((mismatch) => `--screen ${mismatch.key}`).join(" ")
            : "--all"
        }`
      : `tieline screens capture ${scopeFlags(scope)}`;
    if (options.json) {
      io.write(
        `${JSON.stringify(
          {
            verify: true,
            passed,
            playwright: captured.playwright,
            selection,
            verified: captured.captured.length + captured.unstable.length,
            mismatches,
            orphaned_text: orphanedText,
            not_covered: notCovered,
            ...(keptScreenshots ? { kept_screenshots: keptScreenshots.length } : {}),
            fix: passed ? null : fix,
          },
          null,
          2
        )}\n`
      );
      return passed ? 0 : 1;
    }
    io.write(
      `Verified ${captured.captured.length + captured.unstable.length} screen(s) against a fresh capture: ${mismatches.length} mismatch(es), ${orphanedText.length} orphaned ARIA snapshot(s).\n`
    );
    for (const mismatch of mismatches) {
      io.write(
        `  mismatch  ${escapeTerminalText(mismatch.key)}: ${mismatch.causes.map((cause) => CAUSE_LABELS[cause]).join("; ")}\n`
      );
    }
    for (const path of orphanedText) {
      io.write(`  orphaned  ${escapeTerminalText(path)}: no catalogued screen has this key\n`);
    }
    renderCoverage(selection, notCovered, io);
    for (const rule of selection.unavailable) {
      io.write(`  note  ${rule.rule} rule incomplete: ${escapeTerminalText(rule.detail)}\n`);
    }
    if (selection.widened) {
      io.write(
        `  note  ${escapeTerminalText(selection.widened.reason)}, so every screen was verified, not only the ones this branch may have changed.\n`
      );
    }
    if (keptScreenshots && keptScreenshots.length > 0) {
      io.write(
        `Kept ${keptScreenshots.length} screenshot(s) the capture reproduced exactly in ${escapeTerminalText(settings.capturesPath)}, for publishing.\n`
      );
    }
    if (!passed) {
      io.write(
        `The committed screen outputs do not match a fresh capture. Run \`${escapeTerminalText(fix)}\` in the pinned capture environment and commit the result.\n`
      );
    }
    return passed ? 0 : 1;
  }

  // The catalog and snapshots are read again under the import lock, since an
  // import or an edit may have changed them while Playwright ran; the writer
  // then refuses to replace anything that changed after this read.
  const { plan, ignore } = withScreenImportLock(root, () => {
    const current = loadCaptureCatalog(root, specDirectory, settings);
    const plan = planCaptureOutputs({
      repositoryRoot: root,
      settings,
      sources: current.sources,
      catalog: current.catalog,
      capabilityKeys: current.capabilityKeys,
      text: readScreenTextDirectory(settings),
      captured: captured.captured,
    });
    return { plan, ignore: applyCaptureOutputs(root, settings, plan) };
  });
  // Screens captured elsewhere than the rest of the catalog will not pass
  // verification in the pinned environment; say so now rather than in CI.
  const freshPrints = new Set(captured.captured.map((screen) => screen.fingerprint));
  const otherEnvironments = [...catalog.screens.values()].filter(
    ({ entry }) =>
      entry.capture !== undefined &&
      !freshPrints.has(entry.capture.fingerprint) &&
      !captured.captured.some((screen) => screen.key === entry.key)
  ).length;
  const count = (status: CaptureOutputResult["status"]): number =>
    plan.screens.filter((screen) => screen.status === status).length;
  // Unstable screens are left as they were, so the run is incomplete.
  const exitCode = captured.unstable.length > 0 ? 1 : 0;
  if (options.json) {
    io.write(
      `${JSON.stringify(
        {
          verify: false,
          complete: exitCode === 0,
          playwright: captured.playwright,
          selection,
          screens: plan.screens,
          unstable: captured.unstable,
          not_covered: notCovered,
          catalog_files: plan.catalogFiles
            .filter((file) => file.status !== "unchanged")
            .map((file) => file.path),
          removed_text: plan.orphanedText.map((orphan) => orphan.path),
          screens_from_other_environments: freshPrints.size > 0 ? otherEnvironments : 0,
          captures_gitignore: ignore,
        },
        null,
        2
      )}\n`
    );
    return exitCode;
  }
  io.write(
    selection.screens.length === 0 && selection.excluded.length === 0
      ? "No screen was selected, so nothing was captured.\n"
      : plan.screens.length === 0 && captured.unstable.length === 0
        ? "No screen was captured.\n"
        : `Captured ${plan.screens.length} screen(s) with Playwright ${captured.playwright}${repeat > 1 ? `, identically in ${repeat} runs` : ""}: ${count("new")} new, ${count("updated")} updated, ${count("unchanged")} unchanged.\n`
  );
  for (const screen of plan.screens) {
    if (screen.status === "unchanged") continue;
    io.write(
      `  ${screen.status.padEnd(9)} ${escapeTerminalText(screen.key)}${screen.aspects.length > 0 ? ` (${screen.aspects.join(", ")})` : ""}\n`
    );
  }
  for (const key of captured.unstable) {
    io.write(
      `  unstable  ${escapeTerminalText(key)}: differed between runs and was not written; fix what moves, or mark it not_captured (unstable)\n`
    );
  }
  for (const orphan of plan.orphanedText) {
    io.write(`  removed   ${escapeTerminalText(orphan.path)}: no catalogued screen has this key\n`);
  }
  renderCoverage(selection, notCovered, io);
  for (const rule of selection.unavailable) {
    io.write(`  note  ${rule.rule} rule incomplete: ${escapeTerminalText(rule.detail)}\n`);
  }
  if (freshPrints.size > 0 && otherEnvironments > 0) {
    io.write(
      `  note  ${otherEnvironments} other screen(s) were captured in a different environment; \`--verify\` compares only captures made in the same one.\n`
    );
  }
  if (ignore === "not_managed") {
    io.write(
      `  note  ${escapeTerminalText(settings.capturesPath)} is outside .tieline/; make sure screenshots there are git-ignored.\n`
    );
  } else if (ignore === "unverified") {
    io.write(
      `  note  ${escapeTerminalText(settings.capturesPath)}/.gitignore does not ignore everything in ${escapeTerminalText(settings.capturesPath)} (or is not a regular file), and Tieline leaves it unchanged; make sure screenshots there are git-ignored.\n`
    );
  }
  if (
    plan.catalogFiles.some((file) => file.status !== "unchanged") ||
    plan.texts.length > 0 ||
    plan.orphanedText.length > 0
  ) {
    io.write("Run `tieline contract compile .` to refresh the manifest and review page, then commit the catalog and ARIA snapshots.\n");
  }
  if (exitCode !== 0) {
    io.write(`${captured.unstable.length} unstable screen(s) were not written, so this capture is incomplete.\n`);
  }
  return exitCode;
}

/** Selected screens left out of a run: marked not captured, or without a test. */
function renderCoverage(selection: ScreenSelection, notCovered: readonly string[], io: CommandIO): void {
  for (const screen of selection.excluded) {
    io.write(
      `  skipped   ${escapeTerminalText(screen.key)}: not captured (${screen.reason}): ${escapeTerminalText(screen.detail)}\n`
    );
  }
  for (const key of notCovered) {
    io.write(`  not covered ${escapeTerminalText(key)}: no test is tagged @screen:${escapeTerminalText(key)}\n`);
  }
}

/**
 * `tieline screens audit --capture`: re-captures every screen and writes the
 * outputs, so every screen it reports as new or updated is drift that the
 * selection rules missed. Its outputs land in a normal pull request.
 */
export async function runScreensAuditCaptureCommand(
  options: Pick<ScreensCaptureOptions, "repository" | "json" | "signal">,
  io: CommandIO,
  dependencies: ScreensCaptureDependencies = DEFAULT_DEPENDENCIES
): Promise<number> {
  if (!options.json) {
    io.write(
      "Audit: re-capturing every screen. Screens reported as updated changed without a branch selecting them; review and commit them in a pull request.\n"
    );
  }
  return runScreensCaptureCommand({ ...options, all: true }, io, dependencies);
}
