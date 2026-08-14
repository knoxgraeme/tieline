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
  CODE_TOPOLOGY_DIRECTORY,
  selectWorkspaceTopologyRole,
  topologyArtifactFailureStatus,
} from "../contract/topology-role-snapshot.js";
import {
  buildWorkspaceTopologyReadModel,
  readWorkspaceTopologySelectedInput,
} from "../contract/topology-generation.js";
import { resolveCommandContext, type CommandIO } from "./shared.js";

export type CodeTopologyArtifactAction = "compile" | "validate";

export interface CodeTopologyArtifactCommandOptions {
  repository?: string;
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

export async function publishCodeTopologyArtifact(input: {
  repositoryRoot: string;
  serialized: SerializedCodeTopologyArtifact;
  hooks?: Pick<CodeTopologyArtifactCommandHooks, "beforeAuthorityReplace">;
}): Promise<void> {
  const lock = await acquireLock(input.repositoryRoot);
  try {
    const root = resolve(input.repositoryRoot, CODE_TOPOLOGY_DIRECTORY);
    if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o755 });
    assertOwnedDirectory(root, "The topology authority");
    const graphBytes = input.serialized.files.get(CODE_TOPOLOGY_ARTIFACT_FILE);
    if (!graphBytes || input.serialized.files.size !== 1) {
      throw new TopologyPublicationError("invalid", "Serialized topology must contain only graph.json.");
    }

    const authority = resolve(root, CODE_TOPOLOGY_ARTIFACT_FILE);
    const authorityStat = assertOwnedFileIfPresent(authority, "The topology graph");
    const legacy = legacyArtifactPaths(root);
    const unchanged = authorityStat?.size === graphBytes.byteLength &&
      readFileSync(authority).equals(graphBytes);
    if (!unchanged) {
      const temporary = uniqueTemporary(authority);
      try {
        writeFlushedTemporary(temporary, graphBytes);
        await input.hooks?.beforeAuthorityReplace?.();
        renameSync(temporary, authority);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
    }
    for (const path of legacy.files) unlinkSync(path);
    if (legacy.directory) rmdirSync(legacy.directory);
  } finally {
    releaseLock(lock);
  }
}

function responseForCurrent(snapshot: ReturnType<typeof selectWorkspaceTopologyRole> & { status: "current" }) {
  const { metadata } = snapshot.snapshot;
  return {
    status: "current" as const,
    repository: snapshot.snapshot.repository,
    generation_identity: snapshot.snapshot.generation_identity,
    selected_input_digest: snapshot.snapshot.selected_input_digest,
    artifact_digest: snapshot.snapshot.artifact_digest,
    projection_digest: snapshot.snapshot.projection_digest,
    counts: metadata.counts,
    warnings: snapshot.snapshot.warnings,
  };
}

function render(result: Record<string, unknown>): string {
  const status = String(result.status);
  if (status === "current") {
    return `Code topology current: generation ${result.generation_identity}, artifact ${result.artifact_digest}, ${((result.warnings as unknown[]) ?? []).length} warning(s).\n`;
  }
  return `Code topology ${status}: ${String(result.detail ?? "unavailable")}\n`;
}

export async function runCodeTopologyArtifactCommand(
  action: CodeTopologyArtifactAction,
  options: CodeTopologyArtifactCommandOptions,
  io: CommandIO,
  hooks?: CodeTopologyArtifactCommandHooks
): Promise<number> {
  const context = resolveCommandContext({ repository: options.repository });
  const sourceOptions = {
    repositoryRoot: context.root,
    repository: context.repositoryKey,
    sourceRoots: context.workspace?.config.repository.source_roots ?? ["src"],
    ignore: context.workspace?.config.repository.ignore ?? [],
  };
  let result: Record<string, unknown>;
  if (action === "compile") {
    const built = await buildWorkspaceTopologyReadModel({
      ...sourceOptions,
      afterBuildAttempt: hooks?.afterBuildAttempt,
    });
    if (built.status !== "complete") {
      result = {
        status: built.status === "workspace_changed"
          ? "workspace_changed"
          : built.status === "capacity_exceeded"
            ? "topology_capacity_exceeded"
            : "topology_invalid",
        detail: built.detail,
        path: built.path,
      };
    } else {
      const live = readWorkspaceTopologySelectedInput(sourceOptions);
      if (live.status !== "complete" || live.selected_input_digest !== built.read_model.summary.header.revision) {
        result = {
          status: "workspace_changed",
          detail: live.status === "complete"
            ? "Workspace selected inputs changed after topology compilation."
            : live.detail,
        };
      } else {
        try {
          const serialized = serializeCodeTopologyArtifact(topologyArtifactFromReadModel(built.read_model));
          await publishCodeTopologyArtifact({
            repositoryRoot: context.root,
            serialized,
            hooks,
          });
          const selected = selectWorkspaceTopologyRole(sourceOptions);
          result = selected.status === "current"
            ? responseForCurrent(selected)
            : { status: selected.status, detail: selected.detail };
          selected.status === "current" && selected.snapshot.dispose();
        } catch (error) {
          result = {
            status: error instanceof TopologyPublicationError
              ? topologyArtifactFailureStatus(error.status)
              : "topology_invalid",
            detail: error instanceof Error ? error.message : String(error),
          };
        }
      }
    }
  } else {
    const selected = selectWorkspaceTopologyRole(sourceOptions);
    result = selected.status === "current"
      ? responseForCurrent(selected)
      : {
          status: selected.status,
          detail: selected.detail,
          ...(selected.artifact_digest ? { artifact_digest: selected.artifact_digest } : {}),
          ...(selected.projection_digest ? { projection_digest: selected.projection_digest } : {}),
          ...(selected.generation_identity ? { generation_identity: selected.generation_identity } : {}),
        };
    selected.status === "current" && selected.snapshot.dispose();
  }
  io.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : render(result));
  return result.status === "current" ? 0 : 1;
}
