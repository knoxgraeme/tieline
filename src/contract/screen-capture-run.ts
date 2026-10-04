import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isMap, isSeq, parseDocument } from "yaml";
import { z } from "zod";
import {
  CAPTURE_LIMITS,
  MASK_COLOR,
  RUN_PROTOCOL_VERSION,
  RUN_RECORD_FILE,
  SCREEN_KEY_MAX_CHARS,
  SCREENS_DIRECTORY,
} from "../playwright/protocol.cjs";
import { withinRepository } from "./paths.js";
import {
  realDestination,
  repositoryFilePathProblem,
  SCREEN_LIMITS,
  validateScreenCatalogDocuments,
  type ScreenCapture,
  type ScreenCatalogSource,
  type ScreenSettings,
  type ValidatedScreenCatalog,
} from "./screen-catalog.js";
import {
  applyScreenImport,
  ensureCapturesIgnored,
  readBoundedFile,
  SCREEN_IMPORT_LIMITS,
  serializeScreenCatalogDocument,
  type CapturesIgnoreStatus,
  type PlannedScreenCatalogFile,
  type ScreenImportFileSystem,
} from "./screen-import.js";
import { screenTextDigest, screenTextFile, type ScreenTextDirectory } from "./screen-text.js";

/**
 * Reads what a Playwright capture run produced, checks it is complete, and
 * turns it into committed outputs or a verification report. The run directory
 * is written by repository code (the app's tests, the fixture, and the
 * reporter all run in Playwright), so it is untrusted: every file is bounded,
 * parsed with a schema, and re-hashed here, and nothing is written unless the
 * whole run is complete.
 */

export const SCREEN_CAPTURE_RUN_LIMITS = {
  /** Largest run record read. */
  recordBytes: 16 * 1024 * 1024,
  /** Largest per-screen settings file read. */
  settingsBytes: 64 * 1024,
  /** Most tests a run record may list. */
  tests: 50_000,
  /** Largest screenshot read, as for import. */
  imageBytes: CAPTURE_LIMITS.imageBytes,
  /** Most screenshot bytes one run may read in total, as for import. */
  totalImageBytes: SCREEN_IMPORT_LIMITS.captureTotalBytes,
  /** Largest ARIA snapshot read. */
  textBytes: CAPTURE_LIMITS.textBytes,
  /** Problems listed in an error before the rest are counted. */
  reportedIssues: 20,
} as const;

export class ScreenCaptureError extends Error {
  readonly issues: string[];

  constructor(summary: string, issues: string[] = []) {
    const shown = issues.slice(0, SCREEN_CAPTURE_RUN_LIMITS.reportedIssues);
    const hidden = issues.length - shown.length;
    super(
      [
        summary,
        ...shown.map((issue) => `- ${issue}`),
        ...(hidden > 0 ? [`- (and ${hidden} more)`] : []),
      ].join("\n")
    );
    this.name = "ScreenCaptureError";
    this.issues = issues;
  }
}

const boundedString = (max: number) => z.string().max(max);

const runRecordSchema = z
  .object({
    version: z.literal(RUN_PROTOCOL_VERSION),
    playwright: boundedString(64),
    status: boundedString(32),
    tests: z
      .array(
        z
          .object({
            id: boundedString(512),
            file: boundedString(4_096),
            line: z.number().int().nonnegative(),
            title: boundedString(4_096),
            project: boundedString(256),
            status: boundedString(32),
            keys: z.array(boundedString(SCREEN_KEY_MAX_CHARS)).max(1_000),
            error: boundedString(CAPTURE_LIMITS.errorChars + 1).nullable(),
          })
          .strict()
      )
      .max(SCREEN_CAPTURE_RUN_LIMITS.tests),
    errors: z.array(boundedString(CAPTURE_LIMITS.errorChars + 1)).max(CAPTURE_LIMITS.errors),
  })
  .strict();

type RunRecord = z.infer<typeof runRecordSchema>;

/** What the fixture observed about one capture. */
const captureSettingsSchema = z
  .object({
    version: z.literal(RUN_PROTOCOL_VERSION),
    key: boundedString(SCREEN_KEY_MAX_CHARS),
    browser: z.object({ name: boundedString(64), version: boundedString(64) }).strict(),
    page: z
      .object({
        viewport: z
          .object({
            width: z.number().int().positive().max(100_000),
            height: z.number().int().positive().max(100_000),
          })
          .strict()
          .nullable(),
        device_scale_factor: z.number().positive().max(16),
        color_scheme: z.enum(["light", "dark", "no-preference"]),
        reduced_motion: z.enum(["reduce", "no-preference"]),
        forced_colors: z.enum(["active", "none"]),
        contrast: z.enum(["more", "less", "no-preference"]),
        locale: boundedString(64),
        timezone: boundedString(64),
        touch: z.boolean(),
      })
      .strict(),
    snapshot: z
      .object({
        full_page: z.boolean(),
        animations: z.literal("disabled"),
        caret: z.literal("hide"),
        scale: z.literal("css"),
        mask_color: z.literal(MASK_COLOR),
        masks: z.array(boundedString(1_000)).max(100),
      })
      .strict(),
    settle_attempts: z.number().int().min(1).max(CAPTURE_LIMITS.settleAttempts),
  })
  .strict();

export type CaptureSettings = z.infer<typeof captureSettingsSchema>;

/**
 * Where the capture ran, beyond what the page reports: the platform, the
 * installed fonts, and the container image a CI job names. Read by the
 * command, not the run, so it is not something a test can claim.
 */
export interface CaptureEnvironment {
  platform: string;
  arch: string;
  /** SHA-256 of the sorted installed font files, or null when unknown. */
  fonts: string | null;
  /** The pinned image named by `TIELINE_CAPTURE_IMAGE`, or null. */
  image: string | null;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).sort(([left], [right]) =>
            left.localeCompare(right)
          )
        )
      : entry
  );
}

/**
 * The SHA-256, in canonical form, of where and how screens are rendered: the
 * Playwright and browser versions, the page settings, the machine, and the
 * screenshot method. Two digests are comparable only when their fingerprints
 * are equal, and screens with equal fingerprints were captured in the same
 * environment. A screen's own scene options (its masks and whether it is a
 * full page) are left out: they belong to the scene, and changing them changes
 * the screen's image, which verification reports as such. Nor are which screen
 * it is, or how many attempts it took to settle.
 */
export function captureFingerprint(
  settings: CaptureSettings,
  playwright: string,
  environment: CaptureEnvironment
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        version: 2,
        playwright,
        browser: settings.browser,
        page: settings.page,
        snapshot: {
          animations: settings.snapshot.animations,
          caret: settings.snapshot.caret,
          scale: settings.snapshot.scale,
          mask_color: settings.snapshot.mask_color,
        },
        environment,
      })
    )
    .digest("hex");
}

/** One captured screen, read back from the run and re-hashed. */
export interface CapturedScreen {
  key: string;
  image: Buffer;
  image_sha256: string;
  text: string;
  text_sha256: string;
  fingerprint: string;
  /** The repository-relative test file that captured it. */
  test: string;
}

/**
 * What a capture is compared by, without its screenshot and ARIA snapshot:
 * all a later `--repeat` run keeps.
 */
export type CaptureDigest = Omit<CapturedScreen, "image" | "text">;

interface ReadCapturedScreensInput {
  runDirectory: string;
  repositoryRoot: string;
  record: RunRecord;
  selected: readonly string[];
  environment: CaptureEnvironment;
  limits?: Pick<
    typeof SCREEN_CAPTURE_RUN_LIMITS,
    "imageBytes" | "totalImageBytes" | "textBytes" | "settingsBytes"
  >;
  /**
   * Screenshot bytes the capture already holds from earlier batches. They
   * count toward `totalImageBytes`, so one bound covers a capture however it
   * is batched.
   */
  imageBytesHeld?: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readRunFile(path: string, maxBytes: number, label: string): Buffer {
  try {
    return readBoundedFile(path, maxBytes, label);
  } catch (error) {
    throw new ScreenCaptureError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Reads the run record. Null when the reporter never wrote one, which means
 * Playwright stopped before the run finished (or never started it).
 */
export function readCaptureRunRecord(runDirectory: string): RunRecord | null {
  const path = resolve(runDirectory, RUN_RECORD_FILE);
  if (!existsSync(path)) return null;
  const bytes = readRunFile(path, SCREEN_CAPTURE_RUN_LIMITS.recordBytes, "capture run record");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new ScreenCaptureError(
      `The capture run record is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const result = runRecordSchema.safeParse(parsed);
  if (!result.success) {
    throw new ScreenCaptureError(
      "The capture run record is not one this version of Tieline wrote.",
      result.error.issues.map((issue) => `${issue.path.join(".") || "record"}: ${issue.message}`)
    );
  }
  return result.data;
}

const FAILED_STATUSES = new Set(["failed", "timedOut", "interrupted"]);

/** The tests and run-level errors that make a capture run unusable. */
export function captureRunFailures(record: RunRecord): string[] {
  return [
    ...record.tests
      .filter((test) => FAILED_STATUSES.has(test.status))
      .map(
        (test) =>
          `${test.title} (${test.file}:${test.line}${test.project ? `, project ${test.project}` : ""}) ${test.status}${
            test.error ? `: ${test.error.split("\n")[0]}` : ""
          }`
      ),
    ...record.errors.map((error) => `run error: ${error.split("\n")[0]}`),
  ];
}

function repositoryTestPath(repositoryRoot: string, file: string): string | null {
  if (!isAbsolute(file)) return null;
  const root = resolve(repositoryRoot);
  if (!withinRepository(root, file)) return null;
  const path = relative(root, file).split(sep).join("/");
  return repositoryFilePathProblem(path) === null ? path : null;
}

/**
 * Checks that every selected screen was captured exactly once by a passing
 * test, then reads and re-hashes each capture. Every problem is collected and
 * reported together; a run with any problem yields nothing. With `retain`
 * false, each screenshot is dropped once hashed and only digests are kept, so
 * the run holds one screenshot at a time.
 */
export function readCapturedScreens(input: ReadCapturedScreensInput & { retain?: true }): CapturedScreen[];
export function readCapturedScreens(input: ReadCapturedScreensInput & { retain: false }): CaptureDigest[];
export function readCapturedScreens(input: ReadCapturedScreensInput & { retain?: boolean }): CaptureDigest[] {
  const { record } = input;
  const limits = input.limits ?? SCREEN_CAPTURE_RUN_LIMITS;
  const failures = captureRunFailures(record);
  if (failures.length > 0) {
    throw new ScreenCaptureError(
      `${failures.length} test(s) or run step(s) failed, so nothing was written.`,
      failures
    );
  }
  const selected = new Set(input.selected);
  const capturedBy = new Map<string, RunRecord["tests"]>();
  for (const test of record.tests) {
    if (test.status !== "passed") continue;
    for (const key of new Set(test.keys)) {
      if (!selected.has(key)) continue;
      capturedBy.set(key, [...(capturedBy.get(key) ?? []), test]);
    }
  }
  const issues: string[] = [];
  for (const key of input.selected) {
    const tests = capturedBy.get(key) ?? [];
    if (tests.length === 0) {
      issues.push(
        `'${key}' was not captured: no passing test tagged @screen:${key} called tielineSnapshot(page, '${key}')`
      );
    } else if (tests.length > 1) {
      issues.push(
        `'${key}' was captured by ${tests.length} tests (${tests
          .map((test) => `${test.title}${test.project ? ` [${test.project}]` : ""}`)
          .join("; ")}); capture each screen in exactly one test and one project`
      );
    } else {
      // A key attached twice by one test is two captures of the same screen.
      const attached = tests[0]!.keys.filter((attachedKey) => attachedKey === key).length;
      if (attached > 1) {
        issues.push(`'${key}' was captured ${attached} times by ${tests[0]!.title}; capture it once`);
      }
    }
  }
  if (issues.length > 0) {
    throw new ScreenCaptureError(
      `The capture run is incomplete, so nothing was written.`,
      issues
    );
  }

  const captured: CaptureDigest[] = [];
  let imageBytes = input.imageBytesHeld ?? 0;
  const directory = resolve(input.runDirectory, SCREENS_DIRECTORY);
  for (const key of [...input.selected].sort((left, right) => left.localeCompare(right))) {
    const test = capturedBy.get(key)![0]!;
    try {
      const image = readRunFile(resolve(directory, `${key}.png`), limits.imageBytes, "screenshot");
      if (!image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        throw new ScreenCaptureError(`the screenshot of '${key}' is not a PNG file`);
      }
      // Only screenshots kept count: one dropped once hashed is not held.
      if (input.retain !== false) imageBytes += image.length;
      if (imageBytes > limits.totalImageBytes) {
        throw new ScreenCaptureError(
          `the capture's screenshots exceed the ${limits.totalImageBytes}-byte total; capture fewer screens at once`
        );
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(
          readRunFile(resolve(directory, `${key}.yml`), limits.textBytes, "ARIA snapshot")
        );
      } catch (error) {
        throw error instanceof ScreenCaptureError
          ? error
          : new ScreenCaptureError(`the ARIA snapshot of '${key}' is not valid UTF-8`);
      }
      if (text.includes("\0")) throw new ScreenCaptureError(`the ARIA snapshot of '${key}' contains a NUL byte`);
      let settingsValue: unknown;
      try {
        settingsValue = JSON.parse(
          readRunFile(resolve(directory, `${key}.json`), limits.settingsBytes, "capture settings").toString("utf8")
        );
      } catch (error) {
        throw error instanceof ScreenCaptureError
          ? error
          : new ScreenCaptureError(`the capture settings of '${key}' are not valid JSON`);
      }
      const settings = captureSettingsSchema.safeParse(settingsValue);
      if (!settings.success) {
        throw new ScreenCaptureError(
          `the capture settings of '${key}' are invalid: ${settings.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")}`
        );
      }
      if (settings.data.key !== key) {
        throw new ScreenCaptureError(`the capture settings of '${key}' name '${settings.data.key}'`);
      }
      const testPath = repositoryTestPath(input.repositoryRoot, test.file);
      if (!testPath) {
        throw new ScreenCaptureError(`'${key}' was captured by a test outside the repository (${test.file})`);
      }
      // Committed snapshots use LF line endings and end with a newline.
      const lines = text.replace(/\r\n/g, "\n");
      const committedText = lines.endsWith("\n") ? lines : `${lines}\n`;
      const digest: CaptureDigest = {
        key,
        image_sha256: createHash("sha256").update(image).digest("hex"),
        text_sha256: screenTextDigest(committedText),
        fingerprint: captureFingerprint(settings.data, record.playwright, input.environment),
        test: testPath,
      };
      const screen: CaptureDigest | CapturedScreen = input.retain === false ? digest : { ...digest, image, text: committedText };
      captured.push(screen);
    } catch (error) {
      if (!(error instanceof ScreenCaptureError)) throw error;
      issues.push(error.message);
    }
  }
  if (issues.length > 0) {
    throw new ScreenCaptureError("The capture run produced unusable files, so nothing was written.", issues);
  }
  return captured;
}

/** Why a captured screen's committed outputs do not match a fresh capture. */
export type ScreenVerifyCause = "unstable" | "not_captured" | "environment" | "image" | "text" | "test";

export interface ScreenVerifyMismatch {
  key: string;
  causes: ScreenVerifyCause[];
}

/**
 * Compares fresh captures with what the branch commits. Digests captured in a
 * different environment are never compared: a fingerprint mismatch is
 * reported as such, because the pixels would differ whether or not the screen
 * did.
 */
export function verifyCapturedScreens(input: {
  catalog: ValidatedScreenCatalog;
  text: ScreenTextDirectory;
  captured: readonly CapturedScreen[];
}): ScreenVerifyMismatch[] {
  const mismatches: ScreenVerifyMismatch[] = [];
  for (const fresh of input.captured) {
    const entry = input.catalog.screens.get(fresh.key)?.entry;
    const record = entry?.capture;
    if (!entry || !record) {
      mismatches.push({ key: fresh.key, causes: ["not_captured"] });
      continue;
    }
    if (record.fingerprint !== fresh.fingerprint) {
      mismatches.push({ key: fresh.key, causes: ["environment"] });
      continue;
    }
    const causes: ScreenVerifyCause[] = [];
    if (entry.image?.sha256 !== fresh.image_sha256) causes.push("image");
    if (
      record.text_sha256 !== fresh.text_sha256 ||
      input.text.digests.get(fresh.key) !== fresh.text_sha256
    ) {
      causes.push("text");
    }
    if (record.test !== fresh.test) causes.push("test");
    if (causes.length > 0) mismatches.push({ key: fresh.key, causes });
  }
  return mismatches;
}

export type CapturedScreenStatus = "new" | "updated" | "unchanged";
export type CapturedScreenAspect = "image" | "text" | "environment" | "test";

export interface CaptureOutputResult {
  key: string;
  status: CapturedScreenStatus;
  /** Empty unless `status` is `updated`. */
  aspects: CapturedScreenAspect[];
}

export interface CaptureOutputPlan {
  screens: CaptureOutputResult[];
  catalogFiles: PlannedScreenCatalogFile[];
  screenshots: Array<{ absolutePath: string; content: Buffer }>;
  /** ARIA snapshots to write, with what they replace so a failure can restore it. */
  texts: PlannedScreenCatalogFile[];
  /** Repository-relative ARIA snapshots of screens the catalog no longer has. */
  orphanedText: Array<{ absolutePath: string; path: string }>;
}

function captureRecord(fresh: CapturedScreen): ScreenCapture {
  return { fingerprint: fresh.fingerprint, text_sha256: fresh.text_sha256, test: fresh.test };
}

/**
 * Works out what a complete capture writes: each screenshot as `<key>.png` in
 * the captures directory, each ARIA snapshot in the text directory, and each
 * screen's `image` and `capture` fields, edited in place so the rest of the
 * catalog, comments included, is untouched. The edited catalog is validated
 * before it is returned.
 */
export function planCaptureOutputs(input: {
  repositoryRoot: string;
  settings: ScreenSettings;
  sources: readonly ScreenCatalogSource[];
  catalog: ValidatedScreenCatalog;
  capabilityKeys: ReadonlySet<string>;
  text: ScreenTextDirectory;
  captured: readonly CapturedScreen[];
}): CaptureOutputPlan {
  const { settings, catalog } = input;
  const screens: CaptureOutputResult[] = [];
  const edits = new Map<string, CapturedScreen[]>();
  for (const fresh of input.captured) {
    const screen = catalog.screens.get(fresh.key);
    if (!screen) {
      throw new ScreenCaptureError(`Captured screen '${fresh.key}' is not in the catalog.`);
    }
    const previous = screen.entry.capture;
    const image = screen.entry.image;
    const aspects: CapturedScreenAspect[] = [];
    if (previous && previous.fingerprint !== fresh.fingerprint) aspects.push("environment");
    if (!image || !("path" in image) || image.path !== `${fresh.key}.png` || image.sha256 !== fresh.image_sha256) {
      aspects.push("image");
    }
    if (previous?.text_sha256 !== fresh.text_sha256 || input.text.digests.get(fresh.key) !== fresh.text_sha256) {
      aspects.push("text");
    }
    if (previous && previous.test !== fresh.test) aspects.push("test");
    const status: CapturedScreenStatus = !previous ? "new" : aspects.length > 0 ? "updated" : "unchanged";
    screens.push({ key: fresh.key, status, aspects: status === "updated" ? aspects : [] });
    if (status !== "unchanged") edits.set(screen.path, [...(edits.get(screen.path) ?? []), fresh]);
  }

  // Every catalog file, changed or not: the writer checks that each still
  // holds what was read before replacing any.
  const catalogFiles: PlannedScreenCatalogFile[] = [];
  const outputs = input.sources.map((source) => {
    const changes = edits.get(source.path);
    if (!changes) {
      catalogFiles.push({
        path: source.path,
        absolutePath: source.absolutePath,
        status: "unchanged",
        content: source.content,
        original: source.content,
        realParent: dirname(source.realPath),
      });
      return { source, content: source.content };
    }
    const document = parseDocument(source.content);
    const sequence = document.get("screens", true);
    if (!isSeq(sequence)) {
      throw new ScreenCaptureError(`Screen catalog '${source.path}' has no 'screens' list to update.`);
    }
    for (const fresh of changes) {
      const item = sequence.items.find((candidate) => {
        if (!isMap(candidate)) return false;
        const value: unknown = candidate.get("key");
        return typeof value === "string" && value.trim() === fresh.key;
      });
      if (!isMap(item)) {
        throw new ScreenCaptureError(`Screen '${fresh.key}' could not be located in '${source.path}'; nothing was written.`);
      }
      item.set("image", document.createNode({ path: `${fresh.key}.png`, sha256: fresh.image_sha256 }));
      item.set("capture", document.createNode(captureRecord(fresh)));
    }
    const content = serializeScreenCatalogDocument(document);
    catalogFiles.push({
      path: source.path,
      absolutePath: source.absolutePath,
      status: content === source.content ? "unchanged" : "updated",
      content,
      original: source.content,
      realParent: dirname(source.realPath),
    });
    return { source, content };
  });
  const issues: string[] = [];
  // The loader refuses oversized catalog files, and a catalog over its total,
  // so capture must not write either.
  let totalBytes = 0;
  for (const { source, content } of outputs) {
    const bytes = Buffer.byteLength(content);
    totalBytes += bytes;
    if (bytes > SCREEN_LIMITS.catalogFileBytes) {
      issues.push(`${source.path}: the catalog would be ${bytes} bytes; the limit is ${SCREEN_LIMITS.catalogFileBytes}`);
    }
  }
  if (totalBytes > SCREEN_LIMITS.catalogTotalBytes) {
    issues.push(`the catalog would hold ${totalBytes} bytes; the limit is ${SCREEN_LIMITS.catalogTotalBytes}`);
  }
  validateScreenCatalogDocuments(
    outputs.map(({ source, content }) => ({ path: source.path, document: parseDocument(content).toJS() })),
    input.capabilityKeys,
    issues
  );
  if (issues.length > 0) {
    throw new ScreenCaptureError("The captured catalog would not validate; nothing was written.", issues);
  }

  return {
    screens,
    catalogFiles,
    screenshots: input.captured.map((fresh) => ({
      absolutePath: resolve(settings.capturesDirectory, `${fresh.key}.png`),
      content: fresh.image,
    })),
    texts: input.captured
      .filter((fresh) => input.text.digests.get(fresh.key) !== fresh.text_sha256)
      .map((fresh): PlannedScreenCatalogFile => {
        const file = screenTextFile(settings, fresh.key);
        const original = input.text.digests.has(fresh.key)
          ? readRunFile(file.absolutePath, SCREEN_CAPTURE_RUN_LIMITS.textBytes, "ARIA snapshot").toString("utf8")
          : null;
        return {
          ...file,
          status: original === null ? "created" : "updated",
          content: fresh.text,
          original,
          realParent: realDestination(dirname(file.absolutePath)),
        };
      }),
    orphanedText: [...input.text.digests.keys()]
      .filter((key) => !catalog.screens.has(key))
      .sort((left, right) => left.localeCompare(right))
      .map((key) => screenTextFile(settings, key)),
  };
}

/**
 * Keeps each screenshot a verification reproduced exactly in the git-ignored
 * captures directory. A fresh screenshot whose digest equals the committed
 * one is byte for byte the committed screenshot, so keeping it changes
 * nothing committed, and hosted screens can then publish it. A file already
 * holding those bytes is left alone. Returns the keys of the screenshots
 * written.
 */
export function keepVerifiedScreenshots(
  repositoryRoot: string,
  settings: ScreenSettings,
  catalog: ValidatedScreenCatalog,
  captured: readonly CapturedScreen[]
): { kept: string[]; ignore: CapturesIgnoreStatus | null } {
  const verified = captured.filter((fresh) => {
    const image = catalog.screens.get(fresh.key)?.entry.image;
    return image !== undefined && "path" in image && image.path === `${fresh.key}.png` && image.sha256 === fresh.image_sha256;
  });
  const kept: string[] = [];
  let ignore: CapturesIgnoreStatus | null = null;
  for (const fresh of verified) {
    const path = resolve(settings.capturesDirectory, `${fresh.key}.png`);
    if (existsSync(path)) {
      try {
        const current = readBoundedFile(path, SCREEN_CAPTURE_RUN_LIMITS.imageBytes, "screenshot");
        if (createHash("sha256").update(current).digest("hex") === fresh.image_sha256) continue;
      } catch {
        // Unreadable or oversized: replace it with the verified screenshot.
      }
    }
    ignore ??= ensureCapturesIgnored(repositoryRoot, settings);
    writeAtomically(path, fresh.image);
    kept.push(fresh.key);
  }
  return { kept: kept.sort((left, right) => left.localeCompare(right)), ignore };
}

/**
 * Replaces a file through a temporary file created exclusively, so a link
 * planted at the temporary path is never followed, and a rename, so a reader
 * never sees half a file.
 */
function writeAtomically(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { flag: "wx" });
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Writes a capture's outputs. The git-ignored screenshots come first. Then the
 * committed ARIA snapshots, and last the catalog, through the importer's
 * writer: it checks that no catalog file changed since it was read, replaces
 * them all or none, and restores what it replaced on failure. If the catalog
 * is not written, the snapshots written before it are restored too, so a
 * capture record never describes a snapshot that is not there, nor the other
 * way round. Snapshots of screens the catalog no longer has are removed last.
 * Run it holding the screen import lock, which keeps an import from writing
 * the catalog in between.
 */
export function applyCaptureOutputs(
  repositoryRoot: string,
  settings: ScreenSettings,
  plan: CaptureOutputPlan,
  fileSystem?: ScreenImportFileSystem
): CapturesIgnoreStatus {
  const ignore = ensureCapturesIgnored(repositoryRoot, settings);
  // Each screenshot replaced is kept beside it until the catalog is written,
  // so a failure puts every one back: the catalog's digests and the files in
  // the captures directory never disagree.
  const screenshots: Array<{ path: string; previous: string | null }> = [];
  const written: PlannedScreenCatalogFile[] = [];
  try {
    for (const screenshot of plan.screenshots) {
      const previous = existsSync(screenshot.absolutePath) ? `${screenshot.absolutePath}.${process.pid}.previous` : null;
      if (previous) renameSync(screenshot.absolutePath, previous);
      screenshots.push({ path: screenshot.absolutePath, previous });
      writeAtomically(screenshot.absolutePath, screenshot.content);
    }
    for (const text of plan.texts) {
      writeAtomically(text.absolutePath, text.content);
      written.push(text);
    }
    applyScreenImport(
      {
        entries: 0,
        created: [],
        updated: [],
        moved: [],
        unchanged: [],
        pruned: [],
        skipped_unknown_capability: [],
        files: plan.catalogFiles,
        catalog: {
          repositoryRoot,
          settings,
          limits: {
            entries: SCREEN_LIMITS.catalogEntries,
            files: SCREEN_LIMITS.catalogFiles,
            fileBytes: SCREEN_LIMITS.catalogFileBytes,
            totalBytes: SCREEN_LIMITS.catalogTotalBytes,
          },
        },
      },
      fileSystem
    );
  } catch (error) {
    const unrestored: string[] = [];
    for (const text of written.reverse()) {
      try {
        if (text.original === null) rmSync(text.absolutePath, { force: true });
        else writeAtomically(text.absolutePath, text.original);
      } catch (restoreError) {
        unrestored.push(`${text.path} (${errorMessage(restoreError)})`);
      }
    }
    for (const screenshot of screenshots.reverse()) {
      try {
        if (screenshot.previous) renameSync(screenshot.previous, screenshot.path);
        else rmSync(screenshot.path, { force: true });
      } catch (restoreError) {
        unrestored.push(`${relative(repositoryRoot, screenshot.path).split(sep).join("/")} (${errorMessage(restoreError)})`);
      }
    }
    if (unrestored.length === 0) throw error;
    throw new ScreenCaptureError(
      `${errorMessage(error)}\nThe files written before it could not all be restored: restore ARIA snapshots from git, and capture again for screenshots.`,
      unrestored
    );
  }
  for (const screenshot of screenshots) {
    if (screenshot.previous) rmSync(screenshot.previous, { force: true });
  }
  for (const orphan of plan.orphanedText) rmSync(orphan.absolutePath, { force: true });
  return ignore;
}

/**
 * Catalog keys that name the same file on a case-insensitive filesystem, as
 * macOS and Windows checkouts use. Their screenshots and ARIA snapshots would
 * overwrite each other, so capture refuses to run while any exist.
 */
export function caseCollidingKeys(catalog: ValidatedScreenCatalog): string[][] {
  const byFolded = new Map<string, string[]>();
  for (const key of catalog.screens.keys()) {
    const folded = key.toLowerCase();
    byFolded.set(folded, [...(byFolded.get(folded) ?? []), key]);
  }
  return [...byFolded.values()]
    .filter((keys) => keys.length > 1)
    .map((keys) => keys.sort((left, right) => left.localeCompare(right)));
}
