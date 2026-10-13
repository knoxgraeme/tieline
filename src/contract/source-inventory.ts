import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, posix, relative, resolve, sep } from "node:path";
import { compareCodeTopologyText } from "../domain/code-topology-ordering.js";
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
  sourceRoots: readonly string[];
  ignore: readonly string[];
  files: readonly SourceInventoryFile[];
  /** Ignored paths are pruned before symlinks are resolved. */
  excludedPaths: readonly string[];
  /** SHA-256 over normalized configuration, paths, and observed file metadata. */
  digest: string;
}

export interface CreateSourceInventoryOptions {
  repositoryRoot: string;
  sourceRoots: string[];
  ignore?: string[];
  /**
   * Select only what a Git tree records as files: skip symbolic links and
   * nested Git work trees instead of following them. Topology uses this so a
   * working tree and the commit holding the same bytes select the same paths.
   */
  gitTreeEntriesOnly?: boolean;
}

/** Normalize a repository-derived path for stable identities and output. */
export function normalizeInventoryPath(path: string): string {
  return path.split(sep).join("/").normalize("NFC").replace(/^\.\//, "");
}

/**
 * One spelling per source root (`src/.`, `src//`, and `src/../src` all mean
 * `src`), so working-tree walks and Git path matching select the same files.
 */
export function canonicalSourceRoot(root: string): string {
  const normalized = posix.normalize(normalizeInventoryPath(root.trim())).replace(/\/+$/, "");
  return normalized === "" ? "." : normalized;
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

/**
 * Git records a directory as a nested repository (a link, not files) only when
 * its `.git` is a `gitdir:` file or a directory with the repository layout.
 */
function nestedGitWorkTree(directory: string): boolean {
  const marker = join(directory, ".git");
  let stat;
  try {
    // Follow a linked `.git`: Git still records the directory as a repository.
    stat = statSync(marker);
  } catch {
    return false;
  }
  if (stat.isFile()) {
    if (stat.size >= 4_096) return false;
    // Git ignores a stale pointer, such as a copied submodule checkout.
    const pointer = readFileSync(marker, "utf8").match(/^gitdir: *(.+?)\s*$/m);
    return pointer !== null && validGitHead(join(resolve(directory, pointer[1]!), "HEAD"));
  }
  return stat.isDirectory() &&
    existsSync(join(marker, "objects")) &&
    existsSync(join(marker, "refs")) &&
    validGitHead(join(marker, "HEAD"));
}

/** Git ignores a `.git` directory whose HEAD is neither a ref nor an object id. */
function validGitHead(path: string): boolean {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 4_096) return false;
    const head = readFileSync(path, "utf8").trim();
    return /^ref: refs\/\S+$/.test(head) || /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head);
  } catch {
    return false;
  }
}

/** A Git tree has no entries below a symbolic link or nested repository. */
function gitTreeReachable(repositoryRoot: string, sourceRoot: string): boolean {
  const parts = relative(repositoryRoot, sourceRoot).split(sep).filter(Boolean);
  let current = repositoryRoot;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    if (part === ".git" || lstatSync(current).isSymbolicLink() || nestedGitWorkTree(current)) {
      return false;
    }
  }
  return true;
}

interface WalkState {
  repositoryRoot: string;
  gitTreeEntriesOnly: boolean;
  ignoredPatterns: readonly RegExp[];
  excluded: Set<string>;
  visitedDirectories: Set<string>;
  files: Map<string, SourceInventoryFile>;
}

function walk(path: string, state: WalkState): void {
  const repositoryPath = normalizeInventoryPath(relative(state.repositoryRoot, path));
  if (
    repositoryPath &&
    state.ignoredPatterns.some((pattern) => pattern.test(repositoryPath))
  ) {
    state.excluded.add(repositoryPath);
    return;
  }
  if (state.gitTreeEntriesOnly) {
    if (basename(path) === ".git") return;
    let link;
    try {
      link = lstatSync(path);
    } catch (error) {
      const outcome = errorCode(error) === "ENOENT" ? "missing" : "unreadable";
      throw inventoryError(outcome, repositoryPath || path, String(error), error);
    }
    if (link.isSymbolicLink()) return;
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
  if (
    state.gitTreeEntriesOnly &&
    realPath !== state.repositoryRoot &&
    nestedGitWorkTree(realPath)
  ) {
    return;
  }
  state.visitedDirectories.add(realPath);

  let entries;
  try {
    entries = readdirSync(realPath, { withFileTypes: true }).sort((left, right) =>
      compareCodeTopologyText(left.name, right.name)
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
    gitTreeEntriesOnly: options.gitTreeEntriesOnly ?? false,
    ignoredPatterns: patterns
      .map(normalizePattern)
      .filter((pattern) => pattern.length > 0)
      .map(wildcardPattern),
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
      throw inventoryError(
        "missing",
        configuredRoot,
        "the configured source root does not exist"
      );
    }
    if (state.gitTreeEntriesOnly && !gitTreeReachable(repositoryRoot, sourceRoot)) continue;
    walk(sourceRoot, state);
  }

  const files = [...state.files.values()].sort((left, right) =>
    compareCodeTopologyText(left.path, right.path)
  );
  const sourceRoots = options.sourceRoots.map(normalizeInventoryPath);
  const ignore = patterns.map(normalizePattern);
  const excludedPaths = [...state.excluded].sort(compareCodeTopologyText);
  const digest = stableDigest({
    schemaVersion: 1,
    sourceRoots,
    ignore,
    files,
  });
  return Object.freeze({
    schemaVersion: 1 as const,
    sourceRoots: Object.freeze([...sourceRoots]),
    ignore: Object.freeze([...ignore]),
    files: Object.freeze(
      files.map((file) =>
        Object.freeze({ ...file, metadata: Object.freeze({ ...file.metadata }) })
      )
    ),
    excludedPaths: Object.freeze([...excludedPaths]),
    digest,
  });
}
