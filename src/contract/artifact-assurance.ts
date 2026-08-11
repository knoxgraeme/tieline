import { relative } from "node:path";
import type { ContractTarget } from "./schema.js";
import {
  createArtifactHashResolver,
  type ArtifactHashResolver,
} from "./manifest.js";
import {
  createCachedSelectorResolver,
  type ResolveSelectorOptions,
  type SelectorNotCheckedReason,
  type SelectorResolution,
  type SelectorVocabulary,
} from "./selector.js";
import { selectorVocabularyForRepository } from "./validate.js";
import {
  createFilesystemSourceSnapshotReader,
  type SourceSnapshotReader,
} from "./source-snapshot.js";

export type ArtifactTarget = Exclude<ContractTarget, { kind: "help" }>;

/** Structural target failures already used by impact reporting. */
export type BrokenLinkCause =
  | "missing"
  | "not_file"
  | "outside_repository";

export type ArtifactFreshness =
  | "current"
  | "stale"
  | "unknown"
  | "broken";

export type ArtifactFreshnessReason = "cross_repository" | "unreadable";

export interface ArtifactFreshnessInspection {
  freshness: ArtifactFreshness;
  freshness_reason: ArtifactFreshnessReason | null;
  broken_cause: BrokenLinkCause | null;
}

export type ArtifactLocatorResolution =
  | "resolved"
  | "unresolved"
  | "not_checked"
  | "not_applicable";

export type ArtifactLocatorNotCheckedReason =
  | SelectorNotCheckedReason
  | "cross_repository"
  | "outside_repository";

/**
 * Derived structural state only. Authored provenance and link scope stay on the
 * claim beside this value; semantic evidence is deliberately never inferred.
 */
export interface ArtifactAssurance extends ArtifactFreshnessInspection {
  locator_resolution: ArtifactLocatorResolution;
  locator_reason: ArtifactLocatorNotCheckedReason | null;
  semantic_support: "not_assessed";
}

export interface ArtifactAssuranceInput {
  target: ArtifactTarget;
  reviewed_content_hash: string | null;
}

export interface ArtifactAssuranceInspector {
  inspectFreshness(input: ArtifactAssuranceInput): ArtifactFreshnessInspection;
  inspect(input: ArtifactAssuranceInput): ArtifactAssurance;
}

export interface CreateArtifactAssuranceInspectorOptions {
  repositoryRoot: string;
  repositoryKey: string;
  maxSourceBytes?: number;
  /** Narrow injection seams keep request-cache behavior directly testable. */
  hashResolver?: ArtifactHashResolver;
  sourceSnapshotReader?: SourceSnapshotReader;
  selectorVocabulary?: SelectorVocabulary;
  selectorResolver?: (options: ResolveSelectorOptions) => SelectorResolution;
}

function inputKey(input: ArtifactAssuranceInput): string {
  return [
    input.target.repository,
    input.target.kind,
    input.target.path,
    input.target.selector ?? "",
    input.target.kind === "test" ? (input.target.framework_hint ?? "") : "",
    input.reviewed_content_hash ?? "",
  ].join("\0");
}

function locatorKey(target: ArtifactTarget): string {
  return [target.repository, target.path, target.selector ?? ""].join("\0");
}

function freshnessKey(input: ArtifactAssuranceInput): string {
  return [
    input.target.repository,
    input.target.path,
    input.reviewed_content_hash ?? "",
  ].join("\0");
}

function isFilesystemError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    typeof (error as NodeJS.ErrnoException).code === "string"
  );
}

function unavailableLocator(
  reason: ArtifactLocatorNotCheckedReason
): Pick<ArtifactAssurance, "locator_resolution" | "locator_reason"> {
  return { locator_resolution: "not_checked", locator_reason: reason };
}

function locatorFromResolution(
  resolution: SelectorResolution
): Pick<ArtifactAssurance, "locator_resolution" | "locator_reason"> {
  return {
    locator_resolution: resolution.status,
    locator_reason: resolution.reason,
  };
}

/**
 * Creates the structural inspector for one context/impact request.
 *
 * Measurements are cached per path and selector results per full locator. This
 * is intentionally request-local: current checkout state is derived evidence,
 * never manifest state and never a persisted semantic grade.
 */
export function createArtifactAssuranceInspector(
  options: CreateArtifactAssuranceInspectorOptions
): ArtifactAssuranceInspector {
  let sourceSnapshots: SourceSnapshotReader | undefined =
    options.sourceSnapshotReader;
  const snapshots = () =>
    (sourceSnapshots ??= createFilesystemSourceSnapshotReader({
      repositoryRoot: options.repositoryRoot,
      maxSourceBytes: Number.MAX_SAFE_INTEGER,
    }));
  let hashes = options.hashResolver;
  let vocabulary = options.selectorVocabulary;
  const selectorResolver =
    options.selectorResolver ??
    createCachedSelectorResolver({
      readSource(absolutePath, maxSourceBytes) {
        const source = snapshots().read(
          relative(options.repositoryRoot, absolutePath)
        );
        if (source.status === "read") {
          return source.snapshot.metadata.size > maxSourceBytes
            ? { status: "skipped", reason: "file_too_large" }
            : { status: "read", content: source.snapshot.text };
        }
        const reason: SelectorNotCheckedReason =
          source.status === "missing"
            ? "file_missing"
            : source.status === "not_file"
              ? "not_a_file"
              : source.status === "binary"
                ? "binary_content"
                : source.status === "oversized"
                  ? "file_too_large"
                  : source.status === "repository_escape"
                    ? "unreadable"
                    : "unreadable";
        return { status: "skipped", reason };
      },
    });
  type Measurement =
    | ReturnType<ArtifactHashResolver["measure"]>
    | { status: "unreadable" };
  const measurements = new Map<
    string,
    Measurement
  >();
  const locators = new Map<
    string,
    Pick<ArtifactAssurance, "locator_resolution" | "locator_reason">
  >();
  const freshnessInspections = new Map<
    string,
    ArtifactFreshnessInspection
  >();
  const assurances = new Map<string, ArtifactAssurance>();

  const measure = (path: string) => {
    const cached = measurements.get(path);
    if (cached) return cached;
    let measured: Measurement;
    try {
      hashes ??= createArtifactHashResolver(options.repositoryRoot, {
        snapshotReader: snapshots(),
      });
      measured = hashes.measure(path);
    } catch (error) {
      if (!isFilesystemError(error)) throw error;
      measured = { status: "unreadable" };
    }
    measurements.set(path, measured);
    return measured;
  };

  const inspectLocator = (
    target: ArtifactTarget,
    freshness: ArtifactFreshnessInspection
  ): Pick<ArtifactAssurance, "locator_resolution" | "locator_reason"> => {
    if (target.repository !== options.repositoryKey) {
      return unavailableLocator("cross_repository");
    }
    if (!target.selector) {
      return { locator_resolution: "not_applicable", locator_reason: null };
    }
    if (freshness.freshness_reason === "unreadable") {
      return unavailableLocator("unreadable");
    }
    if (freshness.broken_cause === "missing") {
      return unavailableLocator("file_missing");
    }
    if (freshness.broken_cause === "not_file") {
      return unavailableLocator("not_a_file");
    }
    if (freshness.broken_cause === "outside_repository") {
      return unavailableLocator("outside_repository");
    }

    const key = locatorKey(target);
    const cached = locators.get(key);
    if (cached) return cached;
    const locator = locatorFromResolution(
      selectorResolver({
        repositoryRoot: options.repositoryRoot,
        path: target.path,
        selector: target.selector,
        vocabulary:
          vocabulary ??=
            selectorVocabularyForRepository(options.repositoryRoot),
        ...(options.maxSourceBytes === undefined
          ? {}
          : { maxSourceBytes: options.maxSourceBytes }),
      })
    );
    locators.set(key, locator);
    return locator;
  };

  const inspectFreshness = (
    input: ArtifactAssuranceInput
  ): ArtifactFreshnessInspection => {
    const key = freshnessKey(input);
    const cached = freshnessInspections.get(key);
    if (cached) return cached;

    let inspection: ArtifactFreshnessInspection;
    if (input.target.repository !== options.repositoryKey) {
      inspection = {
        freshness: "unknown",
        freshness_reason: "cross_repository",
        broken_cause: null,
      };
    } else {
      const measured = measure(input.target.path);
      if (measured.status === "unreadable") {
        inspection = {
          freshness: "unknown",
          freshness_reason: "unreadable",
          broken_cause: null,
        };
      } else if (measured.status !== "hashed") {
        inspection = {
          freshness: "broken",
          freshness_reason: null,
          broken_cause: measured.status,
        };
      } else {
        inspection = {
          freshness:
            input.reviewed_content_hash !== null &&
            measured.hash === input.reviewed_content_hash
              ? "current"
              : "stale",
          freshness_reason: null,
          broken_cause: null,
        };
      }
    }
    freshnessInspections.set(key, inspection);
    return inspection;
  };

  return {
    inspectFreshness,
    inspect(input) {
      const key = inputKey(input);
      const cached = assurances.get(key);
      if (cached) return cached;

      const freshness = inspectFreshness(input);

      const assurance: ArtifactAssurance = {
        ...freshness,
        ...inspectLocator(input.target, freshness),
        semantic_support: "not_assessed",
      };
      assurances.set(key, assurance);
      return assurance;
    },
  };
}
