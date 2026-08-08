import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { createArtifactHashResolver } from "./manifest.js";
import type { ArtifactHashResolver, ContractManifest } from "./manifest.js";
import { wildcardPattern, withinRepository } from "./paths.js";

/**
 * How much is known about a mapped file, beyond the fact that someone linked it.
 *
 * The tiers are ordered and a path is reported at the highest one it reaches.
 * None of them is a claim that the acceptance criterion holds:
 *
 * - `asserted` — a link names the path. A human said so; nothing was measured.
 *   This is the floor and the only tier reachable without hash comparison.
 * - `hash_current` — the content a reviewer accepted is still the content on
 *   disk. It says the file has not drifted since review, not that the review
 *   was right.
 */
export type MappingConfidenceTier = "asserted" | "hash_current";

export const MAPPING_CONFIDENCE_TIERS: readonly MappingConfidenceTier[] = [
  "asserted",
  "hash_current",
];

export interface MappingConfidenceTiers {
  /** False when no hash resolver was reachable, so `hash_current` was unreachable. */
  hash_comparison_available: boolean;
  /** Mapped files at each tier. Sums to `mapped_files`. */
  counts: Record<MappingConfidenceTier, number>;
  /**
   * Each tier's share of `eligible_files`, on the same denominator and rounding
   * as `percentage`, so the tiers sum to `percentage`. `null` when nothing is
   * eligible.
   */
  percentages: Record<MappingConfidenceTier, number | null>;
  /** The mapped paths at each tier, sorted. */
  paths: Record<MappingConfidenceTier, string[]>;
}

export interface RepositoryMappingCoverage {
  status: "measured" | "no_eligible_files";
  source_roots: string[];
  eligible_files: number;
  mapped_files: number;
  unmapped_files: string[];
  excluded_files: number;
  percentage: number | null;
  /**
   * Additive breakdown of `mapped_files`. Every field above keeps its original
   * meaning: a file is mapped when a link names it, whatever tier it lands in.
   */
  confidence: MappingConfidenceTiers;
}

export interface RepositoryMappingCoverageOptions {
  repositoryRoot: string;
  sourceRoots: string[];
  ignore?: string[];
  /**
   * Resolver backing the `hash_current` tier. Defaults to one measured over
   * `repositoryRoot`; pass `null` to disable hash comparison, in which case
   * every mapped file stays at `asserted`.
   */
  hashes?: ArtifactHashResolver | null;
  /**
   * Manifest supplying the `reviewed_content_hash` values compared for the
   * `hash_current` tier. Defaults to the manifest being measured.
   *
   * Pass the manifest a reviewer accepted when the measured manifest was
   * compiled from the working tree: a freshly compiled manifest records the
   * content it just measured, so comparing it against itself always matches and
   * says nothing about drift.
   */
  reviewedManifest?: ContractManifest;
}

function normalizePath(path: string): string {
  return path.split(sep).join("/");
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

export interface SourceFileEligibility {
  /** Configured `repository.source_roots`, relative to the repository root. */
  sourceRoots: string[];
  /** Configured `repository.ignore` patterns. */
  ignore?: string[];
}

function withinSourceRoot(path: string, sourceRoot: string): boolean {
  const root = normalizePath(sourceRoot.trim())
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  if (root === "" || root === ".") return true;
  return path === root || path.startsWith(`${root}/`);
}

/**
 * Whether a repository-relative path is one this module would count as
 * eligible: inside a configured source root and matching no ignore pattern.
 *
 * This is the same admission test `computeRepositoryMappingCoverage` applies
 * while walking, decided from the path alone. Callers holding a diff can ask
 * about a path without walking the tree, and without the path still existing on
 * disk — which is what makes it usable for deleted and renamed-away paths.
 */
export function isEligibleSourcePath(
  path: string,
  options: SourceFileEligibility
): boolean {
  const normalized = normalizePath(path)
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  if (!normalized) return false;
  if (!options.sourceRoots.some((root) => withinSourceRoot(normalized, root))) {
    return false;
  }
  return !ignored(normalized, options.ignore ?? []);
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
  if (!withinRepository(repositoryRoot, realPath)) {
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

/**
 * Every repository path a contract link names, mapped to the reviewed content
 * hashes recorded for it across those links.
 *
 * Story-level and criterion-level links are treated alike: a link names a path
 * whatever its scope, so both make the path mapped and both can carry a
 * reviewed hash that lifts it to `hash_current`.
 */
function mappedPaths(manifest: ContractManifest): Map<string, Set<string>> {
  const paths = new Map<string, Set<string>>();
  const record = (path: string, reviewedHash: string | null): void => {
    const normalized = normalizePath(path);
    const hashes = paths.get(normalized) ?? new Set<string>();
    if (reviewedHash) hashes.add(reviewedHash);
    paths.set(normalized, hashes);
  };
  for (const capability of manifest.capabilities) {
    for (const story of capability.stories) {
      const links = [
        ...story.links,
        ...story.acceptance_criteria.flatMap((criterion) => criterion.links),
      ];
      for (const link of links) {
        if (
          link.target.kind === "help" ||
          link.target.repository !== manifest.repository.key
        ) {
          continue;
        }
        record(link.target.path, link.reviewed_content_hash);
      }
    }
  }
  return paths;
}

/** Resolves the resolver for the `hash_current` tier, or `null` when unreachable. */
function resolveHashes(
  option: ArtifactHashResolver | null | undefined,
  repositoryRoot: string
): ArtifactHashResolver | null {
  if (option !== undefined) return option;
  try {
    return createArtifactHashResolver(repositoryRoot);
  } catch {
    // An unreachable resolver is not a failure: every mapped file simply stays
    // at `asserted`, which is exactly what is known without measurement.
    return null;
  }
}

/** The highest tier a mapped path qualifies for. */
function tierFor(input: {
  path: string;
  reviewed: Set<string> | undefined;
  hashes: ArtifactHashResolver | null;
}): MappingConfidenceTier {
  if (input.hashes && input.reviewed && input.reviewed.size > 0) {
    const measured = input.hashes.measure(input.path);
    if (measured.status === "hashed" && input.reviewed.has(measured.hash)) {
      return "hash_current";
    }
  }
  return "asserted";
}

function emptyTierRecord<Value>(value: () => Value): Record<
  MappingConfidenceTier,
  Value
> {
  return {
    asserted: value(),
    hash_current: value(),
  };
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
    if (!withinRepository(root, realSourceRoot)) {
      throw new Error(
        `Configured source root '${configuredRoot}' resolves outside the repository.`
      );
    }
    for (const file of walkFiles(realSourceRoot, root, patterns, excluded)) {
      allFiles.add(normalizePath(relative(root, file)));
    }
  }

  const sorted = [...allFiles].sort();
  const mapped = mappedPaths(manifest);
  const mappedFiles = sorted.filter((path) => mapped.has(path));
  const unmappedFiles = sorted.filter((path) => !mapped.has(path));

  const hashes = resolveHashes(options.hashes, root);
  const share = (count: number): number | null =>
    sorted.length === 0
      ? null
      : Math.round((count / sorted.length) * 10_000) / 100;
  const reviewed = options.reviewedManifest
    ? mappedPaths(options.reviewedManifest)
    : null;
  const paths = emptyTierRecord<string[]>(() => []);
  for (const path of mappedFiles) {
    paths[
      tierFor({
        path,
        reviewed: reviewed ? reviewed.get(path) : mapped.get(path),
        hashes,
      })
    ].push(path);
  }
  const counts = emptyTierRecord<number>(() => 0);
  for (const tier of MAPPING_CONFIDENCE_TIERS) counts[tier] = paths[tier].length;

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
    confidence: {
      hash_comparison_available: hashes !== null,
      counts,
      percentages: {
        asserted: share(counts.asserted),
        hash_current: share(counts.hash_current),
      },
      paths,
    },
  };
}
