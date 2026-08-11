import type { Sql, TransactionSql } from "postgres";
import {
  CodeTopologyCheckpointConflictError,
  CodeTopologyIntegrityError,
  codeTopologyFactsDigestNormalized,
  codeTopologyGenerationCounts,
  normalizeCompleteCodeTopologyGeneration,
  validateCompleteCodeTopologyGeneration,
  type CodeTopologyEdgeRecord,
  type CodeTopologyStore,
  type CommitCodeTopologyGenerationResult,
  type CompleteCodeTopologyGeneration,
  type DeleteCodeTopologyGenerationsResult,
  type StoredCodeTopologyGeneration,
} from "../../domain/code-topology-store.js";
import { getAdminSql, getReadSql, getSyncSql } from "./connections.js";

type QuerySql = Sql | TransactionSql<Record<string, never>>;
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

export const CODE_TOPOLOGY_INSERT_BATCH_SIZE = 1_000;

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

function batches<T>(values: readonly T[]): T[][] {
  const result: T[][] = [];
  for (
    let offset = 0;
    offset < values.length;
    offset += CODE_TOPOLOGY_INSERT_BATCH_SIZE
  ) {
    result.push(values.slice(offset, offset + CODE_TOPOLOGY_INSERT_BATCH_SIZE));
  }
  return result;
}

async function insertRows(
  tx: TransactionSql<Record<string, never>>,
  generation: CompleteCodeTopologyGeneration,
  afterWrite: (stage: CodeTopologyWriteStage) => Promise<void>
): Promise<void> {
  const generationIdentity = generation.header.identity;
  for (const batch of batches(generation.files)) {
    await tx`insert into code_topology_files ${tx(
      batch.map((file) => ({
        generation_identity: generationIdentity,
        path: file.path,
        asset_kind: file.kind,
        framework_hint: file.framework_hint,
        language: file.language,
        source_hash: file.source_hash,
        parser_identity: file.parser_identity,
        diagnostics: json(file.diagnostics),
        symbols_truncated: file.symbols_truncated,
        references_truncated: file.references_truncated,
        diagnostics_truncated: file.diagnostics_truncated,
      }))
    )}`;
  }
  await afterWrite("files");
  for (const batch of batches(generation.symbols)) {
    await tx`insert into code_topology_symbols ${tx(
      batch.map((symbol) => ({
        generation_identity: generationIdentity,
        identity: symbol.identity,
        file_path: symbol.file_path,
        name: symbol.name,
        native_kind: symbol.native_kind,
        kind: symbol.kind,
        canonical_selector: symbol.canonical_selector,
        owner_identity: symbol.owner_identity,
        owner_chain: json(symbol.owner_chain),
        name_range: symbol.name_range === null ? null : json(symbol.name_range),
        body_range: symbol.body_range === null ? null : json(symbol.body_range),
        syntax_status: symbol.syntax_status,
      }))
    )}`;
  }
  await afterWrite("symbols");
  for (const batch of batches(generation.references)) {
    await tx`insert into code_topology_references ${tx(
      batch.map((reference) => ({
        generation_identity: generationIdentity,
        identity: reference.identity,
        file_path: reference.file_path,
        owner_symbol_identity: reference.owner_symbol_identity,
        kind: reference.kind,
        native_kind: reference.native_kind,
        module_specifier: reference.module_specifier,
        module_specifier_range:
          reference.module_specifier_range === null
            ? null
            : json(reference.module_specifier_range),
        statement_range:
          reference.statement_range === null
            ? null
            : json(reference.statement_range),
        is_type_only: reference.is_type_only,
        bindings: json(reference.bindings),
      }))
    )}`;
  }
  await afterWrite("references");
  for (const batch of batches(generation.resolutions)) {
    await tx`insert into code_topology_resolutions ${tx(
      batch.map((resolution) => ({
        generation_identity: generationIdentity,
        reference_identity: resolution.reference_identity,
        status: resolution.status,
        rule: resolution.rule,
        resolver_configuration_digest:
          resolution.resolver_configuration_digest,
        target_file_path: resolution.target_file_path,
        target_symbol_identity: resolution.target_symbol_identity,
        candidate_targets: json(resolution.candidate_targets),
        diagnostics: json(resolution.diagnostics),
      }))
    )}`;
  }
  await afterWrite("resolutions");
  for (const batch of batches(generation.edges)) {
    await tx`insert into code_topology_edges ${tx(
      batch.map((edge) => ({
        generation_identity: generationIdentity,
        identity: edge.identity,
        kind: edge.kind,
        source_generation_identity: edge.source.generation_identity,
        source_symbol_identity: edge.source.symbol_identity,
        target_generation_identity: edge.target.generation_identity,
        target_symbol_identity: edge.target.symbol_identity,
        reference_identity: edge.reference_identity,
      }))
    )}`;
  }
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
    const sql = this.readProvider();
    return sql.begin("read only isolation level repeatable read", async (tx) => {
      const rows = await tx<GenerationRow[]>`
        select generation.*, repository.key as repository
        from complete_code_topology_generations generation
        join repositories repository on repository.id = generation.repository_id
        where generation.identity = ${identity}`;
      const row = rows[0];
      if (!row) return null;
      const files = await tx<any[]>`
        select * from complete_code_topology_files
        where generation_identity = ${identity} order by path`;
      const symbols = await tx<any[]>`
        select * from complete_code_topology_symbols
        where generation_identity = ${identity} order by identity`;
      const references = await tx<any[]>`
        select * from complete_code_topology_references
        where generation_identity = ${identity} order by identity`;
      const resolutions = await tx<any[]>`
        select * from complete_code_topology_resolutions
        where generation_identity = ${identity} order by reference_identity`;
      const edges = await tx<any[]>`
        select * from complete_code_topology_edges
        where generation_identity = ${identity} order by identity`;
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
        files: files.map((file) => ({
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
        symbols: symbols.map((symbol) => ({
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
        references: references.map((reference) => ({
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
        resolutions: resolutions.map((resolution) => ({
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
        edges: edges.map((edge) => ({
          identity: edge.identity,
          kind: edge.kind,
          source: {
            generation_identity: edge.source_generation_identity,
            symbol_identity: edge.source_symbol_identity,
          },
          target: {
            generation_identity: edge.target_generation_identity,
            symbol_identity: edge.target_symbol_identity,
          },
          reference_identity: edge.reference_identity,
        })),
      };
    });
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
        generation_identity: edge.source_generation_identity,
        symbol_identity: edge.source_symbol_identity,
      },
      target: {
        generation_identity: edge.target_generation_identity,
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
        generation_identity: edge.source_generation_identity,
        symbol_identity: edge.source_symbol_identity,
      },
      target: {
        generation_identity: edge.target_generation_identity,
        symbol_identity: edge.target_symbol_identity,
      },
      reference_identity: edge.reference_identity,
    }));
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
