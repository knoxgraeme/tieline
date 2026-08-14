import { posix } from "node:path";
import { compareCodeTopologyText } from "../../domain/code-topology-ordering.js";
import type { SupportedCodeLanguage } from "../code-analysis/languages.js";
import type { SourceInventory } from "../source-inventory.js";
import { canonicalRepositoryRelativePath } from "../paths.js";
import type { SourceSnapshotReader } from "../source-snapshot.js";
import {
  moduleTarget,
  type CodeModuleResolver,
  type CodeResolutionDiagnostic,
  type CodeResolutionOutcome,
  type CodeResolutionTarget,
  type CodeResolutionVia,
  type ResolutionAnalysis,
  type ResolutionReferenceFact,
} from "./types.js";
import {
  indexResolutionSymbols,
  resolutionDigest,
  resolutionIdentity,
  uniqueResolutionTargets,
  type ResolutionSymbolIndex,
} from "./support.js";

export const javascriptResolutionCompatibility = "javascript-module-resolution-v2";

const javascriptLanguages = new Set<SupportedCodeLanguage>([
  "javascript",
  "jsx",
  "typescript",
  "tsx",
]);
const supportedExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const emittedSourceExtensions: Readonly<Record<string, readonly string[]>> = {
  ".js": [".ts", ".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

export interface JavaScriptResolutionConfigurationFile {
  path: string;
  sha256: string;
}

export interface JavaScriptPathAlias {
  pattern: string;
  targets: readonly string[];
}

export interface JavaScriptResolutionConfiguration {
  compatibility: typeof javascriptResolutionCompatibility;
  digest: string;
  /** Stable digest used when no supported config is present. */
  emptyDigest: string;
  files: readonly JavaScriptResolutionConfigurationFile[];
  baseUrl: string | null;
  aliases: readonly JavaScriptPathAlias[];
  diagnostics: readonly CodeResolutionDiagnostic[];
}

export interface ReadJavaScriptResolutionConfigurationOptions {
  inventory: SourceInventory;
  reader: SourceSnapshotReader;
}

export interface CreateJavaScriptModuleResolverOptions {
  inventory: SourceInventory;
  analyses: ReadonlyMap<string, ResolutionAnalysis>;
  configuration: JavaScriptResolutionConfiguration;
}

function stripJsonCommentsAndTrailingCommas(source: string): string {
  let result = "";
  let string = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];
    if (string) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') string = false;
      continue;
    }
    if (character === '"') {
      string = true;
      result += character;
      continue;
    }
    if (character === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      result += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") result += "\n";
        index += 1;
      }
      index += 1;
      continue;
    }
    if (character === ",") {
      let lookahead = index + 1;
      while (/\s/.test(source[lookahead] ?? "")) lookahead += 1;
      if (source[lookahead] === "}" || source[lookahead] === "]") continue;
    }
    result += character;
  }
  return result;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeConfigPath(path: string): string | null {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "") || ".";
  return normalized === "." ? "." : canonicalRepositoryRelativePath(normalized);
}

function emptyConfigurationDigest(): string {
  return resolutionDigest({ compatibility: javascriptResolutionCompatibility, files: [], baseUrl: null, aliases: [] });
}

export function readJavaScriptResolutionConfiguration(
  options: ReadJavaScriptResolutionConfigurationOptions
): JavaScriptResolutionConfiguration {
  const emptyDigest = emptyConfigurationDigest();
  const inventoryPaths = new Set(options.inventory.files.map((file) => file.path));
  const configPath = ["tsconfig.json", "jsconfig.json"].find((path) => inventoryPaths.has(path));
  if (!configPath) {
    return Object.freeze({
      compatibility: javascriptResolutionCompatibility,
      digest: emptyDigest,
      emptyDigest,
      files: Object.freeze([]),
      baseUrl: null,
      aliases: Object.freeze([]),
      diagnostics: Object.freeze([]),
    });
  }

  const read = options.reader.read(configPath);
  if (read.status !== "read") {
    const diagnostics = Object.freeze([{
      code: "configuration_unreadable",
      detail: `Could not read ${configPath}: ${read.detail}`,
    }]);
    return Object.freeze({
      compatibility: javascriptResolutionCompatibility,
      digest: resolutionDigest({ compatibility: javascriptResolutionCompatibility, configPath, status: read.status }),
      emptyDigest,
      files: Object.freeze([]),
      baseUrl: null,
      aliases: Object.freeze([]),
      diagnostics,
    });
  }

  const files = Object.freeze([{ path: configPath, sha256: read.snapshot.sha256 }]);
  const diagnostics: CodeResolutionDiagnostic[] = [];
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = record(JSON.parse(stripJsonCommentsAndTrailingCommas(read.snapshot.text)));
  } catch {
    diagnostics.push({
      code: "configuration_invalid",
      detail: `${configPath} is not supported JSON/JSONC`,
    });
  }
  if (parsed?.extends !== undefined) {
    diagnostics.push({
      code: "configuration_extends_unsupported",
      detail: `${configPath} extends another configuration; only its local static options were used`,
    });
  }
  const compilerOptions = record(parsed?.compilerOptions);
  const configuredBaseUrl = typeof compilerOptions?.baseUrl === "string"
    ? normalizeConfigPath(compilerOptions.baseUrl || ".")
    : null;
  if (compilerOptions?.baseUrl !== undefined && configuredBaseUrl === null) {
    diagnostics.push({
      code: "configuration_base_url_unsafe",
      detail: `${configPath} has a baseUrl outside the indexed repository`,
    });
  }
  const baseUrl = configuredBaseUrl;
  const paths = record(compilerOptions?.paths);
  const aliases: JavaScriptPathAlias[] = [];
  if (paths) {
    for (const [pattern, rawTargets] of Object.entries(paths).sort(([left], [right]) =>
      compareCodeTopologyText(left, right)
    )) {
      const targets = Array.isArray(rawTargets)
        ? rawTargets.filter((target): target is string => typeof target === "string")
        : [];
      if (
        targets.length === 0 ||
        (pattern.match(/\*/g)?.length ?? 0) > 1 ||
        targets.some((target) => (target.match(/\*/g)?.length ?? 0) > 1)
      ) {
        diagnostics.push({
          code: "configuration_alias_unsupported",
          detail: `${configPath} path alias '${pattern}' is outside the supported static subset`,
        });
        continue;
      }
      aliases.push(Object.freeze({ pattern: pattern.normalize("NFC"), targets: Object.freeze([...targets]) }));
    }
  }
  aliases.sort((left, right) =>
    right.pattern.replace("*", "").length - left.pattern.replace("*", "").length ||
    compareCodeTopologyText(left.pattern, right.pattern)
  );
  const normalized = {
    compatibility: javascriptResolutionCompatibility as typeof javascriptResolutionCompatibility,
    files,
    baseUrl,
    aliases,
    diagnostics,
  };
  return Object.freeze({
    ...normalized,
    digest: resolutionDigest(normalized),
    emptyDigest,
    aliases: Object.freeze(aliases),
    diagnostics: Object.freeze(diagnostics),
  });
}

interface ModuleCandidate {
  path: string;
  rule: string;
}

interface ExportTarget {
  target: CodeResolutionTarget;
  via: CodeResolutionVia[];
}

interface ExportLookup {
  matches: ExportTarget[];
  ambiguous: CodeResolutionTarget[];
  diagnostics: CodeResolutionDiagnostic[];
  incomplete: boolean;
}

function extension(path: string): string {
  return supportedExtensions.find((candidate) => path.endsWith(candidate)) ?? "";
}

function uniqueCandidates(candidates: readonly ModuleCandidate[]): ModuleCandidate[] {
  const byPath = new Map<string, ModuleCandidate>();
  for (const candidate of candidates) byPath.set(candidate.path, candidate);
  return [...byPath.values()].sort((left, right) =>
    compareCodeTopologyText(left.path, right.path)
  );
}

function aliasCapture(pattern: string, specifier: string): string | null {
  const star = pattern.indexOf("*");
  if (star < 0) return pattern === specifier ? "" : null;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  return specifier.startsWith(prefix) && specifier.endsWith(suffix)
    ? specifier.slice(prefix.length, specifier.length - suffix.length)
    : null;
}

class JavaScriptModuleResolver implements CodeModuleResolver {
  readonly languages = javascriptLanguages;
  readonly compatibility = javascriptResolutionCompatibility;
  readonly configurationDigest: string;
  readonly #files: ReadonlySet<string>;
  readonly #analyses: ReadonlyMap<string, ResolutionAnalysis>;
  readonly #symbols: ReadonlyMap<string, ResolutionSymbolIndex>;
  readonly #configuration: JavaScriptResolutionConfiguration;

  constructor(options: CreateJavaScriptModuleResolverOptions) {
    this.#files = new Set(
      options.inventory.files
        .filter((file) => file.language !== null && javascriptLanguages.has(file.language))
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
    if (!analysis || !javascriptLanguages.has(analysis.language)) return Object.freeze([]);
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

  #pathCandidates(path: string, extensionlessRule: string, indexRule: string): ModuleCandidate[] {
    const normalized = canonicalRepositoryRelativePath(path);
    if (!normalized) return [];
    if (extension(normalized)) {
      if (this.#files.has(normalized)) {
        return [{ path: normalized, rule: extensionlessRule.replace("extensionless", "exact") }];
      }
      const inputExtension = extension(normalized);
      const stem = normalized.slice(0, -inputExtension.length);
      return uniqueCandidates(
        (emittedSourceExtensions[inputExtension] ?? []).flatMap((sourceExtension) => {
          const file = `${stem}${sourceExtension}`;
          return this.#files.has(file)
            ? [{
                path: file,
                rule: extensionlessRule.replace("extensionless", "emitted_source"),
              }]
            : [];
        })
      );
    }
    const candidates: ModuleCandidate[] = [];
    for (const candidateExtension of supportedExtensions) {
      const file = `${normalized}${candidateExtension}`;
      if (this.#files.has(file)) candidates.push({ path: file, rule: extensionlessRule });
    }
    for (const candidateExtension of supportedExtensions) {
      const file = `${normalized}/index${candidateExtension}`;
      if (this.#files.has(file)) candidates.push({ path: file, rule: indexRule });
    }
    return uniqueCandidates(candidates);
  }

  #resolveModule(sourcePath: string, specifier: string): {
    candidates: ModuleCandidate[];
    rule: string;
    reason: string | null;
  } {
    if (specifier.startsWith(".")) {
      const path = posix.join(posix.dirname(sourcePath), specifier);
      const candidates = this.#pathCandidates(
        path,
        "javascript_relative_extensionless",
        "javascript_relative_index"
      );
      return {
        candidates,
        rule: candidates[0]?.rule ?? (extension(path) ? "javascript_relative_exact" : "javascript_relative_extensionless"),
        reason: candidates.length === 0 ? "module_not_found" : candidates.length > 1 ? "ambiguous_module" : null,
      };
    }
    for (const alias of this.#configuration.aliases) {
      const capture = aliasCapture(alias.pattern, specifier);
      if (capture === null) continue;
      const base = this.#configuration.baseUrl ?? ".";
      const candidates = uniqueCandidates(alias.targets.flatMap((target) => {
        const substituted = target.replace("*", capture).replaceAll("\\", "/");
        if (substituted.startsWith("/") || /^[A-Za-z]:\//.test(substituted)) return [];
        return this.#pathCandidates(
          posix.join(base, substituted),
          "javascript_paths_alias",
          "javascript_paths_alias"
        ).map((candidate) => ({ ...candidate, rule: "javascript_paths_alias" }));
      }));
      return {
        candidates,
        rule: "javascript_paths_alias",
        reason: candidates.length === 0 ? "alias_target_not_found" : candidates.length > 1 ? "ambiguous_module" : null,
      };
    }
    if (this.#configuration.baseUrl !== null) {
      const candidates = this.#pathCandidates(
        posix.join(this.#configuration.baseUrl, specifier),
        "javascript_base_url",
        "javascript_base_url"
      ).map((candidate) => ({ ...candidate, rule: "javascript_base_url" }));
      if (candidates.length > 0) {
        return {
          candidates,
          rule: "javascript_base_url",
          reason: candidates.length > 1 ? "ambiguous_module" : null,
        };
      }
    }
    if (specifier.startsWith("#")) {
      return { candidates: [], rule: "javascript_package_imports_unsupported", reason: "unsupported_conditional_exports" };
    }
    return { candidates: [], rule: "javascript_bare_external", reason: "external_package" };
  }

  #exportedTargets(
    modulePath: string,
    exportedName: string,
    visited: ReadonlySet<string>
  ): ExportLookup {
    const visitKey = `${modulePath}:${exportedName}`;
    if (visited.has(visitKey)) {
      return {
        matches: [],
        ambiguous: [],
        diagnostics: [{
          code: "reexport_cycle",
          detail: `Re-export lookup for '${exportedName}' revisited ${modulePath}`,
        }],
        incomplete: true,
      };
    }
    const nextVisited = new Set(visited).add(visitKey);
    const analysis = this.#analyses.get(modulePath);
    if (!analysis) {
      return {
        matches: [],
        ambiguous: [],
        diagnostics: [{
          code: "reexport_target_not_analyzed",
          detail: `${modulePath} was not available for export lookup`,
        }],
        incomplete: true,
      };
    }
    const symbols = this.#symbols.get(modulePath)!;
    const topLevel = symbols.topLevel;
    const results: ExportTarget[] = [];
    const ambiguous: CodeResolutionTarget[] = [];
    const diagnostics: CodeResolutionDiagnostic[] = [];
    let incomplete = analysis.truncated.symbols || analysis.truncated.references;
    for (const reference of analysis.references) {
      if (reference.kind === "export") {
        if (reference.ownerIdentity) {
          const symbol = symbols.byIdentity.get(reference.ownerIdentity);
          if (symbol?.name === exportedName) {
            results.push({ target: moduleTarget(analysis, symbol), via: [] });
          }
        }
        if (reference.bindings.length === 0) {
          for (const symbol of topLevel) {
            if (
              symbol.name === exportedName &&
              symbol.bodyRange.utf16.start >= reference.statementRange.utf16.start &&
              symbol.bodyRange.utf16.end <= reference.statementRange.utf16.end
            ) {
              results.push({ target: moduleTarget(analysis, symbol), via: [] });
            }
          }
        }
        for (const binding of reference.bindings) {
          if (binding.exported !== exportedName || !binding.imported) continue;
          for (const symbol of symbols.topLevelByName.get(binding.imported) ?? []) {
            results.push({ target: moduleTarget(analysis, symbol), via: [] });
          }
        }
        continue;
      }
      if (reference.kind !== "reexport" || !reference.moduleSpecifier) continue;
      const binding = reference.bindings.find((entry) => entry.exported === exportedName);
      if (reference.bindings.length > 0 && !binding) continue;
      if (exportedName === "default" && reference.bindings.length === 0) continue;
      const module = this.#resolveModule(modulePath, reference.moduleSpecifier);
      if (module.candidates.length !== 1) {
        if (module.candidates.length > 1) {
          for (const candidate of module.candidates) {
            const candidateAnalysis = this.#analyses.get(candidate.path);
            if (candidateAnalysis) ambiguous.push(moduleTarget(candidateAnalysis));
          }
          diagnostics.push({
            code: "reexport_target_ambiguous",
            detail: `${modulePath} re-export '${reference.moduleSpecifier}' matched multiple modules`,
          });
        } else {
          diagnostics.push({
            code: "reexport_target_unresolved",
            detail: `${modulePath} re-export '${reference.moduleSpecifier}' could not be resolved`,
          });
        }
        incomplete = true;
        continue;
      }
      const importedName = binding?.imported ?? exportedName;
      const nested = this.#exportedTargets(module.candidates[0]!.path, importedName!, nextVisited);
      ambiguous.push(...nested.ambiguous);
      diagnostics.push(...nested.diagnostics);
      incomplete ||= nested.incomplete;
      for (const target of nested.matches) {
        results.push({
          target: target.target,
          via: [{ path: modulePath, rule: module.rule }, ...target.via],
        });
      }
    }
    const unique = new Map<string, ExportTarget>();
    for (const result of results) {
      unique.set(`${result.target.path}:${result.target.symbolIdentity ?? "module"}`, result);
    }
    incomplete ||= results.length === 0 && analysis.diagnostics.length > 0;
    return {
      matches: [...unique.values()].sort((left, right) =>
        compareCodeTopologyText(left.target.path, right.target.path) ||
        compareCodeTopologyText(
          left.target.symbolIdentity ?? "",
          right.target.symbolIdentity ?? ""
        )
      ),
      ambiguous: uniqueResolutionTargets(ambiguous),
      diagnostics,
      incomplete,
    };
  }

  #resolveReference(
    source: ResolutionAnalysis,
    reference: ResolutionReferenceFact
  ): CodeResolutionOutcome {
    let status: CodeResolutionOutcome["status"] = "unresolved";
    let rule = "javascript_dynamic_specifier";
    let reason: string | null = "dynamic_specifier";
    let targets: CodeResolutionTarget[] = [];
    let candidates: CodeResolutionTarget[] = [];
    let via: CodeResolutionVia[] = [];
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
      if (rule === "javascript_bare_external") {
        status = "external";
        candidates = [];
      } else if (module.candidates.length > 1) {
        status = "ambiguous";
      } else if (module.candidates.length === 1) {
        const targetAnalysis = this.#analyses.get(module.candidates[0]!.path);
        if (!targetAnalysis) {
          reason = "target_not_analyzed";
        } else {
          const importedNames = reference.bindings
            .map((binding) => binding.imported)
            .filter((name): name is string => name !== null);
          if (importedNames.length === 0) {
            status = "resolved";
            reason = null;
            targets = [moduleTarget(targetAnalysis)];
            candidates = [];
          } else {
            const lookups = importedNames.map((name) =>
              this.#exportedTargets(targetAnalysis.path, name, new Set())
            );
            const exportsByBinding = lookups.map((lookup) => lookup.matches);
            const exports = exportsByBinding.flat();
            const exportedTargets = uniqueResolutionTargets(exports.map((entry) => entry.target));
            const ambiguousTargets = uniqueResolutionTargets(
              lookups.flatMap((lookup) => lookup.ambiguous)
            );
            const lookupDiagnostics = lookups.flatMap(
              (lookup) => lookup.diagnostics
            );
            if (lookupDiagnostics.length > 0) {
              diagnostics = [...diagnostics, ...lookupDiagnostics];
            }
            if (
              exportsByBinding.every((matches) => matches.length === 1) &&
              lookups.every((lookup) => !lookup.incomplete && lookup.ambiguous.length === 0)
            ) {
              status = "resolved";
              reason = null;
              targets = exportedTargets;
              candidates = [];
              via = exports.flatMap((entry) => entry.via);
            } else if (
              exportsByBinding.some((matches) => matches.length > 1) ||
              ambiguousTargets.length > 0
            ) {
              status = "ambiguous";
              reason = "ambiguous_export";
              candidates = uniqueResolutionTargets([
                ...exportedTargets,
                ...ambiguousTargets,
              ]);
            } else {
              const incomplete = lookups.some((lookup) => lookup.incomplete) ||
                targetAnalysis.truncated.symbols ||
                targetAnalysis.truncated.references ||
                targetAnalysis.diagnostics.length > 0;
              reason = incomplete ? "target_analysis_incomplete" : "export_not_found";
              if (incomplete) {
                diagnostics = [
                  ...diagnostics,
                  {
                    code: "target_analysis_incomplete",
                    detail: `${targetAnalysis.path} has truncated facts or parser diagnostics`,
                  },
                ];
              }
              targets = exportedTargets;
              candidates = [];
            }
          }
        }
      }
    }

    targets = uniqueResolutionTargets(targets);
    candidates = uniqueResolutionTargets(candidates);
    via = [...new Map(via.map((entry) => [`${entry.path}:${entry.rule}`, entry])).values()];
    const stable = {
      compatibility: this.compatibility,
      sourcePath: source.path,
      referenceIdentity: reference.identity,
      status,
      targets,
      candidates,
      via,
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
      via: Object.freeze(via),
      rule,
      configurationDigest: this.configurationDigest,
      reason,
      diagnostics: Object.freeze(diagnostics),
    });
  }
}

export function createJavaScriptModuleResolver(
  options: CreateJavaScriptModuleResolverOptions
): CodeModuleResolver {
  return new JavaScriptModuleResolver(options);
}
