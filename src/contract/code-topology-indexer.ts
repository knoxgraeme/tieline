import { createHash } from "node:crypto";
import {
  codeTopologyGenerationIdentity,
  normalizeCompleteCodeTopologyGeneration,
  validateCompleteCodeTopologyGeneration,
  type CodeTopologyEdgeRecord,
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
  CodeResolutionOutcome,
  CodeResolutionTarget,
} from "./code-resolution/types.js";
import type { SourceInventory } from "./source-inventory.js";
import type { SourceSnapshotReader } from "./source-snapshot.js";

export const CODE_TOPOLOGY_SCHEMA_VERSION = 1;
export const CODE_TOPOLOGY_RESOLVER_IMPLEMENTATION =
  "tieline-static-modules@1";
export const CODE_TOPOLOGY_FACT_POLICY = "tieline-code-topology-facts@1";
const MAX_TOPOLOGY_FILES = 5_000;
const MAX_TOPOLOGY_SOURCE_BYTES = 50 * 1024 * 1024;
const MAX_TOPOLOGY_SYMBOLS = 100_000;
const MAX_TOPOLOGY_EDGES = 250_000;

export interface TopologySourceCollection {
  kind: "committed" | "workspace";
  /** Exact Git tree for committed input; content identity for a workspace. */
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

export interface BuildCodeTopologyGenerationOptions {
  repository: string;
  source: TopologySourceCollection;
  maxFiles?: number;
  maxTotalSourceBytes?: number;
  maxSymbols?: number;
  maxEdges?: number;
  parserConcurrency?: number;
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

function edgeIdentity(
  referenceIdentity: string,
  sourceIdentity: string,
  targetIdentity: string
): string {
  return `edge:${canonicalDigest({
    kind: "imports",
    referenceIdentity,
    sourceIdentity,
    targetIdentity,
  })}`;
}

function targetKey(target: CodeResolutionTarget, targetIdentity: string): string {
  return `${target.path}#${targetIdentity}`;
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

function resolverForLanguage(
  language: LanguageAnalysisResult["language"],
  resolvers: readonly CodeModuleResolver[]
): CodeModuleResolver | undefined {
  return resolvers.find((resolver) => resolver.languages.has(language));
}

/** Parse, resolve, and immediately reduce one immutable source collection. */
export async function buildCodeTopologyGeneration(
  options: BuildCodeTopologyGenerationOptions
): Promise<TopologyGenerationBuildResult> {
  const maxFiles = Math.min(options.maxFiles ?? MAX_TOPOLOGY_FILES, MAX_TOPOLOGY_FILES);
  const maxTotalSourceBytes = Math.min(
    options.maxTotalSourceBytes ?? MAX_TOPOLOGY_SOURCE_BYTES,
    MAX_TOPOLOGY_SOURCE_BYTES
  );
  const maxSymbols = Math.min(
    options.maxSymbols ?? MAX_TOPOLOGY_SYMBOLS,
    MAX_TOPOLOGY_SYMBOLS
  );
  const maxEdges = Math.min(options.maxEdges ?? MAX_TOPOLOGY_EDGES, MAX_TOPOLOGY_EDGES);
  const parserConcurrency = options.parserConcurrency ?? 4;
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
          analyses.set(file.path, await analyzer.analyze(snapshot));
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
      analyses,
      configuration: javascriptConfiguration,
    }),
    createPythonModuleResolver({
      inventory: options.source.inventory,
      analyses,
      configuration: pythonConfiguration,
    }),
    createRustModuleResolver({
      inventory: options.source.inventory,
      analyses,
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
  const identityFields = {
    repository: options.repository,
    revision:
      options.source.kind === "committed"
        ? options.source.revision
        : inventoryDigest,
    inventory_digest: inventoryDigest,
    parser_compatibility_digest: compatibility.parser_compatibility_digest,
    resolver_implementation: compatibility.resolver_implementation,
    resolver_configuration_digest: resolverConfigurationDigest,
    topology_schema_version: compatibility.topology_schema_version,
    fact_policy_digest: compatibility.fact_policy_digest,
  };
  const generationIdentity = codeTopologyGenerationIdentity(identityFields);
  const moduleIdentities = new Map(
    [...analyses.values()].map((analysis) => [
      analysis.path,
      syntheticModuleIdentity(analysis.path, analysis.sourceHash),
    ])
  );
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

  const outcomes = new Map<string, CodeResolutionOutcome>();
  for (const analysis of analyses.values()) {
    const resolver = resolverForLanguage(analysis.language, resolvers);
    for (const outcome of resolver?.resolveFile(analysis.path) ?? []) {
      outcomes.set(`${analysis.path}\0${outcome.reference.identity}`, outcome);
    }
  }
  const referenceEntries = [...analyses.values()].flatMap((analysis) =>
    analysis.references.map((reference) => {
      const remappedOwner = reference.ownerIdentity
        ? generationSymbolIdentity(analysis.path, reference.ownerIdentity)
        : null;
      return {
        path: analysis.path,
        rawIdentity: reference.identity,
        record: {
          identity: generationReferenceIdentity(analysis.path, reference.identity),
          file_path: analysis.path,
          owner_symbol_identity:
            remappedOwner !== null && knownSymbols.has(remappedOwner)
              ? remappedOwner
              : null,
          kind: reference.kind,
          native_kind: reference.nativeKind,
          module_specifier: reference.moduleSpecifier,
          module_specifier_range: reference.moduleSpecifierRange,
          statement_range: reference.statementRange,
          is_type_only: reference.isTypeOnly,
          bindings: reference.bindings,
        },
      };
    })
  );
  const references = referenceEntries.map((entry) => entry.record);
  const resolutions: CodeTopologyResolutionRecord[] = [];
  const edges: CodeTopologyEdgeRecord[] = [];
  for (const entry of referenceEntries) {
    const reference = entry.record;
    const outcome = outcomes.get(`${entry.path}\0${entry.rawIdentity}`);
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
        identity: edgeIdentity(reference.identity, sourceIdentity, resolvedTargetIdentity),
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
  if (edges.length > maxEdges) {
    return {
      status: "capacity_exceeded",
      path: null,
      detail: `Topology contains ${edges.length} edges; limit is ${maxEdges}.`,
    };
  }

  const generation = normalizeCompleteCodeTopologyGeneration({
    header: { ...identityFields, identity: generationIdentity },
    files: [...analyses.values()].map((analysis) => ({
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
    })),
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
    retained_bytes: Buffer.byteLength(JSON.stringify(generation)),
  };
}
