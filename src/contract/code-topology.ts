import type {
  CodeTopologyEdgeRecord,
  CodeTopologyFrontierRecord,
  CodeTopologyReadStore,
  CodeTopologyTraversalSymbolRecord,
  TopologyAssetKind,
} from "../domain/code-topology-store.js";
export { ImmutableCodeTopologySnapshotStore } from "./compact-code-topology-store.js";

export type CodeTopologyDirection = "dependencies" | "dependents";
export type CodeTopologyGenerationRole = "base" | "current";

export interface CodeTopologyLocator {
  repository: string;
  kind: TopologyAssetKind;
  path: string;
  selector: string | null;
  framework_hint: string | null;
}

export interface CodeTopologyTraversalLimits {
  depth: number;
  nodes: number;
  edges: number;
  paths: number;
}

export const DEFAULT_CODE_TOPOLOGY_LIMITS: Readonly<CodeTopologyTraversalLimits> =
  Object.freeze({ depth: 4, nodes: 500, edges: 2_000, paths: 100 });

export const MAX_CODE_TOPOLOGY_LIMITS: Readonly<CodeTopologyTraversalLimits> =
  Object.freeze({ depth: 8, nodes: 1_000, edges: 4_000, paths: 200 });

export interface CodeTopologyPathNode {
  generation_role: CodeTopologyGenerationRole;
  generation_identity: string;
  symbol_identity: string;
  locator: CodeTopologyLocator;
  native_kind: string;
}

export interface CodeTopologyPathEdge extends CodeTopologyEdgeRecord {
  generation_role: CodeTopologyGenerationRole;
  relationship: "derived_code_dependency";
}

export interface CodeTopologyTraversalPath {
  relationship: "derived_code_dependency";
  nodes: CodeTopologyPathNode[];
  edges: CodeTopologyPathEdge[];
}

export interface CodeTopologyTraversalFrontier
  extends CodeTopologyFrontierRecord {
  generation_role: CodeTopologyGenerationRole;
  generation_identity: string;
  relationship: "derived_code_dependency";
}

export type CodeTopologyTruncationReason =
  | "depth"
  | "nodes"
  | "edges"
  | "paths";

interface DimensionTruncation {
  limit: number;
  truncated: boolean;
  /** Candidates observed at the bounded expansion boundary. */
  omitted: number;
}

export interface CodeTopologyTruncation {
  truncated: boolean;
  reasons: CodeTopologyTruncationReason[];
  depth: DimensionTruncation;
  nodes: DimensionTruncation;
  edges: DimensionTruncation;
  paths: DimensionTruncation;
}

interface TraceIdentity {
  repository: string;
  generation_identity: string;
  generation_revision: string;
  generation_role: CodeTopologyGenerationRole;
  direction: CodeTopologyDirection;
  limits: CodeTopologyTraversalLimits;
}

export type CodeTopologyTraceResult =
  | (TraceIdentity & {
      status: "complete";
      start: CodeTopologyPathNode;
      visited: CodeTopologyPathNode[];
      paths: CodeTopologyTraversalPath[];
      frontiers: CodeTopologyTraversalFrontier[];
      truncation: CodeTopologyTruncation;
    })
  | {
      status: "generation_unavailable";
      generation_identity: string;
    }
  | (TraceIdentity & {
      status: "repository_mismatch" | "unresolved_start";
      locator: CodeTopologyLocator;
    })
  | (TraceIdentity & {
      status: "ambiguous_start";
      locator: CodeTopologyLocator;
      matches: CodeTopologyPathNode[];
    });

export interface TraceCodeTopologyInput {
  store: CodeTopologyReadStore;
  generation_identity: string;
  generation_role?: CodeTopologyGenerationRole;
  locator: CodeTopologyLocator;
  direction?: CodeTopologyDirection;
  limits?: Partial<CodeTopologyTraversalLimits>;
}

export function resolveCodeTopologyLimits(
  supplied: Partial<CodeTopologyTraversalLimits> | undefined
): CodeTopologyTraversalLimits {
  const limits = { ...DEFAULT_CODE_TOPOLOGY_LIMITS, ...supplied };
  for (const key of Object.keys(limits) as Array<keyof CodeTopologyTraversalLimits>) {
    const value = limits[key];
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Topology ${key} limit must be a positive integer.`);
    }
    if (value > MAX_CODE_TOPOLOGY_LIMITS[key]) {
      throw new Error(
        `Topology ${key} limit ${value} exceeds the hard maximum ${MAX_CODE_TOPOLOGY_LIMITS[key]}.`
      );
    }
  }
  return limits;
}

function pathNode(
  symbol: CodeTopologyTraversalSymbolRecord,
  repository: string,
  generationIdentity: string,
  generationRole: CodeTopologyGenerationRole
): CodeTopologyPathNode {
  return {
    generation_role: generationRole,
    generation_identity: generationIdentity,
    symbol_identity: symbol.identity,
    locator: {
      repository,
      kind: symbol.asset_kind,
      path: symbol.file_path,
      selector: symbol.canonical_selector,
      framework_hint: symbol.framework_hint,
    },
    native_kind: symbol.native_kind,
  };
}

function matchesLocator(
  symbol: CodeTopologyTraversalSymbolRecord,
  locator: CodeTopologyLocator
): boolean {
  return (
    symbol.file_path === locator.path &&
    symbol.asset_kind === locator.kind &&
    symbol.framework_hint === locator.framework_hint &&
    symbol.canonical_selector === locator.selector &&
    // A nullable selector names the file module, never an anonymous declaration.
    (locator.selector !== null || symbol.native_kind === "source_file")
  );
}

function compareEdges(left: CodeTopologyEdgeRecord, right: CodeTopologyEdgeRecord): number {
  return left.identity.localeCompare(right.identity);
}

function nextIdentity(
  edge: CodeTopologyEdgeRecord,
  direction: CodeTopologyDirection
): string {
  return direction === "dependencies"
    ? edge.target.symbol_identity
    : edge.source.symbol_identity;
}

interface IdentityPath {
  nodes: string[];
  edges: CodeTopologyEdgeRecord[];
}

function truncation(
  limits: CodeTopologyTraversalLimits,
  omitted: Record<CodeTopologyTruncationReason, number>
): CodeTopologyTruncation {
  const reasons = (["depth", "nodes", "edges", "paths"] as const).filter(
    (reason) => omitted[reason] > 0
  );
  const dimension = (key: CodeTopologyTruncationReason): DimensionTruncation => ({
    limit: limits[key],
    truncated: omitted[key] > 0,
    omitted: omitted[key],
  });
  return {
    truncated: reasons.length > 0,
    reasons,
    depth: dimension("depth"),
    nodes: dimension("nodes"),
    edges: dimension("edges"),
    paths: dimension("paths"),
  };
}

function edgeForPath(
  edge: CodeTopologyEdgeRecord,
  role: CodeTopologyGenerationRole
): CodeTopologyPathEdge {
  return {
    ...edge,
    generation_role: role,
    relationship: "derived_code_dependency",
  };
}

/**
 * Bounded, deterministic adjacency traversal. Store access is one exact-locator
 * read, one adjacency/frontier pair per depth, and one final symbol hydration.
 */
export async function traceCodeTopology(
  input: TraceCodeTopologyInput
): Promise<CodeTopologyTraceResult> {
  const limits = resolveCodeTopologyLimits(input.limits);
  const role = input.generation_role ?? "current";
  const direction = input.direction ?? "dependencies";
  const summary = await input.store.getGenerationSummary(input.generation_identity);
  if (!summary) {
    return {
      status: "generation_unavailable",
      generation_identity: input.generation_identity,
    };
  }
  const identity: TraceIdentity = {
    repository: summary.header.repository,
    generation_identity: summary.header.identity,
    generation_revision: summary.header.revision,
    generation_role: role,
    direction,
    limits,
  };
  if (input.locator.repository !== summary.header.repository) {
    return { ...identity, status: "repository_mismatch", locator: input.locator };
  }
  const candidates = (
    await input.store.listSymbolsByPaths({
      generation_identity: summary.header.identity,
      paths: [input.locator.path],
    })
  ).filter((symbol) => matchesLocator(symbol, input.locator));
  const orderedCandidates = candidates.sort((left, right) =>
    left.identity.localeCompare(right.identity)
  );
  if (orderedCandidates.length === 0) {
    return { ...identity, status: "unresolved_start", locator: input.locator };
  }
  if (orderedCandidates.length > 1) {
    return {
      ...identity,
      status: "ambiguous_start",
      locator: input.locator,
      matches: orderedCandidates.map((symbol) =>
        pathNode(symbol, identity.repository, identity.generation_identity, role)
      ),
    };
  }

  const start = orderedCandidates[0]!;
  const visited = new Set([start.identity]);
  const visitedOrder = [start.identity];
  const primaryPaths = new Map<string, IdentityPath>([
    [start.identity, { nodes: [start.identity], edges: [] }],
  ]);
  let frontier = [start.identity];
  const paths: IdentityPath[] = [];
  const frontiers = new Map<string, CodeTopologyFrontierRecord>();
  const traversedEdges = new Set<string>();
  const omitted: Record<CodeTopologyTruncationReason, number> = {
    depth: 0,
    nodes: 0,
    edges: 0,
    paths: 0,
  };

  for (let depth = 0; frontier.length > 0; depth += 1) {
    const [edgeBatch, frontierBatch] = await Promise.all([
      direction === "dependencies"
        ? input.store.listForwardEdges({
            generation_identity: identity.generation_identity,
            source_symbol_identities: frontier,
          })
        : input.store.listReverseEdges({
            generation_identity: identity.generation_identity,
            target_symbol_identities: frontier,
          }),
      input.store.listDependencyFrontiers({
        generation_identity: identity.generation_identity,
        source_symbol_identities: frontier,
      }),
    ]);
    for (const gap of frontierBatch) {
      if (frontiers.has(gap.reference_identity)) continue;
      if (frontiers.size + traversedEdges.size >= limits.edges) {
        omitted.edges += 1;
        continue;
      }
      frontiers.set(gap.reference_identity, gap);
    }
    const orderedEdges = [...edgeBatch].sort(compareEdges);
    if (depth >= limits.depth) {
      omitted.depth += orderedEdges.filter((edge) => {
        const source =
          direction === "dependencies"
            ? edge.source.symbol_identity
            : edge.target.symbol_identity;
        const path = primaryPaths.get(source);
        return path !== undefined && !path.nodes.includes(nextIdentity(edge, direction));
      }).length;
      break;
    }

    const nextFrontier: string[] = [];
    for (const edge of orderedEdges) {
      const source =
        direction === "dependencies"
          ? edge.source.symbol_identity
          : edge.target.symbol_identity;
      const sourcePath = primaryPaths.get(source);
      if (!sourcePath) continue;
      const target = nextIdentity(edge, direction);
      if (sourcePath.nodes.includes(target)) continue;
      if (!traversedEdges.has(edge.identity)) {
        if (traversedEdges.size + frontiers.size >= limits.edges) {
          omitted.edges += 1;
          continue;
        }
        traversedEdges.add(edge.identity);
      }
      if (paths.length >= limits.paths) {
        omitted.paths += 1;
        continue;
      }
      const isNewNode = !visited.has(target);
      if (isNewNode && visited.size >= limits.nodes) {
        omitted.nodes += 1;
        continue;
      }
      const candidatePath: IdentityPath = {
        nodes: [...sourcePath.nodes, target],
        edges: [...sourcePath.edges, edge],
      };
      paths.push(candidatePath);
      if (isNewNode) {
        visited.add(target);
        visitedOrder.push(target);
        primaryPaths.set(target, candidatePath);
        nextFrontier.push(target);
      }
    }
    frontier = nextFrontier;
  }

  const hydrated = await input.store.listSymbolsByIdentities({
    generation_identity: identity.generation_identity,
    symbol_identities: visitedOrder,
  });
  const symbols = new Map(hydrated.map((symbol) => [symbol.identity, symbol]));
  // Preserve the exact starting record even if a custom store omits it on hydration.
  symbols.set(start.identity, start);
  const node = (symbolIdentity: string): CodeTopologyPathNode => {
    const symbol = symbols.get(symbolIdentity);
    if (!symbol) {
      throw new Error(`Topology store omitted visited symbol '${symbolIdentity}'.`);
    }
    return pathNode(symbol, identity.repository, identity.generation_identity, role);
  };
  return {
    ...identity,
    status: "complete",
    start: node(start.identity),
    visited: visitedOrder.map(node),
    paths: paths.map((path) => ({
      relationship: "derived_code_dependency",
      nodes: path.nodes.map(node),
      edges: path.edges.map((edge) => edgeForPath(edge, role)),
    })),
    frontiers: [...frontiers.values()]
      .sort((left, right) =>
        left.reference_identity.localeCompare(right.reference_identity)
      )
      .map((frontier) => ({
        ...frontier,
        generation_role: role,
        generation_identity: identity.generation_identity,
        relationship: "derived_code_dependency",
      })),
    truncation: truncation(limits, omitted),
  };
}

export interface TraceCodeTopologyBatchInput
  extends Omit<TraceCodeTopologyInput, "locator"> {
  locators: readonly CodeTopologyLocator[];
}

export interface CodeTopologyBatchStartOutcome {
  locator: CodeTopologyLocator;
  status: "resolved" | "unresolved" | "ambiguous" | "repository_mismatch";
  matches: CodeTopologyPathNode[];
}

export type CodeTopologyBatchTraceResult =
  | {
      status: "generation_unavailable";
      generation_identity: string;
    }
  | (TraceIdentity & {
      status: "complete";
      starts: CodeTopologyPathNode[];
      start_outcomes: CodeTopologyBatchStartOutcome[];
      visited: CodeTopologyPathNode[];
      paths: CodeTopologyTraversalPath[];
      frontiers: CodeTopologyTraversalFrontier[];
      truncation: CodeTopologyTruncation;
    });

/** Multi-source variant used by blast radius so changed symbols share one BFS. */
export async function traceCodeTopologyBatch(
  input: TraceCodeTopologyBatchInput
): Promise<CodeTopologyBatchTraceResult> {
  const limits = resolveCodeTopologyLimits(input.limits);
  const role = input.generation_role ?? "current";
  const direction = input.direction ?? "dependencies";
  const summary = await input.store.getGenerationSummary(input.generation_identity);
  if (!summary) {
    return { status: "generation_unavailable", generation_identity: input.generation_identity };
  }
  const identity: TraceIdentity = {
    repository: summary.header.repository,
    generation_identity: summary.header.identity,
    generation_revision: summary.header.revision,
    generation_role: role,
    direction,
    limits,
  };
  const orderedLocators = [...input.locators].sort((left, right) =>
    [left.repository, left.kind, left.path, left.selector ?? "", left.framework_hint ?? ""].join("\0")
      .localeCompare([right.repository, right.kind, right.path, right.selector ?? "", right.framework_hint ?? ""].join("\0"))
  );
  const byPath = await input.store.listSymbolsByPaths({
    generation_identity: identity.generation_identity,
    paths: [...new Set(orderedLocators.map((locator) => locator.path))].sort(),
  });
  const outcomes: CodeTopologyBatchStartOutcome[] = [];
  const startsByIdentity = new Map<string, CodeTopologyTraversalSymbolRecord>();
  for (const locator of orderedLocators) {
    if (locator.repository !== identity.repository) {
      outcomes.push({ locator, status: "repository_mismatch", matches: [] });
      continue;
    }
    const matches = byPath
      .filter((symbol) => matchesLocator(symbol, locator))
      .sort((left, right) => left.identity.localeCompare(right.identity));
    const matchNodes = matches.map((symbol) =>
      pathNode(symbol, identity.repository, identity.generation_identity, role)
    );
    if (matches.length === 0) outcomes.push({ locator, status: "unresolved", matches: [] });
    else if (matches.length > 1) outcomes.push({ locator, status: "ambiguous", matches: matchNodes });
    else {
      outcomes.push({ locator, status: "resolved", matches: matchNodes });
      startsByIdentity.set(matches[0]!.identity, matches[0]!);
    }
  }

  const omitted: Record<CodeTopologyTruncationReason, number> = {
    depth: 0,
    nodes: 0,
    edges: 0,
    paths: 0,
  };
  const allStarts = [...startsByIdentity.values()].sort((left, right) =>
    left.identity.localeCompare(right.identity)
  );
  if (allStarts.length > limits.nodes) omitted.nodes += allStarts.length - limits.nodes;
  const starts = allStarts.slice(0, limits.nodes);
  const visited = new Set(starts.map((start) => start.identity));
  const visitedOrder = starts.map((start) => start.identity);
  const primaryPaths = new Map<string, IdentityPath>(
    starts.map((start) => [start.identity, { nodes: [start.identity], edges: [] }])
  );
  let frontier = [...visitedOrder];
  const paths: IdentityPath[] = [];
  const frontierRecords = new Map<string, CodeTopologyFrontierRecord>();
  const traversedEdges = new Set<string>();

  for (let depth = 0; frontier.length > 0; depth += 1) {
    const [edgeBatch, gapBatch] = await Promise.all([
      direction === "dependencies"
        ? input.store.listForwardEdges({
            generation_identity: identity.generation_identity,
            source_symbol_identities: frontier,
          })
        : input.store.listReverseEdges({
            generation_identity: identity.generation_identity,
            target_symbol_identities: frontier,
          }),
      input.store.listDependencyFrontiers({
        generation_identity: identity.generation_identity,
        source_symbol_identities: frontier,
      }),
    ]);
    for (const gap of gapBatch) {
      if (frontierRecords.has(gap.reference_identity)) continue;
      if (frontierRecords.size >= limits.edges) {
        omitted.edges += 1;
        continue;
      }
      frontierRecords.set(gap.reference_identity, gap);
    }
    const orderedEdges = [...edgeBatch].sort(compareEdges);
    if (depth >= limits.depth) {
      omitted.depth += orderedEdges.filter((edge) => {
        const source = direction === "dependencies"
          ? edge.source.symbol_identity
          : edge.target.symbol_identity;
        const sourcePath = primaryPaths.get(source);
        return sourcePath !== undefined && !sourcePath.nodes.includes(nextIdentity(edge, direction));
      }).length;
      break;
    }
    const nextFrontier: string[] = [];
    for (const edge of orderedEdges) {
      const source = direction === "dependencies"
        ? edge.source.symbol_identity
        : edge.target.symbol_identity;
      const sourcePath = primaryPaths.get(source);
      if (!sourcePath) continue;
      const target = nextIdentity(edge, direction);
      if (sourcePath.nodes.includes(target)) continue;
      if (!traversedEdges.has(edge.identity)) {
        if (traversedEdges.size + frontierRecords.size >= limits.edges) {
          omitted.edges += 1;
          continue;
        }
        traversedEdges.add(edge.identity);
      }
      if (paths.length >= limits.paths) {
        omitted.paths += 1;
        continue;
      }
      const isNewNode = !visited.has(target);
      if (isNewNode && visited.size >= limits.nodes) {
        omitted.nodes += 1;
        continue;
      }
      const candidatePath = {
        nodes: [...sourcePath.nodes, target],
        edges: [...sourcePath.edges, edge],
      };
      paths.push(candidatePath);
      if (isNewNode) {
        visited.add(target);
        visitedOrder.push(target);
        primaryPaths.set(target, candidatePath);
        nextFrontier.push(target);
      }
    }
    frontier = nextFrontier;
  }

  const hydrated = await input.store.listSymbolsByIdentities({
    generation_identity: identity.generation_identity,
    symbol_identities: visitedOrder,
  });
  const symbols = new Map(hydrated.map((symbol) => [symbol.identity, symbol]));
  for (const start of starts) symbols.set(start.identity, start);
  const node = (symbolIdentity: string): CodeTopologyPathNode => {
    const symbol = symbols.get(symbolIdentity);
    if (!symbol) throw new Error(`Topology store omitted visited symbol '${symbolIdentity}'.`);
    return pathNode(symbol, identity.repository, identity.generation_identity, role);
  };
  return {
    ...identity,
    status: "complete",
    starts: starts.map((start) => node(start.identity)),
    start_outcomes: outcomes,
    visited: visitedOrder.map(node),
    paths: paths.map((path) => ({
      relationship: "derived_code_dependency",
      nodes: path.nodes.map(node),
      edges: path.edges.map((edge) => edgeForPath(edge, role)),
    })),
    frontiers: [...frontierRecords.values()]
      .sort((left, right) => left.reference_identity.localeCompare(right.reference_identity))
      .map((gap) => ({
        ...gap,
        generation_role: role,
        generation_identity: identity.generation_identity,
        relationship: "derived_code_dependency",
      })),
    truncation: truncation(limits, omitted),
  };
}
