import { createHash } from "node:crypto";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { languageForPath, type SupportedCodeLanguage } from "./code-analysis/languages.js";
import { withinRepository, wildcardPattern } from "./paths.js";
import {
  sourceFileMetadataFromStat,
  type SourceFileMetadata,
} from "./source-snapshot.js";

export type SourceInventoryFailure =
  | "missing"
  | "repository_escape"
  | "unreadable";

export class SourceInventoryError extends Error {
  constructor(
    readonly outcome: SourceInventoryFailure,
    readonly path: string,
    message: string,
    options: ErrorOptions = {}
  ) {
    super(message, options);
    this.name = "SourceInventoryError";
  }
}

export interface SourceInventoryFile {
  /** Canonical repository-relative path with `/` separators. */
  path: string;
  language: SupportedCodeLanguage | null;
  metadata: SourceFileMetadata;
}

export interface SourceInventory {
  schemaVersion: 1;
  sourceRoots: string[];
  ignore: string[];
  files: SourceInventoryFile[];
  /** Ignored paths are pruned before symlinks are resolved. */
  excludedPaths: string[];
  /** SHA-256 over normalized configuration, paths, and observed file metadata. */
  digest: string;
}

export interface CreateSourceInventoryOptions {
  repositoryRoot: string;
  sourceRoots: string[];
  ignore?: string[];
}

/** Normalize a repository-derived path for stable identities and output. */
export function normalizeInventoryPath(path: string): string {
  return path.split(sep).join("/").normalize("NFC").replace(/^\.\//, "");
}

function normalizePattern(pattern: string): string {
  return normalizeInventoryPath(pattern.trim())
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
}

export function sourcePathIgnored(path: string, patterns: readonly string[]): boolean {
  const normalized = normalizeInventoryPath(path).replace(/^\.\//, "");
  return patterns.some((entry) => {
    const pattern = normalizePattern(entry);
    return pattern.length > 0 && wildcardPattern(pattern).test(normalized);
  });
}

function withinSourceRoot(path: string, sourceRoot: string): boolean {
  const root = normalizePattern(sourceRoot);
  if (root === "" || root === ".") return true;
  return path === root || path.startsWith(`${root}/`);
}

export interface SourceFileEligibility {
  sourceRoots: string[];
  ignore?: string[];
}

/** Path-only eligibility also works for deleted or renamed-away files. */
export function isSourceInventoryPathEligible(
  path: string,
  options: SourceFileEligibility
): boolean {
  const normalized = normalizeInventoryPath(path).replace(/\/+$/, "");
  if (!normalized) return false;
  if (!options.sourceRoots.some((root) => withinSourceRoot(normalized, root))) {
    return false;
  }
  return !sourcePathIgnored(normalized, options.ignore ?? []);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function inventoryError(
  outcome: SourceInventoryFailure,
  path: string,
  detail: string,
  cause?: unknown
): SourceInventoryError {
  return new SourceInventoryError(
    outcome,
    path,
    `Cannot inventory repository path '${path}': ${detail}`,
    cause === undefined ? {} : { cause }
  );
}

function stableDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

interface WalkState {
  repositoryRoot: string;
  patterns: readonly string[];
  excluded: Set<string>;
  visitedDirectories: Set<string>;
  files: Map<string, SourceInventoryFile>;
}

function walk(path: string, state: WalkState): void {
  const repositoryPath = normalizeInventoryPath(relative(state.repositoryRoot, path));
  if (repositoryPath && sourcePathIgnored(repositoryPath, state.patterns)) {
    state.excluded.add(repositoryPath);
    return;
  }

  let realPath: string;
  try {
    realPath = realpathSync(path);
  } catch (error) {
    const outcome = errorCode(error) === "ENOENT" ? "missing" : "unreadable";
    throw inventoryError(outcome, repositoryPath || path, String(error), error);
  }
  if (!withinRepository(state.repositoryRoot, realPath)) {
    throw inventoryError(
      "repository_escape",
      repositoryPath || path,
      "the resolved path is outside the repository"
    );
  }

  let stat;
  try {
    stat = statSync(realPath);
  } catch (error) {
    throw inventoryError("unreadable", repositoryPath || path, String(error), error);
  }
  if (stat.isFile()) {
    const canonicalPath = normalizeInventoryPath(relative(state.repositoryRoot, realPath));
    state.files.set(canonicalPath, {
      path: canonicalPath,
      language: languageForPath(canonicalPath) ?? null,
      metadata: sourceFileMetadataFromStat(stat),
    });
    return;
  }
  if (!stat.isDirectory() || state.visitedDirectories.has(realPath)) return;
  state.visitedDirectories.add(realPath);

  let entries;
  try {
    entries = readdirSync(realPath, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name)
    );
  } catch (error) {
    throw inventoryError("unreadable", repositoryPath || path, String(error), error);
  }
  for (const entry of entries) walk(resolve(realPath, entry.name), state);
}

/**
 * Build one deterministic, metadata-only view of eligible repository files.
 * Source bytes are intentionally read by `SourceSnapshotReader`, once per file.
 */
export function createSourceInventory(options: CreateSourceInventoryOptions): SourceInventory {
  const requestedRoot = resolve(options.repositoryRoot);
  let repositoryRoot: string;
  try {
    repositoryRoot = realpathSync(requestedRoot);
  } catch (error) {
    throw inventoryError(
      errorCode(error) === "ENOENT" ? "missing" : "unreadable",
      requestedRoot,
      String(error),
      error
    );
  }
  const patterns = options.ignore ?? [];
  const state: WalkState = {
    repositoryRoot,
    patterns,
    excluded: new Set(),
    visitedDirectories: new Set(),
    files: new Map(),
  };

  for (const configuredRoot of options.sourceRoots) {
    const sourceRoot = resolve(repositoryRoot, configuredRoot);
    if (!withinRepository(repositoryRoot, sourceRoot)) {
      throw inventoryError(
        "repository_escape",
        configuredRoot,
        "the configured source root escapes the repository"
      );
    }
    if (!existsSync(sourceRoot)) {
      throw inventoryError("missing", configuredRoot, "the configured source root does not exist");
    }
    walk(sourceRoot, state);
  }

  const files = [...state.files.values()].sort((left, right) =>
    left.path.localeCompare(right.path)
  );
  const sourceRoots = options.sourceRoots.map(normalizeInventoryPath);
  const ignore = patterns.map(normalizePattern);
  const excludedPaths = [...state.excluded].sort((left, right) =>
    left.localeCompare(right)
  );
  const digest = stableDigest({
    schemaVersion: 1,
    sourceRoots,
    ignore,
    files,
  });
  return Object.freeze({
    schemaVersion: 1 as const,
    sourceRoots: Object.freeze([...sourceRoots]) as unknown as string[],
    ignore: Object.freeze([...ignore]) as unknown as string[],
    files: Object.freeze(
      files.map((file) =>
        Object.freeze({ ...file, metadata: Object.freeze({ ...file.metadata }) })
      )
    ) as unknown as SourceInventoryFile[],
    excludedPaths: Object.freeze([...excludedPaths]) as unknown as string[],
    digest,
  });
}
