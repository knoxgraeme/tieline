import { createHash } from "node:crypto";
import type { SupportedCodeLanguage } from "../contract/code-analysis/languages.js";
import type {
  CodeTopologyFrontierRecord,
  CodeTopologyGenerationCounts,
  CodeTopologyGenerationHeader,
  CodeTopologyReadModelEdge,
  CodeTopologyTraversalSymbolRecord,
  TopologyAssetKind,
} from "./code-topology-store.js";

export const CODE_TOPOLOGY_ARTIFACT_SCHEMA_VERSION = 1;
export const CODE_TOPOLOGY_ARTIFACT_ENCODING = "json-v1";
export const CODE_TOPOLOGY_ARTIFACT_PRODUCER = "tieline_tree_sitter";
export const CODE_TOPOLOGY_ARTIFACT_PRODUCER_VERSION = 1;
export const CODE_TOPOLOGY_ARTIFACT_PROVIDER = "tieline";
export const CODE_TOPOLOGY_MAX_DEPENDENCY_RECORDS = 250_000;

export interface CodeTopologyArtifactProducer {
  identity: string;
  version: number;
}

export interface CodeTopologyArtifactProvider {
  identity: string;
}

export interface CodeTopologyArtifactCompatibility {
  topology_schema_version: number;
  parser_compatibility_digest: string;
  resolver_implementation: string;
  resolver_configuration_digest: string;
  fact_policy_digest: string;
}

export interface CodeTopologyArtifactFileRecord {
  path: string;
  kind: TopologyAssetKind;
  framework_hint: string | null;
  language: SupportedCodeLanguage;
  source_hash: string;
}

export interface CodeTopologyArtifactCounts extends CodeTopologyGenerationCounts {
  frontiers: number;
  dependency_records: number;
}

export type CodeTopologyArtifactEdgeRecord = CodeTopologyReadModelEdge;

/**
 * Provider-neutral traversal projection. Producers normalize into this model;
 * parser ranges, source text, snippets, authored intent, and memory estimates
 * are deliberately not representable.
 */
export interface CodeTopologyArtifactEnvelope {
  schema_version: number;
  encoding: string;
  producer: CodeTopologyArtifactProducer;
  provider: CodeTopologyArtifactProvider;
  compatibility: CodeTopologyArtifactCompatibility;
  generation: CodeTopologyGenerationHeader;
  selected_input_digest: string;
  projection_digest: string;
  artifact_digest: string;
  counts: CodeTopologyArtifactCounts;
  files: CodeTopologyArtifactFileRecord[];
  symbols: CodeTopologyTraversalSymbolRecord[];
  edges: CodeTopologyArtifactEdgeRecord[];
  frontiers: CodeTopologyFrontierRecord[];
}

export type CodeTopologyArtifactReadResult =
  | { status: "complete"; artifact: CodeTopologyArtifactEnvelope }
  | { status: "incompatible"; detail: string }
  | { status: "invalid"; detail: string }
  | { status: "capacity_exceeded"; detail: string };

export function canonicalCodeTopologyJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalCodeTopologyJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) =>
      `${JSON.stringify(key)}:${canonicalCodeTopologyJson(child)}`
    ).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Cannot serialize an undefined topology value.");
  return encoded;
}

export function codeTopologyArtifactProjectionDigest(input: Pick<
  CodeTopologyArtifactEnvelope,
  "files" | "symbols" | "frontiers"
> & { edges: readonly CodeTopologyReadModelEdge[] }): string {
  return codeTopologyArtifactProjectionDigestOrdered({
    files: [...input.files].sort((left, right) => left.path.localeCompare(right.path)),
    symbols: [...input.symbols].sort((left, right) => left.identity.localeCompare(right.identity)),
    edges: [...input.edges].sort((left, right) => [
      left.source_symbol_identity,
      left.target_symbol_identity,
      left.reference_identity ?? "",
      left.kind,
    ].join("\0").localeCompare([
      right.source_symbol_identity,
      right.target_symbol_identity,
      right.reference_identity ?? "",
      right.kind,
    ].join("\0"))),
    frontiers: [...input.frontiers].sort((left, right) =>
      left.reference_identity.localeCompare(right.reference_identity)
    ),
  });
}

/** Hashes records already in the logical artifact order without staging strings. */
export function codeTopologyArtifactProjectionDigestOrdered(input: Pick<
  CodeTopologyArtifactEnvelope,
  "files" | "symbols" | "frontiers"
> & { edges: readonly CodeTopologyReadModelEdge[] }): string {
  const hash = createHash("sha256");
  for (const [group, records] of Object.entries(input)) {
    hash.update(`${group}:${records.length}\0`);
    for (const record of records) {
      hash.update(createHash("sha256").update(canonicalCodeTopologyJson(record)).digest("hex"));
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}
