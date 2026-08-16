import {
  codeTopologyDerivedEdgeIdentity,
  type CodeTopologyEdgeRecord,
  type CodeTopologyFrontierRecord,
  type CodeTopologyReadStore,
  type CodeTopologyReadModelGeneration,
  type CodeTopologyStoreComparison,
  type CodeTopologyTraversalGenerationSummary,
  type CodeTopologyTraversalSymbolRecord,
  type StoredCodeTopologyGeneration,
  type TopologyAssetKind,
} from "../domain/code-topology-store.js";

interface CompactFile {
  kind: TopologyAssetKind;
  framework_hint: string | null;
  source_hash: string;
}

interface CompactEdge {
  identity?: string;
  kind: string;
  source_symbol_identity: string;
  target_symbol_identity: string;
  reference_identity: string | null;
}

interface CompactGeneration {
  summary: CodeTopologyTraversalGenerationSummary;
  files: Map<string, CompactFile>;
  symbols: Map<string, CodeTopologyTraversalSymbolRecord>;
  symbols_by_path: Map<string, CodeTopologyTraversalSymbolRecord[]>;
  edges: CompactEdge[];
  forward: Map<string, number[]>;
  reverse: Map<string, number[]>;
  frontiers: Map<string, CodeTopologyFrontierRecord[]>;
}

function compactGeneration(generation: StoredCodeTopologyGeneration): CompactGeneration {
  const files = new Map(generation.files.map((file) => [file.path, {
    kind: file.kind,
    framework_hint: file.framework_hint,
    source_hash: file.source_hash,
  }]));
  const symbols = new Map<string, CodeTopologyTraversalSymbolRecord>();
  const symbolsByPath = new Map<string, CodeTopologyTraversalSymbolRecord[]>();
  const modules = new Map<string, string>();
  for (const symbol of generation.symbols) {
    const file = files.get(symbol.file_path);
    if (!file) continue;
    const compact = {
      identity: symbol.identity,
      file_path: symbol.file_path,
      native_kind: symbol.native_kind,
      canonical_selector: symbol.canonical_selector,
      asset_kind: file.kind,
      framework_hint: file.framework_hint,
    };
    symbols.set(compact.identity, compact);
    const pathSymbols = symbolsByPath.get(compact.file_path);
    if (pathSymbols) pathSymbols.push(compact);
    else symbolsByPath.set(compact.file_path, [compact]);
    if (symbol.native_kind === "source_file") modules.set(symbol.file_path, symbol.identity);
  }
  for (const values of symbolsByPath.values()) {
    values.sort((left, right) => left.identity.localeCompare(right.identity));
  }

  const edges: CompactEdge[] = [];
  const forward = new Map<string, number[]>();
  const reverse = new Map<string, number[]>();
  for (const edge of generation.edges) {
    const index = edges.length;
    edges.push({
      identity: edge.identity,
      kind: edge.kind,
      source_symbol_identity: edge.source.symbol_identity,
      target_symbol_identity: edge.target.symbol_identity,
      reference_identity: edge.reference_identity,
    });
    const outgoing = forward.get(edge.source.symbol_identity);
    if (outgoing) outgoing.push(index);
    else forward.set(edge.source.symbol_identity, [index]);
    const incoming = reverse.get(edge.target.symbol_identity);
    if (incoming) incoming.push(index);
    else reverse.set(edge.target.symbol_identity, [index]);
  }

  const resolutionByReference = new Map(generation.resolutions.map((resolution) => [
    resolution.reference_identity,
    resolution,
  ]));
  const frontiers = new Map<string, CodeTopologyFrontierRecord[]>();
  for (const reference of generation.references) {
    const source = reference.owner_symbol_identity ?? modules.get(reference.file_path);
    const resolution = resolutionByReference.get(reference.identity);
    if (!source || !resolution || resolution.status === "resolved" ||
        reference.module_specifier === null ||
        !["import", "dynamic_import", "reexport"].includes(reference.kind)) continue;
    const frontier: CodeTopologyFrontierRecord = {
      reference_identity: reference.identity,
      source_symbol_identity: source,
      file_path: reference.file_path,
      kind: reference.kind,
      module_specifier: reference.module_specifier,
      status: resolution.status,
      rule: resolution.rule,
      candidate_targets: [...resolution.candidate_targets],
      diagnostics: [...resolution.diagnostics],
    };
    const values = frontiers.get(source);
    if (values) values.push(frontier);
    else frontiers.set(source, [frontier]);
  }

  const summary = { header: generation.header, counts: generation.counts };
  return { summary, files, symbols, symbols_by_path: symbolsByPath, edges, forward, reverse, frontiers };
}

function compactReadModel(model: CodeTopologyReadModelGeneration): CompactGeneration {
  const files = new Map(model.files.map((file) => [file.path, file]));
  const symbols = new Map(model.symbols.map((symbol) => [symbol.identity, symbol]));
  const symbolsByPath = new Map<string, CodeTopologyTraversalSymbolRecord[]>();
  for (const symbol of model.symbols) {
    const values = symbolsByPath.get(symbol.file_path);
    if (values) values.push(symbol);
    else symbolsByPath.set(symbol.file_path, [symbol]);
  }
  for (const values of symbolsByPath.values()) {
    values.sort((left, right) => left.identity.localeCompare(right.identity));
  }
  // The read model is already compact. Retain its edge array directly and add
  // only integer adjacency indexes; copying every edge briefly doubles the
  // dominant projection at the store boundary.
  const edges: CompactEdge[] = model.edges;
  const forward = new Map<string, number[]>();
  const reverse = new Map<string, number[]>();
  for (let index = 0; index < edges.length; index += 1) {
    const edge = edges[index]!;
    const outgoing = forward.get(edge.source_symbol_identity);
    if (outgoing) outgoing.push(index);
    else forward.set(edge.source_symbol_identity, [index]);
    const incoming = reverse.get(edge.target_symbol_identity);
    if (incoming) incoming.push(index);
    else reverse.set(edge.target_symbol_identity, [index]);
  }
  const frontiers = new Map<string, CodeTopologyFrontierRecord[]>();
  for (const frontier of model.frontiers) {
    const values = frontiers.get(frontier.source_symbol_identity);
    if (values) values.push(frontier);
    else frontiers.set(frontier.source_symbol_identity, [frontier]);
  }
  return {
    summary: model.summary,
    files,
    symbols,
    symbols_by_path: symbolsByPath,
    edges,
    forward,
    reverse,
    frontiers,
  };
}

function compatibilityKey(generation: CompactGeneration): string {
  const header = generation.summary.header;
  return [
    header.parser_compatibility_digest,
    header.resolver_implementation,
    header.topology_schema_version,
    header.fact_policy_digest,
  ].join("\0");
}

function compareFiles(
  base: CompactGeneration,
  current: CompactGeneration
): CodeTopologyStoreComparison["files"] {
  const deleted = [...base.files].filter(([path]) => !current.files.has(path));
  const added = [...current.files].filter(([path]) => !base.files.has(path));
  const deletedByHash = new Map<string, typeof deleted>();
  const addedByHash = new Map<string, typeof added>();
  for (const value of deleted) {
    deletedByHash.set(value[1].source_hash, [...(deletedByHash.get(value[1].source_hash) ?? []), value]);
  }
  for (const value of added) {
    addedByHash.set(value[1].source_hash, [...(addedByHash.get(value[1].source_hash) ?? []), value]);
  }
  const renamedFrom = new Set<string>();
  const renamedTo = new Set<string>();
  const changes: CodeTopologyStoreComparison["files"] = [];
  for (const [hash, before] of deletedByHash) {
    const after = addedByHash.get(hash) ?? [];
    if (before.length !== 1 || after.length !== 1) continue;
    renamedFrom.add(before[0]![0]);
    renamedTo.add(after[0]![0]);
    changes.push({ status: "renamed", previous_path: before[0]![0], path: after[0]![0] });
  }
  for (const [path] of deleted) if (!renamedFrom.has(path)) changes.push({ status: "deleted", path });
  for (const [path] of added) if (!renamedTo.has(path)) changes.push({ status: "added", path });
  for (const [path, before] of base.files) {
    const after = current.files.get(path);
    if (after && before.source_hash !== after.source_hash) changes.push({ status: "modified", path });
  }
  return changes.sort((left, right) =>
    left.path.localeCompare(right.path) || left.status.localeCompare(right.status)
  );
}

function locator(generation: CompactGeneration, identity: string) {
  const symbol = generation.symbols.get(identity);
  return symbol ? {
    repository: generation.summary.header.repository,
    kind: symbol.asset_kind,
    path: symbol.file_path,
    selector: symbol.canonical_selector,
    framework_hint: symbol.framework_hint,
  } : null;
}

function logicalEdgeKey(generation: CompactGeneration, edge: CompactEdge): string | null {
  const source = locator(generation, edge.source_symbol_identity);
  const target = locator(generation, edge.target_symbol_identity);
  return source && target ? [
    edge.kind,
    source.kind,
    source.path,
    source.selector ?? "",
    source.framework_hint ?? "",
    target.kind,
    target.path,
    target.selector ?? "",
    target.framework_hint ?? "",
  ].join("\0") : null;
}

/**
 * Request-local read projection. Rich reference, resolution, range, and parser
 * facts are reduced to traversal symbols, compact adjacency, and true frontiers.
 */
export class ImmutableCodeTopologySnapshotStore implements CodeTopologyReadStore {
  private readonly generations = new Map<string, CompactGeneration>();

  constructor(generations: readonly StoredCodeTopologyGeneration[] = []) {
    for (const generation of generations) this.addGeneration(generation);
  }

  /** Project one transferred generation and retain none of its persistence-only facts. */
  addGeneration(
    generation: StoredCodeTopologyGeneration
  ): CodeTopologyTraversalGenerationSummary {
    const compact = compactGeneration(generation);
    this.generations.set(generation.header.identity, compact);
    return structuredClone(compact.summary);
  }

  addReadModel(
    model: CodeTopologyReadModelGeneration
  ): CodeTopologyTraversalGenerationSummary {
    const compact = compactReadModel(model);
    this.generations.set(model.summary.header.identity, compact);
    return structuredClone(compact.summary);
  }

  dispose(): void {
    this.generations.clear();
  }

  async getCurrentGenerationIdentity(_repository: string): Promise<string | null> {
    return null;
  }

  async getGenerationSummary(
    identity: string
  ): Promise<CodeTopologyTraversalGenerationSummary | null> {
    const generation = this.generations.get(identity);
    return generation ? structuredClone(generation.summary) : null;
  }

  async listSymbolsByPaths(input: { generation_identity: string; paths: readonly string[] }) {
    const generation = this.generations.get(input.generation_identity);
    if (!generation) return [];
    return [...new Set(input.paths)].flatMap((path) =>
      generation.symbols_by_path.get(path) ?? []
    ).map((symbol) => ({ ...symbol }));
  }

  async listSymbolsByIdentities(input: {
    generation_identity: string;
    symbol_identities: readonly string[];
  }) {
    const generation = this.generations.get(input.generation_identity);
    if (!generation) return [];
    return [...new Set(input.symbol_identities)].flatMap((identity) => {
      const symbol = generation.symbols.get(identity);
      return symbol ? [{ ...symbol }] : [];
    });
  }

  private edge(generationIdentity: string, edge: CompactEdge): CodeTopologyEdgeRecord {
    return {
      identity: edge.identity ?? codeTopologyDerivedEdgeIdentity({
        referenceIdentity: edge.reference_identity ?? "",
        sourceIdentity: edge.source_symbol_identity,
        targetIdentity: edge.target_symbol_identity,
      }),
      kind: edge.kind,
      source: {
        generation_identity: generationIdentity,
        symbol_identity: edge.source_symbol_identity,
      },
      target: {
        generation_identity: generationIdentity,
        symbol_identity: edge.target_symbol_identity,
      },
      reference_identity: edge.reference_identity,
    };
  }

  async listForwardEdges(input: {
    generation_identity: string;
    source_symbol_identities: readonly string[];
  }) {
    const generation = this.generations.get(input.generation_identity);
    if (!generation) return [];
    return [...new Set(input.source_symbol_identities)].flatMap((identity) =>
      (generation.forward.get(identity) ?? []).map((index) =>
        this.edge(input.generation_identity, generation.edges[index]!)
      )
    );
  }

  async listReverseEdges(input: {
    generation_identity: string;
    target_symbol_identities: readonly string[];
  }) {
    const generation = this.generations.get(input.generation_identity);
    if (!generation) return [];
    return [...new Set(input.target_symbol_identities)].flatMap((identity) =>
      (generation.reverse.get(identity) ?? []).map((index) =>
        this.edge(input.generation_identity, generation.edges[index]!)
      )
    );
  }

  async listDependencyFrontiers(input: {
    generation_identity: string;
    source_symbol_identities: readonly string[];
  }) {
    const generation = this.generations.get(input.generation_identity);
    if (!generation) return [];
    return [...new Set(input.source_symbol_identities)].flatMap((identity) =>
      generation.frontiers.get(identity) ?? []
    ).map((frontier) => structuredClone(frontier))
      .sort((left, right) => left.reference_identity.localeCompare(right.reference_identity));
  }

  async compareGenerations(input: {
    base_generation_identity: string;
    current_generation_identity: string;
  }): Promise<CodeTopologyStoreComparison | null> {
    const base = this.generations.get(input.base_generation_identity);
    const current = this.generations.get(input.current_generation_identity);
    if (!base || !current) return null;
    const keyed = (generation: CompactGeneration) => new Map(
      generation.edges.flatMap((edge) => {
        const key = logicalEdgeKey(generation, edge);
        return key ? [[key, edge] as const] : [];
      })
    );
    const before = keyed(base);
    const after = keyed(current);
    const edges: CodeTopologyStoreComparison["edges"] = [];
    const append = (status: "added" | "deleted", generation: CompactGeneration, edge: CompactEdge) => {
      const source = locator(generation, edge.source_symbol_identity);
      const target = locator(generation, edge.target_symbol_identity);
      if (source && target) edges.push({ status, kind: edge.kind, source, target });
    };
    for (const [key, edge] of before) if (!after.has(key)) append("deleted", base, edge);
    for (const [key, edge] of after) if (!before.has(key)) append("added", current, edge);
    edges.sort((left, right) =>
      [left.status, left.kind, left.source.path, left.source.selector ?? "", left.target.path, left.target.selector ?? ""].join("\0")
        .localeCompare([right.status, right.kind, right.source.path, right.source.selector ?? "", right.target.path, right.target.selector ?? ""].join("\0"))
    );
    return {
      base_generation_identity: base.summary.header.identity,
      current_generation_identity: current.summary.header.identity,
      compatibility: compatibilityKey(base) === compatibilityKey(current) ? "compatible" : "incompatible",
      configuration_changed:
        base.summary.header.resolver_configuration_digest !==
        current.summary.header.resolver_configuration_digest,
      files: compareFiles(base, current),
      edges,
    };
  }
}
