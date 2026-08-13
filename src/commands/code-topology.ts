import { canonicalRepositoryRelativePath } from "../contract/paths.js";
import { parseSelector } from "../contract/selector.js";
import {
  analyzeCodeBlastRadius,
  type CodeBlastRadiusExplicitChange,
  type CodeBlastRadiusResult,
} from "../contract/code-blast-radius.js";
import {
  traceCodeTopology,
  type CodeTopologyDirection,
  type CodeTopologyGenerationRole,
  type CodeTopologyLocator,
  type CodeTopologyTraceResult,
  type CodeTopologyTraversalLimits,
} from "../contract/code-topology.js";
import { selectWorkspaceTopologyRole, type TopologyRoleSnapshot } from "../contract/topology-role-snapshot.js";
import { selectGitTopologyRole } from "../contract/git-artifact-snapshot.js";
import { ImmutableCodeTopologySnapshotStore } from "../contract/compact-code-topology-store.js";
import {
  composeIntentAwareRoleSnapshot,
  selectGitManifestRole,
  selectWorkspaceManifestRole,
  type IntentAwareRoleSnapshot,
  type ManifestLifecycleStatus,
} from "../contract/intent-aware-role-snapshot.js";
import { codeTopologyRuntimeCompatibility } from "../contract/code-topology-indexer.js";
import type {
  CodeTopologyReadStore,
  CodeTopologyTraversalGenerationSummary,
  TopologyAssetKind,
} from "../domain/code-topology-store.js";
import { config } from "../config.js";
import { getCodeTopologyStore } from "../code-topology-store.js";
import { findTielineWorkspace, type TielineWorkspace } from "../tieline/workspace.js";
import type { CommandIO } from "./shared.js";

export interface CodeTopologyLocatorInput {
  path: string;
  kind?: TopologyAssetKind;
  selector?: string | null;
  frameworkHint?: string | null;
}

interface SharedCodeTopologyOptions {
  repositoryRoot?: string;
  repository: string;
  revision?: string;
  generation?: string;
  direction?: CodeTopologyDirection;
  role?: CodeTopologyGenerationRole;
  limits?: Partial<CodeTopologyTraversalLimits>;
}

export interface DependencyTraceCommandOptions extends SharedCodeTopologyOptions {
  locator: CodeTopologyLocatorInput;
  json?: boolean;
}

export interface BlastRadiusChangeInput extends CodeTopologyLocatorInput {
  status?: "added" | "modified";
}

export interface BlastRadiusCommandOptions
  extends Omit<SharedCodeTopologyOptions, "revision" | "generation" | "role"> {
  base?: string;
  changes?: readonly BlastRadiusChangeInput[];
  json?: boolean;
}

export type CodeTopologyUnavailableStatus =
  | "no_workspace"
  | "no_manifest"
  | "generation_unavailable"
  | "incompatible_generation"
  | "repository_mismatch"
  | "capacity_exceeded"
  | "source_unavailable"
  | "workspace_changed"
  | "topology_missing"
  | "topology_missing_at_revision"
  | "topology_stale"
  | "topology_incompatible"
  | "topology_invalid"
  | "topology_capacity_exceeded"
  | "topology_unsafe_path";

export interface CodeTopologyUnavailableResult {
  status: CodeTopologyUnavailableStatus;
  repository: string;
  detail: string;
  generation_identity?: string;
}

export type DependencyTracePrimitiveResult =
  | (CodeTopologyTraceResult & { topology_provenance: TopologyRoleProvenance })
  | CodeTopologyUnavailableResult;

type RoleManifestStatus = `base_${ManifestLifecycleStatus}` | `current_${ManifestLifecycleStatus}`;

export type BlastRadiusPrimitiveResult =
  | (Extract<CodeBlastRadiusResult, { status: "complete" }> & {
      topology_provenance: {
        base: TopologyRoleProvenance | null;
        current: TopologyRoleProvenance;
      };
      contract_provenance: {
        base: ContractRoleProvenance | null;
        current: ContractRoleProvenance;
      };
    })
  | Exclude<CodeBlastRadiusResult, { status: "complete" }>
  | {
      status: CodeTopologyUnavailableStatus | "contract_unavailable" | RoleManifestStatus;
      repository: string;
      detail: string;
      generation_identity?: string;
      generation_role?: CodeTopologyGenerationRole;
    };

export interface TopologyRoleProvenance {
  source: "workspace" | "git" | "persisted";
  queried_revision: string | null;
  generation_identity: string;
  selected_input_digest: string | null;
  artifact_digest: string | null;
  projection_digest: string | null;
  warnings: string[];
}

export interface ContractRoleProvenance {
  source: "workspace" | "git";
  queried_revision: string | null;
  manifest_digest: string;
}

function persistedCompatibilityDetail(
  generation: CodeTopologyTraversalGenerationSummary
): string | null {
  const expected = codeTopologyRuntimeCompatibility();
  const actual = generation.header;
  return actual.parser_compatibility_digest !==
    expected.parser_compatibility_digest ||
    actual.resolver_implementation !== expected.resolver_implementation ||
    actual.topology_schema_version !== expected.topology_schema_version ||
    actual.fact_policy_digest !== expected.fact_policy_digest
    ? `Persisted topology generation '${actual.identity}' was produced by an incompatible parser, resolver, schema, or fact policy.`
    : null;
}

function workspaceAt(path: string | undefined): TielineWorkspace | null {
  return findTielineWorkspace(
    path ?? process.env.TIELINE_WORKSPACE ?? process.cwd()
  );
}

function locator(
  repository: string,
  input: CodeTopologyLocatorInput
): CodeTopologyLocator {
  const path = canonicalRepositoryRelativePath(input.path);
  if (!path) {
    throw new Error(
      `Code topology path '${input.path}' must name a file inside the repository.`
    );
  }
  const parsedSelector =
    input.selector == null ? null : parseSelector(input.selector);
  if (parsedSelector !== null && !parsedSelector.ok) {
    throw new Error(parsedSelector.error);
  }
  return {
    repository,
    kind: input.kind ?? "code",
    path,
    selector: parsedSelector === null ? null : parsedSelector.selector.canonical,
    framework_hint: input.frameworkHint?.normalize("NFC").trim() || null,
  };
}

function sourceOptions(workspace: TielineWorkspace, repository: string) {
  return {
    repositoryRoot: workspace.root,
    repository,
    sourceRoots: workspace.config.repository.source_roots,
    ignore: workspace.config.repository.ignore,
  };
}

function artifactProvenance(snapshot: TopologyRoleSnapshot): TopologyRoleProvenance {
  return {
    source: snapshot.source,
    queried_revision: snapshot.queried_revision,
    generation_identity: snapshot.generation_identity,
    selected_input_digest: snapshot.selected_input_digest,
    artifact_digest: snapshot.artifact_digest,
    projection_digest: snapshot.projection_digest,
    warnings: [...snapshot.warnings],
  };
}

async function selectedGeneration(
  options: SharedCodeTopologyOptions,
  workspace: TielineWorkspace | null
): Promise<
  | {
      status: "complete";
      store: CodeTopologyReadStore;
      summary: CodeTopologyTraversalGenerationSummary;
      provenance: TopologyRoleProvenance;
      dispose(): void;
    }
  | CodeTopologyUnavailableResult
> {
  if (options.generation) {
    if (!config.dbUrl) {
      return {
        status: "generation_unavailable",
        repository: options.repository,
        generation_identity: options.generation,
        detail: "A persisted generation was requested, but DATABASE_URL is not configured.",
      };
    }
    const store = getCodeTopologyStore();
    const generation = await store.getGenerationSummary(options.generation);
    if (!generation || generation.header.repository !== options.repository) {
      return {
        status: "generation_unavailable",
        repository: options.repository,
        generation_identity: options.generation,
        detail: `No complete persisted topology generation '${options.generation}' is available for '${options.repository}'.`,
      };
    }
    const incompatibility = persistedCompatibilityDetail(generation);
    if (incompatibility) {
      return {
        status: "incompatible_generation",
        repository: options.repository,
        generation_identity: generation.header.identity,
        detail: incompatibility,
      };
    }
    return {
      status: "complete",
      store,
      summary: generation,
      provenance: {
        source: "persisted",
        queried_revision: null,
        generation_identity: generation.header.identity,
        selected_input_digest: null,
        artifact_digest: null,
        projection_digest: null,
        warnings: [],
      },
      dispose() {},
    };
  }
  if (!workspace) {
    if (options.revision) {
      return {
        status: "source_unavailable",
        repository: options.repository,
        detail: `Git revision '${options.revision}' requires a readable local workspace; pass generation_identity for a hosted persisted read.`,
      };
    }
    if (!config.dbUrl) {
      return {
        status: "no_workspace",
        repository: options.repository,
        detail: "No Tieline workspace was found and DATABASE_URL is not configured for a hosted persisted read.",
      };
    }
    const identity = await getCodeTopologyStore().getCurrentGenerationIdentity(
      options.repository
    );
    if (!identity) {
      return {
        status: "generation_unavailable",
        repository: options.repository,
        detail: `No current complete topology generation is available for '${options.repository}'.`,
      };
    }
    const store = getCodeTopologyStore();
    const generation = await store.getGenerationSummary(identity);
    if (!generation) {
      return {
        status: "generation_unavailable",
        repository: options.repository,
        generation_identity: identity,
        detail: `The current topology checkpoint '${identity}' is unavailable.`,
      };
    }
    const incompatibility = persistedCompatibilityDetail(generation);
    if (incompatibility) {
      return {
        status: "incompatible_generation",
        repository: options.repository,
        generation_identity: generation.header.identity,
        detail: incompatibility,
      };
    }
    return {
      status: "complete",
      store,
      summary: generation,
      provenance: {
        source: "persisted",
        queried_revision: null,
        generation_identity: generation.header.identity,
        selected_input_digest: null,
        artifact_digest: null,
        projection_digest: null,
        warnings: [],
      },
      dispose() {},
    };
  }
  const selected = options.revision
    ? selectGitTopologyRole({
        ...sourceOptions(workspace, options.repository),
        revision: options.revision,
      })
    : selectWorkspaceTopologyRole(sourceOptions(workspace, options.repository));
  if (selected.status !== "current") {
    return {
      status: selected.status,
      repository: options.repository,
      detail: selected.detail,
      ...(selected.generation_identity
        ? { generation_identity: selected.generation_identity }
        : {}),
    };
  }
  const snapshot = selected.snapshot;
  return {
    status: "complete",
    store: snapshot.store,
    summary: { header: snapshot.metadata.generation, counts: snapshot.metadata.counts },
    provenance: artifactProvenance(snapshot),
    dispose() { snapshot.dispose(); },
  };
}

/** Shared primitive used unchanged by CLI and MCP structured output. */
export async function executeDependencyTrace(
  options: DependencyTraceCommandOptions
): Promise<DependencyTracePrimitiveResult> {
  if (options.revision && options.generation) {
    throw new Error("Choose either revision or generation, not both.");
  }
  const workspace = workspaceAt(options.repositoryRoot);
  if (workspace && workspace.config.product.repo_name !== options.repository) {
    return {
      status: "repository_mismatch",
      repository: options.repository,
      detail: `Workspace '${workspace.root}' declares repository '${workspace.config.product.repo_name}', not '${options.repository}'.`,
    };
  }
  const selected = await selectedGeneration(options, workspace);
  if (selected.status !== "complete") return selected;
  try {
    const result = await traceCodeTopology({
      store: selected.store,
      generation_identity: selected.summary.header.identity,
      generation_role: options.role,
      locator: locator(options.repository, options.locator),
      direction: options.direction,
      limits: options.limits,
    });
    return { ...result, topology_provenance: selected.provenance };
  } finally {
    selected.dispose();
  }
}

function explicitChanges(
  repository: string,
  changes: readonly BlastRadiusChangeInput[] | undefined
): CodeBlastRadiusExplicitChange[] | undefined {
  return changes?.map((change) => ({
    status: change.status ?? "modified",
    locator: locator(repository, change),
  }));
}

/** Shared AC-aware primitive; authored claims remain manifest authority. */
export async function executeChangeBlastRadius(
  options: BlastRadiusCommandOptions
): Promise<BlastRadiusPrimitiveResult> {
  if (Boolean(options.base) === Boolean(options.changes?.length)) {
    throw new Error(
      "Blast radius requires exactly one of a Git base or one or more explicit changed locators."
    );
  }
  const workspace = workspaceAt(options.repositoryRoot);
  if (!workspace) {
    return {
      status: "contract_unavailable",
      repository: options.repository,
      detail: "AC-aware blast radius requires a Tieline workspace so an authored manifest snapshot can be joined; hosted topology alone cannot supply contract authority.",
    };
  }
  if (workspace.config.product.repo_name !== options.repository) {
    return {
      status: "repository_mismatch",
      repository: options.repository,
      detail: `Workspace '${workspace.root}' declares repository '${workspace.config.product.repo_name}', not '${options.repository}'.`,
    };
  }
  const common = sourceOptions(workspace, options.repository);
  const selectCurrent = (): IntentAwareRoleSnapshot | BlastRadiusPrimitiveResult => {
    const topology = selectWorkspaceTopologyRole(common);
    if (topology.status !== "current") {
      return {
        status: topology.status,
        repository: options.repository,
        generation_role: "current",
        detail: topology.detail,
      };
    }
    const contract = selectWorkspaceManifestRole(workspace, options.repository);
    if (contract.status !== "current") {
      topology.snapshot.dispose();
      return {
        status: `current_${contract.status}`,
        repository: options.repository,
        generation_role: "current",
        detail: contract.detail,
      };
    }
    return composeIntentAwareRoleSnapshot({
      topology: topology.snapshot,
      contract: contract.snapshot,
    });
  };
  const current = selectCurrent();
  if (!("topology" in current)) return current;
  let base: IntentAwareRoleSnapshot | undefined;
  let comparisonStore: ImmutableCodeTopologySnapshotStore | undefined;
  try {
    if (options.base) {
      const topology = selectGitTopologyRole({ ...common, revision: options.base });
      if (topology.status !== "current") {
        return {
          status: topology.status,
          repository: options.repository,
          generation_role: "base",
          detail: topology.detail,
        };
      }
      const commit = topology.snapshot.queried_revision!;
      const contract = selectGitManifestRole({
        repositoryRoot: workspace.root,
        repository: options.repository,
        commit,
        manifestPath: workspace.manifestPath,
      });
      if (contract.status !== "current") {
        topology.snapshot.dispose();
        return {
          status: `base_${contract.status}`,
          repository: options.repository,
          generation_role: "base",
          detail: contract.detail,
        };
      }
      base = composeIntentAwareRoleSnapshot({
        topology: topology.snapshot,
        contract: contract.snapshot,
      });
      comparisonStore = new ImmutableCodeTopologySnapshotStore();
      comparisonStore.addReadModel(base.topology.read_model);
      comparisonStore.addReadModel(current.topology.read_model);
      base.topology.dispose();
      current.topology.dispose();
    }
    const currentStore = comparisonStore ?? current.topology.store;
    const result = await analyzeCodeBlastRadius({
      current: {
        store: currentStore,
        generation_identity: current.topology.generation_identity,
      },
      ...(base ? {
        base: {
          store: comparisonStore!,
          generation_identity: base.topology.generation_identity,
        },
      } : {}),
      manifests: {
        current: current.contract.manifest,
        ...(base ? { base: base.contract.manifest } : {}),
      },
      changes: explicitChanges(options.repository, options.changes),
      direction: options.direction,
      limits: options.limits,
    });
    return result.status === "complete" ? {
      ...result,
      topology_provenance: {
        base: base ? artifactProvenance(base.topology) : null,
        current: artifactProvenance(current.topology),
      },
      contract_provenance: {
        base: base ? {
          source: base.contract.source,
          queried_revision: base.contract.queried_revision,
          manifest_digest: base.contract.manifest_digest,
        } : null,
        current: {
          source: current.contract.source,
          queried_revision: current.contract.queried_revision,
          manifest_digest: current.contract.manifest_digest,
        },
      },
    } : result;
  } finally {
    comparisonStore?.dispose();
    base?.dispose();
    current.dispose();
  }
}

export function renderDependencyTraceText(
  result: DependencyTracePrimitiveResult
): string {
  if (result.status !== "complete") {
    return `Code dependency trace: ${result.status}\n${"detail" in result ? result.detail : "The requested topology could not be traced."}\n`;
  }
  let text = `Code dependency trace: complete\n`;
  text += `Generation: ${result.generation_role} ${result.generation_identity} (${result.generation_revision})\n`;
  text += `Direction: ${result.direction}\n`;
  text += `Relationship: derived_code_dependency\n`;
  text += `Visited: ${result.visited.length}; paths: ${result.paths.length}; frontiers: ${result.frontiers.length}\n`;
  text += `Truncated: ${result.truncation.truncated}${result.truncation.reasons.length ? ` (${result.truncation.reasons.join(", ")})` : ""}\n`;
  for (const path of result.paths) {
    text += `  ${path.nodes.map((node) => `${node.locator.path}${node.locator.selector ? `#${node.locator.selector}` : ""}`).join(" -> ")}\n`;
  }
  return text;
}

export function renderBlastRadiusText(
  result: BlastRadiusPrimitiveResult
): string {
  if (result.status !== "complete") {
    return `AC-aware code blast radius: ${result.status}\n${"detail" in result ? result.detail : "The requested blast radius could not be analyzed."}\n`;
  }
  let text = "AC-aware code blast radius: complete (advisory)\n";
  text += `Impact: may_be_impacted; semantic support: not_assessed\n`;
  text += `Direction: ${result.direction}; relationship: derived_code_dependency\n`;
  text += `Current generation: ${result.generations.current.identity}\n`;
  if (result.generations.base) text += `Base generation: ${result.generations.base.identity}\n`;
  text += `Current manifest: ${result.authored_contracts.current.manifest_digest}\n`;
  if (result.authored_contracts.base) {
    text += `Base manifest: ${result.authored_contracts.base.manifest_digest}\n`;
  }
  text += `Visited: ${result.visited.length}; paths: ${result.paths.length}; frontiers: ${result.frontiers.length}; AC joins: ${result.intent_impacts.length}\n`;
  text += `Truncated: ${result.truncation.truncated}${result.truncation.reasons.length ? ` (${result.truncation.reasons.join(", ")})` : ""}\n`;
  for (const impact of result.intent_impacts) {
    text += `  ${impact.acceptance_criterion_stable_id}: may_be_impacted via ${impact.via_relationship}; contract_coupling (${impact.link_scope})\n`;
  }
  return text;
}

export async function runDependencyTraceCommand(
  options: DependencyTraceCommandOptions,
  io: CommandIO
): Promise<number> {
  const result = await executeDependencyTrace(options);
  io.write(
    options.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : renderDependencyTraceText(result)
  );
  return result.status === "complete" ? 0 : 1;
}

export async function runBlastRadiusCommand(
  options: BlastRadiusCommandOptions,
  io: CommandIO
): Promise<number> {
  const result = await executeChangeBlastRadius(options);
  io.write(
    options.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : renderBlastRadiusText(result)
  );
  return result.status === "complete" ? 0 : 1;
}
