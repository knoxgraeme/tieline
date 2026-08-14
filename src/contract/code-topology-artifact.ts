import { createHash } from "node:crypto";
import { supportedCodeLanguages } from "./code-analysis/languages.js";
import {
  CODE_TOPOLOGY_ARTIFACT_ENCODING,
  CODE_TOPOLOGY_ARTIFACT_PRODUCER,
  CODE_TOPOLOGY_ARTIFACT_PRODUCER_VERSION,
  CODE_TOPOLOGY_ARTIFACT_PROVIDER,
  CODE_TOPOLOGY_ARTIFACT_SCHEMA_VERSION,
  CODE_TOPOLOGY_MAX_DEPENDENCY_RECORDS,
  canonicalCodeTopologyJson,
  codeTopologyArtifactProjectionDigestOrdered,
  type CodeTopologyArtifactEnvelope,
  type CodeTopologyArtifactReadResult,
} from "../domain/code-topology-artifact.js";
import type {
  CodeTopologyFrontierRecord,
  CodeTopologyReadModelGeneration,
} from "../domain/code-topology-store.js";

export const CODE_TOPOLOGY_ARTIFACT_FILE = "graph.json";
export const CODE_TOPOLOGY_ARTIFACT_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const CODE_TOPOLOGY_ARTIFACT_MAX_PATH_LENGTH = 1_000;
export const CODE_TOPOLOGY_ARTIFACT_MAX_STRING_LENGTH = 8_000;
export const CODE_TOPOLOGY_ARTIFACT_MAX_FILES = 5_000;
export const CODE_TOPOLOGY_ARTIFACT_MAX_SYMBOLS = 100_000;
export const CODE_TOPOLOGY_ARTIFACT_MAX_RECORDS =
  CODE_TOPOLOGY_ARTIFACT_MAX_FILES +
  CODE_TOPOLOGY_ARTIFACT_MAX_SYMBOLS +
  CODE_TOPOLOGY_MAX_DEPENDENCY_RECORDS;

export interface SerializedCodeTopologyArtifact {
  files: ReadonlyMap<string, Buffer>;
  artifact_digest: string;
  total_bytes: number;
}

export type CodeTopologyArtifactMetadata = Omit<
  CodeTopologyArtifactEnvelope,
  "files" | "symbols" | "edges" | "frontiers"
>;

export type CodeTopologyArtifactDirectReadResult =
  | {
      status: "complete";
      artifact_digest: string;
      metadata: CodeTopologyArtifactMetadata;
      read_model: CodeTopologyReadModelGeneration;
    }
  | Exclude<CodeTopologyArtifactReadResult, { status: "complete" }>;

const sha256Pattern = /^[a-f0-9]{64}$/;
const artifactLanguages: ReadonlySet<string> = new Set(
  supportedCodeLanguages.map((language) => language.id)
);
const artifactFrontierKinds: ReadonlySet<string> = new Set<CodeTopologyFrontierRecord["kind"]>([
  "import", "dynamic_import", "export", "reexport",
]);
const artifactFrontierStatuses: ReadonlySet<string> = new Set<CodeTopologyFrontierRecord["status"]>([
  "ambiguous", "unresolved", "external",
]);

function sorted<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...values].sort((left, right) => key(left).localeCompare(key(right)));
}

function edgeKey(edge: CodeTopologyArtifactEnvelope["edges"][number]): string {
  return [
    edge.source_symbol_identity,
    edge.target_symbol_identity,
    edge.reference_identity ?? "",
    edge.kind,
  ].join("\0");
}

function logicalDigestInput(artifact: CodeTopologyArtifactEnvelope): unknown {
  const { artifact_digest: _artifactDigest, ...logical } = artifact;
  return logical;
}

function updateCanonicalHash(
  hash: ReturnType<typeof createHash>,
  value: unknown
): void {
  if (Array.isArray(value)) {
    hash.update("[");
    value.forEach((child, index) => {
      if (index > 0) hash.update(",");
      updateCanonicalHash(hash, child);
    });
    hash.update("]");
    return;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    hash.update("{");
    entries.forEach(([key, child], index) => {
      if (index > 0) hash.update(",");
      hash.update(`${JSON.stringify(key)}:`);
      updateCanonicalHash(hash, child);
    });
    hash.update("}");
    return;
  }
  hash.update(canonicalCodeTopologyJson(value));
}

export function codeTopologyArtifactDigest(
  artifact: CodeTopologyArtifactEnvelope
): string {
  const hash = createHash("sha256");
  updateCanonicalHash(hash, logicalDigestInput(artifact));
  return hash.digest("hex");
}

function normalizedEnvelope(
  artifact: CodeTopologyArtifactEnvelope
): CodeTopologyArtifactEnvelope {
  const normalized: CodeTopologyArtifactEnvelope = {
    ...artifact,
    files: sorted(artifact.files, (file) => file.path),
    symbols: sorted(artifact.symbols, (symbol) => symbol.identity),
    edges: sorted(artifact.edges, edgeKey),
    frontiers: sorted(artifact.frontiers, (frontier) => frontier.reference_identity),
  };
  normalized.artifact_digest = codeTopologyArtifactDigest(normalized);
  return normalized;
}

function serializeGraph(artifact: CodeTopologyArtifactEnvelope): Buffer {
  const entries = Object.entries(artifact)
    .sort(([left], [right]) => left.localeCompare(right));
  const lines = ["{"];
  entries.forEach(([key, value], fieldIndex) => {
    const suffix = fieldIndex + 1 < entries.length ? "," : "";
    if (!Array.isArray(value)) {
      lines.push(`${JSON.stringify(key)}:${canonicalCodeTopologyJson(value)}${suffix}`);
      return;
    }
    lines.push(`${JSON.stringify(key)}:[`);
    value.forEach((record, recordIndex) => {
      lines.push(`${canonicalCodeTopologyJson(record)}${recordIndex + 1 < value.length ? "," : ""}`);
    });
    lines.push(`]${suffix}`);
  });
  lines.push("}");
  return Buffer.from(`${lines.join("\n")}\n`);
}

export function topologyArtifactFromReadModel(
  model: CodeTopologyReadModelGeneration
): CodeTopologyArtifactEnvelope {
  if (model.files.length > CODE_TOPOLOGY_ARTIFACT_MAX_FILES) {
    throw new Error(`Topology artifact exceeds the ${CODE_TOPOLOGY_ARTIFACT_MAX_FILES}-file limit.`);
  }
  if (model.symbols.length > CODE_TOPOLOGY_ARTIFACT_MAX_SYMBOLS) {
    throw new Error(`Topology artifact exceeds the ${CODE_TOPOLOGY_ARTIFACT_MAX_SYMBOLS}-symbol limit.`);
  }
  if (model.edges.length + model.frontiers.length > CODE_TOPOLOGY_MAX_DEPENDENCY_RECORDS) {
    throw new Error(`Topology artifact exceeds the ${CODE_TOPOLOGY_MAX_DEPENDENCY_RECORDS}-record shared edge/frontier limit.`);
  }
  const generation = structuredClone(model.summary.header);
  return normalizedEnvelope({
    schema_version: CODE_TOPOLOGY_ARTIFACT_SCHEMA_VERSION,
    encoding: CODE_TOPOLOGY_ARTIFACT_ENCODING,
    producer: {
      identity: CODE_TOPOLOGY_ARTIFACT_PRODUCER,
      version: CODE_TOPOLOGY_ARTIFACT_PRODUCER_VERSION,
    },
    provider: { identity: CODE_TOPOLOGY_ARTIFACT_PROVIDER },
    compatibility: {
      topology_schema_version: generation.topology_schema_version,
      parser_compatibility_digest: generation.parser_compatibility_digest,
      resolver_implementation: generation.resolver_implementation,
      resolver_configuration_digest: generation.resolver_configuration_digest,
      fact_policy_digest: generation.fact_policy_digest,
    },
    generation,
    selected_input_digest: generation.revision,
    projection_digest: model.projection_digest,
    artifact_digest: "",
    counts: {
      ...model.summary.counts,
      frontiers: model.frontiers.length,
      dependency_records: model.edges.length + model.frontiers.length,
    },
    files: structuredClone(model.files),
    symbols: structuredClone(model.symbols),
    edges: structuredClone(model.edges),
    frontiers: structuredClone(model.frontiers),
  });
}

/** Serialize the thin traversal projection as one deterministic, line-oriented JSON document. */
export function serializeCodeTopologyArtifact(
  input: CodeTopologyArtifactEnvelope
): SerializedCodeTopologyArtifact {
  const artifact = normalizedEnvelope(input);
  validateArtifact(artifact);
  const bytes = serializeGraph(artifact);
  if (bytes.byteLength > CODE_TOPOLOGY_ARTIFACT_MAX_FILE_BYTES) {
    throw new Error(`Topology graph exceeds the ${CODE_TOPOLOGY_ARTIFACT_MAX_FILE_BYTES}-byte file limit.`);
  }
  return {
    files: new Map([[CODE_TOPOLOGY_ARTIFACT_FILE, bytes]]),
    artifact_digest: artifact.artifact_digest,
    total_bytes: bytes.byteLength,
  };
}

function invalid(detail: string): { status: "invalid"; detail: string } {
  return { status: "invalid", detail };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  label: string,
  expected: readonly string[]
): void {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new Error(`${label} contains unsupported fields.`);
  }
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Topology graph is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertBoundedJson(value: unknown): void {
  let visited = 0;
  const visit = (entry: unknown, depth: number): void => {
    visited += 1;
    if (visited > 4_000_000) throw new Error("Topology graph exceeds the decoded-value limit.");
    if (depth > 16) throw new Error("Topology graph exceeds the nesting limit.");
    if (typeof entry === "string" && entry.length > CODE_TOPOLOGY_ARTIFACT_MAX_STRING_LENGTH) {
      throw new Error(`Topology graph contains a string longer than ${CODE_TOPOLOGY_ARTIFACT_MAX_STRING_LENGTH} characters.`);
    }
    if (Array.isArray(entry)) {
      if (entry.length > CODE_TOPOLOGY_MAX_DEPENDENCY_RECORDS) {
        throw new Error("Topology graph contains an oversized array.");
      }
      for (const child of entry) visit(child, depth + 1);
    } else if (isObject(entry)) {
      for (const [key, child] of Object.entries(entry)) {
        if (key.length > CODE_TOPOLOGY_ARTIFACT_MAX_STRING_LENGTH) {
          throw new Error("Topology graph contains an oversized property name.");
        }
        visit(child, depth + 1);
      }
    }
  };
  visit(value, 0);
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function sha256String(value: unknown): value is string {
  return typeof value === "string" && sha256Pattern.test(value);
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isSorted<T>(values: readonly T[], key: (value: T) => string): boolean {
  return values.every((value, index) => index === 0 || key(values[index - 1]!) <= key(value));
}

function artifactFromUnknown(value: unknown): CodeTopologyArtifactEnvelope {
  const graph = asObject(value, "Topology graph");
  assertExactKeys(graph, "Topology graph", [
    "schema_version", "encoding", "producer", "provider", "compatibility",
    "generation", "selected_input_digest", "projection_digest", "artifact_digest",
    "counts", "files", "symbols", "edges", "frontiers",
  ]);
  const producer = isObject(graph.producer) ? graph.producer : null;
  const provider = isObject(graph.provider) ? graph.provider : null;
  const compatibility = isObject(graph.compatibility) ? graph.compatibility : null;
  const generation = isObject(graph.generation) ? graph.generation : null;
  const counts = isObject(graph.counts) ? graph.counts : null;
  if (!producer || !provider || !compatibility || !generation || !counts ||
      !Array.isArray(graph.files) || !Array.isArray(graph.symbols) ||
      !Array.isArray(graph.edges) || !Array.isArray(graph.frontiers)) {
    throw new Error("Topology graph fields are incomplete.");
  }
  assertExactKeys(producer, "Topology graph producer", ["identity", "version"]);
  assertExactKeys(provider, "Topology graph provider", ["identity"]);
  assertExactKeys(compatibility, "Topology graph compatibility", [
    "topology_schema_version", "parser_compatibility_digest", "resolver_implementation",
    "resolver_configuration_digest", "fact_policy_digest",
  ]);
  assertExactKeys(generation, "Topology graph generation", [
    "repository", "revision", "inventory_digest", "parser_compatibility_digest",
    "resolver_implementation", "resolver_configuration_digest", "topology_schema_version",
    "fact_policy_digest", "identity",
  ]);
  assertExactKeys(counts, "Topology graph counts", [
    "files", "symbols", "references", "resolutions", "edges", "frontiers",
    "dependency_records",
  ]);
  if (graph.schema_version !== CODE_TOPOLOGY_ARTIFACT_SCHEMA_VERSION) {
    throw new Error(`Unsupported artifact schema '${graph.schema_version}'.`);
  }
  if (graph.encoding !== CODE_TOPOLOGY_ARTIFACT_ENCODING) {
    throw new Error(`Unsupported artifact encoding '${graph.encoding}'.`);
  }
  if (producer.identity !== CODE_TOPOLOGY_ARTIFACT_PRODUCER ||
      producer.version !== CODE_TOPOLOGY_ARTIFACT_PRODUCER_VERSION ||
      provider.identity !== CODE_TOPOLOGY_ARTIFACT_PROVIDER) {
    throw new Error("Unsupported topology artifact producer/provider.");
  }
  if (!nonnegativeInteger(compatibility.topology_schema_version) ||
      !sha256String(compatibility.parser_compatibility_digest) ||
      !nonemptyString(compatibility.resolver_implementation) ||
      !sha256String(compatibility.resolver_configuration_digest) ||
      !sha256String(compatibility.fact_policy_digest) ||
      !nonemptyString(generation.repository) ||
      !sha256String(generation.identity) ||
      !sha256String(generation.revision) ||
      !sha256String(generation.inventory_digest) ||
      !sha256String(generation.parser_compatibility_digest) ||
      !nonemptyString(generation.resolver_implementation) ||
      !sha256String(generation.resolver_configuration_digest) ||
      !nonnegativeInteger(generation.topology_schema_version) ||
      !sha256String(generation.fact_policy_digest) ||
      !sha256String(graph.selected_input_digest) ||
      !sha256String(graph.projection_digest) ||
      !sha256String(graph.artifact_digest)) {
    throw new Error("Topology graph metadata is malformed.");
  }
  if (![counts.files, counts.symbols, counts.references, counts.resolutions,
    counts.edges, counts.frontiers, counts.dependency_records].every(nonnegativeInteger)) {
    throw new Error("Topology graph counts are malformed.");
  }
  for (const value of graph.files) {
    const file = isObject(value) ? value : null;
    if (file) assertExactKeys(file, "Topology graph file record", [
      "path", "kind", "framework_hint", "language", "source_hash",
    ]);
    if (!file || !nonemptyString(file.path) || file.path.length > CODE_TOPOLOGY_ARTIFACT_MAX_PATH_LENGTH ||
        (file.kind !== "code" && file.kind !== "test") ||
        !nullableString(file.framework_hint) ||
        typeof file.language !== "string" || !artifactLanguages.has(file.language) ||
        !sha256String(file.source_hash)) {
      throw new Error("Topology graph contains an invalid file record.");
    }
  }
  for (const value of graph.symbols) {
    const symbol = isObject(value) ? value : null;
    if (symbol) assertExactKeys(symbol, "Topology graph symbol record", [
      "identity", "file_path", "native_kind", "canonical_selector", "asset_kind",
      "framework_hint",
    ]);
    if (!symbol || !nonemptyString(symbol.identity) || !nonemptyString(symbol.file_path) ||
        symbol.file_path.length > CODE_TOPOLOGY_ARTIFACT_MAX_PATH_LENGTH ||
        !nonemptyString(symbol.native_kind) || !nullableString(symbol.canonical_selector) ||
        (symbol.asset_kind !== "code" && symbol.asset_kind !== "test") ||
        !nullableString(symbol.framework_hint)) {
      throw new Error("Topology graph contains an invalid symbol record.");
    }
  }
  for (const value of graph.edges) {
    const edge = isObject(value) ? value : null;
    if (edge) assertExactKeys(edge, "Topology graph edge record", [
      "kind", "source_symbol_identity", "target_symbol_identity", "reference_identity",
    ]);
    if (!edge || !nonemptyString(edge.kind) || !nonemptyString(edge.source_symbol_identity) ||
        !nonemptyString(edge.target_symbol_identity) ||
        !(edge.reference_identity === null || nonemptyString(edge.reference_identity))) {
      throw new Error("Topology graph contains an invalid edge record.");
    }
  }
  for (const value of graph.frontiers) {
    const frontier = isObject(value) ? value : null;
    if (frontier) assertExactKeys(frontier, "Topology graph frontier record", [
      "reference_identity", "source_symbol_identity", "file_path", "kind",
      "module_specifier", "status", "rule", "candidate_targets", "diagnostics",
    ]);
    if (!frontier || !nonemptyString(frontier.reference_identity) ||
        !nonemptyString(frontier.source_symbol_identity) || !nonemptyString(frontier.file_path) ||
        frontier.file_path.length > CODE_TOPOLOGY_ARTIFACT_MAX_PATH_LENGTH ||
        typeof frontier.kind !== "string" || !artifactFrontierKinds.has(frontier.kind) ||
        !nullableString(frontier.module_specifier) ||
        typeof frontier.status !== "string" || !artifactFrontierStatuses.has(frontier.status) ||
        !nonemptyString(frontier.rule) || !stringArray(frontier.candidate_targets) ||
        !stringArray(frontier.diagnostics)) {
      throw new Error("Topology graph contains an invalid frontier record.");
    }
  }
  return graph as unknown as CodeTopologyArtifactEnvelope;
}

function validateArtifact(artifact: CodeTopologyArtifactEnvelope): void {
  if (artifact.files.length > CODE_TOPOLOGY_ARTIFACT_MAX_FILES ||
      artifact.symbols.length > CODE_TOPOLOGY_ARTIFACT_MAX_SYMBOLS ||
      artifact.files.length + artifact.symbols.length + artifact.edges.length + artifact.frontiers.length >
        CODE_TOPOLOGY_ARTIFACT_MAX_RECORDS) {
    throw new Error("Topology graph exceeds the record limits.");
  }
  if (artifact.edges.length + artifact.frontiers.length > CODE_TOPOLOGY_MAX_DEPENDENCY_RECORDS) {
    throw new Error("Topology graph exceeds the dependency-record limit.");
  }
  if (artifact.selected_input_digest !== artifact.generation.revision) {
    throw new Error("Selected-input digest does not match the generation.");
  }
  if (artifact.compatibility.topology_schema_version !== artifact.generation.topology_schema_version ||
      artifact.compatibility.parser_compatibility_digest !== artifact.generation.parser_compatibility_digest ||
      artifact.compatibility.resolver_implementation !== artifact.generation.resolver_implementation ||
      artifact.compatibility.resolver_configuration_digest !== artifact.generation.resolver_configuration_digest ||
      artifact.compatibility.fact_policy_digest !== artifact.generation.fact_policy_digest) {
    throw new Error("Topology graph compatibility metadata does not match its generation.");
  }
  if (artifact.counts.files !== artifact.files.length ||
      artifact.counts.symbols !== artifact.symbols.length ||
      artifact.counts.edges !== artifact.edges.length ||
      artifact.counts.frontiers !== artifact.frontiers.length ||
      artifact.counts.dependency_records !== artifact.edges.length + artifact.frontiers.length) {
    throw new Error("Topology graph count mismatch.");
  }
  if (!isSorted(artifact.files, (file) => file.path) ||
      !isSorted(artifact.symbols, (symbol) => symbol.identity) ||
      !isSorted(artifact.edges, edgeKey) ||
      !isSorted(artifact.frontiers, (frontier) => frontier.reference_identity)) {
    throw new Error("Topology graph records are not in canonical order.");
  }
  const filePaths = new Set<string>();
  for (const file of artifact.files) {
    if (filePaths.has(file.path)) throw new Error(`Duplicate topology file path '${file.path}'.`);
    filePaths.add(file.path);
  }
  const symbols = new Map<string, CodeTopologyArtifactEnvelope["symbols"][number]>();
  for (const symbol of artifact.symbols) {
    if (!filePaths.has(symbol.file_path)) {
      throw new Error(`Topology symbol '${symbol.identity}' refers to missing file '${symbol.file_path}'.`);
    }
    if (symbols.has(symbol.identity)) throw new Error(`Duplicate artifact symbol identity '${symbol.identity}'.`);
    symbols.set(symbol.identity, symbol);
  }
  for (const edge of artifact.edges) {
    if (!symbols.has(edge.source_symbol_identity) || !symbols.has(edge.target_symbol_identity)) {
      throw new Error("Topology graph edge endpoint is missing from the symbol projection.");
    }
  }
  for (const frontier of artifact.frontiers) {
    const source = symbols.get(frontier.source_symbol_identity);
    if (!source || source.file_path !== frontier.file_path) {
      throw new Error(`Topology frontier '${frontier.reference_identity}' has an invalid source.`);
    }
  }
  const projectionDigest = codeTopologyArtifactProjectionDigestOrdered({
    files: artifact.files,
    symbols: artifact.symbols,
    edges: artifact.edges,
    frontiers: artifact.frontiers,
  });
  if (projectionDigest !== artifact.projection_digest) {
    throw new Error(`Topology graph projection digest mismatch: expected ${artifact.projection_digest}, calculated ${projectionDigest}.`);
  }
  if (codeTopologyArtifactDigest(artifact) !== artifact.artifact_digest) {
    throw new Error("Topology graph artifact digest mismatch.");
  }
}

function graphBytes(inputFiles: ReadonlyMap<string, Buffer>): Buffer | Exclude<
  CodeTopologyArtifactDirectReadResult,
  { status: "complete" }
> {
  const bytes = inputFiles.get(CODE_TOPOLOGY_ARTIFACT_FILE);
  if (!bytes) return invalid(`Missing '${CODE_TOPOLOGY_ARTIFACT_FILE}'.`);
  if (inputFiles.size !== 1) return invalid("Topology authority contains unexpected artifact files.");
  if (bytes.byteLength > CODE_TOPOLOGY_ARTIFACT_MAX_FILE_BYTES) {
    return { status: "capacity_exceeded", detail: "Topology graph exceeds the file byte limit." };
  }
  return bytes;
}

export function parseCodeTopologyArtifact(
  inputFiles: ReadonlyMap<string, Buffer>
): CodeTopologyArtifactReadResult {
  const selected = graphBytes(inputFiles);
  if (!Buffer.isBuffer(selected)) return selected;
  try {
    const parsed = parseJson(selected);
    assertBoundedJson(parsed);
    const raw = asObject(parsed, "Topology graph");
    if (raw.schema_version !== undefined && raw.schema_version !== CODE_TOPOLOGY_ARTIFACT_SCHEMA_VERSION) {
      return { status: "incompatible", detail: `Unsupported artifact schema '${raw.schema_version}'.` };
    }
    if (raw.encoding !== undefined && raw.encoding !== CODE_TOPOLOGY_ARTIFACT_ENCODING) {
      return { status: "incompatible", detail: `Unsupported artifact encoding '${raw.encoding}'.` };
    }
    const producer = isObject(raw.producer) ? raw.producer : null;
    const provider = isObject(raw.provider) ? raw.provider : null;
    if ((producer && (producer.identity !== CODE_TOPOLOGY_ARTIFACT_PRODUCER ||
        producer.version !== CODE_TOPOLOGY_ARTIFACT_PRODUCER_VERSION)) ||
        (provider && provider.identity !== CODE_TOPOLOGY_ARTIFACT_PROVIDER)) {
      return { status: "incompatible", detail: "Unsupported topology artifact producer/provider." };
    }
    const artifact = artifactFromUnknown(raw);
    validateArtifact(artifact);
    if (!selected.equals(serializeGraph(artifact))) {
      return invalid("Topology graph bytes are not canonical.");
    }
    return { status: "complete", artifact };
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error));
  }
}

/** Parser-free production reader for the committed graph snapshot. */
export function readCodeTopologyArtifact(
  inputFiles: ReadonlyMap<string, Buffer>
): CodeTopologyArtifactDirectReadResult {
  const parsed = parseCodeTopologyArtifact(inputFiles);
  if (parsed.status !== "complete") return parsed;
  const { files, symbols, edges, frontiers, ...metadata } = parsed.artifact;
  return {
    status: "complete",
    artifact_digest: metadata.artifact_digest,
    metadata,
    read_model: {
      summary: {
        header: metadata.generation,
        counts: {
          files: metadata.counts.files,
          symbols: metadata.counts.symbols,
          references: metadata.counts.references,
          resolutions: metadata.counts.resolutions,
          edges: metadata.counts.edges,
        },
      },
      projection_digest: metadata.projection_digest,
      files,
      symbols,
      edges,
      frontiers,
      retained_bytes: 0,
    },
  };
}

export function artifactReadModel(
  artifact: CodeTopologyArtifactEnvelope
): CodeTopologyReadModelGeneration {
  return {
    summary: {
      header: structuredClone(artifact.generation),
      counts: {
        files: artifact.counts.files,
        symbols: artifact.counts.symbols,
        references: artifact.counts.references,
        resolutions: artifact.counts.resolutions,
        edges: artifact.counts.edges,
      },
    },
    projection_digest: artifact.projection_digest,
    files: structuredClone(artifact.files),
    symbols: structuredClone(artifact.symbols),
    edges: structuredClone(artifact.edges),
    frontiers: structuredClone(artifact.frontiers),
    retained_bytes: 0,
  };
}
