import type { ContractTarget } from "./schema.js";
import {
  createArtifactHashResolver,
  type ArtifactHashResolver,
} from "./manifest.js";
import {
  resolveSelector,
  type ResolveSelectorOptions,
  type SelectorNotCheckedReason,
  type SelectorResolution,
  type SelectorVocabulary,
} from "./selector.js";
import { selectorVocabularyForRepository } from "./validate.js";

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
export interface ArtifactAssurance {
  freshness: ArtifactFreshness;
  broken_cause: BrokenLinkCause | null;
  locator_resolution: ArtifactLocatorResolution;
  locator_reason: ArtifactLocatorNotCheckedReason | null;
  semantic_support: "not_assessed";
}

export interface ArtifactAssuranceInput {
  target: ArtifactTarget;
  reviewed_content_hash: string | null;
}

export interface ArtifactAssuranceInspector {
  inspect(input: ArtifactAssuranceInput): ArtifactAssurance;
}

export interface CreateArtifactAssuranceInspectorOptions {
  repositoryRoot: string;
  repositoryKey: string;
  maxSourceBytes?: number;
  /** Narrow injection seams keep request-cache behavior directly testable. */
  hashResolver?: ArtifactHashResolver;
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
  const hashes =
    options.hashResolver ?? createArtifactHashResolver(options.repositoryRoot);
  const vocabulary =
    options.selectorVocabulary ??
    selectorVocabularyForRepository(options.repositoryRoot);
  const selectorResolver = options.selectorResolver ?? resolveSelector;
  const measurements = new Map<
    string,
    ReturnType<ArtifactHashResolver["measure"]>
  >();
  const locators = new Map<
    string,
    Pick<ArtifactAssurance, "locator_resolution" | "locator_reason">
  >();
  const assurances = new Map<string, ArtifactAssurance>();

  const measure = (path: string) => {
    const cached = measurements.get(path);
    if (cached) return cached;
    const measured = hashes.measure(path);
    measurements.set(path, measured);
    return measured;
  };

  const inspectLocator = (
    target: ArtifactTarget,
    brokenCause: BrokenLinkCause | null
  ): Pick<ArtifactAssurance, "locator_resolution" | "locator_reason"> => {
    if (target.repository !== options.repositoryKey) {
      return unavailableLocator("cross_repository");
    }
    if (!target.selector) {
      return { locator_resolution: "not_applicable", locator_reason: null };
    }
    if (brokenCause === "missing") return unavailableLocator("file_missing");
    if (brokenCause === "not_file") return unavailableLocator("not_a_file");
    if (brokenCause === "outside_repository") {
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
        vocabulary,
        ...(options.maxSourceBytes === undefined
          ? {}
          : { maxSourceBytes: options.maxSourceBytes }),
      })
    );
    locators.set(key, locator);
    return locator;
  };

  return {
    inspect(input) {
      const key = inputKey(input);
      const cached = assurances.get(key);
      if (cached) return cached;

      let freshness: ArtifactFreshness;
      let brokenCause: BrokenLinkCause | null = null;
      if (input.target.repository !== options.repositoryKey) {
        freshness = "unknown";
      } else {
        const measured = measure(input.target.path);
        if (measured.status !== "hashed") {
          freshness = "broken";
          brokenCause = measured.status;
        } else {
          freshness =
            input.reviewed_content_hash !== null &&
            measured.hash === input.reviewed_content_hash
              ? "current"
              : "stale";
        }
      }

      const assurance: ArtifactAssurance = {
        freshness,
        broken_cause: brokenCause,
        ...inspectLocator(input.target, brokenCause),
        semantic_support: "not_assessed",
      };
      assurances.set(key, assurance);
      return assurance;
    },
  };
}
