import { createHash } from "node:crypto";
import {
  CODE_TOPOLOGY_ARTIFACT_ENCODING,
  CODE_TOPOLOGY_ARTIFACT_PRODUCER,
  CODE_TOPOLOGY_ARTIFACT_PRODUCER_VERSION,
  CODE_TOPOLOGY_ARTIFACT_PROVIDER,
  CODE_TOPOLOGY_ARTIFACT_SCHEMA_VERSION,
  CODE_TOPOLOGY_MAX_DEPENDENCY_RECORDS,
  canonicalCodeTopologyJson,
  codeTopologyArtifactProjectionDigest,
  codeTopologyArtifactProjectionDigestOrdered,
  type CodeTopologyArtifactCounts,
  type CodeTopologyArtifactEdgeRecord,
  type CodeTopologyArtifactEnvelope,
  type CodeTopologyArtifactFileRecord,
  type CodeTopologyArtifactReadResult,
} from "../domain/code-topology-artifact.js";
import type {
  CodeTopologyFrontierRecord,
  CodeTopologyReadModelEdge,
  CodeTopologyReadModelGeneration,
  CodeTopologyTraversalSymbolRecord,
} from "../domain/code-topology-store.js";

export const CODE_TOPOLOGY_ARTIFACT_INDEX = "topology.json";
export const CODE_TOPOLOGY_ARTIFACT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
export const CODE_TOPOLOGY_ARTIFACT_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const CODE_TOPOLOGY_ARTIFACT_MAX_SHARDS = 5_000;
export const CODE_TOPOLOGY_ARTIFACT_MAX_PATH_LENGTH = 1_000;
export const CODE_TOPOLOGY_ARTIFACT_MAX_STRING_LENGTH = 8_000;
export const CODE_TOPOLOGY_ARTIFACT_MAX_RECORDS =
  CODE_TOPOLOGY_ARTIFACT_MAX_SHARDS + 100_000 + CODE_TOPOLOGY_MAX_DEPENDENCY_RECORDS;

type CompactSymbol = readonly [string, number, number | null];
type RawCompactEdge = readonly [number, number, number, string, string | null];
type CompactEdge = readonly [number, number, number, number, string | null];
type RawCompactFrontier = readonly [
  string,
  number,
  CodeTopologyFrontierRecord["kind"],
  string | null,
  "ambiguous" | "unresolved" | "external",
  string,
  readonly string[],
  readonly string[],
];
type CompactFrontier = readonly [
  string,
  number,
  number,
  number | null,
  0 | 1 | 2,
  number,
  readonly string[],
  readonly string[],
];

interface CompactShard {
  schema_version: number;
  generation_identity: string;
  file: CodeTopologyArtifactFileRecord;
  symbol_dictionary: { native_kinds: readonly string[]; selectors: readonly string[] };
  symbols: readonly CompactSymbol[];
  edge_kinds: readonly string[];
  edges: readonly CompactEdge[];
  frontier_dictionary: {
    kinds: readonly CodeTopologyFrontierRecord["kind"][];
    module_specifiers: readonly string[];
    rules: readonly string[];
  };
  frontiers: readonly CompactFrontier[];
}

interface ArtifactShardIndex {
  file_path: string;
  name: string;
  digest: string;
  bytes: number;
  symbols: number;
  edges: number;
  frontiers: number;
}

interface ArtifactIndex {
  schema_version: number;
  encoding: string;
  producer: CodeTopologyArtifactEnvelope["producer"];
  provider: CodeTopologyArtifactEnvelope["provider"];
  compatibility: CodeTopologyArtifactEnvelope["compatibility"];
  generation: CodeTopologyArtifactEnvelope["generation"];
  selected_input_digest: string;
  projection_digest: string;
  artifact_digest: string;
  counts: CodeTopologyArtifactCounts;
  shards: ArtifactShardIndex[];
}

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

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function compactIdentity(value: string | null): string | null {
  if (value === null) return null;
  const match = /^([^:]+):([a-f0-9]{64})$/.exec(value);
  return match ? `${match[1]}:${Buffer.from(match[2]!, "hex").toString("base64url")}` : value;
}

function expandIdentity(value: string | null): string | null {
  if (value === null) return null;
  const match = /^([^:]+):([A-Za-z0-9_-]{43})$/.exec(value);
  return match ? `${match[1]}:${Buffer.from(match[2]!, "base64url").toString("hex")}` : value;
}

function sorted<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...values].sort((left, right) => key(left).localeCompare(key(right)));
}

function dictionary(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function serializeIndex(index: ArtifactIndex): string {
  const fields = Object.entries(index)
    .filter(([key]) => key !== "shards")
    .sort(([left], [right]) => left.localeCompare(right));
  const lines = ["{"];
  for (const [key, value] of fields) {
    lines.push(`${JSON.stringify(key)}:${canonicalCodeTopologyJson(value)},`);
  }
  lines.push(`${JSON.stringify("shards")}:[`);
  index.shards.forEach((shard, offset) => {
    lines.push(`${canonicalCodeTopologyJson(shard)}${offset + 1 < index.shards.length ? "," : ""}`);
  });
  lines.push("]", "}");
  return `${lines.join("\n")}\n`;
}

function edgeReadModel(edge: CodeTopologyArtifactEdgeRecord): CodeTopologyReadModelEdge {
  return {
    kind: edge.kind,
    source_symbol_identity: edge.source.symbol_identity,
    target_symbol_identity: edge.target.symbol_identity,
    reference_identity: edge.reference_identity,
  };
}

function logicalDigestInput(artifact: CodeTopologyArtifactEnvelope): unknown {
  return {
    schema_version: artifact.schema_version,
    encoding: artifact.encoding,
    producer: artifact.producer,
    provider: artifact.provider,
    compatibility: artifact.compatibility,
    generation: artifact.generation,
    selected_input_digest: artifact.selected_input_digest,
    projection_digest: artifact.projection_digest,
    counts: artifact.counts,
    files: artifact.files,
    symbols: artifact.symbols,
    edges: artifact.edges,
    frontiers: artifact.frontiers,
  };
}

function updateCanonicalArray<T>(
  hash: ReturnType<typeof createHash>,
  values: readonly T[],
  encode: (value: T) => unknown = (value) => value
): void {
  hash.update("[");
  for (let index = 0; index < values.length; index += 1) {
    if (index > 0) hash.update(",");
    hash.update(canonicalCodeTopologyJson(encode(values[index]!)));
  }
  hash.update("]");
}

function directArtifactDigest(
  index: ArtifactIndex,
  model: CodeTopologyReadModelGeneration
): string {
  const hash = createHash("sha256");
  const fields: Array<readonly [string, () => void]> = [
    ["compatibility", () => hash.update(canonicalCodeTopologyJson(index.compatibility))],
    ["counts", () => hash.update(canonicalCodeTopologyJson(index.counts))],
    ["edges", () => updateCanonicalArray(hash, model.edges, (edge) => ({
      kind: edge.kind,
      source: {
        generation_identity: index.generation.identity,
        symbol_identity: edge.source_symbol_identity,
      },
      target: {
        generation_identity: index.generation.identity,
        symbol_identity: edge.target_symbol_identity,
      },
      reference_identity: edge.reference_identity,
    }))],
    ["encoding", () => hash.update(canonicalCodeTopologyJson(index.encoding))],
    ["files", () => updateCanonicalArray(hash, model.files)],
    ["frontiers", () => updateCanonicalArray(hash, model.frontiers)],
    ["generation", () => hash.update(canonicalCodeTopologyJson(index.generation))],
    ["producer", () => hash.update(canonicalCodeTopologyJson(index.producer))],
    ["projection_digest", () => hash.update(canonicalCodeTopologyJson(index.projection_digest))],
    ["provider", () => hash.update(canonicalCodeTopologyJson(index.provider))],
    ["schema_version", () => hash.update(canonicalCodeTopologyJson(index.schema_version))],
    ["selected_input_digest", () => hash.update(canonicalCodeTopologyJson(index.selected_input_digest))],
    ["symbols", () => updateCanonicalArray(hash, model.symbols)],
  ];
  hash.update("{");
  fields.forEach(([name, write], offset) => {
    if (offset > 0) hash.update(",");
    hash.update(`${JSON.stringify(name)}:`);
    write();
  });
  hash.update("}");
  return hash.digest("hex");
}

export function codeTopologyArtifactDigest(
  artifact: CodeTopologyArtifactEnvelope
): string {
  return sha256(canonicalCodeTopologyJson(logicalDigestInput(artifact)));
}

function normalizedEnvelope(
  artifact: CodeTopologyArtifactEnvelope
): CodeTopologyArtifactEnvelope {
  const files = sorted(artifact.files, (file) => file.path);
  const symbols = sorted(artifact.symbols, (symbol) => symbol.identity);
  const edges = sorted(artifact.edges, (edge) => [
    edge.source.symbol_identity,
    edge.target.symbol_identity,
    edge.reference_identity ?? "",
    edge.kind,
  ].join("\0"));
  const frontiers = sorted(artifact.frontiers, (frontier) => frontier.reference_identity);
  const normalized = { ...artifact, files, symbols, edges, frontiers };
  normalized.artifact_digest = codeTopologyArtifactDigest(normalized);
  return normalized;
}

export function topologyArtifactFromReadModel(
  model: CodeTopologyReadModelGeneration
): CodeTopologyArtifactEnvelope {
  if (model.edges.length + model.frontiers.length > CODE_TOPOLOGY_MAX_DEPENDENCY_RECORDS) {
    throw new Error(`Topology artifact exceeds the ${CODE_TOPOLOGY_MAX_DEPENDENCY_RECORDS}-record shared edge/frontier limit.`);
  }
  const generation = structuredClone(model.summary.header);
  const artifact: CodeTopologyArtifactEnvelope = {
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
    edges: model.edges.map((edge) => ({
      kind: edge.kind,
      source: {
        generation_identity: generation.identity,
        symbol_identity: edge.source_symbol_identity,
      },
      target: {
        generation_identity: generation.identity,
        symbol_identity: edge.target_symbol_identity,
      },
      reference_identity: edge.reference_identity,
    })),
    frontiers: structuredClone(model.frontiers),
  };
  return normalizedEnvelope(artifact);
}

function shardName(digest: string): string {
  return `files/${digest}.json`;
}

/** Selected sharded compact JSON encoder. Local symbol IDs are sorted array indexes. */
export function serializeCodeTopologyArtifact(
  input: CodeTopologyArtifactEnvelope
): SerializedCodeTopologyArtifact {
  const artifact = normalizedEnvelope(input);
  if (artifact.edges.length + artifact.frontiers.length > CODE_TOPOLOGY_MAX_DEPENDENCY_RECORDS) {
    throw new Error(`Topology artifact exceeds the ${CODE_TOPOLOGY_MAX_DEPENDENCY_RECORDS}-record shared edge/frontier limit.`);
  }
  const fileByPath = new Map(artifact.files.map((file) => [file.path, file]));
  const symbolsByPath = new Map<string, CodeTopologyTraversalSymbolRecord[]>();
  for (const symbol of artifact.symbols) {
    if (!fileByPath.has(symbol.file_path)) {
      throw new Error(`Artifact symbol '${symbol.identity}' refers to missing file '${symbol.file_path}'.`);
    }
    const values = symbolsByPath.get(symbol.file_path);
    if (values) values.push(symbol);
    else symbolsByPath.set(symbol.file_path, [symbol]);
  }
  for (const values of symbolsByPath.values()) values.sort((left, right) => left.identity.localeCompare(right.identity));
  const address = new Map<string, { path: string; local: number }>();
  const fileLocal = new Map(artifact.files.map((file, index) => [file.path, index]));
  for (const [path, symbols] of symbolsByPath) {
    symbols.forEach((symbol, local) => {
      if (address.has(symbol.identity)) throw new Error(`Duplicate artifact symbol identity '${symbol.identity}'.`);
      address.set(symbol.identity, { path, local });
    });
  }

  const edgesByPath = new Map<string, RawCompactEdge[]>();
  for (const edge of artifact.edges) {
    const source = address.get(edge.source.symbol_identity);
    const target = address.get(edge.target.symbol_identity);
    if (!source || !target) throw new Error("Artifact edge endpoint is missing from the symbol projection.");
    const compact: RawCompactEdge = [
      source.local,
      fileLocal.get(target.path)!,
      target.local,
      edge.kind,
      compactIdentity(edge.reference_identity),
    ];
    const values = edgesByPath.get(source.path);
    if (values) values.push(compact);
    else edgesByPath.set(source.path, [compact]);
  }
  const frontiersByPath = new Map<string, RawCompactFrontier[]>();
  for (const frontier of artifact.frontiers) {
    const source = address.get(frontier.source_symbol_identity);
    if (!source || source.path !== frontier.file_path) {
      throw new Error(`Artifact frontier '${frontier.reference_identity}' has an invalid source.`);
    }
    const compact: RawCompactFrontier = [
      compactIdentity(frontier.reference_identity)!,
      source.local,
      frontier.kind,
      frontier.module_specifier,
      frontier.status,
      frontier.rule,
      frontier.candidate_targets,
      frontier.diagnostics,
    ];
    const values = frontiersByPath.get(source.path);
    if (values) values.push(compact);
    else frontiersByPath.set(source.path, [compact]);
  }

  const files = new Map<string, Buffer>();
  const shards: ArtifactShardIndex[] = [];
  for (const file of artifact.files) {
    const symbols = symbolsByPath.get(file.path) ?? [];
    const symbolDictionary = {
      native_kinds: dictionary(symbols.map((symbol) => symbol.native_kind)),
      selectors: dictionary(symbols.flatMap((symbol) => symbol.canonical_selector === null ? [] : [symbol.canonical_selector])),
    };
    const rawEdges = (edgesByPath.get(file.path) ?? []).sort((left, right) =>
      canonicalCodeTopologyJson(left).localeCompare(canonicalCodeTopologyJson(right))
    );
    const edgeKinds = dictionary(rawEdges.map((edge) => edge[3]));
    const rawFrontiers = (frontiersByPath.get(file.path) ?? [])
      .sort((left, right) => left[0].localeCompare(right[0]));
    const frontierDictionary = {
      kinds: dictionary(rawFrontiers.map((frontier) => frontier[2])) as CodeTopologyFrontierRecord["kind"][],
      module_specifiers: dictionary(rawFrontiers.flatMap((frontier) => frontier[3] === null ? [] : [frontier[3]])),
      rules: dictionary(rawFrontiers.map((frontier) => frontier[5])),
    };
    const statusCode = { ambiguous: 0, unresolved: 1, external: 2 } as const;
    const shard: CompactShard = {
      schema_version: CODE_TOPOLOGY_ARTIFACT_SCHEMA_VERSION,
      generation_identity: artifact.generation.identity,
      file,
      symbol_dictionary: symbolDictionary,
      symbols: symbols.map((symbol) => [
        compactIdentity(symbol.identity)!,
        symbolDictionary.native_kinds.indexOf(symbol.native_kind),
        symbol.canonical_selector === null ? null : symbolDictionary.selectors.indexOf(symbol.canonical_selector),
      ] as const),
      edge_kinds: edgeKinds,
      edges: rawEdges.map((edge) => [edge[0], edge[1], edge[2], edgeKinds.indexOf(edge[3]), edge[4]] as const),
      frontier_dictionary: frontierDictionary,
      frontiers: rawFrontiers.map((frontier) => [
        frontier[0],
        frontier[1],
        frontierDictionary.kinds.indexOf(frontier[2]),
        frontier[3] === null ? null : frontierDictionary.module_specifiers.indexOf(frontier[3]),
        statusCode[frontier[4]],
        frontierDictionary.rules.indexOf(frontier[5]),
        frontier[6],
        frontier[7],
      ] as const),
    };
    const content = Buffer.from(`${canonicalCodeTopologyJson(shard)}\n`);
    if (content.byteLength > CODE_TOPOLOGY_ARTIFACT_MAX_FILE_BYTES) {
      throw new Error(`Artifact shard for '${file.path}' exceeds the per-file byte limit.`);
    }
    const digest = sha256(content);
    const name = shardName(digest);
    if (files.has(name)) throw new Error(`Artifact shard-name collision for '${file.path}'.`);
    files.set(name, content);
    shards.push({
      file_path: file.path,
      name,
      digest,
      bytes: content.byteLength,
      symbols: shard.symbols.length,
      edges: shard.edges.length,
      frontiers: shard.frontiers.length,
    });
  }
  const index: ArtifactIndex = {
    schema_version: artifact.schema_version,
    encoding: artifact.encoding,
    producer: artifact.producer,
    provider: artifact.provider,
    compatibility: artifact.compatibility,
    generation: artifact.generation,
    selected_input_digest: artifact.selected_input_digest,
    projection_digest: artifact.projection_digest,
    artifact_digest: artifact.artifact_digest,
    counts: artifact.counts,
    shards,
  };
  files.set(CODE_TOPOLOGY_ARTIFACT_INDEX, Buffer.from(serializeIndex(index)));
  const totalBytes = [...files.values()].reduce((sum, file) => sum + file.byteLength, 0);
  if (totalBytes > CODE_TOPOLOGY_ARTIFACT_MAX_TOTAL_BYTES) {
    throw new Error("Artifact exceeds the total byte limit.");
  }
  return { files, artifact_digest: artifact.artifact_digest, total_bytes: totalBytes };
}

function invalid(detail: string): { status: "invalid"; detail: string } {
  return { status: "invalid", detail };
}

function asObject(value: unknown, label: string): Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, any>;
}

function parseJson(bytes: Buffer, label: string): any {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch (error) { throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

function assertBoundedJson(value: unknown, label: string): void {
  let visited = 0;
  const visit = (entry: unknown, depth: number): void => {
    visited += 1;
    if (visited > 2_000_000) throw new Error(`${label} exceeds the decoded-value limit.`);
    if (depth > 32) throw new Error(`${label} exceeds the nesting limit.`);
    if (typeof entry === "string" && entry.length > CODE_TOPOLOGY_ARTIFACT_MAX_STRING_LENGTH) {
      throw new Error(`${label} contains a string longer than ${CODE_TOPOLOGY_ARTIFACT_MAX_STRING_LENGTH} characters.`);
    }
    if (Array.isArray(entry)) {
      if (entry.length > CODE_TOPOLOGY_MAX_DEPENDENCY_RECORDS) {
        throw new Error(`${label} contains an oversized array.`);
      }
      for (const child of entry) visit(child, depth + 1);
    } else if (entry !== null && typeof entry === "object") {
      for (const [key, child] of Object.entries(entry as Record<string, unknown>)) {
        if (key.length > CODE_TOPOLOGY_ARTIFACT_MAX_STRING_LENGTH) {
          throw new Error(`${label} contains an oversized property name.`);
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

/**
 * Parser-free production reader for the selected physical candidate.
 *
 * The decoder transfers one thin read model to the traversal store. It does
 * not first hydrate the larger logical envelope with nested edge endpoints;
 * that distinction is what keeps two-role reads inside the artifact memory
 * budget.
 */
export function readCodeTopologyArtifact(
  inputFiles: ReadonlyMap<string, Buffer>
): CodeTopologyArtifactDirectReadResult {
  try {
    const indexBytes = inputFiles.get(CODE_TOPOLOGY_ARTIFACT_INDEX);
    if (!indexBytes) return invalid(`Missing '${CODE_TOPOLOGY_ARTIFACT_INDEX}'.`);
    const totalBytes = [...inputFiles.values()].reduce((sum, value) => sum + value.byteLength, 0);
    if (totalBytes > CODE_TOPOLOGY_ARTIFACT_MAX_TOTAL_BYTES) {
      return { status: "capacity_exceeded", detail: "Artifact exceeds the total byte limit." };
    }
    for (const [name, bytes] of inputFiles) {
      if (bytes.byteLength > CODE_TOPOLOGY_ARTIFACT_MAX_FILE_BYTES) {
        return { status: "capacity_exceeded", detail: `Artifact file '${name}' exceeds the per-file byte limit.` };
      }
    }
    const parsedIndex = parseJson(indexBytes, CODE_TOPOLOGY_ARTIFACT_INDEX);
    assertBoundedJson(parsedIndex, "Artifact index");
    const index = asObject(parsedIndex, "Artifact index") as unknown as ArtifactIndex;
    if (index.schema_version !== CODE_TOPOLOGY_ARTIFACT_SCHEMA_VERSION) {
      return { status: "incompatible", detail: `Unsupported artifact schema '${index.schema_version}'.` };
    }
    if (index.encoding !== CODE_TOPOLOGY_ARTIFACT_ENCODING) {
      return { status: "incompatible", detail: `Unsupported artifact encoding '${index.encoding}'.` };
    }
    if (index.producer?.identity !== CODE_TOPOLOGY_ARTIFACT_PRODUCER ||
        index.producer?.version !== CODE_TOPOLOGY_ARTIFACT_PRODUCER_VERSION ||
        index.provider?.identity !== CODE_TOPOLOGY_ARTIFACT_PROVIDER) {
      return { status: "incompatible", detail: "Unsupported topology artifact producer/provider." };
    }
    if (!Array.isArray(index.shards) || !index.generation || !index.counts) return invalid("Artifact index fields are incomplete.");
    if (index.shards.length > CODE_TOPOLOGY_ARTIFACT_MAX_SHARDS) {
      return { status: "capacity_exceeded", detail: `Artifact exceeds the ${CODE_TOPOLOGY_ARTIFACT_MAX_SHARDS}-shard limit.` };
    }
    if (!index.shards.every((entry) =>
      nonnegativeInteger(entry?.bytes) && nonnegativeInteger(entry?.symbols) &&
      nonnegativeInteger(entry?.edges) && nonnegativeInteger(entry?.frontiers)
    )) return invalid("Artifact shard counts are malformed.");
    if (![index.counts.files, index.counts.symbols, index.counts.references,
      index.counts.resolutions, index.counts.edges, index.counts.frontiers,
      index.counts.dependency_records].every(nonnegativeInteger)) {
      return invalid("Artifact counts are malformed.");
    }
    if (index.shards.reduce((sum, entry) => sum + entry.edges + entry.frontiers, 0) > CODE_TOPOLOGY_MAX_DEPENDENCY_RECORDS) {
      return { status: "capacity_exceeded", detail: "Artifact shard declarations exceed the dependency-record limit." };
    }
    if (index.shards.reduce((sum, entry) =>
      sum + 1 + entry.symbols + entry.edges + entry.frontiers, 0
    ) > CODE_TOPOLOGY_ARTIFACT_MAX_RECORDS) {
      return { status: "capacity_exceeded", detail: "Artifact shard declarations exceed the total record limit." };
    }
    if (index.selected_input_digest !== index.generation.revision) return invalid("Selected-input digest does not match the generation.");
    if (!sha256Pattern.test(index.artifact_digest) || !sha256Pattern.test(index.projection_digest)) return invalid("Artifact digests are malformed.");
    if (index.counts.dependency_records > CODE_TOPOLOGY_MAX_DEPENDENCY_RECORDS) {
      return { status: "capacity_exceeded", detail: "Artifact exceeds the dependency-record limit." };
    }
    if (!indexBytes.equals(Buffer.from(serializeIndex(index)))) {
      return invalid("Artifact index bytes are not canonical.");
    }

    const files: CodeTopologyArtifactFileRecord[] = [];
    const symbols: CodeTopologyTraversalSymbolRecord[] = [];
    const shardSymbols = new Map<string, CodeTopologyTraversalSymbolRecord[]>();
    const edges: CodeTopologyReadModelEdge[] = [];
    const frontiers: CodeTopologyFrontierRecord[] = [];
    const seenNames = new Set<string>();
    const seenPaths = new Set<string>();
    for (const rawEntry of index.shards) {
      const entry = asObject(rawEntry, "Shard index") as unknown as ArtifactShardIndex;
      if (seenNames.has(entry.name) || seenPaths.has(entry.file_path)) return invalid("Artifact contains a duplicate shard identity.");
      seenNames.add(entry.name);
      seenPaths.add(entry.file_path);
      if (typeof entry.file_path !== "string" || entry.file_path.length > CODE_TOPOLOGY_ARTIFACT_MAX_PATH_LENGTH ||
          typeof entry.name !== "string" || entry.name !== shardName(entry.digest) ||
          entry.name.startsWith("/") || entry.name.includes("..")) return invalid(`Unsafe or mismatched shard name '${entry.name}'.`);
      const bytes = inputFiles.get(entry.name);
      if (!bytes || bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.digest) return invalid(`Artifact shard '${entry.name}' is missing or corrupt.`);
      const parsedShard = parseJson(bytes, entry.name);
      assertBoundedJson(parsedShard, `Artifact shard '${entry.name}'`);
      const shard = asObject(parsedShard, "Artifact shard") as unknown as CompactShard;
      if (!bytes.equals(Buffer.from(`${canonicalCodeTopologyJson(shard)}\n`))) {
        return invalid(`Artifact shard '${entry.name}' bytes are not canonical.`);
      }
      if (shard.schema_version !== CODE_TOPOLOGY_ARTIFACT_SCHEMA_VERSION || shard.generation_identity !== index.generation.identity) return invalid(`Artifact shard '${entry.name}' belongs to another generation.`);
      if (!shard.file || shard.file.path !== entry.file_path || shard.file.path.length > CODE_TOPOLOGY_ARTIFACT_MAX_PATH_LENGTH || !Array.isArray(shard.symbols) || !Array.isArray(shard.edges) || !Array.isArray(shard.frontiers) || !shard.symbol_dictionary || !Array.isArray(shard.edge_kinds) || !shard.frontier_dictionary) return invalid(`Artifact shard '${entry.name}' has an invalid shape.`);
      if (shard.symbols.length !== entry.symbols || shard.edges.length !== entry.edges || shard.frontiers.length !== entry.frontiers) return invalid(`Artifact shard '${entry.name}' count mismatch.`);
      const localSymbols = shard.symbols.map((symbol): CodeTopologyTraversalSymbolRecord => {
        if (!Array.isArray(symbol) || symbol.length !== 3) throw new Error(`Artifact shard '${entry.name}' contains an invalid symbol.`);
        const nativeKind = shard.symbol_dictionary.native_kinds[symbol[1]];
        const selector = symbol[2] === null ? null : shard.symbol_dictionary.selectors[symbol[2]];
        if (!nativeKind || selector === undefined) throw new Error(`Artifact shard '${entry.name}' contains an invalid symbol dictionary reference.`);
        return {
          identity: expandIdentity(symbol[0])!, file_path: shard.file.path, native_kind: nativeKind,
          canonical_selector: selector, asset_kind: shard.file.kind,
          framework_hint: shard.file.framework_hint,
        };
      });
      files.push(shard.file);
      symbols.push(...localSymbols);
      shardSymbols.set(shard.file.path, localSymbols);
    }
    const identities = new Set<string>();
    for (const symbol of symbols) {
      if (identities.has(symbol.identity)) return invalid(`Duplicate artifact symbol identity '${symbol.identity}'.`);
      identities.add(symbol.identity);
    }

    // Resolve adjacency in a second bounded shard pass. Keeping 250,000 raw
    // edge tuples beside their expanded read-model objects pushed two-role
    // peak RSS over the product gate. Re-decoding one <=8 MiB shard at a time
    // trades a small amount of CPU for a much smaller transient graph.
    for (const rawEntry of index.shards) {
      const entry = rawEntry as ArtifactShardIndex;
      const bytes = inputFiles.get(entry.name)!;
      const shard = parseJson(bytes, entry.name) as CompactShard;
      const localSymbols = shardSymbols.get(entry.file_path)!;
      for (const edge of shard.edges) {
        if (!Array.isArray(edge) || edge.length !== 5) {
          throw new Error(`Artifact shard '${entry.name}' contains an invalid edge.`);
        }
        const source = localSymbols[edge[0]];
        const targetPath = index.shards[edge[1]]?.file_path;
        const target = targetPath ? shardSymbols.get(targetPath)?.[edge[2]] : undefined;
        const kind = shard.edge_kinds[edge[3]];
        if (!source || !target || !kind) {
          throw new Error(`Artifact shard '${entry.name}' contains a missing edge endpoint or dictionary reference.`);
        }
        edges.push({
          kind,
          source_symbol_identity: source.identity,
          target_symbol_identity: target.identity,
          reference_identity: expandIdentity(edge[4]),
        });
      }
      for (const frontier of shard.frontiers) {
        if (!Array.isArray(frontier) || frontier.length !== 8) {
          throw new Error(`Artifact shard '${entry.name}' contains an invalid frontier.`);
        }
        const source = localSymbols[frontier[1]];
        const kind = shard.frontier_dictionary.kinds[frontier[2]];
        const moduleSpecifier = frontier[3] === null
          ? null
          : shard.frontier_dictionary.module_specifiers[frontier[3]];
        const statuses = ["ambiguous", "unresolved", "external"] as const;
        const status = statuses[frontier[4]];
        const rule = shard.frontier_dictionary.rules[frontier[5]];
        if (!source || !kind || moduleSpecifier === undefined || !status || !rule ||
            !Array.isArray(frontier[6]) || !Array.isArray(frontier[7])) {
          throw new Error(`Artifact shard '${entry.name}' contains an invalid frontier endpoint or dictionary reference.`);
        }
        frontiers.push({
          reference_identity: expandIdentity(frontier[0])!,
          source_symbol_identity: source.identity,
          file_path: shard.file.path,
          kind,
          module_specifier: moduleSpecifier,
          status,
          rule,
          candidate_targets: frontier[6],
          diagnostics: frontier[7],
        });
      }
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    symbols.sort((left, right) => left.identity.localeCompare(right.identity));
    edges.sort((left, right) => [
      left.source_symbol_identity,
      left.target_symbol_identity,
      left.reference_identity ?? "",
      left.kind,
    ].join("\0").localeCompare([
      right.source_symbol_identity,
      right.target_symbol_identity,
      right.reference_identity ?? "",
      right.kind,
    ].join("\0")));
    frontiers.sort((left, right) =>
      left.reference_identity.localeCompare(right.reference_identity)
    );
    const counts = index.counts;
    if (files.length !== counts.files || symbols.length !== counts.symbols ||
        edges.length !== counts.edges || frontiers.length !== counts.frontiers ||
        edges.length + frontiers.length !== counts.dependency_records) return invalid("Artifact count mismatch.");
    const readModel: CodeTopologyReadModelGeneration = {
      summary: {
        header: index.generation,
        counts: {
          files: counts.files,
          symbols: counts.symbols,
          references: counts.references,
          resolutions: counts.resolutions,
          edges: counts.edges,
        },
      },
      projection_digest: index.projection_digest,
      files,
      symbols,
      edges,
      frontiers,
      retained_bytes: 0,
    };
    const projectionDigest = codeTopologyArtifactProjectionDigestOrdered({
      files, symbols, edges, frontiers,
    });
    if (projectionDigest !== index.projection_digest) {
      return invalid(`Artifact projection digest mismatch: expected ${index.projection_digest}, calculated ${projectionDigest}.`);
    }
    if (directArtifactDigest(index, readModel) !== index.artifact_digest) {
      return invalid("Artifact digest mismatch.");
    }
    const { shards: _shards, ...metadata } = index;
    return {
      status: "complete",
      artifact_digest: index.artifact_digest,
      metadata,
      read_model: readModel,
    };
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error));
  }
}

/** Logical-envelope compatibility reader used by encoder tests and tooling. */
export function parseCodeTopologyArtifact(
  inputFiles: ReadonlyMap<string, Buffer>
): CodeTopologyArtifactReadResult {
  const result = readCodeTopologyArtifact(inputFiles);
  if (result.status !== "complete") return result;
  const { metadata, read_model: model } = result;
  const generationIdentity = metadata.generation.identity;
  return {
    status: "complete",
    artifact: {
      ...metadata,
      files: model.files,
      symbols: model.symbols,
      edges: model.edges.map((edge) => ({
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
      })),
      frontiers: model.frontiers,
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
    edges: artifact.edges.map(edgeReadModel),
    frontiers: structuredClone(artifact.frontiers),
    retained_bytes: 0,
  };
}
