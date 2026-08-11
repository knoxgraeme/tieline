import { readContractManifest } from "../contract/manifest.js";
import { canonicalRepositoryRelativePath } from "../contract/paths.js";
import { parseSelector } from "../contract/selector.js";
import {
  analyzeCodeBlastRadius,
  type CodeBlastRadiusExplicitChange,
  type CodeBlastRadiusResult,
} from "../contract/code-blast-radius.js";
import {
  ImmutableCodeTopologySnapshotStore,
  traceCodeTopology,
  type CodeTopologyDirection,
  type CodeTopologyGenerationRole,
  type CodeTopologyLocator,
  type CodeTopologyTraceResult,
  type CodeTopologyTraversalLimits,
} from "../contract/code-topology.js";
import {
  buildCommittedTopologyGeneration,
  buildTopologyRoles,
  TopologyGenerationService,
} from "../contract/topology-generation.js";
import { codeTopologyRuntimeCompatibility } from "../contract/code-topology-indexer.js";
import type {
  CompleteCodeTopologyGeneration,
  StoredCodeTopologyGeneration,
  TopologyAssetKind,
} from "../domain/code-topology-store.js";
import {
  codeTopologyFactsDigest,
  codeTopologyGenerationCounts,
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
  | "workspace_changed";

export interface CodeTopologyUnavailableResult {
  status: CodeTopologyUnavailableStatus;
  repository: string;
  detail: string;
  generation_identity?: string;
}

export type DependencyTracePrimitiveResult =
  | CodeTopologyTraceResult
  | CodeTopologyUnavailableResult;

export type BlastRadiusPrimitiveResult =
  | CodeBlastRadiusResult
  | {
      status: CodeTopologyUnavailableStatus | "contract_unavailable";
      repository: string;
      detail: string;
      generation_identity?: string;
    };

const generationService = new TopologyGenerationService();

function persistedCompatibilityDetail(
  generation: StoredCodeTopologyGeneration
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

function stored(
  generation: CompleteCodeTopologyGeneration
): StoredCodeTopologyGeneration {
  return {
    ...generation,
    facts_digest: codeTopologyFactsDigest(generation),
    counts: codeTopologyGenerationCounts(generation),
    completed_at: "1970-01-01T00:00:00.000Z",
    pinned: false,
  };
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

function buildFailure(
  repository: string,
  result: Exclude<
    Awaited<ReturnType<TopologyGenerationService["buildWorkspace"]>>,
    { status: "complete" }
  >
): CodeTopologyUnavailableResult {
  return {
    status: result.status,
    repository,
    detail: result.detail,
  };
}

async function selectedGeneration(
  options: SharedCodeTopologyOptions,
  workspace: TielineWorkspace | null
): Promise<
  | { status: "complete"; generation: StoredCodeTopologyGeneration }
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
    const generation = await getCodeTopologyStore().getGeneration(
      options.generation
    );
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
    return { status: "complete", generation };
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
    const generation = await getCodeTopologyStore().getGeneration(identity);
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
    return { status: "complete", generation };
  }
  const built = options.revision
    ? await buildCommittedTopologyGeneration({
        ...sourceOptions(workspace, options.repository),
        revision: options.revision,
      })
    : await generationService.buildWorkspace(
        sourceOptions(workspace, options.repository)
      );
  if (built.status !== "complete") return buildFailure(options.repository, built);
  return { status: "complete", generation: stored(built.generation) };
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
  return traceCodeTopology({
    store: new ImmutableCodeTopologySnapshotStore([selected.generation]),
    generation_identity: selected.generation.header.identity,
    generation_role: options.role,
    locator: locator(options.repository, options.locator),
    direction: options.direction,
    limits: options.limits,
  });
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
  let manifest;
  try {
    manifest = readContractManifest(workspace.manifestPath);
  } catch (error) {
    return {
      status: "no_manifest",
      repository: options.repository,
      detail: `The contract manifest '${workspace.manifestPath}' is missing or unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const common = sourceOptions(workspace, options.repository);
  let base: StoredCodeTopologyGeneration | undefined;
  let current: StoredCodeTopologyGeneration;
  if (options.base) {
    const roles = await buildTopologyRoles({
      base: { ...common, revision: options.base },
      current: common,
      currentKind: "workspace",
    });
    if (roles.status !== "complete") return buildFailure(options.repository, roles);
    base = stored(roles.base);
    current = stored(roles.current);
  } else {
    const selected = await selectedGeneration(options, workspace);
    if (selected.status !== "complete") return selected;
    current = selected.generation;
  }
  const generations = base ? [base, current] : [current];
  const snapshot = new ImmutableCodeTopologySnapshotStore(generations);
  return analyzeCodeBlastRadius({
    current: { store: snapshot, generation_identity: current.header.identity },
    ...(base
      ? { base: { store: snapshot, generation_identity: base.header.identity } }
      : {}),
    manifest,
    changes: explicitChanges(options.repository, options.changes),
    direction: options.direction,
    limits: options.limits,
  });
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
  text += `Manifest: ${result.authored_contract.manifest_digest}\n`;
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
  return 0;
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
  return 0;
}
