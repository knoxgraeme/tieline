import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  type Stats,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, resolve } from "node:path";
import {
  CODE_TOPOLOGY_ARTIFACT_FILE,
  serializeCodeTopologyArtifact,
  topologyArtifactFromReadModel,
  type SerializedCodeTopologyArtifact,
} from "../contract/code-topology-artifact.js";
import {
  CODE_TOPOLOGY_CACHE_DIRECTORY,
  CODE_TOPOLOGY_DIRECTORY,
  codeTopologyCacheEntryName,
  readWorkspaceCodeTopologyFiles,
  selectWorkspaceTopologyRole,
  topologyArtifactFailureStatus,
  topologyRoleSnapshotFromFiles,
  type CodeTopologyMode,
  type TopologyRoleSnapshotResult,
} from "../contract/topology-role-snapshot.js";
import {
  readCommitTopologySelectedInput,
  resolveTopologyCommit,
  selectGitTopologyRole,
} from "../contract/git-artifact-snapshot.js";
import {
  buildCommittedTopologyReadModel,
  buildWorkspaceTopologyReadModel,
  readWorkspaceTopologySelectedInput,
  type TopologyGenerationSourceOptions,
} from "../contract/topology-generation.js";
import { workspaceTopologyMode } from "../tieline/workspace.js";
import { resolveCommandContext, type CommandIO } from "./shared.js";

export type CodeTopologyArtifactAction = "compile" | "validate" | "untrack";

export interface CodeTopologyArtifactCommandOptions {
  repository?: string;
  /** Compile one immutable Git revision into the cache (cached mode only). */
  revision?: string;
  json?: boolean;
}

export interface CodeTopologyArtifactCommandHooks {
  beforeAuthorityReplace?(): void | Promise<void>;
  afterBuildAttempt?(attempt: number): void | Promise<void>;
}

interface LockOwner {
  pid: number;
  host: string;
  created_at: string;
  nonce: string;
}

const LOCK_WAIT_MS = 1_000;
const LOCK_STALE_MS = 30_000;
const LOCK_FILE = ".tieline/topology.lock";
/** Writers evict least-recently-compiled entries beyond this bound; readers never write. */
export const CODE_TOPOLOGY_CACHE_MAX_ENTRIES = 8;
const TOPOLOGY_IGNORE_FILE = ".gitignore";
/** Everything under `.tieline/topology/` is derived; only this rule file is shared. */
export const CODE_TOPOLOGY_IGNORE_CONTENT = "*\n!.gitignore\n";
const LEGACY_GRAPH_PATH = `${CODE_TOPOLOGY_DIRECTORY}/${CODE_TOPOLOGY_ARTIFACT_FILE}`;
const GIT_TIMEOUT_MS = 30_000;
const cacheEntryFilePattern = /^[a-f0-9]{64}\.json$/;

class TopologyPublicationError extends Error {
  constructor(readonly status: "invalid" | "unsafe_path", message: string) {
    super(message);
    this.name = "TopologyPublicationError";
  }
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function owned(stat: Stats): boolean {
  const uid = process.getuid?.();
  return uid === undefined || stat.uid === uid;
}

function assertOwnedDirectory(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat)) {
    throw new TopologyPublicationError("unsafe_path", `${label} is not an owned regular directory.`);
  }
}

function assertOwnedFileIfPresent(path: string, label: string): Stats | null {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || !owned(stat)) {
    throw new TopologyPublicationError("unsafe_path", `${label} is not an owned regular file.`);
  }
  return stat;
}

function processAbsent(owner: LockOwner): boolean {
  if (owner.host !== hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return errno(error) === "ESRCH";
  }
}

function parseLockOwner(path: string): LockOwner | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<LockOwner>;
    return Number.isSafeInteger(value.pid) && (value.pid ?? 0) > 0 &&
      typeof value.host === "string" && typeof value.created_at === "string" &&
      typeof value.nonce === "string" && value.nonce.length > 0
      ? value as LockOwner
      : null;
  } catch {
    return null;
  }
}

function recoverStaleLock(path: string): boolean {
  let before: Stats;
  try {
    before = lstatSync(path);
  } catch (error) {
    if (errno(error) === "ENOENT") return true;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || !owned(before)) {
    throw new TopologyPublicationError("unsafe_path", "The topology publication lock is unsafe.");
  }
  const owner = parseLockOwner(path);
  if (!owner) return false;
  const age = Date.now() - Math.max(before.mtimeMs, Date.parse(owner.created_at));
  if (!Number.isFinite(age) || age < LOCK_STALE_MS || !processAbsent(owner)) return false;
  let after: Stats;
  try {
    after = lstatSync(path);
  } catch (error) {
    if (errno(error) === "ENOENT") return true;
    throw error;
  }
  if (before.dev !== after.dev || before.ino !== after.ino) return false;
  try {
    unlinkSync(path);
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error;
  }
  return true;
}

async function acquireLock(repositoryRoot: string): Promise<{ path: string; owner: LockOwner }> {
  const tielineRoot = resolve(repositoryRoot, ".tieline");
  assertOwnedDirectory(tielineRoot, "The repository .tieline directory");
  const path = resolve(repositoryRoot, LOCK_FILE);
  const owner: LockOwner = {
    pid: process.pid,
    host: hostname(),
    created_at: new Date().toISOString(),
    nonce: randomUUID(),
  };
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      const descriptor = openSync(path, "wx", 0o600);
      try {
        writeFileSync(descriptor, `${JSON.stringify(owner)}\n`);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      return { path, owner };
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error;
      if (recoverStaleLock(path)) continue;
      if (Date.now() >= deadline) {
        throw new TopologyPublicationError(
          "invalid",
          "Topology publication lock remained owned or contended past the bounded wait."
        );
      }
      await new Promise<void>((done) => setTimeout(done, 25));
    }
  }
}

function releaseLock(lock: { path: string; owner: LockOwner }): void {
  const observed = parseLockOwner(lock.path);
  if (observed?.nonce === lock.owner.nonce) unlinkSync(lock.path);
}

function writeFlushedTemporary(path: string, bytes: Buffer): void {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function uniqueTemporary(finalPath: string): string {
  return resolve(dirname(finalPath), `.${basename(finalPath)}.${process.pid}.${randomUUID()}.tmp`);
}

function legacyArtifactPaths(root: string): { files: string[]; directory: string | null } {
  const legacyIndex = resolve(root, "topology.json");
  const files = [] as string[];
  if (existsSync(legacyIndex)) {
    assertOwnedFileIfPresent(legacyIndex, "The legacy topology index");
    files.push(legacyIndex);
  }
  const filesRoot = resolve(root, "files");
  if (!existsSync(filesRoot)) return { files, directory: null };
  assertOwnedDirectory(filesRoot, "The legacy topology shard directory");
  for (const entry of readdirSync(filesRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) {
      throw new TopologyPublicationError(
        "unsafe_path",
        `Legacy topology shard path '${entry.name}' is unsafe.`
      );
    }
    const path = resolve(filesRoot, entry.name);
    assertOwnedFileIfPresent(path, `Legacy topology shard '${entry.name}'`);
    files.push(path);
  }
  return { files, directory: filesRoot };
}

function serializedGraphBytes(serialized: SerializedCodeTopologyArtifact): Buffer {
  const graphBytes = serialized.files.get(CODE_TOPOLOGY_ARTIFACT_FILE);
  if (!graphBytes || serialized.files.size !== 1) {
    throw new TopologyPublicationError("invalid", "Serialized topology must contain only graph.json.");
  }
  return graphBytes;
}

/** Atomically replace one owned file; returns false when its bytes already match. */
async function replaceOwnedFile(
  path: string,
  label: string,
  bytes: Buffer,
  hooks?: Pick<CodeTopologyArtifactCommandHooks, "beforeAuthorityReplace">
): Promise<boolean> {
  const stat = assertOwnedFileIfPresent(path, label);
  if (stat?.size === bytes.byteLength && readFileSync(path).equals(bytes)) return false;
  const temporary = uniqueTemporary(path);
  try {
    writeFlushedTemporary(temporary, bytes);
    await hooks?.beforeAuthorityReplace?.();
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return true;
}

function ensureOwnedDirectory(path: string, label: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o755 });
  assertOwnedDirectory(path, label);
}

export async function publishCodeTopologyArtifact(input: {
  repositoryRoot: string;
  serialized: SerializedCodeTopologyArtifact;
  hooks?: Pick<CodeTopologyArtifactCommandHooks, "beforeAuthorityReplace">;
}): Promise<void> {
  const lock = await acquireLock(input.repositoryRoot);
  try {
    const root = resolve(input.repositoryRoot, CODE_TOPOLOGY_DIRECTORY);
    ensureOwnedDirectory(root, "The topology authority");
    const graphBytes = serializedGraphBytes(input.serialized);
    const authority = resolve(root, CODE_TOPOLOGY_ARTIFACT_FILE);
    assertOwnedFileIfPresent(authority, "The topology graph");
    const legacy = legacyArtifactPaths(root);
    await replaceOwnedFile(authority, "The topology graph", graphBytes, input.hooks);
    for (const path of legacy.files) unlinkSync(path);
    if (legacy.directory) rmdirSync(legacy.directory);
  } finally {
    releaseLock(lock);
  }
}

/**
 * Tieline owns `.tieline/topology/`, so it may add the rule that keeps derived
 * graphs out of Git. An existing rule file belongs to the user and is kept.
 */
function ensureTopologyIgnore(topologyRoot: string): void {
  const path = resolve(topologyRoot, TOPOLOGY_IGNORE_FILE);
  if (assertOwnedFileIfPresent(path, "The topology ignore file")) return;
  try {
    writeFileSync(path, CODE_TOPOLOGY_IGNORE_CONTENT, { flag: "wx", mode: 0o644 });
  } catch (error) {
    if (errno(error) !== "EEXIST") throw error;
  }
}

function evictCacheEntries(cacheRoot: string, retained: string): void {
  const entries = readdirSync(cacheRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && cacheEntryFilePattern.test(entry.name))
    .map((entry) => resolve(cacheRoot, entry.name))
    .filter((path) => path !== retained)
    .map((path) => ({ path, modified: lstatSync(path).mtimeMs }))
    .sort((left, right) => right.modified - left.modified || left.path.localeCompare(right.path));
  for (const entry of entries.slice(CODE_TOPOLOGY_CACHE_MAX_ENTRIES - 1)) {
    unlinkSync(entry.path);
  }
}

/** Caller holds the publication lock. */
async function writeCacheEntry(input: {
  repositoryRoot: string;
  graphBytes: Buffer;
  selectedInputDigest: string;
  hooks?: Pick<CodeTopologyArtifactCommandHooks, "beforeAuthorityReplace">;
}): Promise<void> {
  const topologyRoot = resolve(input.repositoryRoot, CODE_TOPOLOGY_DIRECTORY);
  ensureOwnedDirectory(topologyRoot, "The topology authority");
  ensureTopologyIgnore(topologyRoot);
  const cacheRoot = resolve(input.repositoryRoot, CODE_TOPOLOGY_CACHE_DIRECTORY);
  ensureOwnedDirectory(cacheRoot, "The topology cache");
  const entry = resolve(cacheRoot, codeTopologyCacheEntryName(input.selectedInputDigest));
  const replaced = await replaceOwnedFile(entry, "The cached topology graph", input.graphBytes, input.hooks);
  if (!replaced) {
    const now = new Date();
    utimesSync(entry, now, now);
  }
  evictCacheEntries(cacheRoot, entry);
}

export async function publishCachedCodeTopologyArtifact(input: {
  repositoryRoot: string;
  serialized: SerializedCodeTopologyArtifact;
  selectedInputDigest: string;
  hooks?: Pick<CodeTopologyArtifactCommandHooks, "beforeAuthorityReplace">;
}): Promise<void> {
  const graphBytes = serializedGraphBytes(input.serialized);
  const lock = await acquireLock(input.repositoryRoot);
  try {
    await writeCacheEntry({
      repositoryRoot: input.repositoryRoot,
      graphBytes,
      selectedInputDigest: input.selectedInputDigest,
      hooks: input.hooks,
    });
  } finally {
    releaseLock(lock);
  }
}

function selectionResponse(selected: TopologyRoleSnapshotResult): Record<string, unknown> {
  if (selected.status !== "current") {
    return {
      status: selected.status,
      detail: selected.detail,
      ...(selected.artifact_digest ? { artifact_digest: selected.artifact_digest } : {}),
      ...(selected.projection_digest ? { projection_digest: selected.projection_digest } : {}),
      ...(selected.generation_identity ? { generation_identity: selected.generation_identity } : {}),
      ...(selected.selected_input_digest ? { selected_input_digest: selected.selected_input_digest } : {}),
    };
  }
  const { snapshot } = selected;
  try {
    return {
      status: "current" as const,
      repository: snapshot.repository,
      ...(snapshot.queried_revision ? { queried_revision: snapshot.queried_revision } : {}),
      generation_identity: snapshot.generation_identity,
      selected_input_digest: snapshot.selected_input_digest,
      artifact_digest: snapshot.artifact_digest,
      projection_digest: snapshot.projection_digest,
      counts: snapshot.metadata.counts,
      warnings: snapshot.warnings,
    };
  } finally {
    snapshot.dispose();
  }
}

function publicationFailure(error: unknown): Record<string, unknown> {
  return {
    status: error instanceof TopologyPublicationError
      ? topologyArtifactFailureStatus(error.status)
      : "topology_invalid",
    detail: error instanceof Error ? error.message : String(error),
  };
}

function buildFailure(built: { status: string; detail: string; path?: string | null }): Record<string, unknown> {
  return {
    status: built.status === "workspace_changed"
      ? "workspace_changed"
      : built.status === "capacity_exceeded"
        ? "topology_capacity_exceeded"
        : "topology_invalid",
    detail: built.detail,
    path: built.path,
  };
}

function git(repositoryRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    // Stable messages: non-Git detection must not depend on the user's locale.
    env: { ...process.env, LC_ALL: "C" },
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** `git check-ignore` exits 1 for paths that are not ignored, including tracked paths. */
function gitPathIgnored(repositoryRoot: string, path: string): boolean {
  try {
    git(repositoryRoot, ["check-ignore", "-q", "--", path]);
    return true;
  } catch (error) {
    if ((error as { status?: unknown } | null)?.status === 1) return false;
    throw error;
  }
}

/** Distinguish a non-Git directory from a Git failure that must stay visible. */
function insideGitWorkTree(repositoryRoot: string): boolean {
  try {
    return git(repositoryRoot, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch (error) {
    const stderr = String((error as { stderr?: unknown } | null)?.stderr ?? "");
    if (/not a git repository/i.test(stderr)) return false;
    throw error;
  }
}

function legacyGraphTracked(repositoryRoot: string): boolean {
  return insideGitWorkTree(repositoryRoot) &&
    git(repositoryRoot, ["ls-files", "-z", "--", LEGACY_GRAPH_PATH]).length > 0;
}

function lifecycleNotices(repositoryRoot: string, mode: CodeTopologyMode): string[] {
  try {
    if (mode === "cached") {
      if (!insideGitWorkTree(repositoryRoot)) return [];
      const cacheDirectory = `${CODE_TOPOLOGY_CACHE_DIRECTORY}/`;
      return [
        ...(legacyGraphTracked(repositoryRoot)
          ? [`${LEGACY_GRAPH_PATH} is still tracked by Git but is no longer updated in cached mode. Run \`tieline code untrack .\` and commit the result.`]
          : []),
        ...(existsSync(resolve(repositoryRoot, cacheDirectory)) && !gitPathIgnored(repositoryRoot, cacheDirectory)
          ? [`${cacheDirectory} is not ignored by Git. Keep derived graphs out of commits, for example with the rule \`*\` and \`!.gitignore\` in .tieline/topology/.gitignore.`]
          : []),
      ];
    }
    return insideGitWorkTree(repositoryRoot) && gitPathIgnored(repositoryRoot, LEGACY_GRAPH_PATH)
      ? [`${LEGACY_GRAPH_PATH} is ignored by Git, so committed mode cannot commit it. Remove the ignore rule (for example the cached-mode .tieline/topology/.gitignore).`]
      : [];
  } catch (error) {
    return [`Could not inspect Git for ${LEGACY_GRAPH_PATH}: ${error instanceof Error ? error.message : String(error)}`];
  }
}

async function compileWorkspace(
  repositoryRoot: string,
  sourceOptions: TopologyGenerationSourceOptions,
  mode: CodeTopologyMode,
  hooks?: CodeTopologyArtifactCommandHooks
): Promise<Record<string, unknown>> {
  const built = await buildWorkspaceTopologyReadModel({
    ...sourceOptions,
    afterBuildAttempt: hooks?.afterBuildAttempt,
  });
  if (built.status !== "complete") return buildFailure(built);
  const live = readWorkspaceTopologySelectedInput(sourceOptions);
  if (live.status !== "complete" || live.selected_input_digest !== built.read_model.summary.header.revision) {
    return {
      status: "workspace_changed",
      detail: live.status === "complete"
        ? "Workspace selected inputs changed after topology compilation."
        : live.detail,
    };
  }
  try {
    const serialized = serializeCodeTopologyArtifact(topologyArtifactFromReadModel(built.read_model));
    if (mode === "committed") {
      await publishCodeTopologyArtifact({ repositoryRoot, serialized, hooks });
    } else {
      await publishCachedCodeTopologyArtifact({
        repositoryRoot,
        serialized,
        selectedInputDigest: live.selected_input_digest,
        hooks,
      });
    }
    return selectionResponse(selectWorkspaceTopologyRole(sourceOptions, mode));
  } catch (error) {
    return publicationFailure(error);
  }
}

async function compileRevision(
  repositoryRoot: string,
  sourceOptions: TopologyGenerationSourceOptions,
  mode: CodeTopologyMode,
  revision: string,
  hooks?: CodeTopologyArtifactCommandHooks
): Promise<Record<string, unknown>> {
  if (mode === "committed") {
    throw new Error(
      "`code compile --revision` requires topology_mode \"cached\"; committed mode publishes only the working-tree graph."
    );
  }
  if (revision.length === 0 || revision.length > 255 || revision.startsWith("-")) {
    throw new Error("Expected a Git revision for `code compile --revision`.");
  }
  let commit: string;
  try {
    commit = resolveTopologyCommit(repositoryRoot, revision);
  } catch (error) {
    return { status: "topology_invalid", detail: error instanceof Error ? error.message : String(error) };
  }
  const built = await buildCommittedTopologyReadModel({ ...sourceOptions, revision: commit });
  if (built.status !== "complete") return buildFailure(built);
  try {
    // Key the entry exactly as revision readers will look it up.
    const expected = readCommitTopologySelectedInput({ ...sourceOptions, revision: commit }, commit);
    if (expected.status !== "complete" ||
        expected.selected_input_digest !== built.read_model.summary.header.revision) {
      return {
        status: "topology_invalid",
        detail: expected.status === "complete"
          ? `Compiled selected inputs for '${commit}' do not match the revision reader's key.`
          : expected.detail,
      };
    }
    const serialized = serializeCodeTopologyArtifact(topologyArtifactFromReadModel(built.read_model));
    await publishCachedCodeTopologyArtifact({
      repositoryRoot,
      serialized,
      selectedInputDigest: built.read_model.summary.header.revision,
      hooks,
    });
    return selectionResponse(selectGitTopologyRole({ ...sourceOptions, revision: commit }, mode));
  } catch (error) {
    return publicationFailure(error);
  }
}

/**
 * Move a legacy committed graph out of Git: seed the cache when the graph is
 * current, stage its removal plus the topology ignore rule, and delete the
 * working copy. It never commits, pushes, or touches unrelated paths.
 */
async function untrackLegacyTopology(
  repositoryRoot: string,
  sourceOptions: TopologyGenerationSourceOptions,
  mode: CodeTopologyMode
): Promise<Record<string, unknown>> {
  if (mode === "committed") {
    throw new Error(
      "`code untrack` applies only to topology_mode \"cached\"; this workspace explicitly selects committed topology."
    );
  }
  // Hash selected inputs before locking so concurrent compiles are not starved.
  const freshness = readWorkspaceTopologySelectedInput(sourceOptions);
  const lock = await acquireLock(repositoryRoot);
  try {
    const topologyRoot = resolve(repositoryRoot, CODE_TOPOLOGY_DIRECTORY);
    const ignorePath = `${CODE_TOPOLOGY_DIRECTORY}/${TOPOLOGY_IGNORE_FILE}`;
    // Inspect everything before the first mutation so a failed precondition
    // leaves the checkout unchanged.
    const repositoryGit = insideGitWorkTree(repositoryRoot);
    const tracked = repositoryGit &&
      git(repositoryRoot, ["ls-files", "-z", "--", LEGACY_GRAPH_PATH]).length > 0;
    const legacy = readWorkspaceCodeTopologyFiles(repositoryRoot);
    if (legacy.status !== "complete" && legacy.status !== "missing") {
      return { status: topologyArtifactFailureStatus(legacy.status), detail: legacy.detail };
    }
    const ignoreExcluded = repositoryGit && gitPathIgnored(repositoryRoot, ignorePath);
    let seededCache = false;
    if (legacy.status === "complete" && freshness.status === "complete") {
      const selected = topologyRoleSnapshotFromFiles({
        source: "workspace",
        repository: sourceOptions.repository,
        queriedRevision: null,
        files: legacy.files,
        selectedInputDigest: freshness.selected_input_digest,
      });
      if (selected.status === "current") {
        selected.snapshot.dispose();
        await writeCacheEntry({
          repositoryRoot,
          graphBytes: legacy.files.get(CODE_TOPOLOGY_ARTIFACT_FILE)!,
          selectedInputDigest: freshness.selected_input_digest,
        });
        seededCache = true;
      }
    }
    ensureOwnedDirectory(topologyRoot, "The topology authority");
    const ignoreCreated = !existsSync(resolve(repositoryRoot, ignorePath));
    ensureTopologyIgnore(topologyRoot);
    // The file is derived, so a staged version differing from HEAD and the
    // working copy carries nothing worth preserving.
    if (tracked) git(repositoryRoot, ["rm", "--cached", "-f", "--quiet", "--", LEGACY_GRAPH_PATH]);
    const removedFile = legacy.status === "complete";
    if (removedFile) unlinkSync(resolve(topologyRoot, CODE_TOPOLOGY_ARTIFACT_FILE));
    const ignorePending = repositoryGit && !ignoreExcluded && (
      git(repositoryRoot, ["ls-files", "-z", "--", ignorePath]).length === 0 ||
      git(repositoryRoot, ["diff", "--name-only", "-z", "--", ignorePath]).length > 0
    );
    if (ignorePending) git(repositoryRoot, ["add", "--", ignorePath]);
    return {
      status: tracked || removedFile || ignoreCreated || ignorePending ? "untracked" : "unchanged",
      removed_from_index: tracked,
      removed_file: removedFile,
      seeded_cache: seededCache,
      staged: [...(tracked ? [LEGACY_GRAPH_PATH] : []), ...(ignorePending ? [ignorePath] : [])],
      ...(ignoreExcluded
        ? { notices: [`${ignorePath} was not staged because repository Git rules already ignore it, which keeps topology untracked.`] }
        : {}),
    };
  } catch (error) {
    return publicationFailure(error);
  } finally {
    releaseLock(lock);
  }
}

function render(result: Record<string, unknown>): string {
  const status = String(result.status);
  const notices = Array.isArray(result.notices)
    ? result.notices.map((notice) => `Notice: ${String(notice)}\n`).join("")
    : "";
  if (status === "current") {
    return `Code topology current: generation ${result.generation_identity}, artifact ${result.artifact_digest}, ${((result.warnings as unknown[]) ?? []).length} warning(s).\n${notices}`;
  }
  if (status === "untracked" || status === "unchanged") {
    return status === "untracked"
      ? `Legacy code topology untracked; staged ${((result.staged as unknown[]) ?? []).join(", ") || "nothing"}. Commit the result.\n${notices}`
      : `No legacy committed code topology to untrack.\n${notices}`;
  }
  return `Code topology ${status}: ${String(result.detail ?? "unavailable")}\n${notices}`;
}

export async function runCodeTopologyArtifactCommand(
  action: CodeTopologyArtifactAction,
  options: CodeTopologyArtifactCommandOptions,
  io: CommandIO,
  hooks?: CodeTopologyArtifactCommandHooks
): Promise<number> {
  const context = resolveCommandContext({ repository: options.repository });
  const mode = workspaceTopologyMode(context.workspace);
  const sourceOptions = {
    repositoryRoot: context.root,
    repository: context.repositoryKey,
    sourceRoots: context.workspace?.config.repository.source_roots ?? ["src"],
    ignore: context.workspace?.config.repository.ignore ?? [],
  };
  if (options.revision !== undefined && action !== "compile") {
    throw new Error("Only `code compile` accepts --revision.");
  }
  let result: Record<string, unknown>;
  if (action === "compile") {
    result = options.revision === undefined
      ? await compileWorkspace(context.root, sourceOptions, mode, hooks)
      : await compileRevision(context.root, sourceOptions, mode, options.revision, hooks);
  } else if (action === "validate") {
    result = selectionResponse(selectWorkspaceTopologyRole(sourceOptions, mode));
  } else {
    result = await untrackLegacyTopology(context.root, sourceOptions, mode);
  }
  if (action !== "untrack") {
    const notices = lifecycleNotices(context.root, mode);
    if (notices.length > 0) result = { ...result, notices };
  }
  io.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : render(result));
  return result.status === "current" || result.status === "untracked" || result.status === "unchanged"
    ? 0
    : 1;
}
