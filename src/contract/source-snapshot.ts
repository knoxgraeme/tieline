import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import { resolve } from "node:path";
import { languageForPath, type SupportedCodeLanguage } from "./code-analysis/languages.js";
import {
  canonicalRepositoryRelativePath,
  createCachedRepositoryEntryInspection,
  repositoryEntryKindExactly,
  withinRepository,
  type RepositoryEntryInspection,
} from "./paths.js";
import type { SourceInventory } from "./source-inventory.js";

/** Standalone analysis refuses unexpectedly large source files by default. */
export const DEFAULT_MAX_SOURCE_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8_000;

export interface SourceFileMetadata {
  size: number;
  modifiedTimeMs: number;
  changedTimeMs: number;
  device: string;
  inode: string;
  mode: number;
  kind: "file" | "other";
}

export function sourceFileMetadataFromStat(stat: Stats): SourceFileMetadata {
  return {
    size: stat.size,
    modifiedTimeMs: stat.mtimeMs,
    changedTimeMs: stat.ctimeMs,
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: stat.mode,
    kind: stat.isFile() ? "file" : "other",
  };
}

export interface SourcePosition {
  /** Zero-based JavaScript string index (UTF-16 code units). */
  utf16Offset: number;
  /** Zero-based byte offset in the original UTF-8 source. */
  utf8ByteOffset: number;
  /** Zero-based line. CRLF is treated as one line ending. */
  line: number;
  /** Zero-based UTF-16 code-unit column. */
  utf16Column: number;
  /** Zero-based UTF-8 byte column. */
  utf8ByteColumn: number;
}

export interface SourceRange {
  utf16: { start: number; end: number };
  utf8Bytes: { start: number; end: number };
  start: SourcePosition;
  end: SourcePosition;
}

export interface SourceCoordinates {
  atUtf16Offset(offset: number): SourcePosition;
  atUtf8ByteOffset(offset: number): SourcePosition;
  rangeFromUtf16(start: number, end: number): SourceRange;
  rangeFromUtf8Bytes(start: number, end: number): SourceRange;
}

export interface SourceSnapshot {
  path: string;
  text: string;
  sha256: string;
  language: SupportedCodeLanguage | null;
  metadata: SourceFileMetadata;
  inventoryDigest: string | null;
  coordinates: SourceCoordinates;
  /** A defensive copy of the exact bytes used to produce every snapshot fact. */
  originalBytes(): Buffer;
}

export type SourceSnapshotFailureStatus =
  | "missing"
  | "not_file"
  | "binary"
  | "oversized"
  | "unreadable"
  | "repository_escape"
  | "changed_during_read";

export type SourceSnapshotReadResult =
  | { status: "read"; snapshot: SourceSnapshot }
  | {
      status: SourceSnapshotFailureStatus;
      path: string;
      detail: string;
      maxSourceBytes?: number;
      observedBytes?: number;
      /** Present when bytes were safely read but were not analyzable source text. */
      sha256?: string;
    };

export interface SourceSnapshotReader {
  /** Results are request-local and cached by canonical repository path. */
  read(path: string): SourceSnapshotReadResult;
}

export interface CreateFilesystemSourceSnapshotReaderOptions {
  repositoryRoot: string;
  inventory?: SourceInventory;
  maxSourceBytes?: number;
  entryInspection?: RepositoryEntryInspection;
  /** Injection seams make changed-during-read and permission failures deterministic in tests. */
  inspectFile?: (absolutePath: string) => SourceFileMetadata;
  readBytes?: (absolutePath: string) => Buffer;
  resolveRealPath?: (absolutePath: string) => string;
}

function metadataEqual(left: SourceFileMetadata, right: SourceFileMetadata): boolean {
  return (
    left.size === right.size &&
    left.modifiedTimeMs === right.modifiedTimeMs &&
    left.changedTimeMs === right.changedTimeMs &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.kind === right.kind
  );
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function failure(
  status: SourceSnapshotFailureStatus,
  path: string,
  detail: string,
  extra: { maxSourceBytes?: number; observedBytes?: number; sha256?: string } = {}
): SourceSnapshotReadResult {
  return Object.freeze({ status, path, detail, ...extra });
}

function buildCoordinates(text: string): SourceCoordinates {
  const byUtf16 = new Map<number, SourcePosition>();
  const byUtf8 = new Map<number, SourcePosition>();
  let utf16Offset = 0;
  let utf8ByteOffset = 0;
  let line = 0;
  let utf16Column = 0;
  let utf8ByteColumn = 0;

  const record = (): void => {
    const position = Object.freeze({
      utf16Offset,
      utf8ByteOffset,
      line,
      utf16Column,
      utf8ByteColumn,
    });
    byUtf16.set(utf16Offset, position);
    byUtf8.set(utf8ByteOffset, position);
  };
  record();
  while (utf16Offset < text.length) {
    const codePoint = text.codePointAt(utf16Offset)!;
    const value = String.fromCodePoint(codePoint);
    const utf16Length = value.length;
    const utf8Length = Buffer.byteLength(value);
    utf16Offset += utf16Length;
    utf8ByteOffset += utf8Length;
    if (value === "\n") {
      line += 1;
      utf16Column = 0;
      utf8ByteColumn = 0;
    } else if (value === "\r" && text[utf16Offset] !== "\n") {
      line += 1;
      utf16Column = 0;
      utf8ByteColumn = 0;
    } else {
      utf16Column += utf16Length;
      utf8ByteColumn += utf8Length;
    }
    record();
  }

  const lookup = (
    positions: ReadonlyMap<number, SourcePosition>,
    offset: number,
    coordinate: "UTF-16" | "UTF-8 byte"
  ): SourcePosition => {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new RangeError(`${coordinate} offset must be a non-negative integer`);
    }
    const position = positions.get(offset);
    if (!position) {
      throw new RangeError(
        `${coordinate} offset ${offset} is outside the source or not a Unicode code-point boundary`
      );
    }
    return position;
  };
  const range = (start: SourcePosition, end: SourcePosition): SourceRange => {
    if (end.utf16Offset < start.utf16Offset) {
      throw new RangeError("Source range end must not precede its start");
    }
    return Object.freeze({
      utf16: Object.freeze({ start: start.utf16Offset, end: end.utf16Offset }),
      utf8Bytes: Object.freeze({
        start: start.utf8ByteOffset,
        end: end.utf8ByteOffset,
      }),
      start,
      end,
    });
  };

  return Object.freeze({
    atUtf16Offset(offset: number) {
      return lookup(byUtf16, offset, "UTF-16");
    },
    atUtf8ByteOffset(offset: number) {
      return lookup(byUtf8, offset, "UTF-8 byte");
    },
    rangeFromUtf16(start: number, end: number) {
      return range(lookup(byUtf16, start, "UTF-16"), lookup(byUtf16, end, "UTF-16"));
    },
    rangeFromUtf8Bytes(start: number, end: number) {
      return range(lookup(byUtf8, start, "UTF-8 byte"), lookup(byUtf8, end, "UTF-8 byte"));
    },
  });
}

function decodeSource(bytes: Buffer): string | null {
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).indexOf(0) !== -1) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Create one request-local filesystem reader. A file is inspected before and
 * after its single byte read; a metadata change refuses the snapshot instead of
 * combining a hash or range from mixed contents.
 */
export function createFilesystemSourceSnapshotReader(
  options: CreateFilesystemSourceSnapshotReaderOptions
): SourceSnapshotReader {
  const repositoryRoot = resolve(options.repositoryRoot);
  const realRepositoryRoot = realpathSync(repositoryRoot);
  const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_SNAPSHOT_BYTES;
  if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes < 0) {
    throw new Error("maxSourceBytes must be a non-negative safe integer");
  }
  const entryInspection = createCachedRepositoryEntryInspection(options.entryInspection);
  const inspectFile =
    options.inspectFile ?? ((path: string) => sourceFileMetadataFromStat(statSync(path)));
  const readBytes = options.readBytes ?? ((path: string) => readFileSync(path));
  const resolveRealPath = options.resolveRealPath ?? ((path: string) => realpathSync(path));
  const inventoryFiles = new Map(
    (options.inventory?.files ?? []).map((file) => [file.path, file] as const)
  );
  const cache = new Map<string, SourceSnapshotReadResult>();

  return {
    read(requestedPath) {
      const canonicalPath = canonicalRepositoryRelativePath(requestedPath);
      if (!canonicalPath) {
        return failure(
          "repository_escape",
          String(requestedPath),
          "path is not a canonical repository-relative path"
        );
      }
      const cached = cache.get(canonicalPath);
      if (cached) return cached;
      const absolutePath = resolve(repositoryRoot, canonicalPath);
      let result: SourceSnapshotReadResult;
      try {
        const kind = repositoryEntryKindExactly(
          repositoryRoot,
          canonicalPath,
          entryInspection
        );
        if (kind === "missing") {
          result = failure("missing", canonicalPath, "path does not exist with this exact spelling");
        } else if (kind !== "file") {
          result = failure("not_file", canonicalPath, "path is not a regular file");
        } else {
          const realPath = resolveRealPath(absolutePath);
          if (!withinRepository(realRepositoryRoot, realPath)) {
            result = failure(
              "repository_escape",
              canonicalPath,
              "resolved path is outside the repository"
            );
          } else {
            const before = inspectFile(realPath);
            const inventoried = inventoryFiles.get(canonicalPath);
            if (before.kind !== "file") {
              result = failure("not_file", canonicalPath, "path is not a regular file");
            } else if (
              inventoried &&
              !metadataEqual(inventoried.metadata, before)
            ) {
              result = failure(
                "changed_during_read",
                canonicalPath,
                "file metadata changed after the source inventory was captured"
              );
            } else if (before.size > maxSourceBytes) {
              result = failure("oversized", canonicalPath, "source exceeds the configured byte limit", {
                maxSourceBytes,
                observedBytes: before.size,
              });
            } else {
              const bytes = Buffer.from(readBytes(realPath));
              const after = inspectFile(realPath);
              if (!metadataEqual(before, after) || bytes.length !== before.size) {
                result = failure(
                  "changed_during_read",
                  canonicalPath,
                  "file metadata or byte length changed while the source was read"
                );
              } else {
                const text = decodeSource(bytes);
                if (text === null) {
                  result = failure(
                    "binary",
                    canonicalPath,
                    "source contains NUL bytes or is not valid UTF-8",
                    { sha256: createHash("sha256").update(bytes).digest("hex") }
                  );
                } else {
                  const retainedBytes = Buffer.from(bytes);
                  const snapshot: SourceSnapshot = Object.freeze({
                    path: canonicalPath,
                    text,
                    sha256: createHash("sha256").update(retainedBytes).digest("hex"),
                    language: languageForPath(canonicalPath) ?? null,
                    metadata: Object.freeze({ ...after }),
                    inventoryDigest: inventoried
                      ? (options.inventory?.digest ?? null)
                      : null,
                    coordinates: buildCoordinates(text),
                    originalBytes: () => Buffer.from(retainedBytes),
                  });
                  result = Object.freeze({ status: "read", snapshot });
                }
              }
            }
          }
        }
      } catch (error) {
        const code = errorCode(error);
        result = failure(
          code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable",
          canonicalPath,
          error instanceof Error ? error.message : String(error)
        );
      }
      cache.set(canonicalPath, result);
      return result;
    },
  };
}
