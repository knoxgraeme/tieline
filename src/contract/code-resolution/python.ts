import { posix } from "node:path";
import { compareCodeTopologyText } from "../../domain/code-topology-ordering.js";
import type { SourceInventory } from "../source-inventory.js";
import { canonicalRepositoryRelativePath } from "../paths.js";
import type { SourceSnapshotReader } from "../source-snapshot.js";
import {
  moduleTarget,
  type CodeModuleResolver,
  type CodeResolutionDiagnostic,
  type CodeResolutionOutcome,
  type CodeResolutionTarget,
  type ResolutionAnalysis,
  type ResolutionReferenceFact,
} from "./types.js";
import {
  indexResolutionSymbols,
  resolutionDigest,
  resolutionIdentity,
  uniqueResolutionTargets,
  uniqueSorted,
  type ResolutionSymbolIndex,
} from "./support.js";

export const pythonResolutionCompatibility = "python-module-resolution-v1";
const pythonLanguages = new Set(["python"] as const);

export interface PythonResolutionConfigurationFile {
  path: string;
  sha256: string;
}

export interface PythonResolutionConfiguration {
  compatibility: typeof pythonResolutionCompatibility;
  digest: string;
  emptyDigest: string;
  files: readonly PythonResolutionConfigurationFile[];
  sourceRoots: readonly string[];
  diagnostics: readonly CodeResolutionDiagnostic[];
}

export interface ReadPythonResolutionConfigurationOptions {
  inventory: SourceInventory;
  reader: SourceSnapshotReader;
}

export interface CreatePythonModuleResolverOptions {
  inventory: SourceInventory;
  analyses: ReadonlyMap<string, ResolutionAnalysis>;
  configuration: PythonResolutionConfiguration;
}

function normalizeRoot(root: string): string | null {
  const portable = root.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (portable === "" || portable === ".") return ".";
  return canonicalRepositoryRelativePath(portable);
}

function parseStaticStringArray(value: string): string[] | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  const values: string[] = [];
  const content = trimmed.slice(1, -1).trim();
  if (!content) return values;
  for (const entry of content.split(",")) {
    const match = entry.trim().match(/^(?:"([^"]*)"|'([^']*)')$/);
    if (!match) return null;
    values.push((match[1] ?? match[2] ?? "").normalize("NFC"));
  }
  return values;
}

function setuptoolsRoots(source: string): { roots: string[]; unsupported: boolean } {
  let section = "";
  let unsupported = false;
  const roots: string[] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1]!.trim();
      continue;
    }
    if (section === "tool.setuptools.packages.find") {
      const where = line.match(/^where\s*=\s*(.+)$/);
      if (where) {
        const parsed = parseStaticStringArray(where[1]!);
        if (parsed) roots.push(...parsed);
        else unsupported = true;
      }
    }
    if (section === "tool.setuptools") {
      const packageDir = line.match(/^package-dir\s*=\s*\{\s*(?:""|'')\s*=\s*(?:"([^"]+)"|'([^']+)')\s*\}\s*$/);
      if (packageDir) roots.push(packageDir[1] ?? packageDir[2] ?? "");
      else if (/^package-dir\s*=/.test(line)) unsupported = true;
    }
  }
  return { roots, unsupported };
}

function normalizedInventoryRoots(inventory: SourceInventory): string[] {
  return uniqueSorted(inventory.sourceRoots.flatMap((root) => {
    const normalized = normalizeRoot(root);
    return normalized ? [normalized] : [];
  }));
}

export function readPythonResolutionConfiguration(
  options: ReadPythonResolutionConfigurationOptions
): PythonResolutionConfiguration {
  const fallbackRoots = normalizedInventoryRoots(options.inventory);
  const emptyNormalized = {
    compatibility: pythonResolutionCompatibility as typeof pythonResolutionCompatibility,
    files: [] as PythonResolutionConfigurationFile[],
    sourceRoots: fallbackRoots,
    diagnostics: [] as CodeResolutionDiagnostic[],
  };
  const emptyDigest = resolutionDigest(emptyNormalized);
  if (!options.inventory.files.some((file) => file.path === "pyproject.toml")) {
    return Object.freeze({
      ...emptyNormalized,
      digest: emptyDigest,
      emptyDigest,
      files: Object.freeze([]),
      sourceRoots: Object.freeze(fallbackRoots),
      diagnostics: Object.freeze([]),
    });
  }

  const read = options.reader.read("pyproject.toml");
  if (read.status !== "read") {
    const diagnostics = [{
      code: "configuration_unreadable",
      detail: `Could not read pyproject.toml: ${read.detail}`,
    }];
    const normalized = {
      compatibility: pythonResolutionCompatibility as typeof pythonResolutionCompatibility,
      files: [] as PythonResolutionConfigurationFile[],
      sourceRoots: fallbackRoots,
      diagnostics,
    };
    return Object.freeze({
      ...normalized,
      digest: resolutionDigest({ ...normalized, status: read.status }),
      emptyDigest,
      files: Object.freeze([]),
      sourceRoots: Object.freeze(fallbackRoots),
      diagnostics: Object.freeze(diagnostics),
    });
  }

  const diagnostics: CodeResolutionDiagnostic[] = [];
  const parsed = setuptoolsRoots(read.snapshot.text);
  const configuredRoots = uniqueSorted(parsed.roots.flatMap((root) => {
    const normalized = normalizeRoot(root);
    if (!normalized) {
      diagnostics.push({
        code: "configuration_source_root_unsafe",
        detail: `pyproject.toml source root '${root}' escapes the indexed repository`,
      });
      return [];
    }
    return [normalized];
  }));
  if (parsed.unsupported) {
    diagnostics.push({
      code: "configuration_source_roots_unsupported",
      detail: "pyproject.toml uses a non-static setuptools source-root form",
    });
  }
  const sourceRoots = configuredRoots.length > 0 ? configuredRoots : fallbackRoots;
  const files = [{ path: "pyproject.toml", sha256: read.snapshot.sha256 }];
  const normalized = {
    compatibility: pythonResolutionCompatibility as typeof pythonResolutionCompatibility,
    files,
    sourceRoots,
    diagnostics,
  };
  return Object.freeze({
    ...normalized,
    digest: resolutionDigest(normalized),
    emptyDigest,
    files: Object.freeze(files),
    sourceRoots: Object.freeze(sourceRoots),
    diagnostics: Object.freeze(diagnostics),
  });
}

interface ModuleCandidate {
  path: string;
}

interface ImportedTargetCandidates {
  targets: CodeResolutionTarget[];
  ambiguousReason: "ambiguous_export" | "ambiguous_module" | null;
  targetNotAnalyzed: boolean;
}

class PythonModuleResolver implements CodeModuleResolver {
  readonly languages = pythonLanguages;
  readonly compatibility = pythonResolutionCompatibility;
  readonly configurationDigest: string;
  readonly #files: ReadonlySet<string>;
  readonly #analyses: ReadonlyMap<string, ResolutionAnalysis>;
  readonly #symbols: ReadonlyMap<string, ResolutionSymbolIndex>;
  readonly #configuration: PythonResolutionConfiguration;

  constructor(options: CreatePythonModuleResolverOptions) {
    this.#files = new Set(
      options.inventory.files
        .filter((file) => file.language === "python")
        .map((file) => file.path)
    );
    this.#analyses = options.analyses;
    this.#symbols = new Map(
      [...options.analyses].map(([path, analysis]) => [
        path,
        indexResolutionSymbols(analysis),
      ])
    );
    this.#configuration = options.configuration;
    this.configurationDigest = options.configuration.digest;
  }

  resolveFile(path: string): readonly CodeResolutionOutcome[] {
    const analysis = this.#analyses.get(path);
    if (!analysis || analysis.language !== "python") return Object.freeze([]);
    return Object.freeze(
      analysis.references
        .filter((reference) => reference.kind !== "export")
        .map((reference) => this.#resolveReference(analysis, reference))
        .sort((left, right) =>
          left.reference.statementRange.utf16.start - right.reference.statementRange.utf16.start ||
          compareCodeTopologyText(left.identity, right.identity)
        )
    );
  }

  #moduleFiles(base: string): ModuleCandidate[] {
    const normalized = canonicalRepositoryRelativePath(base);
    if (!normalized) return [];
    const paths = [`${normalized}.py`, `${normalized}.pyi`, `${normalized}/__init__.py`, `${normalized}/__init__.pyi`];
    return uniqueSorted(paths.filter((path) => this.#files.has(path))).map((path) => ({ path }));
  }

  #resolveModule(sourcePath: string, specifier: string): {
    candidates: ModuleCandidate[];
    rule: string;
    reason: string | null;
  } {
    if (specifier.startsWith(".")) {
      const dots = specifier.match(/^\.+/)?.[0].length ?? 0;
      const suffix = specifier.slice(dots).replaceAll(".", "/");
      let base = posix.dirname(sourcePath);
      for (let level = 1; level < dots; level += 1) base = posix.dirname(base);
      const candidates = this.#moduleFiles(posix.join(base, suffix));
      return {
        candidates,
        rule: "python_relative_module",
        reason: candidates.length === 0 ? "module_not_found" : candidates.length > 1 ? "ambiguous_module" : null,
      };
    }
    const modulePath = specifier.replaceAll(".", "/");
    const candidates = new Map<string, ModuleCandidate>();
    for (const root of this.#configuration.sourceRoots) {
      const base = root === "." ? modulePath : posix.join(root, modulePath);
      for (const candidate of this.#moduleFiles(base)) candidates.set(candidate.path, candidate);
    }
    const ordered = [...candidates.values()].sort((left, right) =>
      compareCodeTopologyText(left.path, right.path)
    );
    return {
      candidates: ordered,
      rule: ordered.length > 0 ? "python_declared_root_module" : "python_external_package",
      reason: ordered.length === 0 ? "external_package" : ordered.length > 1 ? "ambiguous_module" : null,
    };
  }

  #namedTargets(analysis: ResolutionAnalysis, imported: string): CodeResolutionTarget[] {
    const name = imported.split(".").at(-1)!.normalize("NFC");
    return uniqueResolutionTargets(
      (this.#symbols.get(analysis.path)?.topLevelByName.get(name) ?? [])
        .map((symbol) => moduleTarget(analysis, symbol))
    );
  }

  #importedTargets(
    packageCandidate: ModuleCandidate,
    packageAnalysis: ResolutionAnalysis,
    imported: string
  ): ImportedTargetCandidates {
    const named = this.#namedTargets(packageAnalysis, imported);
    if (named.length > 0) {
      return {
        targets: named,
        ambiguousReason: named.length > 1 ? "ambiguous_export" : null,
        targetNotAnalyzed: false,
      };
    }
    if (!["__init__.py", "__init__.pyi"].includes(posix.basename(packageCandidate.path))) {
      return { targets: [], ambiguousReason: null, targetNotAnalyzed: false };
    }
    const childModules = this.#moduleFiles(
      posix.join(posix.dirname(packageCandidate.path), imported.replaceAll(".", "/"))
    );
    const childTargets = childModules.flatMap((candidate) => {
      const analysis = this.#analyses.get(candidate.path);
      return analysis ? [moduleTarget(analysis)] : [];
    });
    return {
      targets: childTargets,
      ambiguousReason: childModules.length > 1 ? "ambiguous_module" : null,
      targetNotAnalyzed: childModules.length === 1 && childTargets.length === 0,
    };
  }

  #resolveReference(
    source: ResolutionAnalysis,
    reference: ResolutionReferenceFact
  ): CodeResolutionOutcome {
    let status: CodeResolutionOutcome["status"] = "unresolved";
    let rule = "python_dynamic_specifier";
    let reason: string | null = "dynamic_specifier";
    let targets: CodeResolutionTarget[] = [];
    let candidates: CodeResolutionTarget[] = [];
    let diagnostics: readonly CodeResolutionDiagnostic[] =
      this.#configuration.diagnostics;

    if (reference.moduleSpecifier !== null) {
      const module = this.#resolveModule(source.path, reference.moduleSpecifier);
      rule = module.rule;
      reason = module.reason;
      candidates = module.candidates.flatMap((candidate) => {
        const analysis = this.#analyses.get(candidate.path);
        return analysis ? [moduleTarget(analysis)] : [];
      });
      const glob = reference.bindings.some((binding) => binding.imported === "*");
      if (glob) {
        rule = "python_glob_import";
        reason = "glob_import";
      } else if (module.rule === "python_external_package") {
        status = "external";
        candidates = [];
      } else if (module.candidates.length > 1) {
        status = "ambiguous";
      } else if (module.candidates.length === 1) {
        const targetAnalysis = this.#analyses.get(module.candidates[0]!.path);
        if (!targetAnalysis) {
          reason = "target_not_analyzed";
        } else {
          const imported = reference.bindings
            .map((binding) => binding.imported)
            .filter((name): name is string => name !== null);
          if (imported.length === 0) {
            status = "resolved";
            reason = null;
            targets = [moduleTarget(targetAnalysis)];
            candidates = [];
          } else {
            const matches = imported.map((name) =>
              this.#importedTargets(module.candidates[0]!, targetAnalysis, name)
            );
            if (matches.every((match) => match.targets.length === 1)) {
              status = "resolved";
              reason = null;
              targets = uniqueResolutionTargets(matches.flatMap((match) => match.targets));
              candidates = [];
            } else if (matches.some((match) => match.ambiguousReason !== null)) {
              status = "ambiguous";
              reason = matches.find((match) => match.ambiguousReason !== null)!.ambiguousReason;
              candidates = uniqueResolutionTargets(matches.flatMap((match) => match.targets));
            } else {
              reason = matches.some((match) => match.targetNotAnalyzed)
                ? "target_not_analyzed"
                : targetAnalysis.truncated.symbols || targetAnalysis.diagnostics.length > 0
                  ? "target_analysis_incomplete"
                  : "export_not_found";
              if (reason === "target_analysis_incomplete") {
                diagnostics = [
                  ...diagnostics,
                  {
                    code: "target_analysis_incomplete",
                    detail: `${targetAnalysis.path} has truncated facts or parser diagnostics`,
                  },
                ];
              }
              candidates = [];
            }
          }
        }
      }
    }

    targets = uniqueResolutionTargets(targets);
    candidates = uniqueResolutionTargets(candidates);
    const stable = {
      compatibility: this.compatibility,
      sourcePath: source.path,
      referenceIdentity: reference.identity,
      status,
      targets,
      candidates,
      via: [],
      rule,
      configurationDigest: this.configurationDigest,
      reason,
      diagnostics,
    };
    const sourceOwner = this.#symbols
      .get(source.path)
      ?.byIdentity.get(reference.ownerIdentity ?? "");
    return Object.freeze({
      identity: resolutionIdentity(stable),
      source: Object.freeze({
        path: source.path,
        language: source.language,
        symbolIdentity: reference.ownerIdentity,
        selector: sourceOwner?.selector ?? null,
      }),
      reference,
      status,
      targets: Object.freeze(targets),
      candidates: Object.freeze(candidates),
      via: Object.freeze([]),
      rule,
      configurationDigest: this.configurationDigest,
      reason,
      diagnostics: Object.freeze(diagnostics),
    });
  }
}

export function createPythonModuleResolver(
  options: CreatePythonModuleResolverOptions
): CodeModuleResolver {
  return new PythonModuleResolver(options);
}
