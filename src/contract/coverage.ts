import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createArtifactHashResolver } from "./manifest.js";
import type { ArtifactHashResolver, ContractManifest } from "./manifest.js";

/**
 * How much is known about a mapped file, beyond the fact that someone linked it.
 *
 * The tiers are ordered and a path is reported at the highest one it reaches.
 * None of them is a claim that the acceptance criterion holds:
 *
 * - `asserted` — a link names the path. A human said so; nothing was measured.
 *   This is the floor and the only tier reachable without tiering inputs.
 * - `hash_current` — the content a reviewer accepted is still the content on
 *   disk. It says the file has not drifted since review, not that the review
 *   was right.
 * - `execution_corroborated` — a supplied execution-corroboration report shows
 *   the path was entered by the tests linked to an acceptance criterion that
 *   links it. Execution is a strong falsifier and a weak confirmer: entering a
 *   file is not satisfying a criterion.
 */
export type MappingConfidenceTier =
  | "asserted"
  | "hash_current"
  | "execution_corroborated";

export const MAPPING_CONFIDENCE_TIERS: readonly MappingConfidenceTier[] = [
  "asserted",
  "hash_current",
  "execution_corroborated",
];

export interface MappingConfidenceTiers {
  /** False when no hash resolver was reachable, so `hash_current` was unreachable. */
  hash_comparison_available: boolean;
  /** False when no corroboration input was supplied, so `execution_corroborated` was unreachable. */
  execution_corroboration_available: boolean;
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

/**
 * Structural subset of `ExecutionCorroborationReport`. Declared here rather than
 * imported so this module never pulls in coverage-report parsing: computing
 * mapping coverage must not depend on a test run having happened.
 */
export interface ExecutionCorroborationReportLike {
  findings: ReadonlyArray<{
    acceptance_criterion_stable_id: string;
    path: string | null;
    kind: string;
    relation: string;
  }>;
}

/**
 * Either an already-computed corroboration report, or a lookup answering "was
 * this path executed by the tests linked to a criterion that links it?".
 *
 * Both are injected. This module reads no coverage files.
 */
export type MappingExecutionCorroborationInput =
  | ExecutionCorroborationReportLike
  | ((path: string) => boolean);

export interface RepositoryMappingCoverageOptions {
  repositoryRoot: string;
  sourceRoots: string[];
  ignore?: string[];
  /**
   * Resolver backing the `hash_current` tier. Defaults to one measured over
   * `repositoryRoot`; pass `null` to disable hash comparison, in which case no
   * mapped file can rise above `asserted` on hashes alone.
   */
  hashes?: ArtifactHashResolver | null;
  /**
   * Optional input backing the `execution_corroborated` tier. Omitted, no
   * mapped file reaches that tier.
   */
  executionCorroboration?: MappingExecutionCorroborationInput;
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

interface MappedPathLinkage {
  /** Reviewed content hashes recorded for this path, across every link naming it. */
  reviewed_hashes: Set<string>;
  /**
   * Stable ids of acceptance criteria that link this path directly with
   * `implements` or `enforces`. Story-level links are excluded on purpose: they
   * are a claim about the story, not about any one criterion, so no
   * per-criterion execution statement can be made about them.
   */
  criteria: Set<string>;
}

function mappedPaths(manifest: ContractManifest): Map<string, MappedPathLinkage> {
  const paths = new Map<string, MappedPathLinkage>();
  const record = (
    path: string,
    reviewedHash: string | null,
    criterionStableId: string | null
  ): void => {
    const normalized = normalizePath(path);
    const linkage = paths.get(normalized) ?? {
      reviewed_hashes: new Set<string>(),
      criteria: new Set<string>(),
    };
    if (reviewedHash) linkage.reviewed_hashes.add(reviewedHash);
    if (criterionStableId) linkage.criteria.add(criterionStableId);
    paths.set(normalized, linkage);
  };
  for (const capability of manifest.capabilities) {
    for (const story of capability.stories) {
      const scoped = [
        ...story.links.map((link) => ({ link, criterion: null })),
        ...story.acceptance_criteria.flatMap((criterion) =>
          criterion.links.map((link) => ({ link, criterion }))
        ),
      ];
      for (const { link, criterion } of scoped) {
        if (
          link.target.kind === "help" ||
          link.target.repository !== manifest.repository.key
        ) {
          continue;
        }
        const claimsCode =
          link.relation === "implements" || link.relation === "enforces";
        record(
          link.target.path,
          link.reviewed_content_hash,
          criterion && claimsCode ? criterion.stable_id : null
        );
      }
    }
  }
  return paths;
}

/** Reviewed content hashes recorded per path, from whichever manifest carries them. */
function reviewedHashes(manifest: ContractManifest): Map<string, Set<string>> {
  const hashes = new Map<string, Set<string>>();
  for (const [path, linkage] of mappedPaths(manifest)) {
    hashes.set(path, linkage.reviewed_hashes);
  }
  return hashes;
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

/**
 * Turns a corroboration report into "did the linked tests of this criterion
 * execute this path?".
 *
 * The report only records what execution failed to support, so corroboration is
 * read as the absence of a contrary finding for a criterion whose own linked
 * tests ran. A criterion carrying an `uncovered_by_linked_tests` finding could
 * not be looked at all, so nothing about its paths is corroborated.
 *
 * The report must have been computed from the manifest being measured. A report
 * from a different manifest mentions different criteria, and silence about a
 * criterion would then be read as corroboration of it.
 */
function executionPredicate(
  input: MappingExecutionCorroborationInput
): (path: string, criteria: Set<string>) => boolean {
  if (typeof input === "function") {
    return (path, criteria) => criteria.size > 0 && input(path) === true;
  }
  const blindCriteria = new Set<string>();
  const unsupported = new Set<string>();
  for (const finding of input.findings) {
    if (finding.kind === "uncovered_by_linked_tests") {
      blindCriteria.add(finding.acceptance_criterion_stable_id);
      continue;
    }
    if (finding.kind === "unsupported_implementation" && finding.path) {
      unsupported.add(
        `${finding.acceptance_criterion_stable_id}\0${normalizePath(finding.path)}`
      );
    }
  }
  return (path, criteria) =>
    [...criteria].some(
      (criterion) =>
        !blindCriteria.has(criterion) &&
        !unsupported.has(`${criterion}\0${path}`)
    );
}

/** The highest tier a mapped path qualifies for. */
function tierFor(input: {
  path: string;
  linkage: MappedPathLinkage;
  reviewed: Set<string> | undefined;
  hashes: ArtifactHashResolver | null;
  executed: ((path: string, criteria: Set<string>) => boolean) | null;
}): MappingConfidenceTier {
  if (input.executed && input.executed(input.path, input.linkage.criteria)) {
    return "execution_corroborated";
  }
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
    execution_corroborated: value(),
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
  const mapped = mappedPaths(manifest);
  const mappedFiles = sorted.filter((path) => mapped.has(path));
  const unmappedFiles = sorted.filter((path) => !mapped.has(path));

  const hashes = resolveHashes(options.hashes, root);
  const executed = options.executionCorroboration
    ? executionPredicate(options.executionCorroboration)
    : null;
  const share = (count: number): number | null =>
    sorted.length === 0
      ? null
      : Math.round((count / sorted.length) * 10_000) / 100;
  const reviewed = options.reviewedManifest
    ? reviewedHashes(options.reviewedManifest)
    : null;
  const paths = emptyTierRecord<string[]>(() => []);
  for (const path of mappedFiles) {
    const linkage = mapped.get(path)!;
    paths[
      tierFor({
        path,
        linkage,
        reviewed: reviewed ? reviewed.get(path) : linkage.reviewed_hashes,
        hashes,
        executed,
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
      execution_corroboration_available: executed !== null,
      counts,
      percentages: {
        asserted: share(counts.asserted),
        hash_current: share(counts.hash_current),
        execution_corroborated: share(counts.execution_corroborated),
      },
      paths,
    },
  };
}
