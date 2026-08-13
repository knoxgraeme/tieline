import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Sql, TransactionSql } from "postgres";
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
  type CodeTopologyStoreComparison,
  type CodeTopologyStore,
  type CommitCodeTopologyGenerationResult,
  type CompleteCodeTopologyGeneration,
  type DeleteCodeTopologyGenerationsResult,
  type StoredCodeTopologyGeneration,
} from "../../domain/code-topology-store.js";
import { getAdminSql, getReadSql, getSyncSql } from "./connections.js";

type QuerySql = Sql | TransactionSql<Record<string, never>>;
const COPY_CHUNK_BYTES = 256 * 1024;

export type CodeTopologyWriteStage =
  | "generation"
  | "files"
  | "symbols"
  | "references"
  | "resolutions"
  | "edges"
  | "promotion";

export interface PostgresCodeTopologyRepositoryOptions {
  /** Transaction-bound test seam for proving rollback at every write boundary. */
  afterWrite?: (stage: CodeTopologyWriteStage) => void | Promise<void>;
}

interface GenerationRow {
  identity: string;
  repository: string;
  revision: string;
  inventory_digest: string;
  parser_compatibility_digest: string;
  resolver_implementation: string;
  resolver_configuration_digest: string;
  topology_schema_version: number;
  fact_policy_digest: string;
  facts_digest: string;
  expected_file_count: number;
  expected_symbol_count: number;
  expected_reference_count: number;
  expected_resolution_count: number;
  expected_edge_count: number;
  completed_at: Date | string;
  pinned: boolean;
}

function generationSummary(row: GenerationRow): CodeTopologyGenerationSummary {
  return {
    header: {
      identity: row.identity,
      repository: row.repository,
      revision: row.revision,
      inventory_digest: row.inventory_digest,
      parser_compatibility_digest: row.parser_compatibility_digest,
      resolver_implementation: row.resolver_implementation,
      resolver_configuration_digest: row.resolver_configuration_digest,
      topology_schema_version: Number(row.topology_schema_version),
      fact_policy_digest: row.fact_policy_digest,
    },
    facts_digest: row.facts_digest,
    counts: {
      files: Number(row.expected_file_count),
      symbols: Number(row.expected_symbol_count),
      references: Number(row.expected_reference_count),
      resolutions: Number(row.expected_resolution_count),
      edges: Number(row.expected_edge_count),
    },
    completed_at:
      row.completed_at instanceof Date
        ? row.completed_at.toISOString()
        : String(row.completed_at),
    pinned: row.pinned,
  };
}

function locatedSymbol(row: any): CodeTopologyLocatedSymbolRecord {
  return {
    identity: row.identity,
    file_path: row.file_path,
    name: row.name,
    native_kind: row.native_kind,
    kind: row.kind,
    canonical_selector: row.canonical_selector,
    owner_identity: row.owner_identity,
    owner_chain: row.owner_chain,
    name_range: row.name_range,
    body_range: row.body_range,
    syntax_status: row.syntax_status,
    asset_kind: row.asset_kind,
    framework_hint: row.framework_hint,
  };
}

function compareFileRows(
  rows: readonly { generation_identity: string; path: string; source_hash: string }[],
  baseIdentity: string,
  currentIdentity: string
): CodeTopologyStoreComparison["files"] {
  const base = new Map(rows.filter((row) => row.generation_identity === baseIdentity)
    .map((row) => [row.path, row.source_hash]));
  const current = new Map(rows.filter((row) => row.generation_identity === currentIdentity)
    .map((row) => [row.path, row.source_hash]));
  const deleted = [...base].filter(([path]) => !current.has(path));
  const added = [...current].filter(([path]) => !base.has(path));
  const deletedByHash = new Map<string, typeof deleted>();
  const addedByHash = new Map<string, typeof added>();
  for (const value of deleted) deletedByHash.set(value[1], [...(deletedByHash.get(value[1]) ?? []), value]);
  for (const value of added) addedByHash.set(value[1], [...(addedByHash.get(value[1]) ?? []), value]);
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
  for (const [path, hash] of base) {
    const after = current.get(path);
    if (after && after !== hash) changes.push({ status: "modified", path });
  }
  return changes.sort((left, right) =>
    left.path.localeCompare(right.path) || left.status.localeCompare(right.status)
  );
}

async function repositoryId(sql: QuerySql, repository: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    select id from repositories where key = ${repository}`;
  if (!rows[0]) {
    throw new CodeTopologyIntegrityError(
      `Repository '${repository}' must exist before topology persistence.`
    );
  }
  return rows[0].id;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function copyCell(value: unknown): string {
  if (value === undefined) {
    throw new CodeTopologyIntegrityError(
      "Cannot persist an undefined topology value; use null for an absent fact."
    );
  }
  if (value === null) return "\\N";
  const source = typeof value === "boolean" ? (value ? "true" : "false") : String(value);
  return source
    .replaceAll("\\", "\\\\")
    .replaceAll("\t", "\\t")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
}

export function* codeTopologyCopyChunks(
  rows: Iterable<readonly unknown[]>,
  maximumChunkBytes = COPY_CHUNK_BYTES
): Generator<Buffer> {
  if (!Number.isSafeInteger(maximumChunkBytes) || maximumChunkBytes < 1) {
    throw new CodeTopologyIntegrityError("COPY chunk bytes must be a positive safe integer.");
  }
  let parts: Buffer[] = [];
  let bytes = 0;
  for (const row of rows) {
    let line = Buffer.from(`${row.map(copyCell).join("\t")}\n`);
    while (line.length > 0) {
      const available = maximumChunkBytes - bytes;
      const accepted = line.subarray(0, available);
      parts.push(accepted);
      bytes += accepted.length;
      line = line.subarray(accepted.length);
      if (bytes === maximumChunkBytes) {
        yield Buffer.concat(parts, bytes);
        parts = [];
        bytes = 0;
      }
    }
  }
  if (bytes > 0) yield Buffer.concat(parts, bytes);
}

async function copyRows(
  tx: TransactionSql<Record<string, never>>,
  table: string,
  columns: readonly string[],
  rows: Iterable<readonly unknown[]>
): Promise<void> {
  const query = `copy ${table} (${columns.join(", ")}) from stdin`;
  const writable = await tx.unsafe(query).writable();
  await pipeline(Readable.from(codeTopologyCopyChunks(rows), { objectMode: false }), writable);
}

function* copyValues<T>(
  values: readonly T[],
  row: (value: T) => readonly unknown[]
): Generator<readonly unknown[]> {
  for (const value of values) yield row(value);
}

async function insertRows(
  tx: TransactionSql<Record<string, never>>,
  generation: CompleteCodeTopologyGeneration,
  afterWrite: (stage: CodeTopologyWriteStage) => Promise<void>
): Promise<void> {
  const generationIdentity = generation.header.identity;
  await copyRows(tx, "code_topology_files", [
    "generation_identity", "path", "asset_kind", "framework_hint", "language",
    "source_hash", "parser_identity", "diagnostics", "symbols_truncated",
    "references_truncated", "diagnostics_truncated",
  ], copyValues(generation.files, (file) => [
    generationIdentity, file.path, file.kind, file.framework_hint, file.language,
    file.source_hash, file.parser_identity, json(file.diagnostics),
    file.symbols_truncated, file.references_truncated, file.diagnostics_truncated,
  ]));
  await afterWrite("files");
  await copyRows(tx, "code_topology_symbols", [
    "generation_identity", "identity", "file_path", "name", "native_kind",
    "kind", "canonical_selector", "owner_identity", "owner_chain", "name_range",
    "body_range", "syntax_status",
  ], copyValues(generation.symbols, (symbol) => [
    generationIdentity, symbol.identity, symbol.file_path, symbol.name,
    symbol.native_kind, symbol.kind, symbol.canonical_selector, symbol.owner_identity,
    json(symbol.owner_chain), symbol.name_range === null ? null : json(symbol.name_range),
    symbol.body_range === null ? null : json(symbol.body_range), symbol.syntax_status,
  ]));
  await afterWrite("symbols");
  await copyRows(tx, "code_topology_references", [
    "generation_identity", "identity", "file_path", "owner_symbol_identity",
    "kind", "native_kind", "module_specifier", "module_specifier_range",
    "statement_range", "is_type_only", "bindings",
  ], copyValues(generation.references, (reference) => [
    generationIdentity, reference.identity, reference.file_path,
    reference.owner_symbol_identity, reference.kind, reference.native_kind,
    reference.module_specifier,
    reference.module_specifier_range === null ? null : json(reference.module_specifier_range),
    reference.statement_range === null ? null : json(reference.statement_range),
    reference.is_type_only, json(reference.bindings),
  ]));
  await afterWrite("references");
  await copyRows(tx, "code_topology_resolutions", [
    "generation_identity", "reference_identity", "status", "rule",
    "resolver_configuration_digest", "target_file_path", "target_symbol_identity",
    "candidate_targets", "diagnostics",
  ], copyValues(generation.resolutions, (resolution) => [
    generationIdentity, resolution.reference_identity, resolution.status,
    resolution.rule, resolution.resolver_configuration_digest,
    resolution.target_file_path, resolution.target_symbol_identity,
    json(resolution.candidate_targets), json(resolution.diagnostics),
  ]));
  await afterWrite("resolutions");
  await copyRows(tx, "code_topology_edges", [
    "generation_identity", "identity", "kind", "source_symbol_identity",
    "target_symbol_identity", "reference_identity",
  ], copyValues(generation.edges, (edge) => [
    generationIdentity, edge.identity, edge.kind, edge.source.symbol_identity,
    edge.target.symbol_identity, edge.reference_identity,
  ]));
  await afterWrite("edges");
}

function assertExistingMatches(
  row: GenerationRow,
  generation: CompleteCodeTopologyGeneration,
  factsDigest: string
): void {
  const counts = codeTopologyGenerationCounts(generation);
  const header = generation.header;
  const matches =
    row.repository === header.repository &&
    row.revision === header.revision &&
    row.inventory_digest === header.inventory_digest &&
    row.parser_compatibility_digest === header.parser_compatibility_digest &&
    row.resolver_implementation === header.resolver_implementation &&
    row.resolver_configuration_digest === header.resolver_configuration_digest &&
    Number(row.topology_schema_version) === header.topology_schema_version &&
    row.fact_policy_digest === header.fact_policy_digest &&
    row.facts_digest === factsDigest &&
    Number(row.expected_file_count) === counts.files &&
    Number(row.expected_symbol_count) === counts.symbols &&
    Number(row.expected_reference_count) === counts.references &&
    Number(row.expected_resolution_count) === counts.resolutions &&
    Number(row.expected_edge_count) === counts.edges;
  if (!matches) {
    throw new CodeTopologyIntegrityError(
      `Generation '${header.identity}' already exists with different metadata or facts.`
    );
  }
}

export class PostgresCodeTopologyRepository implements CodeTopologyStore {
  constructor(
    private readonly readProvider: () => Sql = getReadSql,
    private readonly syncProvider: () => Sql = getSyncSql,
    private readonly adminProvider: () => Sql = getAdminSql,
    private readonly options: PostgresCodeTopologyRepositoryOptions = {}
  ) {}

  private async afterWrite(stage: CodeTopologyWriteStage): Promise<void> {
    await this.options.afterWrite?.(stage);
  }

  async commitGeneration(input: {
    generation: CompleteCodeTopologyGeneration;
    expected_previous_generation_identity: string | null;
  }): Promise<CommitCodeTopologyGenerationResult> {
    validateCompleteCodeTopologyGeneration(input.generation);
    const generation = normalizeCompleteCodeTopologyGeneration(input.generation);
    const factsDigest = codeTopologyFactsDigestNormalized(generation);
    const counts = codeTopologyGenerationCounts(generation);
    const sql = this.syncProvider();
    try {
      return await sql.begin(async (tx) => {
        const repositoryIdentity = await repositoryId(
          tx,
          generation.header.repository
        );
        const inserted = await tx<{ identity: string }[]>`
            insert into code_topology_generations (
              identity, repository_id, revision, inventory_digest,
              parser_compatibility_digest, resolver_implementation,
              resolver_configuration_digest, topology_schema_version,
              fact_policy_digest, facts_digest, expected_file_count,
              expected_symbol_count, expected_reference_count,
              expected_resolution_count, expected_edge_count
            ) values (
              ${generation.header.identity}, ${repositoryIdentity},
              ${generation.header.revision}, ${generation.header.inventory_digest},
              ${generation.header.parser_compatibility_digest},
              ${generation.header.resolver_implementation},
              ${generation.header.resolver_configuration_digest},
              ${generation.header.topology_schema_version},
              ${generation.header.fact_policy_digest}, ${factsDigest},
              ${counts.files}, ${counts.symbols}, ${counts.references},
              ${counts.resolutions}, ${counts.edges}
            )
            on conflict do nothing
            returning identity`;
        let outcome: CommitCodeTopologyGenerationResult["outcome"];
        if (inserted[0]) {
          outcome = "inserted";
          await this.afterWrite("generation");
          await insertRows(tx, generation, (stage) => this.afterWrite(stage));
        } else {
          outcome = "existing";
          const existing = await tx<GenerationRow[]>`
            select generation.*, repository.key as repository
            from code_topology_generations generation
            join repositories repository on repository.id = generation.repository_id
            where generation.identity = ${generation.header.identity}`;
          if (!existing[0]) {
            throw new CodeTopologyIntegrityError(
              "Topology compatibility metadata already maps to a different generation identity."
            );
          }
          assertExistingMatches(existing[0], generation, factsDigest);
        }
        const promoted = await tx<{ previous_identity: string | null }[]>`
          select promote_code_topology_generation(
            ${repositoryIdentity}, ${generation.header.identity},
            ${input.expected_previous_generation_identity}
          ) as previous_identity`;
        await this.afterWrite("promotion");
        return {
          outcome,
          generation_identity: generation.header.identity,
          previous_generation_identity: promoted[0]?.previous_identity ?? null,
        };
      });
    } catch (error) {
      if (error instanceof Error && /topology checkpoint changed/i.test(error.message)) {
        throw new CodeTopologyCheckpointConflictError(
          input.expected_previous_generation_identity,
          await this.getCurrentGenerationIdentity(generation.header.repository)
        );
      }
      throw error;
    }
  }

  async getCurrentGenerationIdentity(repository: string): Promise<string | null> {
    const rows = await this.readProvider()<{ generation_identity: string }[]>`
      select checkpoint.generation_identity
      from code_topology_checkpoints checkpoint
      join repositories repository on repository.id = checkpoint.repository_id
      where repository.key = ${repository}`;
    return rows[0]?.generation_identity ?? null;
  }

  async getGeneration(identity: string): Promise<StoredCodeTopologyGeneration | null> {
    return (await this.getGenerations([identity]))[0] ?? null;
  }

  async getGenerations(
    identities: readonly string[]
  ): Promise<StoredCodeTopologyGeneration[]> {
    const selected = [...new Set(identities)];
    if (selected.length === 0) return [];
    const sql = this.readProvider();
    return sql.begin("read only isolation level repeatable read", async (tx) => {
      const rows = await tx<GenerationRow[]>`
        select generation.*, repository.key as repository
        from complete_code_topology_generations generation
        join repositories repository on repository.id = generation.repository_id
        where generation.identity in ${tx(selected)}`;
      if (rows.length === 0) return [];
      const files = await tx<any[]>`
        select * from complete_code_topology_files
        where generation_identity in ${tx(selected)}
        order by generation_identity, path`;
      const symbols = await tx<any[]>`
        select * from complete_code_topology_symbols
        where generation_identity in ${tx(selected)}
        order by generation_identity, identity`;
      const references = await tx<any[]>`
        select * from complete_code_topology_references
        where generation_identity in ${tx(selected)}
        order by generation_identity, identity`;
      const resolutions = await tx<any[]>`
        select * from complete_code_topology_resolutions
        where generation_identity in ${tx(selected)}
        order by generation_identity, reference_identity`;
      const edges = await tx<any[]>`
        select * from complete_code_topology_edges
        where generation_identity in ${tx(selected)}
        order by generation_identity, identity`;
      const rowsByIdentity = new Map(rows.map((row) => [row.identity, row]));
      return selected.flatMap((identity): StoredCodeTopologyGeneration[] => {
        const row = rowsByIdentity.get(identity);
        if (!row) return [];
        const belongs = (record: any) => record.generation_identity === identity;
        return [{
          ...generationSummary(row),
          files: files.filter(belongs).map((file) => ({
          path: file.path,
          kind: file.asset_kind,
          framework_hint: file.framework_hint,
          language: file.language,
          source_hash: file.source_hash,
          parser_identity: file.parser_identity,
          diagnostics: file.diagnostics,
          symbols_truncated: file.symbols_truncated,
          references_truncated: file.references_truncated,
          diagnostics_truncated: file.diagnostics_truncated,
          })),
          symbols: symbols.filter(belongs).map((symbol) => ({
          identity: symbol.identity,
          file_path: symbol.file_path,
          name: symbol.name,
          native_kind: symbol.native_kind,
          kind: symbol.kind,
          canonical_selector: symbol.canonical_selector,
          owner_identity: symbol.owner_identity,
          owner_chain: symbol.owner_chain,
          name_range: symbol.name_range,
          body_range: symbol.body_range,
          syntax_status: symbol.syntax_status,
          })),
          references: references.filter(belongs).map((reference) => ({
          identity: reference.identity,
          file_path: reference.file_path,
          owner_symbol_identity: reference.owner_symbol_identity,
          kind: reference.kind,
          native_kind: reference.native_kind,
          module_specifier: reference.module_specifier,
          module_specifier_range: reference.module_specifier_range,
          statement_range: reference.statement_range,
          is_type_only: reference.is_type_only,
          bindings: reference.bindings,
          })),
          resolutions: resolutions.filter(belongs).map((resolution) => ({
          reference_identity: resolution.reference_identity,
          status: resolution.status,
          rule: resolution.rule,
          resolver_configuration_digest:
            resolution.resolver_configuration_digest,
          target_file_path: resolution.target_file_path,
          target_symbol_identity: resolution.target_symbol_identity,
          candidate_targets: resolution.candidate_targets,
          diagnostics: resolution.diagnostics,
          })),
          edges: edges.filter(belongs).map((edge) => ({
          identity: edge.identity,
          kind: edge.kind,
          source: {
            generation_identity: edge.generation_identity,
            symbol_identity: edge.source_symbol_identity,
          },
          target: {
            generation_identity: edge.generation_identity,
            symbol_identity: edge.target_symbol_identity,
          },
          reference_identity: edge.reference_identity,
          })),
        }];
      });
    });
  }

  async getGenerationSummary(
    identity: string
  ): Promise<CodeTopologyGenerationSummary | null> {
    const rows = await this.readProvider()<GenerationRow[]>`
      select generation.*, repository.key as repository
      from complete_code_topology_generations generation
      join repositories repository on repository.id = generation.repository_id
      where generation.identity = ${identity}`;
    return rows[0] ? generationSummary(rows[0]) : null;
  }

  async listSymbolsByPaths(input: {
    generation_identity: string;
    paths: readonly string[];
  }): Promise<CodeTopologyLocatedSymbolRecord[]> {
    if (input.paths.length === 0) return [];
    const sql = this.readProvider();
    const rows = await sql<any[]>`
      select symbol.*, file.asset_kind, file.framework_hint
      from complete_code_topology_symbols symbol
      join complete_code_topology_files file
        on file.generation_identity = symbol.generation_identity
       and file.path = symbol.file_path
      where symbol.generation_identity = ${input.generation_identity}
        and symbol.file_path in ${sql([...new Set(input.paths)].sort())}
      order by symbol.identity`;
    return rows.map(locatedSymbol);
  }

  async listSymbolsByIdentities(input: {
    generation_identity: string;
    symbol_identities: readonly string[];
  }): Promise<CodeTopologyLocatedSymbolRecord[]> {
    if (input.symbol_identities.length === 0) return [];
    const sql = this.readProvider();
    const rows = await sql<any[]>`
      select symbol.*, file.asset_kind, file.framework_hint
      from complete_code_topology_symbols symbol
      join complete_code_topology_files file
        on file.generation_identity = symbol.generation_identity
       and file.path = symbol.file_path
      where symbol.generation_identity = ${input.generation_identity}
        and symbol.identity in ${sql([...new Set(input.symbol_identities)].sort())}
      order by symbol.identity`;
    return rows.map(locatedSymbol);
  }

  async listForwardEdges(input: {
    generation_identity: string;
    source_symbol_identities: readonly string[];
  }): Promise<CodeTopologyEdgeRecord[]> {
    if (input.source_symbol_identities.length === 0) return [];
    const sql = this.readProvider();
    const rows = await sql<any[]>`
      select * from complete_code_topology_edges
      where generation_identity = ${input.generation_identity}
        and source_symbol_identity in ${sql([...input.source_symbol_identities])}
      order by identity`;
    return rows.map((edge) => ({
      identity: edge.identity,
      kind: edge.kind,
      source: {
        generation_identity: edge.generation_identity,
        symbol_identity: edge.source_symbol_identity,
      },
      target: {
        generation_identity: edge.generation_identity,
        symbol_identity: edge.target_symbol_identity,
      },
      reference_identity: edge.reference_identity,
    }));
  }

  async listReverseEdges(input: {
    generation_identity: string;
    target_symbol_identities: readonly string[];
  }): Promise<CodeTopologyEdgeRecord[]> {
    if (input.target_symbol_identities.length === 0) return [];
    const sql = this.readProvider();
    const rows = await sql<any[]>`
      select * from complete_code_topology_edges
      where generation_identity = ${input.generation_identity}
        and target_symbol_identity in ${sql([...input.target_symbol_identities])}
      order by identity`;
    return rows.map((edge) => ({
      identity: edge.identity,
      kind: edge.kind,
      source: {
        generation_identity: edge.generation_identity,
        symbol_identity: edge.source_symbol_identity,
      },
      target: {
        generation_identity: edge.generation_identity,
        symbol_identity: edge.target_symbol_identity,
      },
      reference_identity: edge.reference_identity,
    }));
  }

  async listDependencyFrontiers(input: {
    generation_identity: string;
    source_symbol_identities: readonly string[];
  }): Promise<CodeTopologyFrontierRecord[]> {
    if (input.source_symbol_identities.length === 0) return [];
    const sql = this.readProvider();
    const rows = await sql<any[]>`
      select
        reference.identity as reference_identity,
        coalesce(reference.owner_symbol_identity, module.identity) as source_symbol_identity,
        reference.file_path,
        reference.kind,
        reference.module_specifier,
        resolution.status,
        resolution.rule,
        resolution.candidate_targets,
        resolution.diagnostics
      from complete_code_topology_references reference
      join complete_code_topology_resolutions resolution
        on resolution.generation_identity = reference.generation_identity
       and resolution.reference_identity = reference.identity
      left join complete_code_topology_symbols module
        on module.generation_identity = reference.generation_identity
       and module.file_path = reference.file_path
       and module.native_kind = 'source_file'
      where reference.generation_identity = ${input.generation_identity}
        and coalesce(reference.owner_symbol_identity, module.identity)
          in ${sql([...new Set(input.source_symbol_identities)].sort())}
        and reference.kind in ('import', 'dynamic_import', 'reexport')
        and reference.module_specifier is not null
        and resolution.status in ('ambiguous', 'unresolved', 'external')
      order by reference.identity`;
    return rows.map((row) => ({
      reference_identity: row.reference_identity,
      source_symbol_identity: row.source_symbol_identity,
      file_path: row.file_path,
      kind: row.kind,
      module_specifier: row.module_specifier,
      status: row.status,
      rule: row.rule,
      candidate_targets: row.candidate_targets,
      diagnostics: row.diagnostics,
    }));
  }

  async compareGenerations(input: {
    base_generation_identity: string;
    current_generation_identity: string;
  }): Promise<CodeTopologyStoreComparison | null> {
    const selected = [input.base_generation_identity, input.current_generation_identity];
    const sql = this.readProvider();
    return sql.begin("read only isolation level repeatable read", async (tx) => {
      const generations = await tx<GenerationRow[]>`
        select generation.*, repository.key as repository
        from complete_code_topology_generations generation
        join repositories repository on repository.id = generation.repository_id
        where generation.identity in ${tx(selected)}`;
      const byIdentity = new Map(generations.map((row) => [row.identity, row]));
      const base = byIdentity.get(input.base_generation_identity);
      const current = byIdentity.get(input.current_generation_identity);
      if (!base || !current) return null;
      const files = await tx<{ generation_identity: string; path: string; source_hash: string }[]>`
        select generation_identity, path, source_hash
        from complete_code_topology_files
        where generation_identity in ${tx(selected)}
        order by generation_identity, path`;
      const edges = await tx<any[]>`
        with logical_edges as (
          select
            edge.generation_identity,
            edge.kind,
            source_file.asset_kind as source_kind,
            source_symbol.file_path as source_path,
            source_symbol.canonical_selector as source_selector,
            source_file.framework_hint as source_framework_hint,
            target_file.asset_kind as target_kind,
            target_symbol.file_path as target_path,
            target_symbol.canonical_selector as target_selector,
            target_file.framework_hint as target_framework_hint
          from complete_code_topology_edges edge
          join complete_code_topology_symbols source_symbol
            on source_symbol.generation_identity = edge.generation_identity
           and source_symbol.identity = edge.source_symbol_identity
          join complete_code_topology_files source_file
            on source_file.generation_identity = source_symbol.generation_identity
           and source_file.path = source_symbol.file_path
          join complete_code_topology_symbols target_symbol
            on target_symbol.generation_identity = edge.generation_identity
           and target_symbol.identity = edge.target_symbol_identity
          join complete_code_topology_files target_file
            on target_file.generation_identity = target_symbol.generation_identity
           and target_file.path = target_symbol.file_path
          where edge.generation_identity in ${tx(selected)}
        ), base_edges as (
          select kind, source_kind, source_path, source_selector, source_framework_hint,
            target_kind, target_path, target_selector, target_framework_hint
          from logical_edges where generation_identity = ${input.base_generation_identity}
        ), current_edges as (
          select kind, source_kind, source_path, source_selector, source_framework_hint,
            target_kind, target_path, target_selector, target_framework_hint
          from logical_edges where generation_identity = ${input.current_generation_identity}
        )
        select 'deleted'::text as status, removed.* from (
          select * from base_edges except select * from current_edges
        ) removed
        union all
        select 'added'::text as status, added.* from (
          select * from current_edges except select * from base_edges
        ) added
        order by status, kind, source_path, source_selector, target_path, target_selector`;
      const compatibility = (row: GenerationRow) => [
        row.parser_compatibility_digest,
        row.resolver_implementation,
        Number(row.topology_schema_version),
        row.fact_policy_digest,
      ].join("\0");
      const repositoryFor = (status: "added" | "deleted"): string =>
        status === "deleted" ? base.repository : current.repository;
      return {
        base_generation_identity: base.identity,
        current_generation_identity: current.identity,
        compatibility: compatibility(base) === compatibility(current)
          ? "compatible"
          : "incompatible",
        configuration_changed:
          base.resolver_configuration_digest !== current.resolver_configuration_digest,
        files: compareFileRows(files, base.identity, current.identity),
        edges: edges.map((edge) => ({
          status: edge.status,
          kind: edge.kind,
          source: {
            repository: repositoryFor(edge.status),
            kind: edge.source_kind,
            path: edge.source_path,
            selector: edge.source_selector,
            framework_hint: edge.source_framework_hint,
          },
          target: {
            repository: repositoryFor(edge.status),
            kind: edge.target_kind,
            path: edge.target_path,
            selector: edge.target_selector,
            framework_hint: edge.target_framework_hint,
          },
        })),
      };
    });
  }

  async deleteGenerations(input: {
    repository: string;
    generation_identities: readonly string[];
  }): Promise<DeleteCodeTopologyGenerationsResult> {
    if (input.generation_identities.length === 0) {
      return {
        deleted_generation_identities: [],
        protected_generation_identities: [],
      };
    }
    const sql = this.adminProvider();
    return sql.begin(async (tx) => {
      const identity = await repositoryId(tx, input.repository);
      const rows = await tx<{ generation_identity: string; protected: boolean }[]>`
        select * from gc_code_topology_generations(
          ${identity}, ${[...new Set(input.generation_identities)].sort()}
        )`;
      return {
        deleted_generation_identities: rows
          .filter((row) => !row.protected)
          .map((row) => row.generation_identity),
        protected_generation_identities: rows
          .filter((row) => row.protected)
          .map((row) => row.generation_identity),
      };
    });
  }

  async setGenerationPinned(input: {
    repository: string;
    generation_identity: string;
    pinned: boolean;
  }): Promise<boolean> {
    const sql = this.adminProvider();
    const identity = await repositoryId(sql, input.repository);
    const rows = await sql<{ pinned: boolean }[]>`
      select pin_code_topology_generation(
        ${identity}, ${input.generation_identity}, ${input.pinned}
      ) as pinned`;
    return rows[0]?.pinned ?? false;
  }
}
