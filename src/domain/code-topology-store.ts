import { createHash } from "node:crypto";
import type { SourceRange } from "../contract/source-snapshot.js";
import type {
  ModuleBindingFact,
  ModuleLinkageKind,
  NormalizedSymbolKind,
  ParserDiagnostic,
  SymbolSyntaxStatus,
} from "../contract/code-analysis/types.js";
import type { SupportedCodeLanguage } from "../contract/code-analysis/languages.js";

const sha256Pattern = /^[a-f0-9]{64}$/;
const committedRevisionPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export type TopologyAssetKind = "code" | "test";
export type TopologyResolutionStatus =
  | "resolved"
  | "ambiguous"
  | "unresolved"
  | "external";

export interface CodeTopologyGenerationIdentityFields {
  repository: string;
  /**
   * Versioned digest of selected source and fact-producing compatibility inputs.
   * The legacy persistence column is still named `revision` during Phase 1.
   */
  revision: string;
  inventory_digest: string;
  parser_compatibility_digest: string;
  resolver_implementation: string;
  resolver_configuration_digest: string;
  topology_schema_version: number;
  fact_policy_digest: string;
}

export interface CodeTopologyGenerationHeader
  extends CodeTopologyGenerationIdentityFields {
  identity: string;
}

export interface CodeTopologyFileRecord {
  path: string;
  kind: TopologyAssetKind;
  framework_hint: string | null;
  language: SupportedCodeLanguage;
  source_hash: string;
  parser_identity: string;
  diagnostics: readonly ParserDiagnostic[];
  symbols_truncated: boolean;
  references_truncated: boolean;
  diagnostics_truncated: boolean;
}

export interface CodeTopologySymbolRecord {
  identity: string;
  file_path: string;
  name: string | null;
  native_kind: string;
  kind: NormalizedSymbolKind;
  canonical_selector: string | null;
  owner_identity: string | null;
  owner_chain: readonly string[];
  name_range: SourceRange | null;
  body_range: SourceRange | null;
  syntax_status: SymbolSyntaxStatus;
}

export interface CodeTopologyReferenceRecord {
  identity: string;
  file_path: string;
  owner_symbol_identity: string | null;
  kind: ModuleLinkageKind;
  native_kind: string;
  module_specifier: string | null;
  module_specifier_range: SourceRange | null;
  statement_range: SourceRange | null;
  is_type_only: boolean;
  bindings: readonly ModuleBindingFact[];
}

export interface CodeTopologyResolutionRecord {
  reference_identity: string;
  status: TopologyResolutionStatus;
  rule: string;
  resolver_configuration_digest: string;
  target_file_path: string | null;
  target_symbol_identity: string | null;
  candidate_targets: readonly string[];
  diagnostics: readonly string[];
}

export interface CodeTopologyEdgeEndpoint {
  generation_identity: string;
  symbol_identity: string;
}

export interface CodeTopologyEdgeRecord {
  identity: string;
  kind: string;
  source: CodeTopologyEdgeEndpoint;
  target: CodeTopologyEdgeEndpoint;
  reference_identity: string | null;
}

export interface CompleteCodeTopologyGeneration {
  header: CodeTopologyGenerationHeader;
  files: CodeTopologyFileRecord[];
  symbols: CodeTopologySymbolRecord[];
  references: CodeTopologyReferenceRecord[];
  resolutions: CodeTopologyResolutionRecord[];
  edges: CodeTopologyEdgeRecord[];
}

export interface CodeTopologyGenerationCounts {
  files: number;
  symbols: number;
  references: number;
  resolutions: number;
  edges: number;
}

export interface StoredCodeTopologyGeneration extends CompleteCodeTopologyGeneration {
  facts_digest: string;
  counts: CodeTopologyGenerationCounts;
  completed_at: string;
  pinned: boolean;
}

export type CodeTopologyGenerationSummary = Omit<
  StoredCodeTopologyGeneration,
  "files" | "symbols" | "references" | "resolutions" | "edges"
>;

/** Header and counts required by traversal; excludes persistence-only grading metadata. */
export interface CodeTopologyTraversalGenerationSummary {
  header: CodeTopologyGenerationHeader;
  counts: CodeTopologyGenerationCounts;
}

/** Compact symbol and authored-locator fields used by bounded reads. */
export interface CodeTopologyLocatedSymbolRecord extends CodeTopologySymbolRecord {
  asset_kind: TopologyAssetKind;
  framework_hint: string | null;
}

/** Only the symbol fields required to locate and traverse code topology. */
export interface CodeTopologyTraversalSymbolRecord {
  identity: string;
  file_path: string;
  native_kind: string;
  canonical_selector: string | null;
  asset_kind: TopologyAssetKind;
  framework_hint: string | null;
}

/** An unresolved dependency-shaped reference attached to a traversed source. */
export interface CodeTopologyFrontierRecord {
  reference_identity: string;
  source_symbol_identity: string;
  file_path: string;
  kind: ModuleLinkageKind;
  module_specifier: string | null;
  status: Exclude<TopologyResolutionStatus, "resolved">;
  rule: string;
  candidate_targets: readonly string[];
  diagnostics: readonly string[];
}

export interface CodeTopologyComparisonLocator {
  repository: string;
  kind: TopologyAssetKind;
  path: string;
  selector: string | null;
  framework_hint: string | null;
}

export type CodeTopologyComparedFileChange =
  | { status: "added" | "deleted" | "modified"; path: string }
  | { status: "renamed"; path: string; previous_path: string };

export interface CodeTopologyComparedEdgeChange {
  status: "added" | "deleted";
  kind: string;
  source: CodeTopologyComparisonLocator;
  target: CodeTopologyComparisonLocator;
}

export interface CodeTopologyStoreComparison {
  base_generation_identity: string;
  current_generation_identity: string;
  compatibility: "compatible" | "incompatible";
  configuration_changed: boolean;
  files: CodeTopologyComparedFileChange[];
  edges: CodeTopologyComparedEdgeChange[];
}

export interface CodeTopologyReadModelFile {
  path: string;
  kind: TopologyAssetKind;
  framework_hint: string | null;
  source_hash: string;
}

export interface CodeTopologyReadModelEdge {
  kind: string;
  source_symbol_identity: string;
  target_symbol_identity: string;
  reference_identity: string | null;
}

/** Persistence-independent facts retained for local bounded traversal. */
export interface CodeTopologyReadModelGeneration {
  summary: CodeTopologyTraversalGenerationSummary;
  projection_digest: string;
  files: CodeTopologyReadModelFile[];
  symbols: CodeTopologyTraversalSymbolRecord[];
  edges: CodeTopologyReadModelEdge[];
  frontiers: CodeTopologyFrontierRecord[];
  retained_bytes: number;
}

export type CommitCodeTopologyGenerationResult = {
  outcome: "inserted" | "existing";
  generation_identity: string;
  previous_generation_identity: string | null;
};

export interface DeleteCodeTopologyGenerationsResult {
  deleted_generation_identities: string[];
  protected_generation_identities: string[];
}

export class CodeTopologyCheckpointConflictError extends Error {
  constructor(
    readonly expected: string | null,
    readonly actual: string | null
  ) {
    super(
      `Topology checkpoint changed: expected ${expected ?? "no generation"}, found ${actual ?? "no generation"}.`
    );
    this.name = "CodeTopologyCheckpointConflictError";
  }
}

export class CodeTopologyIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeTopologyIntegrityError";
  }
}

export interface CodeTopologyReadStore {
  getCurrentGenerationIdentity(repository: string): Promise<string | null>;
  getGenerationSummary(
    identity: string
  ): Promise<CodeTopologyTraversalGenerationSummary | null>;
  listSymbolsByPaths(input: {
    generation_identity: string;
    paths: readonly string[];
  }): Promise<CodeTopologyTraversalSymbolRecord[]>;
  listSymbolsByIdentities(input: {
    generation_identity: string;
    symbol_identities: readonly string[];
  }): Promise<CodeTopologyTraversalSymbolRecord[]>;
  listForwardEdges(input: {
    generation_identity: string;
    source_symbol_identities: readonly string[];
  }): Promise<CodeTopologyEdgeRecord[]>;
  listReverseEdges(input: {
    generation_identity: string;
    target_symbol_identities: readonly string[];
  }): Promise<CodeTopologyEdgeRecord[]>;
  listDependencyFrontiers(input: {
    generation_identity: string;
    source_symbol_identities: readonly string[];
  }): Promise<CodeTopologyFrontierRecord[]>;
  /** Compare immutable roles without hydrating their persistence fact tables. */
  compareGenerations(input: {
    base_generation_identity: string;
    current_generation_identity: string;
  }): Promise<CodeTopologyStoreComparison | null>;
}

export interface CodeTopologyGenerationArchive {
  getGeneration(identity: string): Promise<StoredCodeTopologyGeneration | null>;
  /** Select multiple immutable generation roles in one store snapshot. */
  getGenerations(
    identities: readonly string[]
  ): Promise<StoredCodeTopologyGeneration[]>;
}

export interface CodeTopologyWriteStore {
  commitGeneration(input: {
    generation: CompleteCodeTopologyGeneration;
    expected_previous_generation_identity: string | null;
  }): Promise<CommitCodeTopologyGenerationResult>;
  deleteGenerations(input: {
    repository: string;
    generation_identities: readonly string[];
  }): Promise<DeleteCodeTopologyGenerationsResult>;
  setGenerationPinned(input: {
    repository: string;
    generation_identity: string;
    pinned: boolean;
  }): Promise<boolean>;
}

export interface CodeTopologyStore
  extends CodeTopologyReadStore,
    CodeTopologyGenerationArchive,
    CodeTopologyWriteStore {}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function updateCanonicalHash(
  hash: ReturnType<typeof createHash>,
  value: unknown
): void {
  if (Array.isArray(value)) {
    hash.update("[");
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) hash.update(",");
      updateCanonicalHash(hash, value[index]);
    }
    hash.update("]");
    return;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    hash.update("{");
    for (let index = 0; index < entries.length; index += 1) {
      if (index > 0) hash.update(",");
      const [key, child] = entries[index]!;
      hash.update(`${JSON.stringify(key)}:`);
      updateCanonicalHash(hash, child);
    }
    hash.update("}");
    return;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new CodeTopologyIntegrityError("Cannot hash an undefined topology value.");
  }
  hash.update(encoded);
}

export function codeTopologyDerivedEdgeIdentity(input: {
  referenceIdentity: string;
  sourceIdentity: string;
  targetIdentity: string;
}): string {
  return `edge:${createHash("sha256").update(canonicalJson({
    kind: "imports",
    ...input,
  })).digest("hex")}`;
}

function hashCanonical(value: unknown): string {
  const hash = createHash("sha256");
  updateCanonicalHash(hash, value);
  return hash.digest("hex");
}

export function codeTopologyGenerationIdentity(
  fields: CodeTopologyGenerationIdentityFields
): string {
  if (fields.resolver_implementation.startsWith("tieline-static-modules@2:")) {
    return hashCanonical({
      identity_semantics: "selected-topology-inputs-v2",
      repository: fields.repository,
      selected_input_digest: fields.revision,
    });
  }
  return hashCanonical({
    repository: fields.repository,
    revision: fields.revision,
    inventory_digest: fields.inventory_digest,
    parser_compatibility_digest: fields.parser_compatibility_digest,
    resolver_implementation: fields.resolver_implementation,
    resolver_configuration_digest: fields.resolver_configuration_digest,
    topology_schema_version: fields.topology_schema_version,
    fact_policy_digest: fields.fact_policy_digest,
  });
}

/** Selected-input identity deliberately excludes any enclosing Git object. */
export function codeTopologySelectedInputDigest(
  fields: Omit<CodeTopologyGenerationIdentityFields, "repository" | "revision">
): string {
  return hashCanonical({
    identity_semantics: "selected-topology-inputs-v2",
    inventory_digest: fields.inventory_digest,
    parser_compatibility_digest: fields.parser_compatibility_digest,
    resolver_implementation: fields.resolver_implementation,
    resolver_configuration_digest: fields.resolver_configuration_digest,
    topology_schema_version: fields.topology_schema_version,
    fact_policy_digest: fields.fact_policy_digest,
  });
}

function byIdentity<T extends { identity: string }>(left: T, right: T): number {
  return left.identity.localeCompare(right.identity);
}

export function normalizeCompleteCodeTopologyGeneration(
  generation: CompleteCodeTopologyGeneration
): CompleteCodeTopologyGeneration {
  return structuredClone({
    header: generation.header,
    files: [...generation.files].sort((left, right) =>
      left.path.localeCompare(right.path)
    ),
    symbols: [...generation.symbols].sort(byIdentity),
    references: [...generation.references].sort(byIdentity),
    resolutions: [...generation.resolutions].sort((left, right) =>
      left.reference_identity.localeCompare(right.reference_identity)
    ),
    edges: [...generation.edges].sort(byIdentity),
  });
}

/**
 * Normalizes a freshly constructed generation whose ownership has not escaped.
 * Persistence callers keep using the defensive-clone normalizer above; the
 * indexer can sort its own arrays without temporarily duplicating the graph.
 */
export function normalizeOwnedCompleteCodeTopologyGeneration(
  generation: CompleteCodeTopologyGeneration
): CompleteCodeTopologyGeneration {
  generation.files.sort((left, right) => left.path.localeCompare(right.path));
  generation.symbols.sort(byIdentity);
  generation.references.sort(byIdentity);
  generation.resolutions.sort((left, right) =>
    left.reference_identity.localeCompare(right.reference_identity)
  );
  generation.edges.sort(byIdentity);
  return generation;
}

function retainedStringBytes(value: string | null): number {
  return value === null ? 0 : 16 + value.length * 2;
}

function retainedRangeBytes(value: SourceRange | null): number {
  // Five small objects plus numeric coordinate fields in the in-memory shape.
  return value === null ? 0 : 256;
}

/**
 * Conservative allocation estimate for cache admission without serializing the
 * entire graph into one temporary JSON string. It intentionally estimates the
 * JavaScript object representation rather than wire size.
 */
export function estimateCodeTopologyGenerationRetainedBytes(
  generation: CompleteCodeTopologyGeneration
): number {
  let bytes = 2_048;
  for (const file of generation.files) {
    bytes += 512 + retainedStringBytes(file.path) + retainedStringBytes(file.framework_hint) +
      retainedStringBytes(file.language) + retainedStringBytes(file.source_hash) +
      retainedStringBytes(file.parser_identity);
    for (const diagnostic of file.diagnostics) {
      bytes += 384 + retainedStringBytes(diagnostic.identity) + retainedStringBytes(diagnostic.kind) +
        retainedStringBytes(diagnostic.nativeKind) + retainedStringBytes(diagnostic.message) +
        retainedRangeBytes(diagnostic.range);
    }
  }
  for (const symbol of generation.symbols) {
    bytes += 640 + retainedStringBytes(symbol.identity) + retainedStringBytes(symbol.file_path) +
      retainedStringBytes(symbol.name) + retainedStringBytes(symbol.native_kind) +
      retainedStringBytes(symbol.kind) + retainedStringBytes(symbol.canonical_selector) +
      retainedStringBytes(symbol.owner_identity) + retainedRangeBytes(symbol.name_range) +
      retainedRangeBytes(symbol.body_range);
    for (const owner of symbol.owner_chain) bytes += 24 + retainedStringBytes(owner);
  }
  for (const reference of generation.references) {
    bytes += 640 + retainedStringBytes(reference.identity) + retainedStringBytes(reference.file_path) +
      retainedStringBytes(reference.owner_symbol_identity) + retainedStringBytes(reference.kind) +
      retainedStringBytes(reference.native_kind) + retainedStringBytes(reference.module_specifier) +
      retainedRangeBytes(reference.module_specifier_range) + retainedRangeBytes(reference.statement_range);
    for (const binding of reference.bindings) {
      bytes += 192 + retainedStringBytes(binding.imported) + retainedStringBytes(binding.local) +
        retainedStringBytes(binding.exported);
    }
  }
  for (const resolution of generation.resolutions) {
    bytes += 512 + retainedStringBytes(resolution.reference_identity) + retainedStringBytes(resolution.status) +
      retainedStringBytes(resolution.rule) + retainedStringBytes(resolution.resolver_configuration_digest) +
      retainedStringBytes(resolution.target_file_path) + retainedStringBytes(resolution.target_symbol_identity);
    for (const candidate of resolution.candidate_targets) bytes += 24 + retainedStringBytes(candidate);
    for (const diagnostic of resolution.diagnostics) bytes += 24 + retainedStringBytes(diagnostic);
  }
  for (const edge of generation.edges) {
    bytes += 384 + retainedStringBytes(edge.identity) + retainedStringBytes(edge.kind) +
      retainedStringBytes(edge.source.generation_identity) + retainedStringBytes(edge.source.symbol_identity) +
      retainedStringBytes(edge.target.generation_identity) + retainedStringBytes(edge.target.symbol_identity) +
      retainedStringBytes(edge.reference_identity);
  }
  return bytes;
}

export function codeTopologyFactsDigest(
  generation: CompleteCodeTopologyGeneration
): string {
  return codeTopologyFactsDigestNormalized(
    normalizeCompleteCodeTopologyGeneration(generation)
  );
}

/** Hashes a generation already normalized by `normalizeCompleteCodeTopologyGeneration`. */
export function codeTopologyFactsDigestNormalized(
  normalized: CompleteCodeTopologyGeneration
): string {
  return hashCanonical({
    files: normalized.files,
    symbols: normalized.symbols,
    references: normalized.references,
    resolutions: normalized.resolutions,
    edges: normalized.edges,
  });
}

function assertDigest(value: string, label: string): void {
  if (!sha256Pattern.test(value)) {
    throw new CodeTopologyIntegrityError(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new CodeTopologyIntegrityError(`Duplicate ${label} '${value}'.`);
    }
    seen.add(value);
  }
}

export function validateCompleteCodeTopologyGeneration(
  generation: CompleteCodeTopologyGeneration
): void {
  const { header } = generation;
  if (header.identity !== codeTopologyGenerationIdentity(header)) {
    throw new CodeTopologyIntegrityError(
      "Topology generation identity does not match its compatibility metadata."
    );
  }
  if (!header.repository.trim()) {
    throw new CodeTopologyIntegrityError("Topology repository must not be empty.");
  }
  if (!committedRevisionPattern.test(header.revision)) {
    throw new CodeTopologyIntegrityError(
      "Persisted topology source identity must be a full Git or SHA-256 identity."
    );
  }
  assertDigest(header.inventory_digest, "Inventory digest");
  assertDigest(header.parser_compatibility_digest, "Parser compatibility digest");
  assertDigest(header.resolver_configuration_digest, "Resolver configuration digest");
  assertDigest(header.fact_policy_digest, "Fact policy digest");
  if (!header.resolver_implementation.trim()) {
    throw new CodeTopologyIntegrityError("Resolver implementation must not be empty.");
  }
  if (!Number.isSafeInteger(header.topology_schema_version) || header.topology_schema_version < 1) {
    throw new CodeTopologyIntegrityError("Topology schema version must be a positive integer.");
  }
  if (
    header.resolver_implementation.startsWith("tieline-static-modules@2:") &&
    header.revision !== codeTopologySelectedInputDigest(header)
  ) {
    throw new CodeTopologyIntegrityError(
      "Topology selected-input digest does not match its fact-producing inputs."
    );
  }

  assertUnique(generation.files.map((file) => file.path), "topology file path");
  assertUnique(generation.symbols.map((symbol) => symbol.identity), "symbol identity");
  assertUnique(generation.references.map((reference) => reference.identity), "reference identity");
  assertUnique(generation.edges.map((edge) => edge.identity), "edge identity");
  assertUnique(
    generation.resolutions.map((resolution) => resolution.reference_identity),
    "resolution for reference"
  );

  const files = new Set(generation.files.map((file) => file.path));
  const symbols = new Map(generation.symbols.map((symbol) => [symbol.identity, symbol]));
  const references = new Set(generation.references.map((reference) => reference.identity));
  for (const file of generation.files) {
    if (file.path.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(file.path)) {
      throw new CodeTopologyIntegrityError(`Unsafe topology file path '${file.path}'.`);
    }
    assertDigest(file.source_hash, `Source hash for ${file.path}`);
  }
  for (const symbol of generation.symbols) {
    if (!files.has(symbol.file_path)) {
      throw new CodeTopologyIntegrityError(
        `Symbol '${symbol.identity}' refers to missing file '${symbol.file_path}'.`
      );
    }
    if (symbol.owner_identity !== null) {
      const owner = symbols.get(symbol.owner_identity);
      if (!owner || owner.file_path !== symbol.file_path) {
        throw new CodeTopologyIntegrityError(
          `Symbol '${symbol.identity}' has an invalid owner '${symbol.owner_identity}'.`
        );
      }
    }
  }
  for (const reference of generation.references) {
    if (!files.has(reference.file_path)) {
      throw new CodeTopologyIntegrityError(
        `Reference '${reference.identity}' refers to missing file '${reference.file_path}'.`
      );
    }
    if (
      reference.owner_symbol_identity !== null &&
      !symbols.has(reference.owner_symbol_identity)
    ) {
      throw new CodeTopologyIntegrityError(
        `Reference '${reference.identity}' has missing owner '${reference.owner_symbol_identity}'.`
      );
    }
  }
  for (const resolution of generation.resolutions) {
    if (!references.has(resolution.reference_identity)) {
      throw new CodeTopologyIntegrityError(
        `Resolution refers to missing reference '${resolution.reference_identity}'.`
      );
    }
    if (
      resolution.resolver_configuration_digest !==
      header.resolver_configuration_digest
    ) {
      throw new CodeTopologyIntegrityError(
        `Resolution for '${resolution.reference_identity}' has incompatible resolver metadata.`
      );
    }
    if (
      resolution.target_symbol_identity !== null &&
      !symbols.has(resolution.target_symbol_identity)
    ) {
      throw new CodeTopologyIntegrityError(
        `Resolution for '${resolution.reference_identity}' has a missing target symbol.`
      );
    }
    if (resolution.target_file_path !== null && !files.has(resolution.target_file_path)) {
      throw new CodeTopologyIntegrityError(
        `Resolution for '${resolution.reference_identity}' has a missing target file.`
      );
    }
  }
  if (generation.resolutions.length !== generation.references.length) {
    throw new CodeTopologyIntegrityError(
      "Every persisted reference must have exactly one resolution outcome."
    );
  }
  for (const edge of generation.edges) {
    if (
      edge.source.generation_identity !== header.identity ||
      edge.target.generation_identity !== header.identity
    ) {
      throw new CodeTopologyIntegrityError(
        `Cross-generation edge '${edge.identity}' is not allowed.`
      );
    }
    if (
      !symbols.has(edge.source.symbol_identity) ||
      !symbols.has(edge.target.symbol_identity)
    ) {
      throw new CodeTopologyIntegrityError(
        `Edge '${edge.identity}' refers to a missing endpoint.`
      );
    }
    if (edge.reference_identity !== null && !references.has(edge.reference_identity)) {
      throw new CodeTopologyIntegrityError(
        `Edge '${edge.identity}' refers to a missing reference.`
      );
    }
  }
}

export function codeTopologyGenerationCounts(
  generation: CompleteCodeTopologyGeneration
): CodeTopologyGenerationCounts {
  return {
    files: generation.files.length,
    symbols: generation.symbols.length,
    references: generation.references.length,
    resolutions: generation.resolutions.length,
    edges: generation.edges.length,
  };
}
