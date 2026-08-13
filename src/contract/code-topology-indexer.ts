import { createHash } from "node:crypto";
import {
  CODE_TOPOLOGY_MAX_DEPENDENCY_RECORDS,
  codeTopologyArtifactProjectionDigest,
} from "../domain/code-topology-artifact.js";
import {
  codeTopologyDerivedEdgeIdentity,
  codeTopologyGenerationIdentity,
  codeTopologySelectedInputDigest,
  estimateCodeTopologyGenerationRetainedBytes,
  normalizeOwnedCompleteCodeTopologyGeneration,
  validateCompleteCodeTopologyGeneration,
  type CodeTopologyEdgeRecord,
  type CodeTopologyFrontierRecord,
  type CodeTopologyReadModelEdge,
  type CodeTopologyReadModelGeneration,
  type CodeTopologyTraversalSymbolRecord,
  type CodeTopologyReferenceRecord,
  type CodeTopologyResolutionRecord,
  type CodeTopologySymbolRecord,
  type CompleteCodeTopologyGeneration,
} from "../domain/code-topology-store.js";
import {
  createJavaScriptAnalyzer,
  javascriptAnalysisCompatibility,
} from "./code-analysis/javascript.js";
import { parserCompatibilitySet } from "./code-analysis/languages.js";
import {
  createPythonAnalyzer,
  pythonAnalysisCompatibility,
} from "./code-analysis/python.js";
import { createCodeParserRuntime } from "./code-analysis/runtime.js";
import {
  createRustAnalyzer,
  rustAnalysisCompatibility,
} from "./code-analysis/rust.js";
import type { LanguageAnalysisResult } from "./code-analysis/types.js";
import {
  createJavaScriptModuleResolver,
  javascriptResolutionCompatibility,
  readJavaScriptResolutionConfiguration,
} from "./code-resolution/javascript.js";
import {
  createPythonModuleResolver,
  pythonResolutionCompatibility,
  readPythonResolutionConfiguration,
} from "./code-resolution/python.js";
import {
  createRustModuleResolver,
  readRustResolutionConfiguration,
  rustResolutionCompatibility,
} from "./code-resolution/rust.js";
import type {
  CodeModuleResolver,
  CodeResolutionTarget,
  ResolutionAnalysis,
} from "./code-resolution/types.js";
import type { SourceInventory } from "./source-inventory.js";
import type {
  SourceCoordinates,
  SourceRange,
  SourceSnapshot,
  SourceSnapshotReader,
} from "./source-snapshot.js";

export const CODE_TOPOLOGY_SCHEMA_VERSION = 1;
export const CODE_TOPOLOGY_RESOLVER_IMPLEMENTATION =
  "tieline-static-modules@2";
export const CODE_TOPOLOGY_FACT_POLICY = "tieline-code-topology-facts@1";
const MAX_TOPOLOGY_FILES = 5_000;
const MAX_TOPOLOGY_SOURCE_BYTES = 50 * 1024 * 1024;
const MAX_TOPOLOGY_SYMBOLS = 100_000;

export interface TopologySourceCollection {
  kind: "committed" | "workspace";
  /** Source-selection metadata kept outside logical generation identity. */
  revision: string;
  inventory: SourceInventory;
  reader: SourceSnapshotReader;
  dispose?(): void;
}

export type TopologyGenerationBuildFailure =
  | "capacity_exceeded"
  | "source_unavailable"
  | "workspace_changed";

export type TopologyGenerationBuildResult =
  | {
      status: "complete";
      source_kind: "committed" | "workspace";
      generation: CompleteCodeTopologyGeneration;
      retained_bytes: number;
    }
  | {
      status: TopologyGenerationBuildFailure;
      path: string | null;
      detail: string;
    };

export type TopologyReadModelBuildResult =
  | {
      status: "complete";
      source_kind: "committed" | "workspace";
      read_model: CodeTopologyReadModelGeneration;
      retained_bytes: number;
    }
  | {
      status: TopologyGenerationBuildFailure;
      path: string | null;
      detail: string;
    };

export interface BuildCodeTopologyGenerationOptions {
  repository: string;
  source: TopologySourceCollection;
  maxFiles?: number;
  maxTotalSourceBytes?: number;
  maxSymbols?: number;
  maxEdges?: number;
  maxDependencyRecords?: number;
  parserConcurrency?: number;
}

export interface BuildCodeTopologyReadModelOptions
  extends BuildCodeTopologyGenerationOptions {
  output: "read_model";
}

function canonicalDigest(value: unknown): string {
  const canonical = (entry: unknown): string => {
    if (Array.isArray(entry)) return `[${entry.map(canonical).join(",")}]`;
    if (entry !== null && typeof entry === "object") {
      const fields = Object.entries(entry as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right));
      return `{${fields
        .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
        .join(",")}}`;
    }
    return JSON.stringify(entry);
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export interface CodeTopologyRuntimeCompatibility {
  parser_compatibility_digest: string;
  resolver_implementation: string;
  topology_schema_version: number;
  fact_policy_digest: string;
}

/** Fact-producing compatibility required before a persisted generation is read. */
export function codeTopologyRuntimeCompatibility(): CodeTopologyRuntimeCompatibility {
  return {
    parser_compatibility_digest: canonicalDigest({
      set: parserCompatibilitySet,
      analyses: [
        javascriptAnalysisCompatibility.identity,
        pythonAnalysisCompatibility.identity,
        rustAnalysisCompatibility.identity,
      ].sort(),
    }),
    resolver_implementation: `${CODE_TOPOLOGY_RESOLVER_IMPLEMENTATION}:${[
      javascriptResolutionCompatibility,
      pythonResolutionCompatibility,
      rustResolutionCompatibility,
    ].join("+")}`,
    topology_schema_version: CODE_TOPOLOGY_SCHEMA_VERSION,
    fact_policy_digest: canonicalDigest(CODE_TOPOLOGY_FACT_POLICY),
  };
}

async function mapBounded<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
        while (true) {
          const index = cursor++;
          if (index >= values.length) return;
          output[index] = await operation(values[index]!);
        }
    }
  );
  const settled = await Promise.allSettled(workers);
  const failed = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (failed) throw failed.reason;
  return output;
}

function syntheticModuleIdentity(path: string, sourceHash: string): string {
  return `module:${canonicalDigest({ path, sourceHash })}`;
}

function generationSymbolIdentity(path: string, factIdentity: string): string {
  return `symbol:${canonicalDigest({ path, factIdentity })}`;
}

function generationReferenceIdentity(path: string, factIdentity: string): string {
  return `reference:${canonicalDigest({ path, factIdentity })}`;
}

function targetKey(target: CodeResolutionTarget, targetIdentity: string): string {
  return `${target.path}#${targetIdentity}`;
}

function estimateReadModelRetainedBytes(model: CodeTopologyReadModelGeneration): number {
  const stringBytes = (value: string | null) => value === null ? 0 : 16 + value.length * 2;
  let bytes = 2_048;
  for (const file of model.files) {
    bytes += 160 + stringBytes(file.path) + stringBytes(file.framework_hint) + stringBytes(file.source_hash);
  }
  for (const symbol of model.symbols) {
    bytes += 224 + stringBytes(symbol.identity) + stringBytes(symbol.file_path) +
      stringBytes(symbol.native_kind) + stringBytes(symbol.canonical_selector) +
      stringBytes(symbol.framework_hint);
  }
  for (const edge of model.edges) {
    bytes += 224 + stringBytes(edge.kind) +
      stringBytes(edge.source_symbol_identity) + stringBytes(edge.target_symbol_identity) +
      stringBytes(edge.reference_identity);
  }
  for (const frontier of model.frontiers) {
    bytes += 384 + stringBytes(frontier.reference_identity) +
      stringBytes(frontier.source_symbol_identity) + stringBytes(frontier.file_path) +
      stringBytes(frontier.kind) + stringBytes(frontier.module_specifier) +
      stringBytes(frontier.status) + stringBytes(frontier.rule);
    for (const candidate of frontier.candidate_targets) bytes += 24 + stringBytes(candidate);
    for (const diagnostic of frontier.diagnostics) bytes += 24 + stringBytes(diagnostic);
  }
  return bytes;
}

function sourceFailure(
  sourceKind: "committed" | "workspace",
  path: string,
  status: string,
  detail: string
): TopologyGenerationBuildResult {
  return {
    status:
      status === "oversized"
        ? "capacity_exceeded"
        : sourceKind === "workspace" && status === "changed_during_read"
        ? "workspace_changed"
        : "source_unavailable",
    path,
    detail,
  };
}

class TopologyBuildAbort extends Error {
  constructor(readonly result: TopologyGenerationBuildResult) {
    super(result.status);
  }
}

function fileKind(path: string): "code" | "test" {
  return /(^|\/)(?:test|tests|spec|specs)(\/|$)|(?:\.|_)(?:test|spec)\.[^.]+$/i.test(path)
    ? "test"
    : "code";
}

function compactResolutionAnalysis(
  analysis: LanguageAnalysisResult
): ResolutionAnalysis {
  return {
    compatibility: analysis.compatibility,
    path: analysis.path,
    language: analysis.language,
    sourceHash: analysis.sourceHash,
    symbols: analysis.symbols.map((symbol) => ({
      identity: symbol.identity,
      name: symbol.name,
      nativeKind: symbol.nativeKind,
      selector: symbol.selector,
      ownerChain: symbol.ownerChain.length === 0 ? [] : [true],
      bodyRange: {
        utf16: {
          start: symbol.bodyRange.utf16.start,
          end: symbol.bodyRange.utf16.end,
        },
      },
    })),
    references: analysis.references.map((reference) => ({
      identity: reference.identity,
      kind: reference.kind,
      nativeKind: reference.nativeKind,
      moduleSpecifier: reference.moduleSpecifier,
      statementRange: {
        utf16: {
          start: reference.statementRange.utf16.start,
          end: reference.statementRange.utf16.end,
        },
      },
      ownerIdentity: reference.ownerIdentity,
      isTypeOnly: reference.isTypeOnly,
      bindings: reference.bindings,
      resolution: "unresolved" as const,
    })),
    diagnostics: analysis.diagnostics.length === 0 ? [] : [true],
    truncated: analysis.truncated,
  };
}

/**
 * Resolution needs only UTF-16 ordering. Supplying that narrow coordinate view
 * prevents the ephemeral path from allocating rich UTF-8/line positions that
 * are immediately discarded; persistence analysis still receives the complete
 * immutable snapshot.
 */
function resolutionAnalysisSnapshot(snapshot: SourceSnapshot): SourceSnapshot {
  const unsupported = (): never => {
    throw new Error("Resolution-only analysis requested a persistence coordinate.");
  };
  const coordinates: SourceCoordinates = {
    atUtf16Offset: unsupported,
    atUtf8ByteOffset: unsupported,
    rangeFromUtf16(start: number, end: number): SourceRange {
      if (
        !Number.isInteger(start) || !Number.isInteger(end) ||
        start < 0 || end < start || end > snapshot.text.length
      ) {
        throw new RangeError("Resolution analysis received an invalid UTF-16 range.");
      }
      return { utf16: { start, end } } as SourceRange;
    },
    rangeFromUtf8Bytes: unsupported,
  };
  return {
    path: snapshot.path,
    text: snapshot.text,
    sha256: snapshot.sha256,
    language: snapshot.language,
    metadata: snapshot.metadata,
    inventoryDigest: snapshot.inventoryDigest,
    coordinates,
    originalBytes: () => snapshot.originalBytes(),
  };
}

function resolverForLanguage(
  language: LanguageAnalysisResult["language"],
  resolvers: readonly CodeModuleResolver[]
): CodeModuleResolver | undefined {
  return resolvers.find((resolver) => resolver.languages.has(language));
}

/** Parse, resolve, and immediately reduce one immutable source collection. */
export function buildCodeTopologyGeneration(
  options: BuildCodeTopologyReadModelOptions
): Promise<TopologyReadModelBuildResult>;
export function buildCodeTopologyGeneration(
  options: BuildCodeTopologyGenerationOptions
): Promise<TopologyGenerationBuildResult>;
export async function buildCodeTopologyGeneration(
  options: BuildCodeTopologyGenerationOptions | BuildCodeTopologyReadModelOptions
): Promise<TopologyGenerationBuildResult | TopologyReadModelBuildResult> {
  const maxFiles = Math.min(options.maxFiles ?? MAX_TOPOLOGY_FILES, MAX_TOPOLOGY_FILES);
  const maxTotalSourceBytes = Math.min(
    options.maxTotalSourceBytes ?? MAX_TOPOLOGY_SOURCE_BYTES,
    MAX_TOPOLOGY_SOURCE_BYTES
  );
  const maxSymbols = Math.min(
    options.maxSymbols ?? MAX_TOPOLOGY_SYMBOLS,
    MAX_TOPOLOGY_SYMBOLS
  );
  const maxDependencyRecords = Math.min(
    options.maxDependencyRecords ?? options.maxEdges ?? CODE_TOPOLOGY_MAX_DEPENDENCY_RECORDS,
    CODE_TOPOLOGY_MAX_DEPENDENCY_RECORDS
  );
  const parserConcurrency = options.parserConcurrency ?? 4;
  const buildingReadModel = "output" in options && options.output === "read_model";
  if (!Number.isInteger(parserConcurrency) || parserConcurrency < 1 || parserConcurrency > 4) {
    throw new Error("Topology parser concurrency must be an integer from 1 to 4.");
  }

  const sourceFiles = options.source.inventory.files.filter(
    (file) => file.language !== null
  );
  if (sourceFiles.length > maxFiles) {
    return {
      status: "capacity_exceeded",
      path: null,
      detail: `Source inventory contains ${sourceFiles.length} parser files; limit is ${maxFiles}.`,
    };
  }

  let totalSourceBytes = 0;
  const runtime = createCodeParserRuntime({ maxConcurrentParsers: parserConcurrency });
  const analyzers = [
    createJavaScriptAnalyzer({ runtime }),
    createPythonAnalyzer({ runtime }),
    createRustAnalyzer({ runtime }),
  ];
  const analyses = new Map<string, LanguageAnalysisResult>();
  const resolutionAnalyses = new Map<string, ResolutionAnalysis>();
  const readSymbolsByIdentity = new Map<string, CodeTopologyTraversalSymbolRecord>();
  const contentInventory: Array<{ path: string; sha256: string }> = [];
  try {
    await mapBounded(
      options.source.inventory.files,
      parserConcurrency,
      async (file): Promise<void> => {
        const read = options.source.reader.read(file.path);
        if (read.status !== "read") {
          throw new TopologyBuildAbort(
            sourceFailure(options.source.kind, file.path, read.status, read.detail)
          );
        }
        const snapshot = read.snapshot;
        totalSourceBytes += snapshot.metadata.size;
        if (totalSourceBytes > maxTotalSourceBytes) {
          throw new TopologyBuildAbort({
            status: "capacity_exceeded",
            path: file.path,
            detail: `Source inventory exceeds the ${maxTotalSourceBytes}-byte repository limit.`,
          });
        }
        contentInventory.push({ path: snapshot.path, sha256: snapshot.sha256 });
        if (file.language === null) return;
        const analyzer = analyzers.find((candidate) =>
          candidate.languages.has(snapshot.language!)
        );
        if (!analyzer) throw new Error(`No topology analyzer for '${file.path}'.`);
        try {
          const analysis = await analyzer.analyze(
            buildingReadModel ? resolutionAnalysisSnapshot(snapshot) : snapshot
          );
          if (buildingReadModel) {
            const assetKind = fileKind(analysis.path);
            const moduleIdentity = syntheticModuleIdentity(
              analysis.path,
              analysis.sourceHash
            );
            readSymbolsByIdentity.set(moduleIdentity, {
              identity: moduleIdentity,
              file_path: analysis.path,
              native_kind: "source_file",
              canonical_selector: null,
              asset_kind: assetKind,
              framework_hint: null,
            });
            for (const symbol of analysis.symbols) {
              for (const owner of symbol.ownerChain) {
                const identity = generationSymbolIdentity(analysis.path, owner.identity);
                if (!readSymbolsByIdentity.has(identity)) {
                  readSymbolsByIdentity.set(identity, {
                    identity,
                    file_path: analysis.path,
                    native_kind: owner.nativeKind,
                    canonical_selector: owner.selector,
                    asset_kind: assetKind,
                    framework_hint: null,
                  });
                }
              }
              const identity = generationSymbolIdentity(analysis.path, symbol.identity);
              readSymbolsByIdentity.set(identity, {
                identity,
                file_path: analysis.path,
                native_kind: symbol.nativeKind,
                canonical_selector: symbol.selector,
                asset_kind: assetKind,
                framework_hint: null,
              });
            }
            resolutionAnalyses.set(file.path, compactResolutionAnalysis(analysis));
          } else {
            analyses.set(file.path, analysis);
          }
        } finally {
          options.source.reader.release?.(file.path);
        }
      }
    );
  } catch (error) {
    if (error instanceof TopologyBuildAbort) return error.result;
    throw error;
  } finally {
    await Promise.all(analyzers.map((analyzer) => analyzer.dispose()));
  }

  const javascriptConfiguration = readJavaScriptResolutionConfiguration({
    inventory: options.source.inventory,
    reader: options.source.reader,
  });
  const pythonConfiguration = readPythonResolutionConfiguration({
    inventory: options.source.inventory,
    reader: options.source.reader,
  });
  const rustConfiguration = readRustResolutionConfiguration({
    inventory: options.source.inventory,
    reader: options.source.reader,
  });
  for (const file of options.source.inventory.files) {
    if (file.language === null) options.source.reader.release?.(file.path);
  }
  const resolverConfigurationDigest = canonicalDigest({
    javascript: javascriptConfiguration.digest,
    python: pythonConfiguration.digest,
    rust: rustConfiguration.digest,
  });
  const resolvers: CodeModuleResolver[] = [
    createJavaScriptModuleResolver({
      inventory: options.source.inventory,
      analyses: buildingReadModel ? resolutionAnalyses : analyses,
      configuration: javascriptConfiguration,
    }),
    createPythonModuleResolver({
      inventory: options.source.inventory,
      analyses: buildingReadModel ? resolutionAnalyses : analyses,
      configuration: pythonConfiguration,
    }),
    createRustModuleResolver({
      inventory: options.source.inventory,
      analyses: buildingReadModel ? resolutionAnalyses : analyses,
      configuration: rustConfiguration,
    }),
  ];

  const inventoryDigest = canonicalDigest({
    schemaVersion: 1,
    sourceRoots: options.source.inventory.sourceRoots,
    ignore: options.source.inventory.ignore,
    files: contentInventory
      .sort((left, right) => left.path.localeCompare(right.path)),
  });
  const compatibility = codeTopologyRuntimeCompatibility();
  const selectedInputFields = {
    inventory_digest: inventoryDigest,
    parser_compatibility_digest: compatibility.parser_compatibility_digest,
    resolver_implementation: compatibility.resolver_implementation,
    resolver_configuration_digest: resolverConfigurationDigest,
    topology_schema_version: compatibility.topology_schema_version,
    fact_policy_digest: compatibility.fact_policy_digest,
  };
  const identityFields = {
    repository: options.repository,
    revision: codeTopologySelectedInputDigest(selectedInputFields),
    ...selectedInputFields,
  };
  const generationIdentity = codeTopologyGenerationIdentity(identityFields);
  const selectedAnalyses = buildingReadModel ? resolutionAnalyses : analyses;
  const moduleIdentities = new Map(
    [...selectedAnalyses.values()].map((analysis) => [
      analysis.path,
      syntheticModuleIdentity(analysis.path, analysis.sourceHash),
    ])
  );
  if (buildingReadModel) {
    const symbolsByIdentity = readSymbolsByIdentity;
    if (symbolsByIdentity.size > maxSymbols) {
      return {
        status: "capacity_exceeded",
        path: null,
        detail: `Topology contains ${symbolsByIdentity.size} symbols; limit is ${maxSymbols}.`,
      };
    }
    const knownSymbols = new Set(symbolsByIdentity.keys());
    const edges: CodeTopologyReadModelEdge[] = [];
    const frontiers: CodeTopologyFrontierRecord[] = [];
    let referenceCount = 0;
    for (const analysis of resolutionAnalyses.values()) {
      const resolver = resolverForLanguage(analysis.language, resolvers);
      const outcomes = new Map(
        (resolver?.resolveFile(analysis.path) ?? []).map((outcome) => [
          outcome.reference.identity,
          outcome,
        ])
      );
      for (const reference of analysis.references) {
        referenceCount += 1;
        const referenceIdentity = generationReferenceIdentity(analysis.path, reference.identity);
        const remappedOwner = reference.ownerIdentity
          ? generationSymbolIdentity(analysis.path, reference.ownerIdentity)
          : null;
        const sourceIdentity = remappedOwner && knownSymbols.has(remappedOwner)
          ? remappedOwner
          : moduleIdentities.get(analysis.path)!;
        const outcome = outcomes.get(reference.identity);
        const targetIdentity = (target: CodeResolutionTarget): string | null =>
          target.symbolIdentity
            ? generationSymbolIdentity(target.path, target.symbolIdentity)
            : moduleIdentities.get(target.path) ?? null;
        const targets = outcome?.status === "resolved" ? outcome.targets : [];
        for (const target of targets) {
          const resolvedTarget = targetIdentity(target);
          if (!resolvedTarget || !knownSymbols.has(resolvedTarget)) continue;
          edges.push({
            kind: "imports",
            source_symbol_identity: sourceIdentity,
            target_symbol_identity: resolvedTarget,
            reference_identity: referenceIdentity,
          });
        }
        if (
          outcome?.status !== "resolved" &&
          reference.moduleSpecifier !== null &&
          ["import", "dynamic_import", "reexport"].includes(reference.kind)
        ) {
          frontiers.push({
            reference_identity: referenceIdentity,
            source_symbol_identity: sourceIdentity,
            file_path: analysis.path,
            kind: reference.kind,
            module_specifier: reference.moduleSpecifier,
            status: outcome?.status ?? "unresolved",
            rule: outcome?.rule ?? "no_static_resolution",
            candidate_targets: (outcome?.candidates ?? []).map((target) => {
              const identity = targetIdentity(target);
              return identity ? targetKey(target, identity) : `${target.path}#unindexed`;
            }).sort(),
            diagnostics: [
              ...(outcome
                ? [`resolver_configuration:${outcome.configurationDigest}`]
                : []),
              ...(outcome?.reason ? [`reason:${outcome.reason}`] : []),
              ...(outcome?.diagnostics.map(
                (diagnostic) => `${diagnostic.code}:${diagnostic.detail}`
              ) ?? []),
            ],
          });
        }
      }
    }
    if (edges.length + frontiers.length > maxDependencyRecords) {
      return {
        status: "capacity_exceeded",
        path: null,
        detail: `Topology contains ${edges.length + frontiers.length} dependency records across edges and frontiers; limit is ${maxDependencyRecords}.`,
      };
    }
    const files = [...resolutionAnalyses.values()].map((analysis) => ({
      path: analysis.path,
      kind: fileKind(analysis.path),
      framework_hint: null,
      language: analysis.language,
      source_hash: analysis.sourceHash,
    })).sort((left, right) => left.path.localeCompare(right.path));
    const symbols = [...symbolsByIdentity.values()].sort((left, right) =>
      left.identity.localeCompare(right.identity)
    );
    edges.sort((left, right) =>
      [left.source_symbol_identity, left.target_symbol_identity,
        left.reference_identity ?? ""].join("\0").localeCompare(
        [right.source_symbol_identity, right.target_symbol_identity,
          right.reference_identity ?? ""].join("\0")
      )
    );
    frontiers.sort((left, right) =>
      left.reference_identity.localeCompare(right.reference_identity)
    );
    analyses.clear();
    resolutionAnalyses.clear();
    resolvers.length = 0;
    moduleIdentities.clear();
    symbolsByIdentity.clear();
    knownSymbols.clear();
    const summary = {
      header: { ...identityFields, identity: generationIdentity },
      counts: {
        files: files.length,
        symbols: symbols.length,
        references: referenceCount,
        resolutions: referenceCount,
        edges: edges.length,
      },
    };
    const readModel: CodeTopologyReadModelGeneration = {
      summary,
      projection_digest: codeTopologyArtifactProjectionDigest({ files, symbols, edges, frontiers }),
      files,
      symbols,
      edges,
      frontiers,
      retained_bytes: 0,
    };
    readModel.retained_bytes = estimateReadModelRetainedBytes(readModel);
    return {
      status: "complete",
      source_kind: options.source.kind,
      read_model: readModel,
      retained_bytes: readModel.retained_bytes,
    };
  }
  const symbolsByIdentity = new Map<string, CodeTopologySymbolRecord>();
  for (const analysis of analyses.values()) {
    const moduleIdentity = moduleIdentities.get(analysis.path)!;
    symbolsByIdentity.set(moduleIdentity, {
      identity: moduleIdentity,
      file_path: analysis.path,
      name: null,
      native_kind: "source_file",
      kind: "module",
      canonical_selector: null,
      owner_identity: null,
      owner_chain: [],
      name_range: null,
      body_range: null,
      syntax_status: analysis.diagnostics.length > 0 ? "recovered" : "exact",
    });
    for (const symbol of analysis.symbols) {
      for (let index = 0; index < symbol.ownerChain.length; index += 1) {
        const owner = symbol.ownerChain[index]!;
        const ownerIdentity = generationSymbolIdentity(analysis.path, owner.identity);
        if (symbolsByIdentity.has(ownerIdentity)) continue;
        const parent = symbol.ownerChain[index - 1];
        symbolsByIdentity.set(ownerIdentity, {
          identity: ownerIdentity,
          file_path: analysis.path,
          name: owner.name,
          native_kind: owner.nativeKind,
          kind: owner.kind,
          canonical_selector: owner.selector,
          owner_identity: parent
            ? generationSymbolIdentity(analysis.path, parent.identity)
            : null,
          owner_chain: symbol.ownerChain
            .slice(0, index)
            .map((ancestor) => generationSymbolIdentity(analysis.path, ancestor.identity)),
          name_range: owner.nameRange,
          body_range: owner.bodyRange,
          syntax_status: "exact",
        });
      }
      const identity = generationSymbolIdentity(analysis.path, symbol.identity);
      symbolsByIdentity.set(identity, {
        identity,
        file_path: analysis.path,
        name: symbol.name,
        native_kind: symbol.nativeKind,
        kind: symbol.kind,
        canonical_selector: symbol.selector,
        owner_identity: symbol.ownerChain.at(-1)
          ? generationSymbolIdentity(
              analysis.path,
              symbol.ownerChain.at(-1)!.identity
            )
          : null,
        owner_chain: symbol.ownerChain.map((owner) =>
          generationSymbolIdentity(analysis.path, owner.identity)
        ),
        name_range: symbol.nameRange,
        body_range: symbol.bodyRange,
        syntax_status: symbol.syntaxStatus,
      });
    }
  }
  const symbols = [...symbolsByIdentity.values()];
  if (symbols.length > maxSymbols) {
    return {
      status: "capacity_exceeded",
      path: null,
      detail: `Topology contains ${symbols.length} symbols; limit is ${maxSymbols}.`,
    };
  }
  const knownSymbols = new Set(symbols.map((symbol) => symbol.identity));
  const files = [...analyses.values()].map((analysis) => ({
    path: analysis.path,
    kind: fileKind(analysis.path),
    framework_hint: null,
    language: analysis.language,
    source_hash: analysis.sourceHash,
    parser_identity: analysis.compatibility.identity,
    diagnostics: analysis.diagnostics,
    symbols_truncated: analysis.truncated.symbols,
    references_truncated: analysis.truncated.references,
    diagnostics_truncated: analysis.truncated.diagnostics,
  }));
  const references: CodeTopologyReferenceRecord[] = [];
  const resolutions: CodeTopologyResolutionRecord[] = [];
  const edges: CodeTopologyEdgeRecord[] = [];
  for (const analysis of analyses.values()) {
    const resolver = resolverForLanguage(analysis.language, resolvers);
    const outcomes = new Map(
      (resolver?.resolveFile(analysis.path) ?? []).map((outcome) => [
        outcome.reference.identity,
        outcome,
      ])
    );
    for (const rawReference of analysis.references) {
      const remappedOwner = rawReference.ownerIdentity
        ? generationSymbolIdentity(analysis.path, rawReference.ownerIdentity)
        : null;
      const reference = {
        identity: generationReferenceIdentity(analysis.path, rawReference.identity),
        file_path: analysis.path,
        owner_symbol_identity:
          remappedOwner !== null && knownSymbols.has(remappedOwner)
            ? remappedOwner
            : null,
        kind: rawReference.kind,
        native_kind: rawReference.nativeKind,
        module_specifier: rawReference.moduleSpecifier,
        module_specifier_range: rawReference.moduleSpecifierRange,
        statement_range: rawReference.statementRange,
        is_type_only: rawReference.isTypeOnly,
        bindings: rawReference.bindings,
      };
      references.push(reference);
      const outcome = outcomes.get(rawReference.identity);
      const targetModule = (target: CodeResolutionTarget): string | null =>
        moduleIdentities.get(target.path) ?? null;
      const targetIdentity = (target: CodeResolutionTarget): string | null =>
        target.symbolIdentity
          ? generationSymbolIdentity(target.path, target.symbolIdentity)
          : targetModule(target);
      const targets = outcome?.status === "resolved" ? outcome.targets : [];
      const uniqueTarget = targets.length === 1 ? targets[0]! : null;
      const uniqueTargetIdentity = uniqueTarget ? targetIdentity(uniqueTarget) : null;
      const candidates = (outcome?.candidates ?? [])
        .map((target) => {
          const identity = targetIdentity(target);
          return identity ? targetKey(target, identity) : `${target.path}#unindexed`;
        })
        .sort();
      resolutions.push({
        reference_identity: reference.identity,
        status: outcome?.status ?? "unresolved",
        rule: outcome?.rule ?? "no_static_resolution",
        resolver_configuration_digest: resolverConfigurationDigest,
        target_file_path: uniqueTarget?.path ?? null,
        target_symbol_identity: uniqueTargetIdentity,
        candidate_targets: candidates,
        diagnostics: [
          ...(outcome
            ? [`resolver_configuration:${outcome.configurationDigest}`]
            : []),
          ...(outcome?.reason ? [`reason:${outcome.reason}`] : []),
          ...(outcome?.diagnostics.map(
            (diagnostic) => `${diagnostic.code}:${diagnostic.detail}`
          ) ?? []),
        ],
      });
      const sourceIdentity =
        reference.owner_symbol_identity ?? moduleIdentities.get(reference.file_path)!;
      for (const target of targets) {
        const resolvedTargetIdentity = targetIdentity(target);
        if (!resolvedTargetIdentity || !knownSymbols.has(resolvedTargetIdentity)) continue;
        edges.push({
          identity: codeTopologyDerivedEdgeIdentity({
            referenceIdentity: reference.identity,
            sourceIdentity,
            targetIdentity: resolvedTargetIdentity,
          }),
          kind: "imports",
          source: {
            generation_identity: generationIdentity,
            symbol_identity: sourceIdentity,
          },
          target: {
            generation_identity: generationIdentity,
            symbol_identity: resolvedTargetIdentity,
          },
          reference_identity: reference.identity,
        });
      }
    }
  }
  const dependencyReferenceIdentities = new Set(references
    .filter((reference) =>
      reference.module_specifier !== null &&
      ["import", "dynamic_import", "reexport"].includes(reference.kind)
    )
    .map((reference) => reference.identity));
  const retainedFrontierCount = resolutions.filter((resolution) =>
    resolution.status !== "resolved" &&
    dependencyReferenceIdentities.has(resolution.reference_identity)
  ).length;
  if (edges.length + retainedFrontierCount > maxDependencyRecords) {
    return {
      status: "capacity_exceeded",
      path: null,
      detail: `Topology contains ${edges.length + retainedFrontierCount} dependency records across edges and frontiers; limit is ${maxDependencyRecords}.`,
    };
  }

  // Final records retain only the required ranges, bindings, and diagnostics.
  // Release parser and resolver indexes before normalization and validation.
  analyses.clear();
  resolvers.length = 0;
  moduleIdentities.clear();
  symbolsByIdentity.clear();
  knownSymbols.clear();

  const generation = normalizeOwnedCompleteCodeTopologyGeneration({
    header: { ...identityFields, identity: generationIdentity },
    files,
    symbols,
    references,
    resolutions,
    edges,
  });
  validateCompleteCodeTopologyGeneration(generation);
  return {
    status: "complete",
    source_kind: options.source.kind,
    generation,
    retained_bytes: estimateCodeTopologyGenerationRetainedBytes(generation),
  };
}
