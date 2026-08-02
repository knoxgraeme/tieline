import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  buildGoverningCriteriaIndex,
  normalizeRepositoryPath as normalizePath,
} from "./governs.js";
import type { ContractManifest } from "./manifest.js";

export interface RepositoryMappingCoverage {
  status: "measured" | "no_eligible_files";
  source_roots: string[];
  eligible_files: number;
  mapped_files: number;
  unmapped_files: string[];
  excluded_files: number;
  percentage: number | null;
}

export interface RepositoryMappingCoverageOptions {
  repositoryRoot: string;
  sourceRoots: string[];
  ignore?: string[];
}

function wildcardPattern(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\0/g, ".*");
  return new RegExp(`^${escaped}(?:/.*)?$`);
}

function ignored(path: string, patterns: string[]): boolean {
  const normalized = normalizePath(path).replace(/^\.\//, "");
  return patterns.some((entry) => {
    const pattern = normalizePath(entry.trim())
      .replace(/^\.\//, "")
      .replace(/\/$/, "");
    return pattern.length > 0 && wildcardPattern(pattern).test(normalized);
  });
}

function withinRoot(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function walkFiles(
  path: string,
  repositoryRoot: string,
  patterns: string[],
  excluded: Set<string>,
  visitedDirectories = new Set<string>()
): string[] {
  const repositoryPath = normalizePath(relative(repositoryRoot, path));
  if (repositoryPath && ignored(repositoryPath, patterns)) {
    excluded.add(repositoryPath);
    return [];
  }
  const realPath = realpathSync(path);
  if (!withinRoot(repositoryRoot, realPath)) {
    throw new Error(`Path '${path}' resolves outside the repository.`);
  }
  const stat = statSync(realPath);
  if (stat.isFile()) return [realPath];
  if (!stat.isDirectory()) return [];
  if (visitedDirectories.has(realPath)) return [];
  visitedDirectories.add(realPath);
  return readdirSync(realPath, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) =>
      walkFiles(
        resolve(realPath, entry.name),
        repositoryRoot,
        patterns,
        excluded,
        visitedDirectories
      )
    );
}

export function computeRepositoryMappingCoverage(
  manifest: ContractManifest,
  options: RepositoryMappingCoverageOptions
): RepositoryMappingCoverage {
  const root = realpathSync(resolve(options.repositoryRoot));
  const patterns = options.ignore ?? [];
  const allFiles = new Set<string>();
  const excluded = new Set<string>();

  for (const configuredRoot of options.sourceRoots) {
    const sourceRoot = resolve(root, configuredRoot);
    if (!existsSync(sourceRoot)) {
      throw new Error(`Configured source root '${configuredRoot}' does not exist.`);
    }
    const realSourceRoot = realpathSync(sourceRoot);
    if (!withinRoot(root, realSourceRoot)) {
      throw new Error(
        `Configured source root '${configuredRoot}' resolves outside the repository.`
      );
    }
    for (const file of walkFiles(realSourceRoot, root, patterns, excluded)) {
      allFiles.add(normalizePath(relative(root, file)));
    }
  }

  const sorted = [...allFiles].sort();
  // The governing-criteria index is keyed by the same normalized repository
  // paths `mappedPaths` used to collect, so coverage reads `.has()` off the
  // richer structure instead of repeating the traversal.
  const mapped = buildGoverningCriteriaIndex(manifest);
  const mappedFiles = sorted.filter((path) => mapped.has(path));
  const unmappedFiles = sorted.filter((path) => !mapped.has(path));

  return {
    status: sorted.length === 0 ? "no_eligible_files" : "measured",
    source_roots: options.sourceRoots.map(normalizePath),
    eligible_files: sorted.length,
    mapped_files: mappedFiles.length,
    unmapped_files: unmappedFiles,
    excluded_files: excluded.size,
    percentage:
      sorted.length === 0
        ? null
        : Math.round((mappedFiles.length / sorted.length) * 10_000) / 100,
  };
}
