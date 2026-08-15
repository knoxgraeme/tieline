import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import { posix, relative, resolve } from "node:path";
import { languageForPath } from "../contract/code-analysis/languages.js";
import {
  isSourceInventoryPathEligible,
  sourcePathIgnored,
} from "../contract/source-inventory.js";
import { compareCodeTopologyText } from "../domain/code-topology-ordering.js";

const DEFAULT_SOURCE_SCOPE_IGNORE = [
  ".git",
  ".tieline",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "vendor",
  ".next",
  "tmp",
] as const;

export interface SourceScopeCandidate {
  root: string;
  files: string[];
}

export interface SourceScopeDiscovery {
  sourceRoots: string[];
  candidates: SourceScopeCandidate[];
}

function normalizeRepositoryPath(path: string): string | undefined {
  const portable = path.normalize("NFC").replaceAll("\\", "/");
  if (portable.startsWith("/") || /^[A-Za-z]:\//.test(portable)) {
    return undefined;
  }
  const normalized = posix.normalize(portable).replace(/^\.\//, "");
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    return undefined;
  }
  return normalized;
}

function candidateFromFiles(root: string, files: string[]): SourceScopeCandidate {
  return { root, files };
}

/**
 * Infer source roots from repository-relative paths. Directory-backed code is
 * preferred over root-level files so config-like scripts cannot widen a
 * repository's scope to `.`. With no directory-backed code, `.` is the safe
 * fallback, including repositories that do not yet contain recognized code.
 */
export function sourceScopeFromPaths(
  paths: readonly string[],
  ignore: readonly string[] = []
): SourceScopeDiscovery {
  const files = [
    ...new Set(
      paths.flatMap((path) => {
        const normalized = normalizeRepositoryPath(path);
        if (
          !normalized ||
          sourcePathIgnored(normalized, ignore) ||
          languageForPath(normalized) === undefined
        ) {
          return [];
        }
        return [normalized];
      })
    ),
  ].sort(compareCodeTopologyText);

  const directoryFiles = new Map<string, string[]>();
  const rootFiles: string[] = [];
  for (const file of files) {
    const separator = file.indexOf("/");
    if (separator < 0) {
      rootFiles.push(file);
      continue;
    }
    const root = file.slice(0, separator);
    const grouped = directoryFiles.get(root) ?? [];
    grouped.push(file);
    directoryFiles.set(root, grouped);
  }

  const directoryRoots = [...directoryFiles.keys()].sort(
    compareCodeTopologyText
  );
  if (directoryRoots.length > 0) {
    const rootCandidate =
      rootFiles.length > 0 ? [candidateFromFiles(".", rootFiles)] : [];
    return {
      sourceRoots: directoryRoots,
      candidates: [
        ...rootCandidate,
        ...directoryRoots.map((root) =>
          candidateFromFiles(root, directoryFiles.get(root)!)
        ),
      ],
    };
  }
  return {
    sourceRoots: ["."],
    candidates:
      rootFiles.length > 0 ? [candidateFromFiles(".", rootFiles)] : [],
  };
}

/** Return only candidate files that the configured roots do not cover. */
export function sourceScopeAdvisoryCandidates(
  candidates: readonly SourceScopeCandidate[],
  configuredRoots: readonly string[]
): SourceScopeCandidate[] {
  const sourceRoots = [...configuredRoots];
  return candidates.flatMap((candidate) => {
    const files = candidate.files.filter(
      (path) =>
        !isSourceInventoryPathEligible(path, { sourceRoots })
    );
    return files.length > 0 ? [candidateFromFiles(candidate.root, files)] : [];
  });
}

export function sourceScopeAdvisoryRoots(
  candidates: readonly SourceScopeCandidate[],
  configuredRoots: readonly string[]
): string[] {
  return sourceScopeAdvisoryCandidates(candidates, configuredRoots).map(
    (candidate) => candidate.root
  );
}

function gitVisiblePaths(repositoryRoot: string): string[] | undefined {
  const listed = spawnSync(
    "git",
    [
      "-C",
      repositoryRoot,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ],
    {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    }
  );
  if (listed.status !== 0 || listed.error) return undefined;
  return listed.stdout.split("\0").filter((path) => {
    if (!path) return false;
    try {
      return lstatSync(resolve(repositoryRoot, path)).isFile();
    } catch {
      return false;
    }
  });
}

function filesystemPaths(
  repositoryRoot: string,
  ignore: readonly string[]
): string[] {
  const paths: string[] = [];
  const walk = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name);
      const path = relative(repositoryRoot, absolute).replaceAll("\\", "/");
      if (sourcePathIgnored(path, ignore) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile()) {
        paths.push(path);
      }
    }
  };
  walk(repositoryRoot);
  return paths;
}

export function effectiveSourceScopeIgnore(
  ignore?: readonly string[]
): string[] {
  return [...new Set(ignore ?? DEFAULT_SOURCE_SCOPE_IGNORE)];
}

/** Inspect the repository without mutating its configuration or worktree. */
export function discoverRepositorySourceScope(
  repositoryRoot: string,
  ignore?: readonly string[]
): SourceScopeDiscovery {
  const root = resolve(repositoryRoot);
  const effectiveIgnore = effectiveSourceScopeIgnore(ignore);
  const gitPaths = gitVisiblePaths(root);
  return sourceScopeFromPaths(
    gitPaths ?? filesystemPaths(root, effectiveIgnore),
    gitPaths === undefined ? [] : effectiveIgnore
  );
}

export function inspectRepositorySourceScope(
  repositoryRoot: string,
  configuredRoots: readonly string[],
  ignore?: readonly string[]
): string[] {
  const discovery = discoverRepositorySourceScope(repositoryRoot, ignore);
  return sourceScopeAdvisoryRoots(discovery.candidates, configuredRoots);
}
