import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { screenPathPattern } from "./paths.js";
import { readBoundedFile } from "./screen-import.js";

/**
 * Finds the Playwright tests that capture each screen by reading their
 * `@screen:<key>` tags as text. This is deliberately a scan, not a test run: it
 * never loads the app's Playwright configuration or executes repository code,
 * so `tieline check` can report screens without a scene cheaply. A tag must be
 * written literally for the scan to see it; the capture run itself is the
 * authority on which test captured which screen.
 */

export const SCREEN_SCENE_LIMITS = {
  /** Largest `git ls-files` listing read. */
  listedBytes: 64 * 1024 * 1024,
  /** Most candidate test files read. */
  files: 20_000,
  /** Largest test file read. */
  fileBytes: 2 * 1024 * 1024,
  /** Most test file bytes read in one scan. */
  totalBytes: 256 * 1024 * 1024,
} as const;

export type ScreenSceneScanLimits = { [Key in keyof typeof SCREEN_SCENE_LIMITS]: number };

/**
 * `complete` when every candidate file was read; `incomplete` when a bound
 * stopped the scan, so a key without a tag may still have a test; and
 * `unavailable` when the repository's files could not be listed.
 */
export type ScreenSceneScanStatus = "complete" | "incomplete" | "unavailable";

export interface ScreenSceneScan {
  status: ScreenSceneScanStatus;
  /** Why the scan is not complete, or null. */
  detail: string | null;
  /** Candidate test files read. */
  files: number;
  /** The repository-relative files that tag each screen key, sorted. */
  tags: ReadonlyMap<string, readonly string[]>;
  /** The repository-relative files that tag each acceptance criterion (`@ac:<key>`). */
  acTags: ReadonlyMap<string, readonly string[]>;
  /**
   * Files that tag screens and also intercept the page's requests
   * (`route`, `routeFromHAR`, `routeWebSocket`). Blocking third-party requests
   * is legitimate; answering the app's own requests with made-up responses
   * captures a state the real app never produced, so these are for review.
   */
  intercepting: ReadonlyArray<{ file: string; keys: readonly string[] }>;
}

const SCRIPT_FILE = /\.[cm]?[jt]sx?$/;
/** Playwright's default test naming, plus Tieline's `*.screens.ts`. */
const DEFAULT_SCENE_FILE = /\.(?:spec|test|screens)\.[cm]?[jt]sx?$/;
const SCREEN_TAG = /@screen:([A-Za-z0-9][A-Za-z0-9._-]*)/g;
const AC_TAG = /@ac:([A-Za-z0-9][A-Za-z0-9._-]*)/g;
const INTERCEPTION = /\.(?:route|routeFromHAR|routeWebSocket)\s*\(/;

/** Whether a repository-relative path is a file the scan reads. */
export function isSceneTestCandidate(path: string, patterns: readonly RegExp[] | null): boolean {
  if (!SCRIPT_FILE.test(path)) return false;
  return patterns ? patterns.some((pattern) => pattern.test(path)) : DEFAULT_SCENE_FILE.test(path);
}

/**
 * The screen keys a test file tags. A trailing `.` is not part of a key: it is
 * far more often the end of a sentence in a comment than the end of a key.
 */
export function screenTagsIn(content: string): string[] {
  return tagsIn(content, SCREEN_TAG);
}

/** The acceptance criteria a test file tags `@ac:<key>`, read the same way. */
export function acceptanceCriterionTagsIn(content: string): string[] {
  return tagsIn(content, AC_TAG);
}

function tagsIn(content: string, pattern: RegExp): string[] {
  const keys = new Set<string>();
  for (const match of content.matchAll(pattern)) {
    const key = match[1]!.replace(/\.+$/, "");
    if (key.length > 0) keys.add(key);
  }
  return [...keys];
}

/** Whether a test file intercepts the page's requests. */
export function interceptsRequests(content: string): boolean {
  return INTERCEPTION.test(content);
}

function listRepositoryFiles(root: string, maxBytes: number): string[] {
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, maxBuffer: maxBytes, stdio: ["ignore", "pipe", "pipe"] }
  );
  return [...new Set(output.toString("utf8").split("\0").filter(Boolean))].sort();
}

function failureDetail(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const text = Buffer.isBuffer(stderr) ? stderr.toString("utf8").trim() : "";
  return text.split("\n")[0] || (error instanceof Error ? error.message : String(error));
}

/**
 * Reads `@screen:` tags from the repository's test files: tracked files and
 * untracked files git does not ignore, filtered by `patterns` (or the default
 * naming), within the given bounds.
 */
export function scanScreenScenes(
  repositoryRoot: string,
  patterns: readonly string[] | null,
  limits: ScreenSceneScanLimits = SCREEN_SCENE_LIMITS
): ScreenSceneScan {
  const root = resolve(repositoryRoot);
  const tags = new Map<string, string[]>();
  const acTags = new Map<string, string[]>();
  const intercepting: Array<{ file: string; keys: string[] }> = [];
  let listed: string[];
  try {
    listed = listRepositoryFiles(root, limits.listedBytes);
  } catch (error) {
    return {
      status: "unavailable",
      detail: `the repository's files could not be listed with git: ${failureDetail(error)}`,
      files: 0,
      tags,
      acTags,
      intercepting,
    };
  }
  const compiled = patterns ? patterns.map(screenPathPattern) : null;
  const candidates = listed.filter((path) => isSceneTestCandidate(path, compiled));
  const skipped: string[] = [];
  let files = 0;
  let bytes = 0;
  let stoppedBy: string | null = null;
  for (const path of candidates) {
    if (files >= limits.files) {
      stoppedBy = `more than ${limits.files} candidate test files`;
      break;
    }
    const absolutePath = resolve(root, path);
    let size: number;
    try {
      const stat = lstatSync(absolutePath);
      // Deleted-but-tracked files are not tests any more, and links are not
      // followed out of the repository.
      if (!stat.isFile()) continue;
      size = stat.size;
    } catch {
      continue;
    }
    if (size > limits.fileBytes) {
      skipped.push(path);
      continue;
    }
    if (bytes + size > limits.totalBytes) {
      stoppedBy = `more than ${limits.totalBytes} bytes of candidate test files`;
      break;
    }
    let content: string;
    try {
      // Read through the bound, not only the size seen above, so a file that
      // grows in between cannot exceed it.
      content = readBoundedFile(absolutePath, limits.fileBytes, "test file").toString("utf8");
    } catch {
      skipped.push(path);
      continue;
    }
    bytes += size;
    files += 1;
    const screenKeys = screenTagsIn(content);
    for (const key of screenKeys) tags.set(key, [...(tags.get(key) ?? []), path]);
    for (const key of acceptanceCriterionTagsIn(content)) acTags.set(key, [...(acTags.get(key) ?? []), path]);
    if (screenKeys.length > 0 && interceptsRequests(content)) intercepting.push({ file: path, keys: screenKeys });
  }
  const details = [
    ...(stoppedBy ? [`the scan stopped at ${stoppedBy}`] : []),
    ...(skipped.length > 0
      ? [
          `${skipped.length} test file(s) larger than ${limits.fileBytes} bytes or unreadable were not read (${skipped
            .slice(0, 3)
            .join(", ")}${skipped.length > 3 ? ", …" : ""})`,
        ]
      : []),
  ];
  return {
    status: details.length > 0 ? "incomplete" : "complete",
    detail: details.length > 0 ? details.join("; ") : null,
    files,
    tags,
    acTags,
    intercepting,
  };
}

export const SCREEN_PAGE_LIMITS = {
  /** Most page files reported. */
  files: 10_000,
} as const;

export interface ScreenPageScan {
  /** `not_configured` when `screens.capture.pages` is empty. */
  status: "complete" | "incomplete" | "unavailable" | "not_configured";
  detail: string | null;
  /** Repository-relative page files matching the patterns, sorted. */
  files: string[];
}

/**
 * The files that define pages: tracked and untracked files git does not
 * ignore that match any pattern, minus those matching a `!` pattern.
 */
export function scanPageFiles(
  repositoryRoot: string,
  patterns: readonly string[],
  limits: { listedBytes: number; files: number } = {
    listedBytes: SCREEN_SCENE_LIMITS.listedBytes,
    files: SCREEN_PAGE_LIMITS.files,
  }
): ScreenPageScan {
  if (patterns.length === 0) return { status: "not_configured", detail: null, files: [] };
  let listed: string[];
  try {
    listed = listRepositoryFiles(resolve(repositoryRoot), limits.listedBytes);
  } catch (error) {
    return {
      status: "unavailable",
      detail: `the repository's files could not be listed with git: ${failureDetail(error)}`,
      files: [],
    };
  }
  const include = patterns.filter((pattern) => !pattern.startsWith("!")).map(screenPathPattern);
  const exclude = patterns
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => screenPathPattern(pattern.slice(1)));
  const files = listed.filter(
    (path) => include.some((pattern) => pattern.test(path)) && !exclude.some((pattern) => pattern.test(path))
  );
  return files.length > limits.files
    ? {
        status: "incomplete",
        detail: `more than ${limits.files} page files match; only the first ${limits.files} were checked`,
        files: files.slice(0, limits.files),
      }
    : { status: "complete", detail: null, files };
}
