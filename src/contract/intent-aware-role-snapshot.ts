import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import {
  compileContractManifest,
  CONTRACT_MANIFEST_INDEX_FILE,
  manifestDigest,
  parseContractManifestSnapshot,
  readContractManifest,
  serializeContractManifest,
  type ContractManifest,
  type ContractManifestSnapshotFile,
} from "./manifest.js";
import type { TopologyRoleSnapshot } from "./topology-role-snapshot.js";
import type { TielineWorkspace } from "../tieline/workspace.js";

export type ManifestLifecycleStatus =
  | "manifest_missing"
  | "manifest_stale"
  | "manifest_incompatible"
  | "manifest_invalid";

export interface ManifestRoleSnapshot {
  source: "workspace" | "git";
  repository: string;
  queried_revision: string | null;
  manifest_digest: string;
  manifest: ContractManifest;
}

export interface IntentAwareRoleSnapshot {
  topology: TopologyRoleSnapshot;
  contract: ManifestRoleSnapshot;
  dispose(): void;
}

export type ManifestRoleSnapshotResult =
  | { status: "current"; snapshot: ManifestRoleSnapshot }
  | { status: ManifestLifecycleStatus; detail: string; manifest_digest?: string };

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export function selectWorkspaceManifestRole(
  workspace: TielineWorkspace,
  repository: string
): ManifestRoleSnapshotResult {
  if (!existsSync(resolve(workspace.manifestPath, CONTRACT_MANIFEST_INDEX_FILE))) {
    return {
      status: "manifest_missing",
      detail: `No contract manifest exists at '${workspace.manifestPath}'.`,
    };
  }
  let manifest: ContractManifest;
  try {
    manifest = readContractManifest(workspace.manifestPath);
  } catch (error) {
    return {
      status: missing(error) ? "manifest_missing" : "manifest_invalid",
      detail: `The contract manifest '${workspace.manifestPath}' is unavailable: ${errorDetail(error)}`,
    };
  }
  const digest = manifestDigest(manifest);
  if (manifest.repository.key !== repository) {
    return {
      status: "manifest_incompatible",
      manifest_digest: digest,
      detail: `Contract manifest repository '${manifest.repository.key}' does not match '${repository}'.`,
    };
  }
  try {
    const compiled = compileContractManifest({
      repositoryRoot: workspace.root,
      repositoryKey: repository,
      specDirectory: workspace.specDirectoryPath,
    });
    if (serializeContractManifest(manifest) !== serializeContractManifest(compiled)) {
      return {
        status: "manifest_stale",
        manifest_digest: digest,
        detail: "The contract manifest does not match the current authored YAML or linked content. Run 'tieline contract compile .' and commit the result.",
      };
    }
  } catch (error) {
    return {
      status: "manifest_stale",
      manifest_digest: digest,
      detail: `The contract manifest cannot be current for this workspace: ${errorDetail(error)}`,
    };
  }
  return {
    status: "current",
    snapshot: {
      source: "workspace",
      repository,
      queried_revision: null,
      manifest_digest: digest,
      manifest,
    },
  };
}

interface GitBlob {
  object: string;
  path: string;
  size: number;
}

function git(repositoryRoot: string, args: string[], input?: string): Buffer {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function normalizedRepositoryPath(repositoryRoot: string, path: string): string | null {
  const normalized = relative(resolve(repositoryRoot), resolve(path)).split(sep).join("/");
  return normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")
    ? null
    : normalized;
}

function listGitBlobs(
  repositoryRoot: string,
  commit: string,
  paths: readonly string[]
): Map<string, GitBlob> {
  if (paths.length === 0) return new Map();
  const literalTopLevelPaths = paths.map((path) => `:(top,literal)${path}`);
  const output = git(repositoryRoot, [
    "ls-tree", "-rz", "-r", "--full-tree", "-l", commit, "--", ...literalTopLevelPaths,
  ]).toString("utf8");
  const result = new Map<string, GitBlob>();
  for (const raw of output.split("\0")) {
    if (!raw) continue;
    const match = raw.match(/^100(?:644|755) blob ([a-f0-9]+)\s+(\d+)\t(.+)$/s);
    if (!match) continue;
    result.set(match[3]!, {
      object: match[1]!,
      size: Number(match[2]),
      path: match[3]!,
    });
  }
  return result;
}

function readGitBlobs(repositoryRoot: string, entries: readonly GitBlob[]): Map<string, Buffer> {
  const objects = [...new Set(entries.map((entry) => entry.object))];
  if (objects.length === 0) return new Map();
  const output = git(repositoryRoot, ["cat-file", "--batch"], `${objects.join("\n")}\n`);
  const contents = new Map<string, Buffer>();
  let offset = 0;
  for (const expected of objects) {
    const newline = output.indexOf(0x0a, offset);
    if (newline < 0) throw new Error(`Git batch ended before manifest object '${expected}'.`);
    const header = output.subarray(offset, newline).toString("utf8");
    const match = header.match(/^([a-f0-9]+) blob (\d+)$/);
    if (!match || match[1] !== expected) {
      throw new Error(`Unexpected Git batch response '${header}' for manifest object '${expected}'.`);
    }
    const end = newline + 1 + Number(match[2]);
    if (end >= output.length || output[end] !== 0x0a) {
      throw new Error(`Git manifest object '${expected}' is truncated.`);
    }
    contents.set(expected, Buffer.from(output.subarray(newline + 1, end)));
    offset = end + 1;
  }
  return contents;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifestEvidencePaths(manifest: ContractManifest): Map<string, string> {
  const expected = new Map(manifest.inputs.map((input) => [input.path, input.sha256]));
  for (const capability of manifest.capabilities) {
    for (const story of capability.stories) {
      for (const link of [
        ...story.links,
        ...story.acceptance_criteria.flatMap((criterion) => criterion.links),
      ]) {
        if (
          link.target.kind !== "help" &&
          link.target.repository === manifest.repository.key &&
          link.reviewed_content_hash !== null
        ) {
          expected.set(link.target.path, link.reviewed_content_hash);
        }
      }
    }
  }
  return expected;
}

/** Select a manifest from an already resolved topology commit; this never resolves the symbolic ref again. */
export function selectGitManifestRole(input: {
  repositoryRoot: string;
  repository: string;
  commit: string;
  manifestPath: string;
}): ManifestRoleSnapshotResult {
  const directory = normalizedRepositoryPath(input.repositoryRoot, input.manifestPath);
  if (!directory) {
    return { status: "manifest_invalid", detail: "The configured contract manifest is outside the repository." };
  }
  try {
    const entries = listGitBlobs(input.repositoryRoot, input.commit, [directory]);
    if (entries.size === 0) {
      return {
        status: "manifest_missing",
        detail: `Git commit '${input.commit}' has no committed contract manifest.`,
      };
    }
    const contents = readGitBlobs(input.repositoryRoot, [...entries.values()]);
    const files: ContractManifestSnapshotFile[] = [...entries.values()]
      .map((entry) => ({
        name: entry.path.slice(`${directory}/`.length),
        content: contents.get(entry.object)!.toString("utf8"),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const manifest = parseContractManifestSnapshot(files, `commit '${input.commit}'`);
    const digest = manifestDigest(manifest);
    if (manifest.repository.key !== input.repository) {
      return {
        status: "manifest_incompatible",
        manifest_digest: digest,
        detail: `Contract manifest repository '${manifest.repository.key}' does not match '${input.repository}'.`,
      };
    }
    const evidence = manifestEvidencePaths(manifest);
    const evidenceEntries = listGitBlobs(input.repositoryRoot, input.commit, [...evidence.keys()]);
    const evidenceContents = readGitBlobs(input.repositoryRoot, [...evidenceEntries.values()]);
    for (const [path, expected] of evidence) {
      const entry = evidenceEntries.get(path);
      const bytes = entry ? evidenceContents.get(entry.object) : undefined;
      if (!bytes || sha256(bytes) !== expected) {
        return {
          status: "manifest_stale",
          manifest_digest: digest,
          detail: `The contract manifest at commit '${input.commit}' does not match '${path}'.`,
        };
      }
    }
    return {
      status: "current",
      snapshot: {
        source: "git",
        repository: input.repository,
        queried_revision: input.commit,
        manifest_digest: digest,
        manifest,
      },
    };
  } catch (error) {
    return { status: "manifest_invalid", detail: errorDetail(error) };
  }
}

export function composeIntentAwareRoleSnapshot(input: {
  topology: TopologyRoleSnapshot;
  contract: ManifestRoleSnapshot;
}): IntentAwareRoleSnapshot {
  if (input.topology.repository !== input.contract.repository) {
    throw new Error("Topology and contract roles name different repositories.");
  }
  if (input.topology.queried_revision !== input.contract.queried_revision) {
    throw new Error("Topology and contract roles do not come from the same immutable snapshot.");
  }
  return {
    ...input,
    dispose() { input.topology.dispose(); },
  };
}
