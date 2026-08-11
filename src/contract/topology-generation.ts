import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type CodeTopologyStore,
  type CommitCodeTopologyGenerationResult,
  type CompleteCodeTopologyGeneration,
  type StoredCodeTopologyGeneration,
} from "../domain/code-topology-store.js";
import {
  buildCodeTopologyGeneration,
  type TopologyGenerationBuildResult,
  type TopologyReadModelBuildResult,
  type TopologySourceCollection,
} from "./code-topology-indexer.js";
import { createGitSourceSnapshotCollection } from "./git-source-snapshot.js";
import {
  createSourceInventory,
  normalizeInventoryPath,
  sourcePathIgnored,
  type SourceInventory,
} from "./source-inventory.js";
import {
  createFilesystemSourceSnapshotReader,
  sourceFileMetadataFromStat,
} from "./source-snapshot.js";

const CONFIGURATION_PATHS = [
  "Cargo.toml",
  "jsconfig.json",
  "pyproject.toml",
  "tsconfig.json",
] as const;

export interface TopologyGenerationSourceOptions {
  repositoryRoot: string;
  repository: string;
  sourceRoots: string[];
  ignore?: string[];
  maxFiles?: number;
  maxSourceBytes?: number;
  maxTotalSourceBytes?: number;
  maxSymbols?: number;
  maxEdges?: number;
  parserConcurrency?: number;
}

export interface BuildCommittedTopologyGenerationOptions
  extends TopologyGenerationSourceOptions {
  revision: string;
}

export interface BuildWorkspaceTopologyGenerationOptions
  extends TopologyGenerationSourceOptions {
  /** Test seam invoked after a build but before the consistency re-inventory. */
  afterBuildAttempt?: (attempt: number) => void | Promise<void>;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function workspaceInventory(options: TopologyGenerationSourceOptions): SourceInventory {
  const base = createSourceInventory({
    repositoryRoot: options.repositoryRoot,
    sourceRoots: options.sourceRoots,
    ignore: options.ignore,
  });
  const byPath = new Map(base.files.map((file) => [file.path, file]));
  for (const path of CONFIGURATION_PATHS) {
    if (byPath.has(path) || sourcePathIgnored(path, options.ignore ?? [])) continue;
    const absolute = resolve(options.repositoryRoot, path);
    if (!existsSync(absolute)) continue;
    const metadata = sourceFileMetadataFromStat(statSync(absolute));
    if (metadata.kind !== "file") continue;
    byPath.set(path, { path, language: null, metadata });
  }
  const files = [...byPath.values()].sort((left, right) =>
    left.path.localeCompare(right.path)
  );
  const sourceRoots = options.sourceRoots.map(normalizeInventoryPath);
  const ignore = (options.ignore ?? []).map(normalizeInventoryPath);
  return Object.freeze({
    schemaVersion: 1 as const,
    sourceRoots: Object.freeze(sourceRoots),
    ignore: Object.freeze(ignore),
    files: Object.freeze(files.map((file) => Object.freeze(file))),
    excludedPaths: base.excludedPaths,
    digest: digest({ schemaVersion: 1, sourceRoots, ignore, files }),
  });
}

function workspaceCollection(
  options: TopologyGenerationSourceOptions,
  inventory: SourceInventory
): TopologySourceCollection {
  return {
    kind: "workspace",
    // The indexer replaces this metadata fingerprint with its content digest.
    revision: inventory.digest,
    inventory,
    reader: createFilesystemSourceSnapshotReader({
      repositoryRoot: options.repositoryRoot,
      inventory,
      maxSourceBytes: options.maxSourceBytes,
    }),
  };
}

function indexOptions(
  options: TopologyGenerationSourceOptions,
  source: TopologySourceCollection
) {
  return {
    repository: options.repository,
    source,
    maxFiles: options.maxFiles,
    maxTotalSourceBytes: options.maxTotalSourceBytes,
    maxSymbols: options.maxSymbols,
    maxEdges: options.maxEdges,
    parserConcurrency: options.parserConcurrency,
  };
}

export async function buildCommittedTopologyGeneration(
  options: BuildCommittedTopologyGenerationOptions
): Promise<TopologyGenerationBuildResult> {
  let source;
  try {
    source = createGitSourceSnapshotCollection({
      repositoryRoot: options.repositoryRoot,
      revision: options.revision,
      sourceRoots: options.sourceRoots,
      ignore: options.ignore,
      maxSourceBytes: options.maxSourceBytes,
      maxTotalSourceBytes: options.maxTotalSourceBytes,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      status: /exceeds the .* limit/i.test(detail)
        ? "capacity_exceeded"
        : "source_unavailable",
      path: null,
      detail,
    };
  }
  try {
    return await buildCodeTopologyGeneration(indexOptions(options, source));
  } finally {
    source.dispose();
  }
}

export async function buildCommittedTopologyReadModel(
  options: BuildCommittedTopologyGenerationOptions
): Promise<TopologyReadModelBuildResult> {
  let source;
  try {
    source = createGitSourceSnapshotCollection({
      repositoryRoot: options.repositoryRoot,
      revision: options.revision,
      sourceRoots: options.sourceRoots,
      ignore: options.ignore,
      maxSourceBytes: options.maxSourceBytes,
      maxTotalSourceBytes: options.maxTotalSourceBytes,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      status: /exceeds the .* limit/i.test(detail)
        ? "capacity_exceeded"
        : "source_unavailable",
      path: null,
      detail,
    };
  }
  try {
    return await buildCodeTopologyGeneration({
      ...indexOptions(options, source),
      output: "read_model",
    });
  } finally {
    source.dispose();
  }
}

/** Retry exactly once rather than return facts from a mixed working tree. */
export async function buildWorkspaceTopologyGeneration(
  options: BuildWorkspaceTopologyGenerationOptions
): Promise<TopologyGenerationBuildResult> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let inventory: SourceInventory;
    try {
      inventory = workspaceInventory(options);
    } catch (error) {
      return {
        status: "source_unavailable",
        path: null,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    const source = workspaceCollection(options, inventory);
    let result: TopologyGenerationBuildResult;
    try {
      result = await buildCodeTopologyGeneration(indexOptions(options, source));
      await options.afterBuildAttempt?.(attempt);
    } finally {
      source.reader.dispose?.();
    }
    let after: SourceInventory;
    try {
      after = workspaceInventory(options);
    } catch (error) {
      if (attempt === 1) continue;
      return {
        status: "workspace_changed",
        path: null,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (
      result.status === "workspace_changed" ||
      after.digest !== inventory.digest
    ) {
      if (attempt === 1) continue;
      return {
        status: "workspace_changed",
        path: result.status === "complete" ? null : result.path,
        detail: "Workspace changed during both topology build attempts.",
      };
    }
    return result;
  }
  throw new Error("Unreachable workspace topology retry state.");
}

/** Build only the persistence-independent traversal projection, retrying once on mutation. */
export async function buildWorkspaceTopologyReadModel(
  options: BuildWorkspaceTopologyGenerationOptions
): Promise<TopologyReadModelBuildResult> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let inventory: SourceInventory;
    try {
      inventory = workspaceInventory(options);
    } catch (error) {
      return {
        status: "source_unavailable",
        path: null,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    const source = workspaceCollection(options, inventory);
    let result: TopologyReadModelBuildResult;
    try {
      result = await buildCodeTopologyGeneration({
        ...indexOptions(options, source),
        output: "read_model",
      });
      await options.afterBuildAttempt?.(attempt);
    } finally {
      source.reader.dispose?.();
    }
    let after: SourceInventory;
    try {
      after = workspaceInventory(options);
    } catch (error) {
      if (attempt === 1) continue;
      return {
        status: "workspace_changed",
        path: null,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (result.status === "workspace_changed" || after.digest !== inventory.digest) {
      if (attempt === 1) continue;
      return {
        status: "workspace_changed",
        path: result.status === "complete" ? null : result.path,
        detail: "Workspace changed during both topology read-model build attempts.",
      };
    }
    return result;
  }
  throw new Error("Unreachable workspace topology read-model retry state.");
}

export async function persistCommittedTopologyGeneration(input: {
  store: CodeTopologyStore;
  result: TopologyGenerationBuildResult;
  expectedPreviousGenerationIdentity: string | null;
}): Promise<CommitCodeTopologyGenerationResult> {
  if (input.result.status !== "complete") {
    throw new Error(`Cannot persist incomplete topology outcome '${input.result.status}'.`);
  }
  if (input.result.source_kind !== "committed") {
    throw new Error("Working-tree topology generations must remain ephemeral.");
  }
  return input.store.commitGeneration({
    generation: input.result.generation,
    expected_previous_generation_identity:
      input.expectedPreviousGenerationIdentity,
  });
}

export type TopologyFileChange =
  | { status: "added"; path: string }
  | { status: "deleted"; path: string }
  | { status: "modified"; path: string }
  | { status: "renamed"; path: string; previous_path: string };

export interface TopologyGenerationComparison {
  base_generation_identity: string;
  current_generation_identity: string;
  compatibility: "compatible" | "incompatible";
  configuration_changed: boolean;
  files: TopologyFileChange[];
}

function compatibilityKey(generation: CompleteCodeTopologyGeneration): string {
  const header = generation.header;
  return JSON.stringify({
    parser: header.parser_compatibility_digest,
    resolver: header.resolver_implementation,
    schema: header.topology_schema_version,
    policy: header.fact_policy_digest,
  });
}

/** Explicitly models both sides; rename inference requires a unique equal hash. */
export function compareTopologyGenerations(
  base: CompleteCodeTopologyGeneration,
  current: CompleteCodeTopologyGeneration
): TopologyGenerationComparison {
  const baseFiles = new Map(base.files.map((file) => [file.path, file]));
  const currentFiles = new Map(current.files.map((file) => [file.path, file]));
  const deleted = [...baseFiles.values()].filter((file) => !currentFiles.has(file.path));
  const added = [...currentFiles.values()].filter((file) => !baseFiles.has(file.path));
  const deletedByHash = new Map<string, typeof deleted>();
  const addedByHash = new Map<string, typeof added>();
  for (const file of deleted) {
    deletedByHash.set(file.source_hash, [...(deletedByHash.get(file.source_hash) ?? []), file]);
  }
  for (const file of added) {
    addedByHash.set(file.source_hash, [...(addedByHash.get(file.source_hash) ?? []), file]);
  }
  const renamedFrom = new Set<string>();
  const renamedTo = new Set<string>();
  const changes: TopologyFileChange[] = [];
  for (const [hash, oldFiles] of deletedByHash) {
    const newFiles = addedByHash.get(hash) ?? [];
    if (oldFiles.length !== 1 || newFiles.length !== 1) continue;
    renamedFrom.add(oldFiles[0]!.path);
    renamedTo.add(newFiles[0]!.path);
    changes.push({
      status: "renamed",
      path: newFiles[0]!.path,
      previous_path: oldFiles[0]!.path,
    });
  }
  for (const file of deleted) {
    if (!renamedFrom.has(file.path)) changes.push({ status: "deleted", path: file.path });
  }
  for (const file of added) {
    if (!renamedTo.has(file.path)) changes.push({ status: "added", path: file.path });
  }
  for (const [path, baseFile] of baseFiles) {
    const currentFile = currentFiles.get(path);
    if (currentFile && currentFile.source_hash !== baseFile.source_hash) {
      changes.push({ status: "modified", path });
    }
  }
  changes.sort(
    (left, right) =>
      left.path.localeCompare(right.path) || left.status.localeCompare(right.status)
  );
  return {
    base_generation_identity: base.header.identity,
    current_generation_identity: current.header.identity,
    compatibility:
      compatibilityKey(base) === compatibilityKey(current)
        ? "compatible"
        : "incompatible",
    configuration_changed:
      base.header.resolver_configuration_digest !==
      current.header.resolver_configuration_digest,
    files: changes,
  };
}

interface EphemeralCacheEntry {
  value: unknown;
  bytes: number;
  expiresAt: number;
  lastAccess: number;
}

interface EphemeralCacheAdapter<Result, Value> {
  completed(result: Result): {
    identity: string;
    value: Value;
    bytes: number;
    cacheable: boolean;
  } | null;
  hit(value: Value, bytes: number): Result;
}

export interface EphemeralTopologyGenerationCacheOptions {
  maxEntries?: number;
  maxBytes?: number;
  ttlMs?: number;
  now?: () => number;
}

/** Shared bounded complete-identity cache plus same-request build coalescing. */
class EphemeralTopologyCache<Result, Value> {
  private readonly entries = new Map<string, EphemeralCacheEntry>();
  private readonly aliases = new Map<string, string>();
  private readonly pending = new Map<string, Promise<Result>>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private sequence = 0;
  private disposed = false;

  constructor(
    private readonly adapter: EphemeralCacheAdapter<Result, Value>,
    options: EphemeralTopologyGenerationCacheOptions = {}
  ) {
    this.maxEntries = options.maxEntries ?? 2;
    this.maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
    this.ttlMs = options.ttlMs ?? 5 * 60 * 1_000;
    this.now = options.now ?? Date.now;
  }

  async getOrBuild(
    requestIdentity: string,
    build: () => Promise<Result>
  ): Promise<Result> {
    if (this.disposed) throw new Error("Ephemeral topology cache has been disposed.");
    this.prune();
    const aliased = this.aliases.get(requestIdentity);
    if (aliased) {
      const cached = this.entries.get(aliased);
      if (cached) {
        cached.lastAccess = ++this.sequence;
        return this.adapter.hit(cached.value as Value, cached.bytes);
      }
      this.aliases.delete(requestIdentity);
    }
    const inflight = this.pending.get(requestIdentity);
    if (inflight) return inflight;
    const pending = build().then((result) => {
      const completed = this.adapter.completed(result);
      if (!this.disposed && completed?.cacheable) this.insert(requestIdentity, completed);
      return result;
    }).finally(() => this.pending.delete(requestIdentity));
    this.pending.set(requestIdentity, pending);
    return pending;
  }

  private insert(
    requestIdentity: string,
    completed: { identity: string; value: Value; bytes: number }
  ): void {
    if (completed.bytes > this.maxBytes) return;
    this.entries.set(completed.identity, {
      value: completed.value,
      bytes: completed.bytes,
      expiresAt: this.now() + this.ttlMs,
      lastAccess: ++this.sequence,
    });
    this.aliases.set(requestIdentity, completed.identity);
    this.prune();
  }

  private prune(): void {
    const now = this.now();
    for (const [identity, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(identity);
    }
    const totalBytes = (): number =>
      [...this.entries.values()].reduce((total, entry) => total + entry.bytes, 0);
    while (this.entries.size > this.maxEntries || totalBytes() > this.maxBytes) {
      const oldest = [...this.entries].sort(
        ([, left], [, right]) => left.lastAccess - right.lastAccess
      )[0];
      if (!oldest) break;
      this.entries.delete(oldest[0]);
    }
    const retained = new Set(this.entries.keys());
    for (const [request, identity] of this.aliases) {
      if (!retained.has(identity)) this.aliases.delete(request);
    }
  }

  stats(): { entries: number; bytes: number; pending: number } {
    this.prune();
    return {
      entries: this.entries.size,
      bytes: [...this.entries.values()].reduce((total, entry) => total + entry.bytes, 0),
      pending: this.pending.size,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.entries.clear();
    this.aliases.clear();
    this.pending.clear();
  }
}

/** Bounded rich-generation cache retained for persistence-oriented callers. */
export class EphemeralTopologyGenerationCache {
  private readonly cache: EphemeralTopologyCache<
    TopologyGenerationBuildResult,
    CompleteCodeTopologyGeneration
  >;

  constructor(options: EphemeralTopologyGenerationCacheOptions = {}) {
    this.cache = new EphemeralTopologyCache({
      completed: (result) => result.status === "complete" ? {
        identity: result.generation.header.identity,
        value: result.generation,
        bytes: result.retained_bytes,
        cacheable: result.source_kind === "workspace",
      } : null,
      hit: (generation, retainedBytes) => ({
        status: "complete",
        source_kind: "workspace",
        generation,
        retained_bytes: retainedBytes,
      }),
    }, options);
  }

  getOrBuild(
    requestIdentity: string,
    build: () => Promise<TopologyGenerationBuildResult>
  ): Promise<TopologyGenerationBuildResult> {
    return this.cache.getOrBuild(requestIdentity, build);
  }

  stats(): { entries: number; bytes: number; pending: number } {
    return this.cache.stats();
  }

  dispose(): void {
    this.cache.dispose();
  }
}

/** Runtime cache stores only the persistence-independent traversal projection. */
export class EphemeralTopologyReadModelCache {
  private readonly cache: EphemeralTopologyCache<
    TopologyReadModelBuildResult,
    Extract<TopologyReadModelBuildResult, { status: "complete" }>["read_model"]
  >;

  constructor(options: EphemeralTopologyGenerationCacheOptions = {}) {
    this.cache = new EphemeralTopologyCache({
      completed: (result) => result.status === "complete" ? {
        identity: result.read_model.summary.header.identity,
        value: result.read_model,
        bytes: result.retained_bytes,
        cacheable: result.source_kind === "workspace",
      } : null,
      hit: (readModel, retainedBytes) => ({
        status: "complete",
        source_kind: "workspace",
        read_model: readModel,
        retained_bytes: retainedBytes,
      }),
    }, options);
  }

  getOrBuild(
    requestIdentity: string,
    build: () => Promise<TopologyReadModelBuildResult>
  ): Promise<TopologyReadModelBuildResult> {
    return this.cache.getOrBuild(requestIdentity, build);
  }

  stats(): { entries: number; bytes: number; pending: number } {
    return this.cache.stats();
  }

  dispose(): void {
    this.cache.dispose();
  }
}

async function workspaceRequestIdentity(
  options: BuildWorkspaceTopologyGenerationOptions
): Promise<string> {
  const root = await realpath(options.repositoryRoot);
  const inventory = workspaceInventory(options);
  return digest({
    root,
    repository: options.repository,
    sourceRoots: options.sourceRoots,
    ignore: options.ignore ?? [],
    inventory: inventory.digest,
  });
}

export class TopologyGenerationService {
  readonly cache: EphemeralTopologyGenerationCache;

  constructor(cache = new EphemeralTopologyGenerationCache()) {
    this.cache = cache;
  }

  async buildWorkspace(
    options: BuildWorkspaceTopologyGenerationOptions
  ): Promise<TopologyGenerationBuildResult> {
    const requestIdentity = await workspaceRequestIdentity(options);
    return this.cache.getOrBuild(requestIdentity, () =>
      buildWorkspaceTopologyGeneration(options)
    );
  }

  dispose(): void {
    this.cache.dispose();
  }
}

export class TopologyReadModelService {
  readonly cache: EphemeralTopologyReadModelCache;

  constructor(cache = new EphemeralTopologyReadModelCache()) {
    this.cache = cache;
  }

  async buildWorkspace(
    options: BuildWorkspaceTopologyGenerationOptions
  ): Promise<TopologyReadModelBuildResult> {
    const requestIdentity = await workspaceRequestIdentity(options);
    return this.cache.getOrBuild(requestIdentity, () =>
      buildWorkspaceTopologyReadModel(options)
    );
  }

  dispose(): void {
    this.cache.dispose();
  }
}

export type PersistedGenerationLookup =
  | { status: "available"; generation: StoredCodeTopologyGeneration }
  | { status: "generation_unavailable"; generation_identity: string };

export async function loadPersistedTopologyGeneration(
  store: CodeTopologyStore,
  generationIdentity: string
): Promise<PersistedGenerationLookup> {
  const generation = await store.getGeneration(generationIdentity);
  return generation
    ? { status: "available", generation }
    : { status: "generation_unavailable", generation_identity: generationIdentity };
}

export type BuildTopologyRolesResult =
  | {
      status: "complete";
      base: CompleteCodeTopologyGeneration;
      current: CompleteCodeTopologyGeneration;
      comparison: TopologyGenerationComparison;
    }
  | Exclude<TopologyGenerationBuildResult, { status: "complete" }>;

export type PersistedBaseWorkspaceRolesResult =
  | BuildTopologyRolesResult
  | { status: "generation_unavailable"; generation_identity: string }
  | {
      status: "incompatible_base";
      base_generation_identity: string;
      current_generation_identity: string;
      comparison: TopologyGenerationComparison;
    };

/** Build base then current sequentially so two source corpora are never retained. */
export async function buildTopologyRoles(options: {
  base: BuildCommittedTopologyGenerationOptions;
  current: BuildCommittedTopologyGenerationOptions | BuildWorkspaceTopologyGenerationOptions;
  currentKind: "committed" | "workspace";
}): Promise<BuildTopologyRolesResult> {
  const base = await buildCommittedTopologyGeneration(options.base);
  if (base.status !== "complete") return base;
  const current = options.currentKind === "committed"
    ? await buildCommittedTopologyGeneration(
        options.current as BuildCommittedTopologyGenerationOptions
      )
    : await buildWorkspaceTopologyGeneration(
        options.current as BuildWorkspaceTopologyGenerationOptions
      );
  if (current.status !== "complete") return current;
  return {
    status: "complete",
    base: base.generation,
    current: current.generation,
    comparison: compareTopologyGenerations(base.generation, current.generation),
  };
}

/** Prefer a retained committed base while keeping dirty current facts ephemeral. */
export async function buildPersistedBaseWorkspaceRoles(options: {
  store: CodeTopologyStore;
  baseGenerationIdentity: string;
  current: BuildWorkspaceTopologyGenerationOptions;
  service?: TopologyGenerationService;
}): Promise<PersistedBaseWorkspaceRolesResult> {
  const base = await loadPersistedTopologyGeneration(
    options.store,
    options.baseGenerationIdentity
  );
  if (base.status !== "available") return base;
  const current = options.service
    ? await options.service.buildWorkspace(options.current)
    : await buildWorkspaceTopologyGeneration(options.current);
  if (current.status !== "complete") return current;
  const comparison = compareTopologyGenerations(base.generation, current.generation);
  if (comparison.compatibility === "incompatible") {
    return {
      status: "incompatible_base",
      base_generation_identity: base.generation.header.identity,
      current_generation_identity: current.generation.header.identity,
      comparison,
    };
  }
  return {
    status: "complete",
    base: base.generation,
    current: current.generation,
    comparison,
  };
}
