import type { ContractManifest } from "./manifest.js";
import { screenPathPattern } from "./paths.js";
import {
  loadScreenCatalog,
  type ScreenNotCapturedReason,
  type ScreenSettings,
  type ValidatedScreenCatalog,
} from "./screen-catalog.js";
import { generatedScenesStatus, type GeneratedScenesStatus } from "./screen-generated-scenes.js";
import {
  scanPageFiles,
  scanScreenScenes,
  type ScreenPageScan,
  type ScreenSceneScan,
  type ScreenSceneScanStatus,
} from "./screen-scenes.js";
import {
  readScreenTextDirectory,
  screenTextFile,
  type ScreenTextDirectory,
} from "./screen-text.js";

/**
 * What a screen is missing before its capture can be trusted. Every capture
 * writes a screenshot digest, a capture record, and an ARIA snapshot at once,
 * and needs a test tagged `@screen:<key>` to run, so each gap is something a
 * reviewer can act on:
 *
 * - `screenshot`: the catalog records no screenshot digest;
 * - `capture`: no Tieline capture record (the screen was never captured, or was
 *   only imported from another tool);
 * - `text`: no committed ARIA snapshot;
 * - `scene`: no test file tags the screen.
 *
 * A screen marked `not_captured` has none of these gaps: it says why instead.
 */
export type ScreenCaptureGap = "screenshot" | "capture" | "text" | "scene";

export const SCREEN_CAPTURE_GAPS: readonly ScreenCaptureGap[] = [
  "screenshot",
  "capture",
  "text",
  "scene",
];

export interface ScreenAuditGap {
  key: string;
  capability: string;
  missing: ScreenCaptureGap[];
}

/**
 * Whether the tests that prove acceptance criteria line up with the contract:
 *
 * - `untested`: criteria that show screens, but no test tags `@ac:<key>`;
 * - `unlinked`: criteria tagged in test files their `tests` links do not name;
 * - `unknown_tags`: `@ac:` tags that name no acceptance criterion.
 *
 * `unavailable` when the contract does not compile; `incomplete` when the tag
 * scan did not finish, so untested criteria are not counted.
 */
export interface ScreenAcceptanceAlignment {
  status: "evaluated" | "incomplete" | "unavailable";
  detail: string | null;
  untested: Array<{ key: string; story: string; shows: string[] }>;
  unlinked: Array<{ key: string; files: string[] }>;
  unknown_tags: Array<{ key: string; files: string[] }>;
}

export interface ScreenAudit {
  catalog_path: string;
  text_path: string;
  screens: number;
  /** Screens missing at least one capture output, by key. */
  incomplete: ScreenAuditGap[];
  /** Screens deliberately not captured, with why. */
  not_captured: Array<{
    key: string;
    capability: string;
    reason: ScreenNotCapturedReason;
    detail: string;
  }>;
  /** Screens whose ARIA snapshot differs from the digest their capture recorded. */
  text_mismatch: string[];
  /** ARIA snapshot files whose screen is not in the catalog. */
  orphaned_text: string[];
  /** `@screen:` tags that name no catalogued screen. */
  unknown_scene_tags: Array<{ key: string; files: string[] }>;
  /**
   * Capture environments in use, most screens first. Digests captured in
   * different environments are never compared, so more than one entry means
   * some screens need re-capturing in the pinned environment.
   */
  environments: Array<{ fingerprint: string; screens: number }>;
  scene_scan: { status: ScreenSceneScanStatus; files: number; detail: string | null };
  /** Files in the text directory that could not be read as ARIA snapshots. */
  text_issues: string[];
  /** Page files (`screens.capture.pages`) that no screen's `paths` claims. */
  pages: {
    status: ScreenPageScan["status"];
    detail: string | null;
    checked: number;
    unclaimed: string[];
  };
  acceptance_criteria: ScreenAcceptanceAlignment;
  /**
   * Screens no Story or acceptance criterion shows, each with the criteria
   * whose `implements` links name a file in the screen's `paths`: where a link
   * most likely belongs. A hint for review, never a failure: a screen no
   * criterion states, such as a search with no matches, stays unlinked. Empty
   * when the contract does not compile.
   */
  unlinked_screens: Array<{ key: string; capability: string; candidates: string[] }>;
  /** Scene test files that intercept the page's requests, for review. */
  intercepting: Array<{ file: string; keys: string[] }>;
  /** Whether the generated page scenes match the catalog. */
  generated_scenes: GeneratedScenesStatus;
}

export interface ScreenAuditSummary {
  screens: number;
  incomplete: number;
  missing_screenshot: number;
  missing_capture: number;
  missing_text: number;
  /** Null when the scene scan did not complete, so a missing tag proves nothing. */
  missing_scene: number | null;
  not_captured: number;
  text_mismatch: number;
  orphaned_text: number;
  environments: number;
  scene_scan: ScreenSceneScanStatus;
  text_issues: number;
  /** Null when page files are not configured or could not be listed in full. */
  unclaimed_pages: number | null;
  /** Null when the contract does not compile or the tag scan did not finish. */
  untested_acceptance_criteria: number | null;
  unlinked_acceptance_criteria: number | null;
  unknown_acceptance_criterion_tags: number | null;
  /** Null when the contract does not compile, so which screens are shown is unknown. */
  unlinked_screens: number | null;
  intercepting_scene_files: number;
}

/** The contract an audit checks acceptance criteria against, or why it cannot. */
export type ScreenAuditContract =
  | { manifest: ContractManifest; detail?: undefined }
  | { manifest: null; detail: string };

function linkedTestPaths(
  links: ContractManifest["capabilities"][number]["stories"][number]["links"]
): string[] {
  return links.flatMap((link) =>
    link.relation === "tests" && "path" in link.target ? [link.target.path] : []
  );
}

function sortedByKey<T extends { key: string }>(items: T[]): T[] {
  return items.sort((left, right) => left.key.localeCompare(right.key));
}

function acceptanceAlignment(
  contract: ScreenAuditContract,
  scenes: ScreenSceneScan
): ScreenAcceptanceAlignment {
  if (!contract.manifest) {
    return { status: "unavailable", detail: contract.detail, untested: [], unlinked: [], unknown_tags: [] };
  }
  const criteria = new Map<string, { story: string; shows: string[]; tests: Set<string> }>();
  for (const capability of contract.manifest.capabilities) {
    for (const story of capability.stories) {
      for (const criterion of story.acceptance_criteria) {
        criteria.set(criterion.stable_id, {
          story: story.stable_id,
          shows: (criterion.shows ?? []).map((link) => link.target.key),
          tests: new Set(linkedTestPaths(criterion.links)),
        });
      }
    }
  }
  const complete = scenes.status === "complete";
  return {
    status: complete ? "evaluated" : scenes.status === "incomplete" ? "incomplete" : "unavailable",
    detail: complete ? null : scenes.detail,
    untested: complete
      ? sortedByKey(
          [...criteria]
            .filter(([key, criterion]) => criterion.shows.length > 0 && !scenes.acTags.has(key))
            .map(([key, criterion]) => ({ key, story: criterion.story, shows: criterion.shows }))
        )
      : [],
    unlinked: sortedByKey(
      [...scenes.acTags].flatMap(([key, files]) => {
        const criterion = criteria.get(key);
        const missing = criterion ? files.filter((file) => !criterion.tests.has(file)) : [];
        return missing.length > 0 ? [{ key, files: missing }] : [];
      })
    ),
    unknown_tags: sortedByKey(
      [...scenes.acTags]
        .filter(([key]) => !criteria.has(key))
        .map(([key, files]) => ({ key, files: [...files] }))
    ),
  };
}

/** Most criteria suggested for one unlinked screen. */
export const UNLINKED_SCREEN_CANDIDATES = 5;

function unlinkedScreens(
  contract: ScreenAuditContract,
  catalog: ValidatedScreenCatalog
): ScreenAudit["unlinked_screens"] {
  if (!contract.manifest) return [];
  const shown = new Set<string>();
  const implementers: Array<{ key: string; path: string }> = [];
  for (const capability of contract.manifest.capabilities) {
    for (const story of capability.stories) {
      for (const link of story.shows ?? []) shown.add(link.target.key);
      for (const criterion of story.acceptance_criteria) {
        for (const link of criterion.shows ?? []) shown.add(link.target.key);
        for (const link of criterion.links) {
          if (link.relation === "implements" && "path" in link.target) {
            implementers.push({ key: criterion.stable_id, path: link.target.path });
          }
        }
      }
    }
  }
  return [...catalog.screens]
    .filter(([key]) => !shown.has(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, { capability, entry }]) => {
      const patterns = (entry.paths ?? []).map(screenPathPattern);
      const candidates = [
        ...new Set(
          implementers
            .filter((link) => patterns.some((pattern) => pattern.test(link.path)))
            .map((link) => link.key)
        ),
      ].sort((left, right) => left.localeCompare(right));
      return { key, capability, candidates: candidates.slice(0, UNLINKED_SCREEN_CANDIDATES) };
    });
}

/**
 * Finds what incremental capture cannot: screens with missing or inconsistent
 * capture outputs, page files no screen claims, and acceptance criteria whose
 * tests do not line up, without capturing anything. Pure over its inputs.
 */
export function auditScreenCaptures(input: {
  settings: ScreenSettings;
  catalog: ValidatedScreenCatalog;
  text: ScreenTextDirectory;
  scenes: ScreenSceneScan;
  pages: ScreenPageScan;
  contract: ScreenAuditContract;
  /** Defaults to not configured. */
  generatedScenes?: GeneratedScenesStatus;
}): ScreenAudit {
  const { settings, catalog, text, scenes } = input;
  const sceneEvaluated = scenes.status === "complete";
  const incomplete: ScreenAuditGap[] = [];
  const notCaptured: ScreenAudit["not_captured"] = [];
  const mismatch: string[] = [];
  const fingerprints = new Map<string, number>();
  const keys = [...catalog.screens.keys()].sort((left, right) => left.localeCompare(right));
  for (const key of keys) {
    const { capability, entry } = catalog.screens.get(key)!;
    if (entry.not_captured) {
      notCaptured.push({ key, capability, ...entry.not_captured });
      continue;
    }
    const textDigest = text.digests.get(key);
    const missing = SCREEN_CAPTURE_GAPS.filter((gap) => {
      switch (gap) {
        case "screenshot":
          return entry.image?.sha256 === undefined;
        case "capture":
          return entry.capture === undefined;
        case "text":
          return textDigest === undefined;
        case "scene":
          return sceneEvaluated && !scenes.tags.has(key);
      }
    });
    if (missing.length > 0) incomplete.push({ key, capability, missing });
    if (entry.capture && textDigest !== undefined && textDigest !== entry.capture.text_sha256) {
      mismatch.push(key);
    }
    if (entry.capture) {
      fingerprints.set(
        entry.capture.fingerprint,
        (fingerprints.get(entry.capture.fingerprint) ?? 0) + 1
      );
    }
  }
  const claims = [...catalog.screens.values()].flatMap(({ entry }) =>
    (entry.paths ?? []).map(screenPathPattern)
  );
  return {
    catalog_path: settings.catalogPath,
    text_path: settings.textPath,
    screens: keys.length,
    incomplete,
    not_captured: notCaptured,
    text_mismatch: mismatch,
    orphaned_text: [...text.digests.keys()]
      .filter((key) => !catalog.screens.has(key))
      .sort((left, right) => left.localeCompare(right))
      .map((key) => screenTextFile(settings, key).path),
    unknown_scene_tags: [...scenes.tags]
      .filter(([key]) => !catalog.screens.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, files]) => ({ key, files: [...files] })),
    environments: [...fingerprints]
      .sort(([leftPrint, left], [rightPrint, right]) => right - left || leftPrint.localeCompare(rightPrint))
      .map(([fingerprint, screens]) => ({ fingerprint, screens })),
    scene_scan: { status: scenes.status, files: scenes.files, detail: scenes.detail },
    text_issues: [...text.issues],
    pages: {
      status: input.pages.status,
      detail: input.pages.detail,
      checked: input.pages.files.length,
      unclaimed: input.pages.files.filter((file) => !claims.some((claim) => claim.test(file))),
    },
    acceptance_criteria: acceptanceAlignment(input.contract, scenes),
    unlinked_screens: unlinkedScreens(input.contract, catalog),
    intercepting: scenes.intercepting.map(({ file, keys: tagged }) => ({ file, keys: [...tagged] })),
    generated_scenes: input.generatedScenes ?? { status: "not_configured", file: null, detail: null },
  };
}

export function summarizeScreenAudit(audit: ScreenAudit): ScreenAuditSummary {
  const count = (gap: ScreenCaptureGap): number =>
    audit.incomplete.filter((screen) => screen.missing.includes(gap)).length;
  const alignment = audit.acceptance_criteria;
  const aligned = alignment.status !== "unavailable";
  return {
    screens: audit.screens,
    incomplete: audit.incomplete.length,
    missing_screenshot: count("screenshot"),
    missing_capture: count("capture"),
    missing_text: count("text"),
    missing_scene: audit.scene_scan.status === "complete" ? count("scene") : null,
    not_captured: audit.not_captured.length,
    text_mismatch: audit.text_mismatch.length,
    orphaned_text: audit.orphaned_text.length,
    environments: audit.environments.length,
    scene_scan: audit.scene_scan.status,
    text_issues: audit.text_issues.length,
    unclaimed_pages: audit.pages.status === "complete" ? audit.pages.unclaimed.length : null,
    untested_acceptance_criteria: alignment.status === "evaluated" ? alignment.untested.length : null,
    unlinked_acceptance_criteria: aligned ? alignment.unlinked.length : null,
    unknown_acceptance_criterion_tags: aligned ? alignment.unknown_tags.length : null,
    unlinked_screens: aligned ? audit.unlinked_screens.length : null,
    intercepting_scene_files: audit.intercepting.length,
  };
}

/**
 * Why a strict audit fails: anything that leaves a screen, a page, or a
 * documented UI behavior unaccounted for, or that the audit could not check.
 * Screens marked not captured are accounted for. Mixed capture environments
 * are left to `--verify`, and request interception to review, since blocking
 * third-party requests is legitimate.
 */
export function screenAuditStrictFailures(audit: ScreenAudit): string[] {
  const summary = summarizeScreenAudit(audit);
  const alignment = audit.acceptance_criteria;
  return [
    ...(summary.incomplete > 0 ? [`${summary.incomplete} screen(s) are missing capture outputs or a test`] : []),
    ...(summary.text_mismatch > 0 ? [`${summary.text_mismatch} ARIA snapshot(s) differ from their capture record`] : []),
    ...(summary.orphaned_text > 0 ? [`${summary.orphaned_text} ARIA snapshot(s) belong to no screen`] : []),
    ...(audit.unknown_scene_tags.length > 0 ? [`${audit.unknown_scene_tags.length} @screen: tag(s) name no screen`] : []),
    ...(summary.text_issues > 0 ? [`${summary.text_issues} file(s) in the text directory could not be read`] : []),
    ...(audit.scene_scan.status !== "complete" ? [`the test scan is ${audit.scene_scan.status}: ${audit.scene_scan.detail ?? ""}`] : []),
    ...(audit.pages.status === "incomplete" || audit.pages.status === "unavailable"
      ? [`the page files could not be checked: ${audit.pages.detail ?? audit.pages.status}`]
      : []),
    ...(audit.pages.unclaimed.length > 0 ? [`${audit.pages.unclaimed.length} page file(s) are claimed by no screen`] : []),
    ...(alignment.status === "unavailable" ? [`acceptance criteria could not be checked: ${alignment.detail ?? ""}`] : []),
    ...(alignment.untested.length > 0 ? [`${alignment.untested.length} acceptance criteria show screens but no test tags them`] : []),
    ...(alignment.unlinked.length > 0 ? [`${alignment.unlinked.length} acceptance criteria are tagged in tests their links do not name`] : []),
    ...(alignment.unknown_tags.length > 0 ? [`${alignment.unknown_tags.length} @ac: tag(s) name no acceptance criterion`] : []),
    ...(audit.generated_scenes.status === "stale"
      ? [`the generated page scenes are out of date (${audit.generated_scenes.detail ?? "stale"}); run \`tieline screens scenes\``]
      : []),
    ...(audit.generated_scenes.status === "invalid"
      ? [`the generated page scenes cannot be checked: ${audit.generated_scenes.detail ?? ""}`]
      : []),
  ];
}

/**
 * Loads the working-tree catalog, validated against the capabilities the spec
 * declares, and audits it against `contract`; or returns the catalog's
 * validation issues: an invalid catalog cannot say which screens exist.
 */
export function loadScreenAudit(
  repositoryRoot: string,
  settings: ScreenSettings,
  capabilityKeys: ReadonlySet<string>,
  contract: ScreenAuditContract
): { audit: ScreenAudit; issues: [] } | { audit: null; issues: string[] } {
  const { catalog, issues } = loadScreenCatalog(repositoryRoot, settings, capabilityKeys);
  if (issues.length > 0) return { audit: null, issues };
  const scenes = scanScreenScenes(repositoryRoot, settings.sceneTests);
  return {
    audit: auditScreenCaptures({
      settings,
      catalog,
      text: readScreenTextDirectory(settings),
      scenes,
      pages: scanPageFiles(repositoryRoot, settings.capture.pages),
      contract,
      generatedScenes: generatedScenesStatus({ repositoryRoot, settings, catalog, scan: scenes }),
    }),
    issues: [],
  };
}

const GAP_PHRASES: Record<ScreenCaptureGap, string> = {
  screenshot: "without a screenshot digest",
  capture: "without a capture record",
  text: "without an ARIA snapshot",
  scene: "without an @screen test",
};

function firstFew(items: readonly string[]): string {
  return `${items.slice(0, 3).join(", ")}${items.length > 3 ? ", …" : ""}`;
}

/**
 * One-line warnings for `tieline check`. They name counts, not keys: the full
 * list is what `tieline screens audit` is for. `added` names files the branch
 * added, so new page files without a screen are called out.
 */
export function screenAuditWarnings(audit: ScreenAudit, added: ReadonlySet<string> = new Set()): string[] {
  const summary = summarizeScreenAudit(audit);
  const gaps: Array<[ScreenCaptureGap, number | null]> = [
    ["screenshot", summary.missing_screenshot],
    ["capture", summary.missing_capture],
    ["text", summary.missing_text],
    ["scene", summary.missing_scene],
  ];
  const parts = gaps
    .filter(([, count]) => count !== null && count > 0)
    .map(([gap, count]) => `${count} ${GAP_PHRASES[gap]}`);
  const newPages = audit.pages.unclaimed.filter((file) => added.has(file));
  const alignment = audit.acceptance_criteria;
  return [
    ...(summary.incomplete > 0
      ? [
          `${summary.incomplete} screen(s) are missing capture outputs (${parts.join(", ")}); run \`tieline screens audit\` for the list.`,
        ]
      : []),
    ...(summary.text_mismatch > 0
      ? [
          `${summary.text_mismatch} screen(s) have an ARIA snapshot that differs from the digest their capture recorded; re-capture them.`,
        ]
      : []),
    ...(summary.orphaned_text > 0
      ? [
          `${summary.orphaned_text} ARIA snapshot(s) belong to no catalogued screen; delete them or restore their screens.`,
        ]
      : []),
    ...(summary.text_issues > 0
      ? [
          `${summary.text_issues} file(s) in the screen text directory could not be read as ARIA snapshots; run \`tieline screens audit\` for details.`,
        ]
      : []),
    ...(summary.environments > 1
      ? [
          `Screens were captured in ${summary.environments} different environments, and digests from different environments are never compared; re-capture them in the pinned environment.`,
        ]
      : []),
    ...(summary.scene_scan !== "complete"
      ? [
          `The test scan did not complete (${audit.scene_scan.detail ?? summary.scene_scan}), so screens and acceptance criteria without a test are not counted.`,
        ]
      : []),
    ...(newPages.length > 0
      ? [`${newPages.length} page file(s) added on this branch are claimed by no screen (${firstFew(newPages)}); add a screen whose paths name them.`]
      : []),
    ...(audit.generated_scenes.status === "stale" || audit.generated_scenes.status === "invalid"
      ? [
          `The generated page scenes in ${audit.generated_scenes.file ?? "the configured file"} are out of date (${audit.generated_scenes.detail ?? "stale"}); run \`tieline screens scenes\`.`,
        ]
      : []),
    ...(audit.pages.unclaimed.length > newPages.length
      ? [
          `${audit.pages.unclaimed.length - newPages.length} other page file(s) are claimed by no screen; run \`tieline screens audit\` for the list.`,
        ]
      : []),
    ...(audit.pages.status === "incomplete" || audit.pages.status === "unavailable"
      ? [`Page files could not be checked in full: ${audit.pages.detail ?? audit.pages.status}.`]
      : []),
    ...(alignment.untested.length > 0
      ? [
          `${alignment.untested.length} acceptance criteria show screens but no test tagged @ac:<key> proves them (${firstFew(alignment.untested.map((criterion) => criterion.key))}).`,
        ]
      : []),
    ...(alignment.unlinked.length > 0
      ? [
          `${alignment.unlinked.length} acceptance criteria are tagged in test files their tests links do not name (${firstFew(alignment.unlinked.map((criterion) => criterion.key))}).`,
        ]
      : []),
    ...(alignment.unknown_tags.length > 0
      ? [
          `${alignment.unknown_tags.length} @ac: tag(s) name no acceptance criterion (${firstFew(alignment.unknown_tags.map((tag) => tag.key))}).`,
        ]
      : []),
    ...(alignment.status === "unavailable" && alignment.detail
      ? [`Acceptance criteria could not be checked against their tests: ${alignment.detail}`]
      : []),
    ...(audit.intercepting.length > 0
      ? [
          `${audit.intercepting.length} scene test file(s) intercept the page's requests (${firstFew(audit.intercepting.map((entry) => entry.file))}); block third-party requests only, and mark states that would need a faked response not captured.`,
        ]
      : []),
  ];
}
