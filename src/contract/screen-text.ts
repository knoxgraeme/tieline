import { createHash } from "node:crypto";
import { existsSync, lstatSync, opendirSync, type Dirent } from "node:fs";
import { resolve } from "node:path";
import { stableKeySchema } from "./schema.js";
import { SCREEN_LIMITS, type ScreenSettings } from "./screen-catalog.js";
import { readBoundedFile } from "./screen-import.js";

/**
 * Committed ARIA snapshots: one `<key>.yml` per captured screen in the text
 * directory (`.tieline/screen-text/` by default). They put copy and structure
 * changes into the reviewed diff line by line, independent of pixels. They live
 * beside the catalog rather than inside it, because the catalog loader reads
 * every YAML file under the catalog directory as a catalog document.
 */

export const SCREEN_TEXT_LIMITS = {
  /** Largest ARIA snapshot Tieline reads or writes. */
  fileBytes: 1024 * 1024,
  /** Most snapshot files read from the directory: one per screen, plus strays. */
  files: SCREEN_LIMITS.screens * 2,
  /** Most directory entries examined, snapshots or not. */
  entries: SCREEN_LIMITS.screens * 4,
} as const;

export const SCREEN_TEXT_EXTENSION = ".yml";

export interface ScreenTextFile {
  absolutePath: string;
  /** Repository-relative, `/`-separated. */
  path: string;
}

/** Where a screen's ARIA snapshot is committed. */
export function screenTextFile(settings: ScreenSettings, key: string): ScreenTextFile {
  const name = `${key}${SCREEN_TEXT_EXTENSION}`;
  return {
    absolutePath: resolve(settings.textDirectory, name),
    path: `${settings.textPath}/${name}`,
  };
}

/**
 * The digest a capture record stores for an ARIA snapshot. Line endings are
 * normalized first, so a checkout that converts them (`core.autocrlf`) does not
 * read as a changed snapshot.
 */
export function screenTextDigest(content: string): string {
  return createHash("sha256").update(content.replace(/\r\n/g, "\n")).digest("hex");
}

export interface ScreenTextDirectory {
  /** Snapshot digests by screen key. */
  digests: ReadonlyMap<string, string>;
  /** Snapshot files that could not be read, or are not named `<key>.yml`. */
  issues: string[];
  /** False when the directory held more snapshot files than Tieline reads. */
  complete: boolean;
}

/**
 * Reads the digest of every committed ARIA snapshot. A missing directory is an
 * empty one: nothing has been captured yet. Only `.yml` files are snapshots;
 * other files are left alone. A snapshot that is a symbolic link, too large, or
 * not UTF-8 is reported rather than followed or read.
 */
export function readScreenTextDirectory(
  settings: ScreenSettings,
  limits: { fileBytes: number; files: number; entries: number } = SCREEN_TEXT_LIMITS
): ScreenTextDirectory {
  const digests = new Map<string, string>();
  const issues: string[] = [];
  const directory = settings.textDirectory;
  if (!existsSync(directory)) return { digests, issues, complete: true };
  if (!lstatSync(directory).isDirectory()) {
    return {
      digests,
      issues: [`${settings.textPath} is not a directory`],
      complete: false,
    };
  }
  // Entries are read one at a time and counted as they are read, so a
  // directory with millions of entries is never listed into memory at once.
  const names: string[] = [];
  let entries = 0;
  let stoppedBy: string | null = null;
  const handle = opendirSync(directory);
  try {
    let entry: Dirent | null;
    while ((entry = handle.readSync()) !== null) {
      entries += 1;
      if (entries > limits.entries) {
        stoppedBy = `more than ${limits.entries} entries`;
        break;
      }
      if (!entry.name.endsWith(SCREEN_TEXT_EXTENSION)) continue;
      if (names.length >= limits.files) {
        stoppedBy = `more than ${limits.files} ARIA snapshot files`;
        break;
      }
      names.push(entry.name);
    }
  } finally {
    handle.closeSync();
  }
  names.sort((left, right) => left.localeCompare(right));
  const complete = stoppedBy === null;
  if (stoppedBy) {
    issues.push(`${settings.textPath} holds ${stoppedBy}; only the first ${names.length} snapshot files were read`);
  }
  for (const name of names) {
    const key = name.slice(0, -SCREEN_TEXT_EXTENSION.length);
    const path = `${settings.textPath}/${name}`;
    if (!stableKeySchema.safeParse(key).success || key !== key.trim()) {
      issues.push(`${path}: the file name is not a screen key`);
      continue;
    }
    const absolutePath = resolve(directory, name);
    if (!lstatSync(absolutePath).isFile()) {
      issues.push(`${path}: not a regular file`);
      continue;
    }
    try {
      const bytes = readBoundedFile(absolutePath, limits.fileBytes, "ARIA snapshot");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      digests.set(key, screenTextDigest(text));
    } catch (error) {
      issues.push(
        `${path}: ${error instanceof TypeError ? "not valid UTF-8" : error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return { digests, issues, complete };
}
