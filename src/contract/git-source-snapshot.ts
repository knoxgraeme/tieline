import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { languageForPath } from "./code-analysis/languages.js";
import {
  isSourceInventoryPathEligible,
  normalizeInventoryPath,
  sourcePathIgnored,
  type SourceInventory,
  type SourceInventoryFile,
} from "./source-inventory.js";
import {
  createSourceSnapshotFromBytes,
  type SourceFileMetadata,
  type SourceSnapshotReadResult,
  type SourceSnapshotReader,
} from "./source-snapshot.js";

const CONFIGURATION_PATHS = new Set([
  "Cargo.toml",
  "jsconfig.json",
  "pyproject.toml",
  "tsconfig.json",
]);
const MAX_TOPOLOGY_SOURCE_BYTES = 50 * 1024 * 1024;
const MAX_TOPOLOGY_FILE_BYTES = 2 * 1024 * 1024;

interface GitTreeEntry {
  mode: string;
  object: string;
  path: string;
  size: number;
}

export interface GitSourceSnapshotCollection {
  kind: "committed";
  /** Exact tree object whose blobs supplied this collection. */
  revision: string;
  inventory: SourceInventory;
  reader: SourceSnapshotReader;
  dispose(): void;
}

export interface CreateGitSourceSnapshotCollectionOptions {
  repositoryRoot: string;
  revision: string;
  sourceRoots: string[];
  ignore?: string[];
  maxSourceBytes?: number;
  maxTotalSourceBytes?: number;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function git(repositoryRoot: string, args: string[], input?: string): Buffer {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function resolveTreeIdentity(repositoryRoot: string, revision: string): string {
  const tree = git(repositoryRoot, ["rev-parse", `${revision}^{tree}`])
    .toString("utf8")
    .trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree)) {
    throw new Error(`Git revision '${revision}' did not resolve to a full tree object identity.`);
  }
  return tree;
}

function selectedPath(
  path: string,
  sourceRoots: readonly string[],
  ignore: readonly string[]
): boolean {
  if (sourcePathIgnored(path, ignore)) return false;
  return (
    CONFIGURATION_PATHS.has(path) ||
    (languageForPath(path) !== undefined &&
      isSourceInventoryPathEligible(path, {
        sourceRoots: [...sourceRoots],
        ignore: [...ignore],
      }))
  );
}

/** Inventory once with `ls-tree -rz`; no worktree metadata participates. */
function listTree(
  repositoryRoot: string,
  treeIdentity: string,
  sourceRoots: readonly string[],
  ignore: readonly string[]
): GitTreeEntry[] {
  const output = git(repositoryRoot, ["ls-tree", "-rz", "--full-tree", "-l", treeIdentity]);
  const entries: GitTreeEntry[] = [];
  for (const raw of output.toString("utf8").split("\0")) {
    if (!raw) continue;
    const match = raw.match(/^([0-7]{6}) blob ([a-f0-9]+)\s+(\d+)\t(.+)$/s);
    if (!match || !match[1]!.startsWith("100")) continue;
    const path = normalizeInventoryPath(match[4]!);
    if (!selectedPath(path, sourceRoots, ignore)) continue;
    entries.push({
      mode: match[1]!,
      object: match[2]!,
      size: Number(match[3]),
      path,
    });
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Read every selected historical blob through one `cat-file --batch` process.
 * The aggregate is rejected above 50 MiB. Each blob gets one independent
 * buffer so releasing a parsed file also releases its backing batch memory.
 */
function readBlobs(repositoryRoot: string, entries: readonly GitTreeEntry[]): Map<string, Buffer> {
  if (entries.length === 0) return new Map();
  const objects = [...new Set(entries.map((entry) => entry.object))];
  const output = git(repositoryRoot, ["cat-file", "--batch"], `${objects.join("\n")}\n`);
  const blobs = new Map<string, Buffer>();
  let offset = 0;
  for (const expected of objects) {
    const newline = output.indexOf(0x0a, offset);
    if (newline < 0) throw new Error(`Git batch output ended before '${expected}'.`);
    const header = output.subarray(offset, newline).toString("utf8");
    const match = header.match(/^([a-f0-9]+) blob (\d+)$/);
    if (!match || match[1] !== expected) {
      throw new Error(`Unexpected Git batch response '${header}' for '${expected}'.`);
    }
    const size = Number(match[2]);
    const start = newline + 1;
    const end = start + size;
    if (end >= output.length || output[end] !== 0x0a) {
      throw new Error(`Truncated Git blob '${expected}'.`);
    }
    blobs.set(expected, Buffer.from(output.subarray(start, end)));
    offset = end + 1;
  }
  return blobs;
}

function metadata(entry: GitTreeEntry): SourceFileMetadata {
  return Object.freeze({
    size: entry.size,
    modifiedTimeMs: 0,
    changedTimeMs: 0,
    device: "git",
    inode: entry.object,
    mode: Number.parseInt(entry.mode, 8),
    kind: "file" as const,
  });
}

export function createGitSourceSnapshotCollection(
  options: CreateGitSourceSnapshotCollectionOptions
): GitSourceSnapshotCollection {
  const sourceRoots = options.sourceRoots.map(normalizeInventoryPath);
  const ignore = (options.ignore ?? []).map(normalizeInventoryPath);
  const revision = resolveTreeIdentity(options.repositoryRoot, options.revision);
  const entries = listTree(
    options.repositoryRoot,
    revision,
    sourceRoots,
    ignore
  );
  const maxSourceBytes = Math.min(
    options.maxSourceBytes ?? MAX_TOPOLOGY_FILE_BYTES,
    MAX_TOPOLOGY_FILE_BYTES
  );
  const maxTotalSourceBytes = Math.min(
    options.maxTotalSourceBytes ?? MAX_TOPOLOGY_SOURCE_BYTES,
    MAX_TOPOLOGY_SOURCE_BYTES
  );
  const oversized = entries.find((entry) => entry.size > maxSourceBytes);
  if (oversized) {
    throw new Error(
      `Git source '${oversized.path}' exceeds the ${maxSourceBytes}-byte file limit.`
    );
  }
  const totalBytes = entries.reduce((total, entry) => total + entry.size, 0);
  if (totalBytes > maxTotalSourceBytes) {
    throw new Error(
      `Git source inventory exceeds the ${maxTotalSourceBytes}-byte repository limit.`
    );
  }
  const inventoryDigest = digest({
    schemaVersion: 1,
    sourceRoots,
    ignore,
    files: entries.map(({ path, object, mode, size }) => ({ path, object, mode, size })),
  });
  const files: SourceInventoryFile[] = entries.map((entry) => ({
    path: entry.path,
    language: languageForPath(entry.path) ?? null,
    metadata: metadata(entry),
  }));
  const inventory: SourceInventory = Object.freeze({
    schemaVersion: 1,
    sourceRoots: Object.freeze(sourceRoots),
    ignore: Object.freeze(ignore),
    files: Object.freeze(files.map((file) => Object.freeze(file))),
    excludedPaths: Object.freeze([]),
    digest: inventoryDigest,
  });
  const blobs = readBlobs(options.repositoryRoot, entries);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const remainingPathsByObject = new Map<string, number>();
  for (const entry of entries) {
    remainingPathsByObject.set(
      entry.object,
      (remainingPathsByObject.get(entry.object) ?? 0) + 1
    );
  }
  const cache = new Map<string, SourceSnapshotReadResult>();
  let disposed = false;
  const reader: SourceSnapshotReader = {
    read(path) {
      if (disposed) throw new Error("Git source snapshot collection has been disposed.");
      const normalized = normalizeInventoryPath(path);
      const cached = cache.get(normalized);
      if (cached) return cached;
      const entry = byPath.get(normalized);
      const bytes = entry ? blobs.get(entry.object) : undefined;
      const result: SourceSnapshotReadResult = !entry || !bytes
        ? Object.freeze({
            status: "missing" as const,
            path: normalized,
            detail: `Path '${normalized}' is absent from Git tree '${revision}'.`,
          })
        : createSourceSnapshotFromBytes({
            path: normalized,
            bytes,
            metadata: metadata(entry),
            inventoryDigest,
            copyBytes: false,
          });
      cache.set(normalized, result);
      return result;
    },
    release(path) {
      const normalized = normalizeInventoryPath(path);
      cache.delete(normalized);
      const entry = byPath.get(normalized);
      if (!entry) return;
      byPath.delete(normalized);
      const remaining = (remainingPathsByObject.get(entry.object) ?? 1) - 1;
      if (remaining <= 0) {
        remainingPathsByObject.delete(entry.object);
        blobs.delete(entry.object);
      } else {
        remainingPathsByObject.set(entry.object, remaining);
      }
    },
    dispose() {
      disposed = true;
      cache.clear();
      blobs.clear();
      byPath.clear();
      remainingPathsByObject.clear();
    },
  };
  return {
    kind: "committed",
    revision,
    inventory,
    reader,
    dispose() {
      reader.dispose?.();
    },
  };
}
