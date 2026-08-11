import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { ContractTarget } from "./schema.js";
import {
  createArtifactHashResolver,
  type ArtifactHashResolver,
} from "./manifest.js";
import type {
  ResolveSelectorOptions,
  SelectorNotCheckedReason,
  SelectorResolution,
  SelectorVocabulary,
} from "./selector.js";
import { selectorVocabularyForRepository } from "./validate.js";
import {
  createFilesystemSourceSnapshotReader,
  sourceFileMetadataFromStat,
  type SourceFileMetadata,
  type SourceRange,
  type SourceSnapshot,
  type SourceSnapshotFailureStatus,
  type SourceSnapshotReader,
} from "./source-snapshot.js";
import {
  createStructuralSelectorResolver,
  localizedDiagnostics,
  type StructuralSelectorResolver,
} from "./code-analysis/selector-resolution.js";
import type {
  CodeAnalysisCompatibility,
  CodeSymbolFact,
  ParserDiagnostic,
} from "./code-analysis/types.js";
import type { SupportedCodeLanguage } from "./code-analysis/languages.js";

export type ArtifactTarget = Exclude<ContractTarget, { kind: "help" }>;

export const DEFAULT_SOURCE_EVIDENCE_MAX_BYTES = 8 * 1024;
export const DEFAULT_SOURCE_EVIDENCE_MAX_LINES = 40;

export type BrokenLinkCause = "missing" | "not_file" | "outside_repository";
export type ArtifactFreshness = "current" | "stale" | "unknown" | "broken";
export type ArtifactFreshnessReason = "cross_repository" | "unreadable";

export interface ArtifactFreshnessInspection {
  freshness: ArtifactFreshness;
  freshness_reason: ArtifactFreshnessReason | null;
  broken_cause: BrokenLinkCause | null;
}

export type ArtifactLocatorResolution =
  | "resolved"
  | "ambiguous"
  | "unresolved"
  | "not_checked"
  | "not_applicable";

export type ArtifactLocatorNotCheckedReason =
  | SelectorNotCheckedReason
  | "cross_repository"
  | "outside_repository";

export interface ArtifactLocatorMatch {
  identity: string;
  selector: string;
  native_kind: string;
  name_range: SourceRange | null;
  range: SourceRange;
}

export interface StructuralSourceSnippet {
  text: string;
  range: SourceRange;
  truncated: boolean;
}

/** Ephemeral evidence from one immutable, hash-current source snapshot. */
export interface StructuralSourceEvidence {
  language: SupportedCodeLanguage;
  canonical_selector: string;
  symbol_identity: string;
  native_kind: string;
  syntax_status: CodeSymbolFact["syntaxStatus"];
  name_range: SourceRange | null;
  range: SourceRange;
  snippet: StructuralSourceSnippet;
  analyzed_content_hash: string;
  compatibility: CodeAnalysisCompatibility;
  diagnostics: readonly ParserDiagnostic[];
}

/** Derived structure only; this never claims implementation satisfies an AC. */
export interface ArtifactAssurance extends ArtifactFreshnessInspection {
  locator_resolution: ArtifactLocatorResolution;
  locator_reason: ArtifactLocatorNotCheckedReason | null;
  locator_matches: readonly ArtifactLocatorMatch[];
  source_evidence: StructuralSourceEvidence | null;
  semantic_support: "not_assessed";
}

export interface ArtifactAssuranceInput {
  target: ArtifactTarget;
  reviewed_content_hash: string | null;
}

export interface ArtifactAssuranceInspector {
  inspectFreshness(input: ArtifactAssuranceInput): ArtifactFreshnessInspection;
  inspect(input: ArtifactAssuranceInput): Promise<ArtifactAssurance>;
  dispose(): Promise<void>;
}

interface SelectorResolverInput extends ResolveSelectorOptions {
  snapshot: SourceSnapshot;
}

export interface CreateArtifactAssuranceInspectorOptions {
  repositoryRoot: string;
  repositoryKey: string;
  maxSourceBytes?: number;
  maxEvidenceBytes?: number;
  maxEvidenceLines?: number;
  hashResolver?: ArtifactHashResolver;
  sourceSnapshotReader?: SourceSnapshotReader;
  selectorVocabulary?: SelectorVocabulary;
  selectorResolver?: (
    options: SelectorResolverInput
  ) => SelectorResolution | Promise<SelectorResolution>;
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
  return [input.target.repository, input.target.path, input.reviewed_content_hash ?? ""].join("\0");
}

function isFilesystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";
}

function selectorReasonForSnapshotFailure(
  status: SourceSnapshotFailureStatus
): SelectorNotCheckedReason {
  switch (status) {
    case "missing": return "file_missing";
    case "not_file": return "not_a_file";
    case "binary": return "binary_content";
    case "oversized": return "file_too_large";
    case "unreadable":
    case "repository_escape":
    case "changed_during_read": return "unreadable";
  }
}

function unavailableLocator(reason: ArtifactLocatorNotCheckedReason): Pick<
  ArtifactAssurance,
  "locator_resolution" | "locator_reason" | "locator_matches" | "source_evidence"
> {
  return {
    locator_resolution: "not_checked",
    locator_reason: reason,
    locator_matches: [],
    source_evidence: null,
  };
}

function metadataEqual(left: SourceFileMetadata, right: SourceFileMetadata): boolean {
  return (
    left.size === right.size &&
    left.modifiedTimeMs === right.modifiedTimeMs &&
    left.changedTimeMs === right.changedTimeMs &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.kind === right.kind
  );
}

function snapshotStillCurrent(repositoryRoot: string, snapshot: SourceSnapshot): boolean {
  try {
    return metadataEqual(
      snapshot.metadata,
      sourceFileMetadataFromStat(statSync(resolve(repositoryRoot, snapshot.path)))
    );
  } catch {
    return false;
  }
}

function boundedSnippet(
  snapshot: SourceSnapshot,
  symbol: CodeSymbolFact,
  maxBytes: number,
  maxLines: number
): StructuralSourceSnippet {
  const start = symbol.bodyRange.utf16.start;
  const sourceEnd = symbol.bodyRange.utf16.end;
  let end = start;
  let bytes = 0;
  let lines = 1;
  while (end < sourceEnd) {
    const crlf = snapshot.text[end] === "\r" && snapshot.text[end + 1] === "\n";
    const lineEnding = crlf || snapshot.text[end] === "\n" || snapshot.text[end] === "\r";
    if (lineEnding) {
      const endingBytes = crlf ? 2 : 1;
      if (lines >= maxLines || bytes + endingBytes > maxBytes) break;
      end += crlf ? 2 : 1;
      bytes += endingBytes;
      lines += 1;
      continue;
    }
    const codePoint = snapshot.text.codePointAt(end)!;
    const value = String.fromCodePoint(codePoint);
    const nextBytes = Buffer.byteLength(value);
    if (bytes + nextBytes > maxBytes) break;
    end += value.length;
    bytes += nextBytes;
  }
  return Object.freeze({
    text: snapshot.text.slice(start, end),
    range: snapshot.coordinates.rangeFromUtf16(start, end),
    truncated: end < sourceEnd,
  });
}

function locatorMatches(resolution: SelectorResolution): ArtifactLocatorMatch[] {
  return [...(resolution.matching_symbols ?? [])].map((symbol) => ({
    identity: symbol.identity,
    selector: resolution.selector,
    native_kind: symbol.nativeKind,
    name_range: symbol.nameRange,
    range: symbol.bodyRange,
  }));
}

function sourceEvidence(
  resolution: SelectorResolution,
  snapshot: SourceSnapshot,
  reviewedHash: string | null,
  repositoryRoot: string,
  maxBytes: number,
  maxLines: number
): StructuralSourceEvidence | null {
  const symbol = resolution.matching_symbols?.[0];
  if (
    resolution.status !== "resolved" ||
    !symbol ||
    !resolution.language ||
    !resolution.compatibility ||
    reviewedHash === null ||
    reviewedHash !== snapshot.sha256 ||
    !snapshotStillCurrent(repositoryRoot, snapshot)
  ) {
    return null;
  }
  return Object.freeze({
    language: resolution.language,
    canonical_selector: resolution.selector,
    symbol_identity: symbol.identity,
    native_kind: symbol.nativeKind,
    syntax_status: symbol.syntaxStatus,
    name_range: symbol.nameRange,
    range: symbol.bodyRange,
    snippet: boundedSnippet(snapshot, symbol, maxBytes, maxLines),
    analyzed_content_hash: snapshot.sha256,
    compatibility: resolution.compatibility,
    diagnostics: Object.freeze([
      ...localizedDiagnostics(resolution.diagnostics ?? [], symbol),
    ]),
  });
}

function validatedBound(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return resolved;
}

/** Creates one request-local, explicitly disposable structural inspector. */
export function createArtifactAssuranceInspector(
  options: CreateArtifactAssuranceInspectorOptions
): ArtifactAssuranceInspector {
  let sourceSnapshots: SourceSnapshotReader | undefined = options.sourceSnapshotReader;
  const snapshots = () =>
    (sourceSnapshots ??= createFilesystemSourceSnapshotReader({
      repositoryRoot: options.repositoryRoot,
      maxSourceBytes: Number.MAX_SAFE_INTEGER,
    }));
  let hashes = options.hashResolver;
  let vocabulary = options.selectorVocabulary;
  let structuralResolver: StructuralSelectorResolver | undefined;
  const maxSourceBytes = options.maxSourceBytes ?? 512_000;
  const maxEvidenceBytes = validatedBound(
    options.maxEvidenceBytes,
    DEFAULT_SOURCE_EVIDENCE_MAX_BYTES,
    "maxEvidenceBytes"
  );
  const maxEvidenceLines = validatedBound(
    options.maxEvidenceLines,
    DEFAULT_SOURCE_EVIDENCE_MAX_LINES,
    "maxEvidenceLines"
  );
  type Measurement = ReturnType<ArtifactHashResolver["measure"]> | { status: "unreadable" };
  const measurements = new Map<string, Measurement>();
  const freshnessInspections = new Map<string, ArtifactFreshnessInspection>();
  const locators = new Map<string, Promise<ReturnType<typeof locatorResult>>>();
  const assurances = new Map<string, Promise<ArtifactAssurance>>();

  const measure = (path: string): Measurement => {
    const cached = measurements.get(path);
    if (cached) return cached;
    let measured: Measurement;
    try {
      hashes ??= createArtifactHashResolver(options.repositoryRoot, { snapshotReader: snapshots() });
      measured = hashes.measure(path);
    } catch (error) {
      if (!isFilesystemError(error)) throw error;
      measured = { status: "unreadable" };
    }
    measurements.set(path, measured);
    return measured;
  };

  const inspectFreshness = (input: ArtifactAssuranceInput): ArtifactFreshnessInspection => {
    const key = freshnessKey(input);
    const cached = freshnessInspections.get(key);
    if (cached) return cached;
    let inspection: ArtifactFreshnessInspection;
    if (input.target.repository !== options.repositoryKey) {
      inspection = { freshness: "unknown", freshness_reason: "cross_repository", broken_cause: null };
    } else {
      const measured = measure(input.target.path);
      if (measured.status === "unreadable") {
        inspection = { freshness: "unknown", freshness_reason: "unreadable", broken_cause: null };
      } else if (measured.status !== "hashed") {
        inspection = { freshness: "broken", freshness_reason: null, broken_cause: measured.status };
      } else {
        inspection = {
          freshness:
            input.reviewed_content_hash !== null && measured.hash === input.reviewed_content_hash
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

  const inspectLocator = async (
    input: ArtifactAssuranceInput,
    freshness: ArtifactFreshnessInspection
  ): Promise<ReturnType<typeof locatorResult>> => {
    const target = input.target;
    if (target.repository !== options.repositoryKey) return unavailableLocator("cross_repository");
    if (!target.selector) {
      return {
        locator_resolution: "not_applicable" as const,
        locator_reason: null,
        locator_matches: [],
        source_evidence: null,
      };
    }
    if (freshness.freshness_reason === "unreadable") return unavailableLocator("unreadable");
    if (freshness.broken_cause === "missing") return unavailableLocator("file_missing");
    if (freshness.broken_cause === "not_file") return unavailableLocator("not_a_file");
    if (freshness.broken_cause === "outside_repository") return unavailableLocator("outside_repository");
    const snapshotRead = snapshots().read(target.path);
    if (snapshotRead.status !== "read") {
      return unavailableLocator(selectorReasonForSnapshotFailure(snapshotRead.status));
    }
    if (snapshotRead.snapshot.metadata.size > maxSourceBytes) return unavailableLocator("file_too_large");
    const resolution = options.selectorResolver
      ? await options.selectorResolver({
          repositoryRoot: options.repositoryRoot,
          path: target.path,
          selector: target.selector,
          vocabulary: (vocabulary ??= selectorVocabularyForRepository(options.repositoryRoot)),
          maxSourceBytes,
          snapshot: snapshotRead.snapshot,
        })
      : await (structuralResolver ??= createStructuralSelectorResolver()).resolve({
          snapshot: snapshotRead.snapshot,
          selector: target.selector,
          vocabulary: (vocabulary ??= selectorVocabularyForRepository(options.repositoryRoot)),
        });
    return locatorResult(
      resolution,
      snapshotRead.snapshot,
      input.reviewed_content_hash,
      options.repositoryRoot,
      maxEvidenceBytes,
      maxEvidenceLines
    );
  };

  return {
    inspectFreshness,
    inspect(input) {
      const key = inputKey(input);
      let pending = assurances.get(key);
      if (!pending) {
        pending = (async () => {
          const freshness = inspectFreshness(input);
          const locatorKeyValue = `${locatorKey(input.target)}\0${input.reviewed_content_hash ?? ""}`;
          let locator = locators.get(locatorKeyValue);
          if (!locator) {
            locator = inspectLocator(input, freshness);
            locators.set(locatorKeyValue, locator);
          }
          return {
            ...freshness,
            ...(await locator),
            semantic_support: "not_assessed" as const,
          };
        })();
        assurances.set(key, pending);
      }
      return pending;
    },
    async dispose() {
      assurances.clear();
      locators.clear();
      await structuralResolver?.dispose();
    },
  };
}

function locatorResult(
  resolution: SelectorResolution,
  snapshot: SourceSnapshot,
  reviewedHash: string | null,
  repositoryRoot: string,
  maxEvidenceBytes: number,
  maxEvidenceLines: number
): Pick<
  ArtifactAssurance,
  "locator_resolution" | "locator_reason" | "locator_matches" | "source_evidence"
> {
  return {
    locator_resolution: resolution.status,
    locator_reason: resolution.reason,
    locator_matches: locatorMatches(resolution),
    source_evidence: sourceEvidence(
      resolution,
      snapshot,
      reviewedHash,
      repositoryRoot,
      maxEvidenceBytes,
      maxEvidenceLines
    ),
  };
}
