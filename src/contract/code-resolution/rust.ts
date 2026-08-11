import { posix } from "node:path";
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

export const rustResolutionCompatibility = "rust-module-resolution-v1";
const rustLanguages = new Set(["rust"] as const);

export interface RustResolutionConfigurationFile {
  path: string;
  sha256: string;
}

export interface RustResolutionConfiguration {
  compatibility: typeof rustResolutionCompatibility;
  digest: string;
  emptyDigest: string;
  files: readonly RustResolutionConfigurationFile[];
  crateName: string | null;
  crateRoots: readonly string[];
  diagnostics: readonly CodeResolutionDiagnostic[];
}

export interface ReadRustResolutionConfigurationOptions {
  inventory: SourceInventory;
  reader: SourceSnapshotReader;
}

export interface CreateRustModuleResolverOptions {
  inventory: SourceInventory;
  analyses: ReadonlyMap<string, ResolutionAnalysis>;
  configuration: RustResolutionConfiguration;
}

interface CargoStaticConfiguration {
  crateName: string | null;
  libPath: string | null;
  hasBuildScript: boolean;
  unsupportedLibPath: boolean;
}

function parseCargoConfiguration(source: string): CargoStaticConfiguration {
  let section = "";
  let crateName: string | null = null;
  let libPath: string | null = null;
  let hasBuildScript = false;
  let unsupportedLibPath = false;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1]!.trim();
      continue;
    }
    const stringValue = line.match(/^([A-Za-z_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*$/);
    if (section === "package" && stringValue?.[1] === "name") {
      crateName = (stringValue[2] ?? stringValue[3] ?? "").replaceAll("-", "_").normalize("NFC");
    }
    if (section === "package" && /^build\s*=/.test(line)) hasBuildScript = true;
    if (section === "lib" && /^path\s*=/.test(line)) {
      if (stringValue?.[1] === "path") libPath = stringValue[2] ?? stringValue[3] ?? "";
      else unsupportedLibPath = true;
    }
  }
  return { crateName, libPath, hasBuildScript, unsupportedLibPath };
}

function normalizeConfiguredPath(path: string): string | null {
  return canonicalRepositoryRelativePath(path.trim().replaceAll("\\", "/"));
}

export function readRustResolutionConfiguration(
  options: ReadRustResolutionConfigurationOptions
): RustResolutionConfiguration {
  const inventoryPaths = new Set(options.inventory.files.map((file) => file.path));
  const conventionalRoots = ["src/lib.rs", "src/main.rs"].filter((path) => inventoryPaths.has(path));
  const emptyNormalized = {
    compatibility: rustResolutionCompatibility as typeof rustResolutionCompatibility,
    files: [] as RustResolutionConfigurationFile[],
    crateName: null,
    crateRoots: conventionalRoots,
    diagnostics: [] as CodeResolutionDiagnostic[],
  };
  const emptyDigest = resolutionDigest(emptyNormalized);
  if (!inventoryPaths.has("Cargo.toml")) {
    return Object.freeze({
      ...emptyNormalized,
      digest: emptyDigest,
      emptyDigest,
      files: Object.freeze([]),
      crateRoots: Object.freeze(conventionalRoots),
      diagnostics: Object.freeze([]),
    });
  }

  const read = options.reader.read("Cargo.toml");
  if (read.status !== "read") {
    const diagnostics = [{
      code: "configuration_unreadable",
      detail: `Could not read Cargo.toml: ${read.detail}`,
    }];
    const normalized = { ...emptyNormalized, diagnostics };
    return Object.freeze({
      ...normalized,
      digest: resolutionDigest({ ...normalized, status: read.status }),
      emptyDigest,
      files: Object.freeze([]),
      crateRoots: Object.freeze(conventionalRoots),
      diagnostics: Object.freeze(diagnostics),
    });
  }

  const parsed = parseCargoConfiguration(read.snapshot.text);
  const diagnostics: CodeResolutionDiagnostic[] = [];
  const configuredLib = parsed.libPath === null ? null : normalizeConfiguredPath(parsed.libPath);
  if (parsed.libPath !== null && configuredLib === null) {
    diagnostics.push({
      code: "configuration_crate_root_unsafe",
      detail: `Cargo.toml lib path '${parsed.libPath}' escapes the indexed repository`,
    });
  }
  if (parsed.unsupportedLibPath) {
    diagnostics.push({
      code: "configuration_crate_root_unsupported",
      detail: "Cargo.toml uses a non-static lib path",
    });
  }
  if (parsed.hasBuildScript) {
    diagnostics.push({
      code: "rust_build_script_not_executed",
      detail: "Cargo build scripts are not executed; generated modules remain unresolved frontiers",
    });
  }
  const crateRoots = uniqueSorted([
    ...(configuredLib && inventoryPaths.has(configuredLib) ? [configuredLib] : []),
    ...conventionalRoots,
  ]);
  const files = [{ path: "Cargo.toml", sha256: read.snapshot.sha256 }];
  const normalized = {
    compatibility: rustResolutionCompatibility as typeof rustResolutionCompatibility,
    files,
    crateName: parsed.crateName,
    crateRoots,
    diagnostics,
  };
  return Object.freeze({
    ...normalized,
    digest: resolutionDigest(normalized),
    emptyDigest,
    files: Object.freeze(files),
    crateRoots: Object.freeze(crateRoots),
    diagnostics: Object.freeze(diagnostics),
  });
}

interface CrateContext {
  root: string;
  rootDirectory: string;
  currentModule: readonly string[];
}

interface ModuleCandidate {
  path: string;
  rule: string;
}

function canonicalRustSegment(segment: string): string {
  return (segment.startsWith("r#") ? segment.slice(2) : segment).normalize("NFC");
}

class RustModuleResolver implements CodeModuleResolver {
  readonly languages = rustLanguages;
  readonly compatibility = rustResolutionCompatibility;
  readonly configurationDigest: string;
  readonly #files: ReadonlySet<string>;
  readonly #analyses: ReadonlyMap<string, ResolutionAnalysis>;
  readonly #symbols: ReadonlyMap<string, ResolutionSymbolIndex>;
  readonly #configuration: RustResolutionConfiguration;

  constructor(options: CreateRustModuleResolverOptions) {
    this.#files = new Set(
      options.inventory.files.filter((file) => file.language === "rust").map((file) => file.path)
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
    if (!analysis || analysis.language !== "rust") return Object.freeze([]);
    return Object.freeze(
      analysis.references
        .filter((reference) => reference.kind !== "export")
        .map((reference) => this.#resolveReference(analysis, reference))
        .sort((left, right) =>
          left.reference.statementRange.utf16.start - right.reference.statementRange.utf16.start ||
          left.identity.localeCompare(right.identity)
        )
    );
  }

  #contexts(sourcePath: string): CrateContext[] {
    const exactRoots = this.#configuration.crateRoots.filter((root) => root === sourcePath);
    if (exactRoots.length > 0) {
      return exactRoots.map((root) => ({
        root,
        rootDirectory: posix.dirname(root),
        currentModule: [],
      }));
    }
    const contexts: CrateContext[] = [];
    for (const root of this.#configuration.crateRoots) {
      const rootDirectory = posix.dirname(root);
      if (!sourcePath.startsWith(`${rootDirectory}/`) || !sourcePath.endsWith(".rs")) continue;
      const relative = sourcePath.slice(rootDirectory.length + 1);
      const currentModule = relative.endsWith("/mod.rs")
        ? relative.slice(0, -"/mod.rs".length).split("/")
        : relative.slice(0, -".rs".length).split("/");
      contexts.push({ root, rootDirectory, currentModule: currentModule.filter(Boolean) });
    }
    return contexts;
  }

  #moduleCandidates(context: CrateContext, segments: readonly string[], rule: string): ModuleCandidate[] {
    if (segments.length === 0) return this.#files.has(context.root) ? [{ path: context.root, rule }] : [];
    const base = posix.join(context.rootDirectory, ...segments);
    return [`${base}.rs`, `${base}/mod.rs`]
      .filter((path) => this.#files.has(path))
      .map((path) => ({ path, rule }));
  }

  #pathCandidates(sourcePath: string, path: string): {
    candidates: ModuleCandidate[];
    rule: string;
    external: boolean;
  } {
    const parts = path.split("::").filter(Boolean).map(canonicalRustSegment);
    const prefix = parts[0];
    const contexts = this.#contexts(sourcePath);
    let rule = "rust_local_path";
    let external = false;
    const candidates: ModuleCandidate[] = [];
    for (const context of contexts) {
      let base: string[];
      let rest: string[];
      if (prefix === "crate" || prefix === this.#configuration.crateName) {
        rule = "rust_crate_path";
        base = [];
        rest = parts.slice(1);
      } else if (prefix === "self") {
        rule = "rust_self_path";
        base = [...context.currentModule];
        rest = parts.slice(1);
      } else if (prefix === "super") {
        rule = "rust_super_path";
        base = [...context.currentModule];
        let index = 0;
        while (parts[index] === "super") {
          base.pop();
          index += 1;
        }
        rest = parts.slice(index);
      } else {
        base = [];
        rest = parts;
      }
      candidates.push(...this.#moduleCandidates(context, [...base, ...rest], rule));
    }
    const unique = new Map<string, ModuleCandidate>();
    for (const candidate of candidates) unique.set(candidate.path, candidate);
    const ordered = [...unique.values()].sort((left, right) => left.path.localeCompare(right.path));
    if (!["crate", "self", "super", this.#configuration.crateName].includes(prefix ?? null) && ordered.length === 0) {
      external = true;
      rule = "rust_external_crate";
    }
    return { candidates: ordered, rule, external };
  }

  #topLevelTargets(path: string, name: string): CodeResolutionTarget[] {
    const analysis = this.#analyses.get(path);
    if (!analysis) return [];
    const canonical = canonicalRustSegment(name.split("::").at(-1)!);
    return uniqueResolutionTargets(
      (this.#symbols.get(path)?.topLevelByName.get(canonical) ?? [])
        .map((symbol) => moduleTarget(analysis, symbol))
    );
  }

  #bindingLookup(sourcePath: string, moduleSpecifier: string, imported: string): {
    modules: ModuleCandidate[];
    targets: CodeResolutionTarget[];
    rule: string;
    external: boolean;
  } {
    if (imported === "self") {
      const module = this.#pathCandidates(sourcePath, moduleSpecifier);
      return {
        ...module,
        modules: module.candidates,
        targets: module.candidates.flatMap((candidate) => {
          const analysis = this.#analyses.get(candidate.path);
          return analysis ? [moduleTarget(analysis)] : [];
        }),
      };
    }
    const specifierParts = moduleSpecifier.split("::").filter(Boolean);
    const importedParts = imported.split("::").filter(Boolean);
    const ungrouped = importedParts.length === 1 &&
      canonicalRustSegment(specifierParts.at(-1) ?? "") === canonicalRustSegment(importedParts[0] ?? "");
    const modulePath = ungrouped
      ? specifierParts.slice(0, -1).join("::")
      : [...specifierParts, ...importedParts.slice(0, -1)].join("::");
    const symbolName = importedParts.at(-1)!;
    const module = this.#pathCandidates(sourcePath, modulePath);
    return {
      ...module,
      modules: module.candidates,
        targets: module.candidates.flatMap((candidate) => this.#topLevelTargets(candidate.path, symbolName)),
    };
  }

  #resolveReference(
    source: ResolutionAnalysis,
    reference: ResolutionReferenceFact
  ): CodeResolutionOutcome {
    let status: CodeResolutionOutcome["status"] = "unresolved";
    let rule = "rust_unsupported_reference";
    let reason: string | null = "unsupported_reference";
    let targets: CodeResolutionTarget[] = [];
    let candidates: CodeResolutionTarget[] = [];
    const via: [] = [];
    const diagnostics = this.#configuration.diagnostics;

    if (reference.moduleSpecifier !== null) {
      if (reference.nativeKind === "mod_item") {
        const contexts = this.#contexts(source.path);
        const moduleCandidates = new Map<string, ModuleCandidate>();
        for (const context of contexts) {
          for (const candidate of this.#moduleCandidates(
            context,
            [...context.currentModule, canonicalRustSegment(reference.moduleSpecifier)],
            "rust_mod_conventional"
          )) moduleCandidates.set(candidate.path, candidate);
        }
        const modules = [...moduleCandidates.values()].sort((left, right) => left.path.localeCompare(right.path));
        rule = "rust_mod_conventional";
        if (modules.length === 0) {
          reason = "module_not_found_or_generated";
        } else if (modules.length > 1) {
          status = "ambiguous";
          reason = "ambiguous_module";
          candidates = modules.flatMap((candidate) => {
            const analysis = this.#analyses.get(candidate.path);
            return analysis ? [moduleTarget(analysis)] : [];
          });
        } else {
          const analysis = this.#analyses.get(modules[0]!.path);
          if (analysis) {
            status = "resolved";
            reason = null;
            targets = [moduleTarget(analysis)];
          } else reason = "target_not_analyzed";
        }
      } else if (reference.bindings.some((binding) => binding.imported === "*")) {
        const module = this.#pathCandidates(source.path, reference.moduleSpecifier);
        rule = "rust_glob_import";
        reason = "glob_import";
        candidates = module.candidates.flatMap((candidate) => {
          const analysis = this.#analyses.get(candidate.path);
          return analysis ? [moduleTarget(analysis)] : [];
        });
      } else {
        const imported = reference.bindings
          .map((binding) => binding.imported)
          .filter((name): name is string => name !== null);
        const lookups = imported.map((name) => this.#bindingLookup(source.path, reference.moduleSpecifier!, name));
        rule = lookups[0]?.rule ?? "rust_unsupported_reference";
        const moduleCandidates = lookups.flatMap((lookup) => lookup.modules);
        const matches = lookups.map((lookup) => uniqueResolutionTargets(lookup.targets));
        if (lookups.length > 0 && lookups.every((lookup) => lookup.external)) {
          status = "external";
          rule = "rust_external_crate";
          reason = "external_crate";
        } else if (lookups.some((lookup) => lookup.modules.length > 1) || matches.some((entries) => entries.length > 1)) {
          status = "ambiguous";
          reason = "ambiguous_module_or_symbol";
          candidates = uniqueResolutionTargets([
            ...matches.flat(),
            ...moduleCandidates.flatMap((candidate) => {
              const analysis = this.#analyses.get(candidate.path);
              return analysis ? [moduleTarget(analysis)] : [];
            }),
          ]);
        } else if (lookups.length > 0 && matches.every((entries) => entries.length === 1)) {
          status = "resolved";
          reason = null;
          targets = uniqueResolutionTargets(matches.flat());
        } else {
          reason = moduleCandidates.length === 0 ? "module_not_found" : "export_not_found";
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

export function createRustModuleResolver(
  options: CreateRustModuleResolverOptions
): CodeModuleResolver {
  return new RustModuleResolver(options);
}
