import { createHash } from "node:crypto";
import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
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
const HASH_CHUNK_BYTES = 64 * 1024;

function hashFileStreaming(
  path: string,
  expectedBytes: number
): { sha256: string; observedBytes: number } {
  const digest = createHash("sha256");
  const chunk = Buffer.allocUnsafe(Math.min(HASH_CHUNK_BYTES, expectedBytes));
  const descriptor = openSync(path, "r");
  let observedBytes = 0;
  try {
    while (observedBytes < expectedBytes) {
      const bytesRead = readSync(
        descriptor,
        chunk,
        0,
        Math.min(chunk.length, expectedBytes - observedBytes),
        observedBytes
      );
      if (bytesRead === 0) break;
      digest.update(chunk.subarray(0, bytesRead));
      observedBytes += bytesRead;
    }
  } finally {
    closeSync(descriptor);
  }
  return { sha256: digest.digest("hex"), observedBytes };
}

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
  /** Allows bounded callers to release source bytes after compact fact extraction. */
  release?(path: string): void;
  dispose?(): void;
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
  const lineUtf16Starts = [0];
  const lineUtf8Starts = [0];
  let utf16Offset = 0;
  let utf8ByteOffset = 0;
  while (utf16Offset < text.length) {
    const codeUnit = text.charCodeAt(utf16Offset);
    const pairedSurrogate =
      codeUnit >= 0xd800 && codeUnit <= 0xdbff &&
      text.charCodeAt(utf16Offset + 1) >= 0xdc00 &&
      text.charCodeAt(utf16Offset + 1) <= 0xdfff;
    const utf16Length = pairedSurrogate ? 2 : 1;
    const utf8Length = pairedSurrogate
      ? 4
      : codeUnit <= 0x7f
        ? 1
        : codeUnit <= 0x7ff
          ? 2
          : 3;
    utf16Offset += utf16Length;
    utf8ByteOffset += utf8Length;
    if (
      codeUnit === 0x0a ||
      (codeUnit === 0x0d && text.charCodeAt(utf16Offset) !== 0x0a)
    ) {
      lineUtf16Starts.push(utf16Offset);
      lineUtf8Starts.push(utf8ByteOffset);
    }
  }

  const lineForOffset = (starts: readonly number[], offset: number): number => {
    let low = 0;
    let high = starts.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (starts[middle]! <= offset) low = middle;
      else high = middle;
    }
    return low;
  };

  const validateOffset = (
    offset: number,
    maximum: number,
    coordinate: "UTF-16" | "UTF-8 byte"
  ): void => {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new RangeError(`${coordinate} offset must be a non-negative integer`);
    }
    if (offset > maximum) {
      throw new RangeError(
        `${coordinate} offset ${offset} is outside the source or not a Unicode code-point boundary`
      );
    }
  };

  const atUtf16Offset = (offset: number): SourcePosition => {
    validateOffset(offset, text.length, "UTF-16");
    const line = lineForOffset(lineUtf16Starts, offset);
    const current = text.charCodeAt(offset);
    const previous = text.charCodeAt(offset - 1);
    if (
      current >= 0xdc00 && current <= 0xdfff &&
      previous >= 0xd800 && previous <= 0xdbff
    ) {
      throw new RangeError(
        `UTF-16 offset ${offset} is outside the source or not a Unicode code-point boundary`
      );
    }
    const lineUtf16Start = lineUtf16Starts[line]!;
    const lineUtf8Start = lineUtf8Starts[line]!;
    const cursor8 = lineUtf8Start + Buffer.byteLength(text.slice(lineUtf16Start, offset));
    return Object.freeze({
      utf16Offset: offset,
      utf8ByteOffset: cursor8,
      line,
      utf16Column: offset - lineUtf16Start,
      utf8ByteColumn: cursor8 - lineUtf8Start,
    });
  };

  const atUtf8ByteOffset = (offset: number): SourcePosition => {
    validateOffset(offset, utf8ByteOffset, "UTF-8 byte");
    const line = lineForOffset(lineUtf8Starts, offset);
    let cursor16 = lineUtf16Starts[line]!;
    let cursor8 = lineUtf8Starts[line]!;
    while (cursor8 < offset) {
      const codeUnit = text.charCodeAt(cursor16);
      const pairedSurrogate =
        codeUnit >= 0xd800 && codeUnit <= 0xdbff &&
        text.charCodeAt(cursor16 + 1) >= 0xdc00 &&
        text.charCodeAt(cursor16 + 1) <= 0xdfff;
      const utf16Length = pairedSurrogate ? 2 : 1;
      const bytes = pairedSurrogate
        ? 4
        : codeUnit <= 0x7f
          ? 1
          : codeUnit <= 0x7ff
            ? 2
            : 3;
      if (cursor8 + bytes > offset) {
        throw new RangeError(
          `UTF-8 byte offset ${offset} is outside the source or not a Unicode code-point boundary`
        );
      }
      cursor16 += utf16Length;
      cursor8 += bytes;
    }
    return Object.freeze({
      utf16Offset: cursor16,
      utf8ByteOffset: cursor8,
      line,
      utf16Column: cursor16 - lineUtf16Starts[line]!,
      utf8ByteColumn: cursor8 - lineUtf8Starts[line]!,
    });
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
      return atUtf16Offset(offset);
    },
    atUtf8ByteOffset(offset: number) {
      return atUtf8ByteOffset(offset);
    },
    rangeFromUtf16(start: number, end: number) {
      return range(atUtf16Offset(start), atUtf16Offset(end));
    },
    rangeFromUtf8Bytes(start: number, end: number) {
      return range(atUtf8ByteOffset(start), atUtf8ByteOffset(end));
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

export interface CreateSourceSnapshotFromBytesOptions {
  path: string;
  bytes: Buffer;
  metadata: SourceFileMetadata;
  inventoryDigest?: string | null;
  /** Trusted internal buffers can avoid a second retained source copy. */
  copyBytes?: boolean;
}

/**
 * Build the shared immutable snapshot shape from bytes supplied by a source
 * other than the working filesystem (for example, a Git object database).
 */
export function createSourceSnapshotFromBytes(
  options: CreateSourceSnapshotFromBytesOptions
): SourceSnapshotReadResult {
  const canonicalPath = canonicalRepositoryRelativePath(options.path);
  if (!canonicalPath) {
    return failure(
      "repository_escape",
      String(options.path),
      "path is not a canonical repository-relative path"
    );
  }
  const retainedBytes =
    options.copyBytes === false ? options.bytes : Buffer.from(options.bytes);
  const sha256 = createHash("sha256").update(retainedBytes).digest("hex");
  const text = decodeSource(retainedBytes);
  if (text === null) {
    return failure(
      "binary",
      canonicalPath,
      "source contains NUL bytes or is not valid UTF-8",
      { sha256 }
    );
  }
  let coordinates: SourceCoordinates | undefined;
  const snapshot: SourceSnapshot = Object.freeze({
    path: canonicalPath,
    text,
    sha256,
    language: languageForPath(canonicalPath) ?? null,
    metadata: Object.freeze({ ...options.metadata }),
    inventoryDigest: options.inventoryDigest ?? null,
    get coordinates() {
      return (coordinates ??= buildCoordinates(text));
    },
    originalBytes: () => Buffer.from(retainedBytes),
  });
  return Object.freeze({ status: "read", snapshot });
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

  let disposed = false;
  return {
    read(requestedPath) {
      if (disposed) throw new Error("Source snapshot reader has been disposed");
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
              const streamed = hashFileStreaming(realPath, before.size);
              const after = inspectFile(realPath);
              if (
                !metadataEqual(before, after) ||
                streamed.observedBytes !== before.size
              ) {
                result = failure(
                  "changed_during_read",
                  canonicalPath,
                  "file metadata or byte length changed while the source was hashed"
                );
              } else {
                result = failure(
                  "oversized",
                  canonicalPath,
                  "source exceeds the configured byte limit",
                  {
                    maxSourceBytes,
                    observedBytes: streamed.observedBytes,
                    sha256: streamed.sha256,
                  }
                );
              }
            } else {
              const retainedBytes = Buffer.from(readBytes(realPath));
              const after = inspectFile(realPath);
              if (
                !metadataEqual(before, after) ||
                retainedBytes.length !== before.size
              ) {
                result = failure(
                  "changed_during_read",
                  canonicalPath,
                  "file metadata or byte length changed while the source was read"
                );
              } else {
                const text = decodeSource(retainedBytes);
                if (text === null) {
                  result = failure(
                    "binary",
                    canonicalPath,
                    "source contains NUL bytes or is not valid UTF-8",
                    {
                      sha256: createHash("sha256")
                        .update(retainedBytes)
                        .digest("hex"),
                    }
                  );
                } else {
                  let coordinates: SourceCoordinates | undefined;
                  const snapshot: SourceSnapshot = Object.freeze({
                    path: canonicalPath,
                    text,
                    sha256: createHash("sha256").update(retainedBytes).digest("hex"),
                    language: languageForPath(canonicalPath) ?? null,
                    metadata: Object.freeze({ ...after }),
                    inventoryDigest: inventoried
                      ? (options.inventory?.digest ?? null)
                      : null,
                    get coordinates() {
                      return (coordinates ??= buildCoordinates(text));
                    },
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
    release(requestedPath) {
      const canonicalPath = canonicalRepositoryRelativePath(requestedPath);
      if (canonicalPath) cache.delete(canonicalPath);
    },
    dispose() {
      disposed = true;
      cache.clear();
    },
  };
}
