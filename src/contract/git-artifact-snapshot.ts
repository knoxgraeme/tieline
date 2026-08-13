import { execFileSync } from "node:child_process";
import {
  CODE_TOPOLOGY_ARTIFACT_INDEX,
  CODE_TOPOLOGY_ARTIFACT_MAX_FILE_BYTES,
  CODE_TOPOLOGY_ARTIFACT_MAX_TOTAL_BYTES,
} from "./code-topology-artifact.js";
import { createGitSourceSnapshotCollection } from "./git-source-snapshot.js";
import {
  CODE_TOPOLOGY_DIRECTORY,
  indexedCodeTopologyArtifactNames,
  topologyArtifactFailureStatus,
  topologyRoleSnapshotFromFiles,
  type TopologyRoleSnapshotResult,
} from "./topology-role-snapshot.js";
import {
  readTopologySourceSelectedInput,
  type BuildCommittedTopologyGenerationOptions,
} from "./topology-generation.js";

interface GitArtifactEntry {
  mode: string;
  object: string;
  size: number;
  path: string;
}

function git(repositoryRoot: string, args: string[], input?: string): Buffer {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function resolveCommit(repositoryRoot: string, revision: string): string {
  const commit = git(repositoryRoot, ["rev-parse", "--verify", `${revision}^{commit}`])
    .toString("utf8").trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) {
    throw new Error(`Git revision '${revision}' did not resolve to one immutable commit.`);
  }
  return commit;
}

function listArtifactTree(repositoryRoot: string, commit: string): Map<string, GitArtifactEntry> {
  const output = git(repositoryRoot, [
    "ls-tree", "-rz", "-r", "--full-tree", "-l", commit, "--", CODE_TOPOLOGY_DIRECTORY,
  ]).toString("utf8");
  const entries = new Map<string, GitArtifactEntry>();
  for (const raw of output.split("\0")) {
    if (!raw) continue;
    const match = raw.match(/^([0-7]{6}) blob ([a-f0-9]+)\s+(\d+)\t(.+)$/s);
    if (!match) continue;
    entries.set(match[4]!, {
      mode: match[1]!, object: match[2]!, size: Number(match[3]), path: match[4]!,
    });
  }
  return entries;
}

/** Read selected Git blobs through one bounded `cat-file --batch` process. */
function readObjects(
  repositoryRoot: string,
  entries: readonly GitArtifactEntry[]
): Map<string, Buffer> {
  const objects = [...new Set(entries.map((entry) => entry.object))];
  if (objects.length === 0) return new Map();
  const output = git(repositoryRoot, ["cat-file", "--batch"], `${objects.join("\n")}\n`);
  const values = new Map<string, Buffer>();
  let offset = 0;
  for (const expected of objects) {
    const newline = output.indexOf(0x0a, offset);
    if (newline < 0) throw new Error(`Git batch ended before topology object '${expected}'.`);
    const header = output.subarray(offset, newline).toString("utf8");
    const match = header.match(/^([a-f0-9]+) blob (\d+)$/);
    if (!match || match[1] !== expected) {
      throw new Error(`Unexpected Git batch response '${header}' for topology object '${expected}'.`);
    }
    const size = Number(match[2]);
    const start = newline + 1;
    const end = start + size;
    if (end >= output.length || output[end] !== 0x0a) {
      throw new Error(`Git topology object '${expected}' is truncated.`);
    }
    values.set(expected, Buffer.from(output.subarray(start, end)));
    offset = end + 1;
  }
  return values;
}

export function selectGitTopologyRole(
  options: BuildCommittedTopologyGenerationOptions
): TopologyRoleSnapshotResult {
  let commit: string;
  try {
    commit = resolveCommit(options.repositoryRoot, options.revision);
  } catch (error) {
    return { status: "topology_invalid", detail: error instanceof Error ? error.message : String(error) };
  }
  try {
    const tree = listArtifactTree(options.repositoryRoot, commit);
    const indexPath = `${CODE_TOPOLOGY_DIRECTORY}/${CODE_TOPOLOGY_ARTIFACT_INDEX}`;
    const indexEntry = tree.get(indexPath);
    if (!indexEntry) {
      return {
        status: "topology_missing_at_revision",
        detail: `Git commit '${commit}' has no committed topology artifact.`,
      };
    }
    if (indexEntry.mode !== "100644" && indexEntry.mode !== "100755") {
      return { status: "topology_unsafe_path", detail: "Committed topology index is not a regular Git file." };
    }
    if (indexEntry.size > CODE_TOPOLOGY_ARTIFACT_MAX_FILE_BYTES) {
      return { status: "topology_capacity_exceeded", detail: "Committed topology index exceeds the per-file byte limit." };
    }
    const indexObject = readObjects(options.repositoryRoot, [indexEntry]).get(indexEntry.object)!;
    const indexed = indexedCodeTopologyArtifactNames(indexObject);
    if (indexed.status !== "complete") {
      return { status: topologyArtifactFailureStatus(indexed.status), detail: indexed.detail };
    }
    const selected: GitArtifactEntry[] = [];
    let totalBytes = indexEntry.size;
    for (const name of indexed.names.slice(1)) {
      const entry = tree.get(`${CODE_TOPOLOGY_DIRECTORY}/${name}`);
      if (!entry) return { status: "topology_invalid", detail: `Committed topology shard '${name}' is missing.` };
      if (entry.mode !== "100644" && entry.mode !== "100755") {
        return { status: "topology_unsafe_path", detail: `Committed topology shard '${name}' is not a regular Git file.` };
      }
      if (entry.size > CODE_TOPOLOGY_ARTIFACT_MAX_FILE_BYTES) {
        return { status: "topology_capacity_exceeded", detail: `Committed topology shard '${name}' exceeds the per-file byte limit.` };
      }
      totalBytes += entry.size;
      if (totalBytes > CODE_TOPOLOGY_ARTIFACT_MAX_TOTAL_BYTES) {
        return { status: "topology_capacity_exceeded", detail: "Committed topology artifact exceeds the total byte limit." };
      }
      selected.push(entry);
    }
    const blobs = readObjects(options.repositoryRoot, selected);
    const files = new Map<string, Buffer>([[CODE_TOPOLOGY_ARTIFACT_INDEX, indexObject]]);
    for (let index = 0; index < selected.length; index += 1) {
      files.set(indexed.names[index + 1]!, blobs.get(selected[index]!.object)!);
    }

    const source = createGitSourceSnapshotCollection({
      repositoryRoot: options.repositoryRoot,
      revision: commit,
      sourceRoots: options.sourceRoots,
      ignore: options.ignore,
      maxSourceBytes: options.maxSourceBytes,
      maxTotalSourceBytes: options.maxTotalSourceBytes,
    });
    try {
      const freshness = readTopologySourceSelectedInput(options, source);
      if (freshness.status !== "complete") {
        return {
          status: freshness.status === "capacity_exceeded"
            ? "topology_capacity_exceeded"
            : "topology_invalid",
          detail: freshness.detail,
        };
      }
      return topologyRoleSnapshotFromFiles({
        source: "git",
        repository: options.repository,
        queriedRevision: commit,
        files,
        selectedInputDigest: freshness.selected_input_digest,
      });
    } finally {
      source.dispose();
    }
  } catch (error) {
    return { status: "topology_invalid", detail: error instanceof Error ? error.message : String(error) };
  }
}
