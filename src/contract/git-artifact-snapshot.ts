import { execFileSync } from "node:child_process";
import {
  CODE_TOPOLOGY_ARTIFACT_FILE,
  CODE_TOPOLOGY_ARTIFACT_MAX_FILE_BYTES,
} from "./code-topology-artifact.js";
import { createGitSourceSnapshotCollection } from "./git-source-snapshot.js";
import {
  CODE_TOPOLOGY_DIRECTORY,
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
    maxBuffer: CODE_TOPOLOGY_ARTIFACT_MAX_FILE_BYTES + 1024 * 1024,
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

function readGraphEntry(repositoryRoot: string, commit: string): GitArtifactEntry | null {
  const graphPath = `${CODE_TOPOLOGY_DIRECTORY}/${CODE_TOPOLOGY_ARTIFACT_FILE}`;
  const output = git(repositoryRoot, [
    "ls-tree", "-z", "--full-tree", "-l", commit, "--", graphPath,
  ]).toString("utf8");
  if (!output) return null;
  const raw = output.endsWith("\0") ? output.slice(0, -1) : output;
  const match = raw.match(/^([0-7]{6}) blob ([a-f0-9]+)\s+(\d+)\t(.+)$/s);
  if (!match || match[4] !== graphPath) {
    throw new Error(`Unexpected Git tree response for topology graph '${graphPath}'.`);
  }
  return {
    mode: match[1]!, object: match[2]!, size: Number(match[3]), path: match[4]!,
  };
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
    const graphEntry = readGraphEntry(options.repositoryRoot, commit);
    if (!graphEntry) {
      return {
        status: "topology_missing_at_revision",
        detail: `Git commit '${commit}' has no committed topology artifact.`,
      };
    }
    if (graphEntry.mode !== "100644" && graphEntry.mode !== "100755") {
      return { status: "topology_unsafe_path", detail: "Committed topology graph is not a regular Git file." };
    }
    if (graphEntry.size > CODE_TOPOLOGY_ARTIFACT_MAX_FILE_BYTES) {
      return { status: "topology_capacity_exceeded", detail: "Committed topology graph exceeds the file byte limit." };
    }
    const graphObject = readObjects(options.repositoryRoot, [graphEntry]).get(graphEntry.object)!;
    const files = new Map<string, Buffer>([[CODE_TOPOLOGY_ARTIFACT_FILE, graphObject]]);

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
