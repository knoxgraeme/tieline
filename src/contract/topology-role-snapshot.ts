import {
  lstatSync,
  readFileSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { resolve } from "node:path";
import {
  CODE_TOPOLOGY_ARTIFACT_FILE,
  CODE_TOPOLOGY_ARTIFACT_MAX_FILE_BYTES,
  readCodeTopologyArtifact,
  type CodeTopologyArtifactMetadata,
} from "./code-topology-artifact.js";
import { codeTopologyRuntimeCompatibility } from "./code-topology-indexer.js";
import { ImmutableCodeTopologySnapshotStore } from "./compact-code-topology-store.js";
import {
  readWorkspaceTopologySelectedInput,
  type TopologyGenerationSourceOptions,
} from "./topology-generation.js";
import { withinRepository } from "./paths.js";
import type {
  CodeTopologyReadModelGeneration,
  CodeTopologyReadStore,
} from "../domain/code-topology-store.js";

export const CODE_TOPOLOGY_DIRECTORY = ".tieline/topology";
/** Ignored, content-addressed store used by the cached topology lifecycle. */
export const CODE_TOPOLOGY_CACHE_DIRECTORY = `${CODE_TOPOLOGY_DIRECTORY}/cache`;

/**
 * `committed` reads the reviewed `.tieline/topology/graph.json`; `cached`
 * reads the cache entry named by the requested snapshot's selected-input
 * digest, so branch-specific graphs never enter Git history.
 */
export type CodeTopologyMode = "committed" | "cached";

const selectedInputDigestPattern = /^[a-f0-9]{64}$/;

export function codeTopologyCacheEntryName(selectedInputDigest: string): string {
  if (!selectedInputDigestPattern.test(selectedInputDigest)) {
    throw new Error("Topology cache keys must be SHA-256 selected-input digests.");
  }
  return `${selectedInputDigest}.json`;
}

export type TopologyLifecycleStatus =
  | "current"
  | "topology_stale"
  | "topology_missing"
  | "topology_incompatible"
  | "topology_invalid"
  | "topology_capacity_exceeded"
  | "topology_unsafe_path"
  | "workspace_changed"
  | "topology_missing_at_revision";

export interface TopologyRoleSnapshot {
  source: "workspace" | "git";
  repository: string;
  queried_revision: string | null;
  generation_identity: string;
  selected_input_digest: string;
  artifact_digest: string;
  projection_digest: string;
  metadata: CodeTopologyArtifactMetadata;
  read_model: CodeTopologyReadModelGeneration;
  store: CodeTopologyReadStore;
  warnings: string[];
  dispose(): void;
}

export type TopologyRoleSnapshotResult =
  | { status: "current"; snapshot: TopologyRoleSnapshot }
  | {
      status: Exclude<TopologyLifecycleStatus, "current">;
      detail: string;
      artifact_digest?: string;
      projection_digest?: string;
      generation_identity?: string;
      selected_input_digest?: string;
    };

/** @internal Deterministic seam for artifact-publication interleaving tests. */
interface WorkspaceArtifactReadHooks {
  afterGraphRead?(): void;
}

type WorkspaceArtifactFilesResult =
  | { status: "complete"; files: Map<string, Buffer> }
  | { status: "missing" | "invalid" | "capacity_exceeded" | "unsafe_path"; detail: string };

export function topologyArtifactFailureStatus(
  status: "missing" | "stale" | "incompatible" | "invalid" | "capacity_exceeded" | "unsafe_path"
): Exclude<TopologyLifecycleStatus, "current" | "workspace_changed" | "topology_missing_at_revision"> {
  return `topology_${status}`;
}

function owned(stat: Stats): boolean {
  const uid = process.getuid?.();
  return uid === undefined || stat.uid === uid;
}

function safeRegularFile(root: string, path: string): string | null {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || !owned(stat)) {
    return "is not an owned regular file";
  }
  const real = realpathSync(path);
  if (!withinRepository(root, real)) return "resolves outside the topology directory";
  return null;
}

function readSafeTopologyGraph(root: string, path: string):
  | { status: "complete"; bytes: Buffer }
  | { status: "capacity_exceeded" | "unsafe_path"; detail: string } {
  const unsafe = safeRegularFile(root, path);
  if (unsafe) return { status: "unsafe_path", detail: `Topology graph ${unsafe}.` };
  if (lstatSync(path).size > CODE_TOPOLOGY_ARTIFACT_MAX_FILE_BYTES) {
    return { status: "capacity_exceeded", detail: "Topology graph exceeds the file byte limit." };
  }
  return { status: "complete", bytes: readFileSync(path) };
}

export function readWorkspaceCodeTopologyFiles(
  repositoryRoot: string,
  hooks: WorkspaceArtifactReadHooks = {}
): WorkspaceArtifactFilesResult {
  const repository = realpathSync(resolve(repositoryRoot));
  const root = resolve(repository, CODE_TOPOLOGY_DIRECTORY);
  const graphPath = resolve(root, CODE_TOPOLOGY_ARTIFACT_FILE);
  try {
    const tielineRoot = resolve(repository, ".tieline");
    const tielineStat = lstatSync(tielineRoot);
    if (!tielineStat.isDirectory() || tielineStat.isSymbolicLink() || !owned(tielineStat)) {
      return { status: "unsafe_path", detail: "The repository .tieline directory is not an owned regular directory." };
    }
    const rootStat = lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !owned(rootStat)) {
      return { status: "unsafe_path", detail: "The topology authority is not an owned regular directory." };
    }
    const realRoot = realpathSync(root);
    if (!withinRepository(repository, realRoot)) {
      return { status: "unsafe_path", detail: "The topology authority resolves outside the repository." };
    }
    const graph = readSafeTopologyGraph(realRoot, graphPath);
    if (graph.status !== "complete") return graph;
    hooks.afterGraphRead?.();
    return {
      status: "complete",
      files: new Map([[CODE_TOPOLOGY_ARTIFACT_FILE, graph.bytes]]),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { status: "missing", detail: `No topology artifact exists at '${graphPath}'.` };
    }
    return {
      status: "invalid",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Read the cache entry for one exact selected-input digest without writing. */
export function readCachedCodeTopologyFiles(
  repositoryRoot: string,
  selectedInputDigest: string
): WorkspaceArtifactFilesResult {
  const repository = realpathSync(resolve(repositoryRoot));
  const cacheRoot = resolve(repository, CODE_TOPOLOGY_CACHE_DIRECTORY);
  const entryPath = resolve(cacheRoot, codeTopologyCacheEntryName(selectedInputDigest));
  try {
    for (const [path, label] of [
      [resolve(repository, ".tieline"), "The repository .tieline directory"],
      [resolve(repository, CODE_TOPOLOGY_DIRECTORY), "The topology authority"],
      [cacheRoot, "The topology cache"],
    ] as const) {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat)) {
        return { status: "unsafe_path", detail: `${label} is not an owned regular directory.` };
      }
    }
    const realCacheRoot = realpathSync(cacheRoot);
    if (!withinRepository(repository, realCacheRoot)) {
      return { status: "unsafe_path", detail: "The topology cache resolves outside the repository." };
    }
    const graph = readSafeTopologyGraph(realCacheRoot, entryPath);
    if (graph.status !== "complete") return graph;
    return {
      status: "complete",
      files: new Map([[CODE_TOPOLOGY_ARTIFACT_FILE, graph.bytes]]),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { status: "missing", detail: `No cached topology exists for selected inputs '${selectedInputDigest}'.` };
    }
    return {
      status: "invalid",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function compatibilityFailure(metadata: CodeTopologyArtifactMetadata): string | null {
  const runtime = codeTopologyRuntimeCompatibility();
  return metadata.compatibility.parser_compatibility_digest !== runtime.parser_compatibility_digest ||
    metadata.compatibility.resolver_implementation !== runtime.resolver_implementation ||
    metadata.compatibility.topology_schema_version !== runtime.topology_schema_version ||
    metadata.compatibility.fact_policy_digest !== runtime.fact_policy_digest
    ? "Topology artifact is incompatible with the current parser, resolver, schema, or fact policy."
    : null;
}

function warningsFor(model: CodeTopologyReadModelGeneration): string[] {
  if (model.frontiers.length === 0) return [];
  const counts = new Map<string, number>();
  for (const frontier of model.frontiers) {
    counts.set(frontier.status, (counts.get(frontier.status) ?? 0) + 1);
  }
  return [...counts].sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${count} ${status} dependency frontier(s) were retained.`);
}

export function topologyRoleSnapshotFromFiles(input: {
  source: "workspace" | "git";
  repository: string;
  queriedRevision: string | null;
  files: ReadonlyMap<string, Buffer>;
  selectedInputDigest: string;
}): TopologyRoleSnapshotResult {
  const read = readCodeTopologyArtifact(input.files);
  if (read.status !== "complete") {
    return { status: topologyArtifactFailureStatus(read.status), detail: read.detail };
  }
  const metadata = read.metadata;
  const identity = metadata.generation.identity;
  const unavailable = (status: Exclude<TopologyLifecycleStatus, "current">, detail: string): TopologyRoleSnapshotResult => ({
    status,
    detail,
    artifact_digest: read.artifact_digest,
    projection_digest: metadata.projection_digest,
    generation_identity: identity,
  });
  if (metadata.generation.repository !== input.repository) {
    return unavailable("topology_invalid", `Topology artifact repository '${metadata.generation.repository}' does not match '${input.repository}'.`);
  }
  const compatibility = compatibilityFailure(metadata);
  if (compatibility) return unavailable("topology_incompatible", compatibility);
  if (metadata.selected_input_digest !== input.selectedInputDigest) {
    return unavailable("topology_stale", "Topology artifact selected inputs do not match the requested snapshot.");
  }
  const store = new ImmutableCodeTopologySnapshotStore();
  store.addReadModel(read.read_model);
  const snapshot: TopologyRoleSnapshot = {
    source: input.source,
    repository: input.repository,
    queried_revision: input.queriedRevision,
    generation_identity: identity,
    selected_input_digest: metadata.selected_input_digest,
    artifact_digest: read.artifact_digest,
    projection_digest: metadata.projection_digest,
    metadata,
    read_model: read.read_model,
    store,
    warnings: warningsFor(read.read_model),
    dispose() { store.dispose(); },
  };
  return { status: "current", snapshot };
}

/** Attach the requested snapshot key so callers can compile or cache it. */
export function withSelectedInputDigest(
  result: TopologyRoleSnapshotResult,
  selectedInputDigest: string
): TopologyRoleSnapshotResult {
  return result.status === "current"
    ? result
    : { ...result, selected_input_digest: selectedInputDigest };
}

/**
 * In cached mode a legacy committed graph may still answer, but only when it
 * is current for the exact requested snapshot. Stale or incompatible legacy
 * bytes are expected once that file stops being updated, so they are not
 * served; corrupt, unsafe, or foreign-repository bytes stay visible failures.
 */
export function legacyTopologyFallback(
  result: TopologyRoleSnapshotResult
): TopologyRoleSnapshotResult | null {
  return result.status === "topology_stale" || result.status === "topology_incompatible"
    ? null
    : result;
}

function workspaceSelectedInputFailure(
  freshness: Exclude<ReturnType<typeof readWorkspaceTopologySelectedInput>, { status: "complete" }>
): TopologyRoleSnapshotResult {
  return {
    status: freshness.status === "workspace_changed"
      ? "workspace_changed"
      : freshness.status === "capacity_exceeded"
        ? "topology_capacity_exceeded"
        : "topology_invalid",
    detail: freshness.detail,
  };
}

function selectCachedWorkspaceTopologyRole(
  options: TopologyGenerationSourceOptions
): TopologyRoleSnapshotResult {
  const freshness = readWorkspaceTopologySelectedInput(options);
  if (freshness.status !== "complete") return workspaceSelectedInputFailure(freshness);
  const digest = freshness.selected_input_digest;
  const fromFiles = (files: ReadonlyMap<string, Buffer>): TopologyRoleSnapshotResult =>
    withSelectedInputDigest(topologyRoleSnapshotFromFiles({
      source: "workspace",
      repository: options.repository,
      queriedRevision: null,
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
  const legacy = readWorkspaceCodeTopologyFiles(options.repositoryRoot);
  if (legacy.status === "complete") {
    const selected = legacyTopologyFallback(fromFiles(legacy.files));
    if (selected) return selected;
  } else if (legacy.status !== "missing") {
    return {
      status: topologyArtifactFailureStatus(legacy.status),
      detail: legacy.detail,
      selected_input_digest: digest,
    };
  }
  return {
    status: "topology_missing",
    detail: `No cached topology exists for the workspace selected inputs '${digest}'.${
      legacy.status === "complete"
        ? " The legacy .tieline/topology/graph.json is not current for these inputs and is no longer updated."
        : ""
    } Run \`tieline code compile .\`.`,
    selected_input_digest: digest,
  };
}

export function selectWorkspaceTopologyRole(
  options: TopologyGenerationSourceOptions,
  mode: CodeTopologyMode
): TopologyRoleSnapshotResult {
  if (mode === "cached") return selectCachedWorkspaceTopologyRole(options);
  const files = readWorkspaceCodeTopologyFiles(options.repositoryRoot);
  if (files.status !== "complete") {
    return { status: topologyArtifactFailureStatus(files.status), detail: files.detail };
  }
  const freshness = readWorkspaceTopologySelectedInput(options);
  if (freshness.status !== "complete") return workspaceSelectedInputFailure(freshness);
  return topologyRoleSnapshotFromFiles({
    source: "workspace",
    repository: options.repository,
    queriedRevision: null,
    files: files.files,
    selectedInputDigest: freshness.selected_input_digest,
  });
}
