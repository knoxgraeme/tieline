import { execFileSync } from "node:child_process";
import {
  CODE_TOPOLOGY_ARTIFACT_FILE,
  CODE_TOPOLOGY_ARTIFACT_MAX_FILE_BYTES,
} from "./code-topology-artifact.js";
import { createGitSourceSnapshotCollection } from "./git-source-snapshot.js";
import {
  CODE_TOPOLOGY_DIRECTORY,
  legacyTopologyFallback,
  readCachedCodeTopologyFiles,
  topologyArtifactFailureStatus,
  topologyRoleSnapshotFromFiles,
  withSelectedInputDigest,
  type CodeTopologyMode,
  type TopologyRoleSnapshotResult,
} from "./topology-role-snapshot.js";
import {
  readTopologySourceSelectedInput,
  type BuildCommittedTopologyGenerationOptions,
  type TopologySelectedInputResult,
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

export function resolveTopologyCommit(repositoryRoot: string, revision: string): string {
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

type CommittedGraphRead =
  | { status: "complete"; files: Map<string, Buffer> }
  | { status: "missing" }
  | {
      status: "topology_unsafe_path" | "topology_capacity_exceeded";
      detail: string;
    };

function readCommittedGraph(repositoryRoot: string, commit: string): CommittedGraphRead {
  const graphEntry = readGraphEntry(repositoryRoot, commit);
  if (!graphEntry) return { status: "missing" };
  if (graphEntry.mode !== "100644" && graphEntry.mode !== "100755") {
    return { status: "topology_unsafe_path", detail: "Committed topology graph is not a regular Git file." };
  }
  if (graphEntry.size > CODE_TOPOLOGY_ARTIFACT_MAX_FILE_BYTES) {
    return { status: "topology_capacity_exceeded", detail: "Committed topology graph exceeds the file byte limit." };
  }
  const graphObject = readObjects(repositoryRoot, [graphEntry]).get(graphEntry.object)!;
  return {
    status: "complete",
    files: new Map<string, Buffer>([[CODE_TOPOLOGY_ARTIFACT_FILE, graphObject]]),
  };
}

function commitSelectedInput(
  options: BuildCommittedTopologyGenerationOptions,
  commit: string
): TopologySelectedInputResult {
  const source = createGitSourceSnapshotCollection({
    repositoryRoot: options.repositoryRoot,
    revision: commit,
    sourceRoots: options.sourceRoots,
    ignore: options.ignore,
    maxSourceBytes: options.maxSourceBytes,
    maxTotalSourceBytes: options.maxTotalSourceBytes,
  });
  try {
    return readTopologySourceSelectedInput(options, source);
  } finally {
    source.dispose();
  }
}

function selectedInputFailure(
  freshness: Exclude<TopologySelectedInputResult, { status: "complete" }>
): TopologyRoleSnapshotResult {
  return {
    status: freshness.status === "capacity_exceeded"
      ? "topology_capacity_exceeded"
      : "topology_invalid",
    detail: freshness.detail,
  };
}

function selectCommittedGitTopologyRole(
  options: BuildCommittedTopologyGenerationOptions,
  commit: string
): TopologyRoleSnapshotResult {
  const committed = readCommittedGraph(options.repositoryRoot, commit);
  if (committed.status === "missing") {
    return {
      status: "topology_missing_at_revision",
      detail: `Git commit '${commit}' has no committed topology artifact.`,
    };
  }
  if (committed.status !== "complete") return committed;
  const freshness = commitSelectedInput(options, commit);
  if (freshness.status !== "complete") return selectedInputFailure(freshness);
  return topologyRoleSnapshotFromFiles({
    source: "git",
    repository: options.repository,
    queriedRevision: commit,
    files: committed.files,
    selectedInputDigest: freshness.selected_input_digest,
  });
}

/**
 * Prefer the cache entry for the commit's exact selected inputs; a graph
 * committed at that revision answers only when it is current for them.
 */
function selectCachedGitTopologyRole(
  options: BuildCommittedTopologyGenerationOptions,
  commit: string
): TopologyRoleSnapshotResult {
  const freshness = commitSelectedInput(options, commit);
  if (freshness.status !== "complete") return selectedInputFailure(freshness);
  const digest = freshness.selected_input_digest;
  const fromFiles = (files: ReadonlyMap<string, Buffer>): TopologyRoleSnapshotResult =>
    withSelectedInputDigest(topologyRoleSnapshotFromFiles({
      source: "git",
      repository: options.repository,
      queriedRevision: commit,
      files,
      selectedInputDigest: digest,
    }), digest);
  const cached = readCachedCodeTopologyFiles(options.repositoryRoot, digest);
  if (cached.status === "complete") return fromFiles(cached.files);
  if (cached.status !== "missing") {
    return {
      status: topologyArtifactFailureStatus(cached.status),
      detail: cached.detail,
      selected_input_digest: digest,
    };
  }
  const committed = readCommittedGraph(options.repositoryRoot, commit);
  if (committed.status === "complete") {
    const selected = legacyTopologyFallback(fromFiles(committed.files));
    if (selected) return selected;
  } else if (committed.status !== "missing") {
    return { ...committed, selected_input_digest: digest };
  }
  return {
    status: "topology_missing_at_revision",
    detail: `No cached topology exists for Git commit '${commit}' (selected inputs '${digest}'). Run \`tieline code compile . --revision ${commit}\`.`,
    selected_input_digest: digest,
  };
}

export function selectGitTopologyRole(
  options: BuildCommittedTopologyGenerationOptions,
  mode: CodeTopologyMode
): TopologyRoleSnapshotResult {
  let commit: string;
  try {
    commit = resolveTopologyCommit(options.repositoryRoot, options.revision);
  } catch (error) {
    return { status: "topology_invalid", detail: error instanceof Error ? error.message : String(error) };
  }
  try {
    return mode === "cached"
      ? selectCachedGitTopologyRole(options, commit)
      : selectCommittedGitTopologyRole(options, commit);
  } catch (error) {
    return { status: "topology_invalid", detail: error instanceof Error ? error.message : String(error) };
  }
}
