import {
  CodeTopologyCheckpointConflictError,
  CodeTopologyIntegrityError,
  codeTopologyFactsDigestNormalized,
  codeTopologyGenerationCounts,
  normalizeCompleteCodeTopologyGeneration,
  validateCompleteCodeTopologyGeneration,
  type CodeTopologyEdgeRecord,
  type CodeTopologyFrontierRecord,
  type CodeTopologyGenerationSummary,
  type CodeTopologyLocatedSymbolRecord,
  type CodeTopologyStore,
  type CommitCodeTopologyGenerationResult,
  type CompleteCodeTopologyGeneration,
  type DeleteCodeTopologyGenerationsResult,
  type StoredCodeTopologyGeneration,
} from "../../../src/domain/code-topology-store.js";
import { ImmutableCodeTopologySnapshotStore } from "../../../src/contract/compact-code-topology-store.js";

export type FakeCodeTopologyFailurePoint =
  | "generation"
  | "files"
  | "symbols"
  | "references"
  | "resolutions"
  | "edges"
  | "promotion";

export interface FakeCodeTopologyStoreOptions {
  failurePoint?: FakeCodeTopologyFailurePoint;
}

export class FakeCodeTopologyStore implements CodeTopologyStore {
  private generations = new Map<string, StoredCodeTopologyGeneration>();
  private checkpoints = new Map<string, string>();
  private readonly failurePoint: FakeCodeTopologyFailurePoint | undefined;

  constructor(options: FakeCodeTopologyStoreOptions = {}) {
    this.failurePoint = options.failurePoint;
  }

  private failAfter(point: FakeCodeTopologyFailurePoint): void {
    if (this.failurePoint === point) {
      throw new Error(`Injected failure after ${point}`);
    }
  }

  async commitGeneration(input: {
    generation: CompleteCodeTopologyGeneration;
    expected_previous_generation_identity: string | null;
  }): Promise<CommitCodeTopologyGenerationResult> {
    validateCompleteCodeTopologyGeneration(input.generation);
    const generation = normalizeCompleteCodeTopologyGeneration(input.generation);
    const identity = generation.header.identity;
    const current = this.checkpoints.get(generation.header.repository) ?? null;
    if (
      current !== input.expected_previous_generation_identity &&
      current !== identity
    ) {
      throw new CodeTopologyCheckpointConflictError(
        input.expected_previous_generation_identity,
        current
      );
    }

    const stagedGenerations = new Map(this.generations);
    const stagedCheckpoints = new Map(this.checkpoints);
    const existing = stagedGenerations.get(identity);
    let outcome: CommitCodeTopologyGenerationResult["outcome"] = "inserted";
    if (existing) {
      const incomingDigest = codeTopologyFactsDigestNormalized(generation);
      if (
        incomingDigest !== existing.facts_digest ||
        JSON.stringify(generation.header) !== JSON.stringify(existing.header)
      ) {
        throw new CodeTopologyIntegrityError(
          `Generation '${identity}' already exists with different metadata or facts.`
        );
      }
      outcome = "existing";
    } else {
      const staged: CompleteCodeTopologyGeneration = {
        header: structuredClone(generation.header),
        files: [],
        symbols: [],
        references: [],
        resolutions: [],
        edges: [],
      };
      this.failAfter("generation");
      staged.files = structuredClone(generation.files);
      this.failAfter("files");
      staged.symbols = structuredClone(generation.symbols);
      this.failAfter("symbols");
      staged.references = structuredClone(generation.references);
      this.failAfter("references");
      staged.resolutions = structuredClone(generation.resolutions);
      this.failAfter("resolutions");
      staged.edges = structuredClone(generation.edges);
      this.failAfter("edges");
      stagedGenerations.set(identity, {
        ...staged,
        facts_digest: codeTopologyFactsDigestNormalized(staged),
        counts: codeTopologyGenerationCounts(staged),
        completed_at: new Date().toISOString(),
        pinned: false,
      });
    }
    stagedCheckpoints.set(generation.header.repository, identity);
    this.failAfter("promotion");
    this.generations = stagedGenerations;
    this.checkpoints = stagedCheckpoints;
    return {
      outcome,
      generation_identity: identity,
      previous_generation_identity: current,
    };
  }

  async getCurrentGenerationIdentity(repository: string): Promise<string | null> {
    return this.checkpoints.get(repository) ?? null;
  }

  async getGeneration(identity: string): Promise<StoredCodeTopologyGeneration | null> {
    const generation = this.generations.get(identity);
    return generation ? structuredClone(generation) : null;
  }

  async getGenerations(
    identities: readonly string[]
  ): Promise<StoredCodeTopologyGeneration[]> {
    return [...new Set(identities)]
      .map((identity) => this.generations.get(identity))
      .filter((generation): generation is StoredCodeTopologyGeneration => generation !== undefined)
      .map((generation) => structuredClone(generation));
  }

  async getGenerationSummary(
    identity: string
  ): Promise<CodeTopologyGenerationSummary | null> {
    const generation = this.generations.get(identity);
    if (!generation) return null;
    const { files: _files, symbols: _symbols, references: _references,
      resolutions: _resolutions, edges: _edges, ...summary } = generation;
    return structuredClone(summary);
  }

  private locatedSymbols(
    generationIdentity: string,
    include: (identity: string, path: string) => boolean
  ): CodeTopologyLocatedSymbolRecord[] {
    const generation = this.generations.get(generationIdentity);
    if (!generation) return [];
    const files = new Map(generation.files.map((file) => [file.path, file]));
    return generation.symbols
      .filter((symbol) => include(symbol.identity, symbol.file_path))
      .map((symbol) => {
        const file = files.get(symbol.file_path)!;
        return {
          ...structuredClone(symbol),
          asset_kind: file.kind,
          framework_hint: file.framework_hint,
        };
      })
      .sort((left, right) => left.identity.localeCompare(right.identity));
  }

  async listSymbolsByPaths(input: {
    generation_identity: string;
    paths: readonly string[];
  }): Promise<CodeTopologyLocatedSymbolRecord[]> {
    const paths = new Set(input.paths);
    return this.locatedSymbols(
      input.generation_identity,
      (_identity, path) => paths.has(path)
    );
  }

  async listSymbolsByIdentities(input: {
    generation_identity: string;
    symbol_identities: readonly string[];
  }): Promise<CodeTopologyLocatedSymbolRecord[]> {
    const identities = new Set(input.symbol_identities);
    return this.locatedSymbols(
      input.generation_identity,
      (identity) => identities.has(identity)
    );
  }

  async listForwardEdges(input: {
    generation_identity: string;
    source_symbol_identities: readonly string[];
  }): Promise<CodeTopologyEdgeRecord[]> {
    const generation = this.generations.get(input.generation_identity);
    if (!generation) return [];
    const sources = new Set(input.source_symbol_identities);
    return structuredClone(
      generation.edges.filter((edge) => sources.has(edge.source.symbol_identity))
    );
  }

  async listReverseEdges(input: {
    generation_identity: string;
    target_symbol_identities: readonly string[];
  }): Promise<CodeTopologyEdgeRecord[]> {
    const generation = this.generations.get(input.generation_identity);
    if (!generation) return [];
    const targets = new Set(input.target_symbol_identities);
    return structuredClone(
      generation.edges.filter((edge) => targets.has(edge.target.symbol_identity))
    );
  }

  async listDependencyFrontiers(input: {
    generation_identity: string;
    source_symbol_identities: readonly string[];
  }): Promise<CodeTopologyFrontierRecord[]> {
    const generation = this.generations.get(input.generation_identity);
    if (!generation) return [];
    const sources = new Set(input.source_symbol_identities);
    const modulesByPath = new Map(
      generation.symbols
        .filter((symbol) => symbol.native_kind === "source_file")
        .map((symbol) => [symbol.file_path, symbol.identity])
    );
    const resolutions = new Map(
      generation.resolutions.map((resolution) => [
        resolution.reference_identity,
        resolution,
      ])
    );
    return generation.references
      .flatMap((reference): CodeTopologyFrontierRecord[] => {
        const source =
          reference.owner_symbol_identity ?? modulesByPath.get(reference.file_path);
        const resolution = resolutions.get(reference.identity);
        if (
          !source ||
          !sources.has(source) ||
          !resolution ||
          resolution.status === "resolved" ||
          reference.module_specifier === null ||
          (reference.kind !== "import" &&
            reference.kind !== "dynamic_import" &&
            reference.kind !== "reexport")
        ) return [];
        return [{
          reference_identity: reference.identity,
          source_symbol_identity: source,
          file_path: reference.file_path,
          kind: reference.kind,
          module_specifier: reference.module_specifier,
          status: resolution.status,
          rule: resolution.rule,
          candidate_targets: [...resolution.candidate_targets],
          diagnostics: [...resolution.diagnostics],
        }];
      })
      .sort((left, right) =>
        left.reference_identity.localeCompare(right.reference_identity)
      );
  }

  async compareGenerations(input: {
    base_generation_identity: string;
    current_generation_identity: string;
  }) {
    const selected = [
      this.generations.get(input.base_generation_identity),
      this.generations.get(input.current_generation_identity),
    ].filter((generation): generation is StoredCodeTopologyGeneration => generation !== undefined);
    if (selected.length !== 2) return null;
    return new ImmutableCodeTopologySnapshotStore(selected).compareGenerations(input);
  }

  async deleteGenerations(input: {
    repository: string;
    generation_identities: readonly string[];
  }): Promise<DeleteCodeTopologyGenerationsResult> {
    const current = this.checkpoints.get(input.repository) ?? null;
    const deleted: string[] = [];
    const protectedIdentities: string[] = [];
    for (const identity of [...new Set(input.generation_identities)].sort()) {
      const generation = this.generations.get(identity);
      if (!generation || generation.header.repository !== input.repository) continue;
      if (identity === current || generation.pinned) {
        protectedIdentities.push(identity);
      } else {
        this.generations.delete(identity);
        deleted.push(identity);
      }
    }
    return {
      deleted_generation_identities: deleted,
      protected_generation_identities: protectedIdentities,
    };
  }

  async setGenerationPinned(input: {
    repository: string;
    generation_identity: string;
    pinned: boolean;
  }): Promise<boolean> {
    const generation = this.generations.get(input.generation_identity);
    if (!generation || generation.header.repository !== input.repository) return false;
    generation.pinned = input.pinned;
    return true;
  }
}
