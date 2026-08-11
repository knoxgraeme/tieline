import type {
  CodeTopologyReadStore,
  CodeTopologyStoreComparison,
  CodeTopologyTraversalSymbolRecord,
} from "../domain/code-topology-store.js";
import { manifestDigest, type ContractManifest } from "./manifest.js";
import {
  buildContractIntentIndex,
  compareContractClaims,
  type ClaimingCriterion,
} from "./reconciliation.js";
import type { TopologyFileChange } from "./topology-generation.js";
import {
  resolveCodeTopologyLimits,
  traceCodeTopologyBatch,
  type CodeTopologyBatchStartOutcome,
  type CodeTopologyDirection,
  type CodeTopologyGenerationRole,
  type CodeTopologyLocator,
  type CodeTopologyPathNode,
  type CodeTopologyTraversalFrontier,
  type CodeTopologyTraversalLimits,
  type CodeTopologyTraversalPath,
  type CodeTopologyTruncation,
  type CodeTopologyTruncationReason,
} from "./code-topology.js";

export interface CodeTopologyRoleInput {
  store: CodeTopologyReadStore;
  generation_identity: string;
}

export type CodeBlastRadiusExplicitChange =
  | { status: "added" | "deleted" | "modified"; locator: CodeTopologyLocator }
  | {
      status: "renamed";
      locator: CodeTopologyLocator;
      previous_locator: CodeTopologyLocator;
    };

export interface CodeTopologyEdgeChange {
  status: "added" | "deleted";
  kind: string;
  source: CodeTopologyLocator;
  target: CodeTopologyLocator;
}

export interface CodeTopologyChangeSet {
  source: "explicit" | "generation_comparison";
  files: TopologyFileChange[];
  edges: CodeTopologyEdgeChange[];
}

export interface AuthoredContractCheckpoint {
  identity: string;
  /** Comparable revision identity supplied by the caller; never inferred. */
  revision: string | null;
}

export type RevisionDivergence = "aligned" | "diverged" | "unknown";

export interface CodeBlastRadiusIntentImpact {
  impact: "may_be_impacted";
  relationship: "contract_coupling";
  via_relationship: "derived_code_dependency" | "changed_locator";
  semantic_support: "not_assessed";
  generation_role: CodeTopologyGenerationRole;
  generation_identity: string;
  locator: CodeTopologyLocator;
  capability_stable_id: string;
  story_stable_id: string;
  story_title: string;
  acceptance_criterion_stable_id: string;
  acceptance_criterion: string;
  relation: ClaimingCriterion["relation"];
  provenance: ClaimingCriterion["provenance"];
  link_scope: ClaimingCriterion["link_scope"];
  match_precision: "exact_selector" | "file_level";
}

export interface AnalyzeCodeBlastRadiusInput {
  current: CodeTopologyRoleInput;
  base?: CodeTopologyRoleInput;
  manifest: ContractManifest;
  authored_checkpoint?: AuthoredContractCheckpoint;
  changes?: readonly CodeBlastRadiusExplicitChange[];
  direction?: CodeTopologyDirection;
  limits?: Partial<CodeTopologyTraversalLimits>;
}

interface CompleteCodeBlastRadiusResult {
  status: "complete";
  advisory: true;
  impact: "may_be_impacted";
  direction: CodeTopologyDirection;
  topology_changes: CodeTopologyChangeSet;
  generations: {
    base: { identity: string; revision: string } | null;
    current: { identity: string; revision: string };
  };
  authored_contract: {
    manifest_digest: string;
    checkpoint_identity: string | null;
    revision: string | null;
  };
  revision_divergence: {
    base: RevisionDivergence | null;
    current: RevisionDivergence;
  };
  visited: CodeTopologyPathNode[];
  paths: CodeTopologyTraversalPath[];
  frontiers: CodeTopologyTraversalFrontier[];
  start_outcomes: CodeTopologyBatchStartOutcome[];
  intent_impacts: CodeBlastRadiusIntentImpact[];
  truncation: CodeTopologyTruncation & { omitted_starts: number };
}

export type CodeBlastRadiusResult =
  | CompleteCodeBlastRadiusResult
  | {
      status: "generation_unavailable";
      generation_role: CodeTopologyGenerationRole;
      generation_identity: string;
    }
  | {
      status: "incompatible_generations";
      base_generation_identity: string;
      current_generation_identity: string;
    };

function locatorKey(locator: CodeTopologyLocator): string {
  return [
    locator.repository,
    locator.kind,
    locator.path,
    locator.selector ?? "",
    locator.framework_hint ?? "",
  ].join("\0");
}

interface Start {
  role: CodeTopologyGenerationRole;
  locator: CodeTopologyLocator;
}

function startsFromExplicit(changes: readonly CodeBlastRadiusExplicitChange[]): Start[] {
  return changes.flatMap((change): Start[] => {
    if (change.status === "added") return [{ role: "current", locator: change.locator }];
    if (change.status === "deleted") return [{ role: "base", locator: change.locator }];
    if (change.status === "renamed") {
      return [
        { role: "base", locator: change.previous_locator },
        { role: "current", locator: change.locator },
      ];
    }
    return [
      { role: "base", locator: change.locator },
      { role: "current", locator: change.locator },
    ];
  });
}

function symbolLocator(
  repository: string,
  symbol: CodeTopologyTraversalSymbolRecord
): CodeTopologyLocator {
  return {
    repository,
    kind: symbol.asset_kind,
    path: symbol.file_path,
    selector: symbol.canonical_selector,
    framework_hint: symbol.framework_hint,
  };
}

async function startsFromComparison(
  files: readonly TopologyFileChange[],
  edges: readonly CodeTopologyEdgeChange[],
  base: CodeTopologyRoleInput,
  current: CodeTopologyRoleInput,
  repository: string
): Promise<Start[]> {
  const starts: Start[] = [];
  const basePaths = new Set<string>();
  const currentPaths = new Set<string>();
  for (const change of files) {
    if (change.status === "added") currentPaths.add(change.path);
    else if (change.status === "deleted") basePaths.add(change.path);
    else if (change.status === "renamed") {
      basePaths.add(change.previous_path);
      currentPaths.add(change.path);
    } else {
      basePaths.add(change.path);
      currentPaths.add(change.path);
    }
  }
  const [baseSymbols, currentSymbols] = await Promise.all([
    base.store.listSymbolsByPaths({
      generation_identity: base.generation_identity,
      paths: [...basePaths].sort(),
    }),
    current.store.listSymbolsByPaths({
      generation_identity: current.generation_identity,
      paths: [...currentPaths].sort(),
    }),
  ]);
  starts.push(...baseSymbols.map((symbol) => ({
    role: "base" as const,
    locator: symbolLocator(repository, symbol),
  })));
  starts.push(...currentSymbols.map((symbol) => ({
    role: "current" as const,
    locator: symbolLocator(repository, symbol),
  })));
  for (const change of edges) {
    const role = change.status === "added" ? "current" : "base";
    starts.push({ role, locator: change.source }, { role, locator: change.target });
  }
  return starts;
}

function divergence(
  topologyRevision: string,
  authoredRevision: string | null | undefined
): RevisionDivergence {
  if (!authoredRevision) return "unknown";
  return topologyRevision === authoredRevision ? "aligned" : "diverged";
}

function claimsForNode(
  node: CodeTopologyPathNode,
  claims: readonly ClaimingCriterion[]
): ClaimingCriterion[] {
  return claims
    .filter(
      (claim) =>
        claim.repository === node.locator.repository &&
        claim.target_kind === node.locator.kind &&
        claim.linked_path === node.locator.path &&
        (claim.selector === node.locator.selector || claim.selector === null) &&
        claim.framework_hint === node.locator.framework_hint
    )
    .sort(compareContractClaims);
}

/** Computes code reachability first, then performs an exact authored-locator join. */
export async function analyzeCodeBlastRadius(
  input: AnalyzeCodeBlastRadiusInput
): Promise<CodeBlastRadiusResult> {
  const [base, current] = await Promise.all([
    input.base?.store.getGenerationSummary(input.base.generation_identity) ?? Promise.resolve(null),
    input.current.store.getGenerationSummary(input.current.generation_identity),
  ]);
  if (!current) {
    return {
      status: "generation_unavailable",
      generation_role: "current",
      generation_identity: input.current.generation_identity,
    };
  }
  if (input.base && !base) {
    return {
      status: "generation_unavailable",
      generation_role: "base",
      generation_identity: input.base.generation_identity,
    };
  }
  let comparison: CodeTopologyStoreComparison | null = null;
  if (input.base && base) {
    comparison = input.base.store === input.current.store
      ? await input.current.store.compareGenerations({
          base_generation_identity: input.base.generation_identity,
          current_generation_identity: input.current.generation_identity,
        })
      : input.changes
        ? {
            base_generation_identity: base.header.identity,
            current_generation_identity: current.header.identity,
            compatibility:
              [base.header.parser_compatibility_digest, base.header.resolver_implementation,
                base.header.topology_schema_version, base.header.fact_policy_digest].join("\0") ===
              [current.header.parser_compatibility_digest, current.header.resolver_implementation,
                current.header.topology_schema_version, current.header.fact_policy_digest].join("\0")
                ? "compatible"
                : "incompatible",
            configuration_changed:
              base.header.resolver_configuration_digest !==
              current.header.resolver_configuration_digest,
            files: [],
            edges: [],
          }
        : null;
    if (!comparison) {
      return {
        status: "generation_unavailable",
        generation_role: "base",
        generation_identity: input.base.generation_identity,
      };
    }
  }
  if (comparison?.compatibility === "incompatible") {
    return {
      status: "incompatible_generations",
      base_generation_identity: base!.header.identity,
      current_generation_identity: current.header.identity,
    };
  }
  const edges: CodeTopologyEdgeChange[] = comparison?.edges ?? [];
  const topologyChanges: CodeTopologyChangeSet = {
    source: input.changes ? "explicit" : "generation_comparison",
    files: input.changes
      ? input.changes.map((change): TopologyFileChange =>
          change.status === "renamed"
            ? { status: "renamed", path: change.locator.path, previous_path: change.previous_locator.path }
            : { status: change.status, path: change.locator.path }
        )
      : (comparison?.files ?? []),
    edges,
  };
  let starts = input.changes
    ? startsFromExplicit(input.changes)
    : input.base && base
      ? await startsFromComparison(
          topologyChanges.files,
          edges,
          input.base,
          input.current,
          current.header.repository
        )
      : [];
  const seenStarts = new Set<string>();
  starts = starts.filter((start) => {
    if (start.role === "base" && !input.base) return false;
    const key = `${start.role}\0${locatorKey(start.locator)}`;
    if (seenStarts.has(key)) return false;
    seenStarts.add(key);
    return true;
  });
  const direction = input.direction ?? "dependents";
  const limits = resolveCodeTopologyLimits(input.limits);

  const nodeMap = new Map<string, CodeTopologyPathNode>();
  const pathMap = new Map<string, CodeTopologyTraversalPath>();
  const frontierMap = new Map<string, CodeTopologyTraversalFrontier>();
  const reasons = new Set<CodeTopologyTruncationReason>();
  const omitted = { depth: 0, nodes: 0, edges: 0, paths: 0 };
  const startOutcomes: CodeTopologyBatchStartOutcome[] = [];
  let omittedStarts = 0;
  // Current code is the useful default. Base consumes only the remaining global budget.
  for (const roleName of ["current", "base"] as const) {
    const roleStarts = starts.filter((start) => start.role === roleName);
    if (roleStarts.length === 0) continue;
    const roleIdentity = roleName === "base"
      ? input.base?.generation_identity
      : input.current.generation_identity;
    const usedEdges = new Set(
      [...pathMap.values()].flatMap((path) => path.edges.map((edge) =>
        `${edge.generation_role}\0${edge.identity}`
      ))
    ).size + frontierMap.size;
    const remainingNodes = limits.nodes - nodeMap.size;
    const remainingEdges = limits.edges - usedEdges;
    const remainingPaths = limits.paths - pathMap.size;
    if (!roleIdentity || remainingNodes < 1 || remainingEdges < 1 || remainingPaths < 1) {
      omittedStarts += roleStarts.length;
      if (remainingNodes < 1) { reasons.add("nodes"); omitted.nodes += roleStarts.length; }
      if (remainingEdges < 1) { reasons.add("edges"); omitted.edges += roleStarts.length; }
      if (remainingPaths < 1) { reasons.add("paths"); omitted.paths += roleStarts.length; }
      continue;
    }
    const trace = await traceCodeTopologyBatch({
      store: roleName === "base" ? input.base!.store : input.current.store,
      generation_identity: roleIdentity,
      generation_role: roleName,
      locators: roleStarts.map((start) => start.locator),
      direction,
      limits: {
        depth: limits.depth,
        nodes: remainingNodes,
        edges: remainingEdges,
        paths: remainingPaths,
      },
    });
    if (trace.status !== "complete") continue;
    startOutcomes.push(...trace.start_outcomes);
    for (const reason of trace.truncation.reasons) reasons.add(reason);
    for (const dimension of ["depth", "nodes", "edges", "paths"] as const) {
      omitted[dimension] += trace.truncation[dimension].omitted;
    }
    for (const node of trace.visited) {
      const key = `${node.generation_role}\0${node.generation_identity}\0${node.symbol_identity}`;
      if (nodeMap.size < limits.nodes || nodeMap.has(key)) nodeMap.set(key, node);
      else { reasons.add("nodes"); omitted.nodes += 1; }
    }
    for (const path of trace.paths) {
      const key = `${path.nodes.map((node) => `${node.generation_role}:${node.symbol_identity}`).join("->")}\0${path.edges.map((edge) => edge.identity).join("->")}`;
      if (pathMap.size < limits.paths || pathMap.has(key)) pathMap.set(key, path);
      else { reasons.add("paths"); omitted.paths += 1; }
    }
    for (const frontier of trace.frontiers) {
      frontierMap.set(`${frontier.generation_role}\0${frontier.reference_identity}`, frontier);
    }
  }
  if (omittedStarts > 0 && !reasons.has("nodes") && !reasons.has("edges")) {
    reasons.add("paths");
    omitted.paths += omittedStarts;
  }
  const visited = [...nodeMap.values()];
  const index = buildContractIntentIndex(input.manifest);
  const impacts: CodeBlastRadiusIntentImpact[] = [];
  const reachedByPath = new Set(
    [...pathMap.values()].flatMap((path) => path.nodes.slice(1).map((node) =>
      `${node.generation_role}\0${node.generation_identity}\0${node.symbol_identity}`
    ))
  );
  for (const node of visited) {
    const nodeKey = `${node.generation_role}\0${node.generation_identity}\0${node.symbol_identity}`;
    for (const claim of claimsForNode(node, index.claims_by_path.get(node.locator.path) ?? [])) {
      impacts.push({
        impact: "may_be_impacted",
        relationship: "contract_coupling",
        via_relationship: reachedByPath.has(nodeKey)
          ? "derived_code_dependency"
          : "changed_locator",
        semantic_support: "not_assessed",
        generation_role: node.generation_role,
        generation_identity: node.generation_identity,
        locator: node.locator,
        capability_stable_id: claim.capability_stable_id,
        story_stable_id: claim.story_stable_id,
        story_title: claim.story_title,
        acceptance_criterion_stable_id: claim.acceptance_criterion_stable_id,
        acceptance_criterion: claim.acceptance_criterion,
        relation: claim.relation,
        provenance: claim.provenance,
        link_scope: claim.link_scope,
        match_precision:
          claim.selector === node.locator.selector
            ? "exact_selector"
            : "file_level",
      });
    }
  }
  impacts.sort((left, right) =>
    `${left.acceptance_criterion_stable_id}\0${left.generation_role}\0${locatorKey(left.locator)}\0${left.link_scope}`.localeCompare(
      `${right.acceptance_criterion_stable_id}\0${right.generation_role}\0${locatorKey(right.locator)}\0${right.link_scope}`
    )
  );

  return {
    status: "complete",
    advisory: true,
    impact: "may_be_impacted",
    direction,
    topology_changes: topologyChanges,
    generations: {
      base: base ? { identity: base.header.identity, revision: base.header.revision } : null,
      current: { identity: current.header.identity, revision: current.header.revision },
    },
    authored_contract: {
      manifest_digest: manifestDigest(input.manifest),
      checkpoint_identity: input.authored_checkpoint?.identity ?? null,
      revision: input.authored_checkpoint?.revision ?? null,
    },
    revision_divergence: {
      base: base ? divergence(base.header.revision, input.authored_checkpoint?.revision) : null,
      current: divergence(current.header.revision, input.authored_checkpoint?.revision),
    },
    visited,
    paths: [...pathMap.values()],
    frontiers: [...frontierMap.values()].sort((left, right) =>
      `${left.generation_role}\0${left.reference_identity}`.localeCompare(
        `${right.generation_role}\0${right.reference_identity}`
      )
    ),
    start_outcomes: startOutcomes,
    intent_impacts: impacts,
    truncation: {
      truncated: reasons.size > 0,
      reasons: (["depth", "nodes", "edges", "paths"] as const).filter((reason) => reasons.has(reason)),
      depth: { limit: limits.depth, truncated: omitted.depth > 0, omitted: omitted.depth },
      nodes: { limit: limits.nodes, truncated: omitted.nodes > 0, omitted: omitted.nodes },
      edges: { limit: limits.edges, truncated: omitted.edges > 0, omitted: omitted.edges },
      paths: { limit: limits.paths, truncated: omitted.paths > 0, omitted: omitted.paths },
      omitted_starts: omittedStarts,
    },
  };
}
