import { createArtifactHashResolver } from "./manifest.js";
import type { ArtifactHashResolver, ContractManifest } from "./manifest.js";
import {
  createSourceInventory,
  isSourceInventoryPathEligible,
  normalizeInventoryPath,
  type SourceFileEligibility,
} from "./source-inventory.js";

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

export type { SourceFileEligibility } from "./source-inventory.js";

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
  return isSourceInventoryPathEligible(path, options);
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
    const normalized = normalizeInventoryPath(path);
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
  const inventory = createSourceInventory({
    repositoryRoot: options.repositoryRoot,
    sourceRoots: options.sourceRoots,
    ...(options.ignore === undefined ? {} : { ignore: options.ignore }),
  });
  const sorted = inventory.files.map((file) => file.path);
  const mapped = mappedPaths(manifest);
  const mappedFiles = sorted.filter((path) => mapped.has(path));
  const unmappedFiles = sorted.filter((path) => !mapped.has(path));

  const hashes = resolveHashes(options.hashes, options.repositoryRoot);
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
    source_roots: [...inventory.sourceRoots],
    eligible_files: sorted.length,
    mapped_files: mappedFiles.length,
    unmapped_files: unmappedFiles,
    excluded_files: inventory.excludedPaths.length,
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
