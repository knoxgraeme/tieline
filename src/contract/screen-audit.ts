import {
  loadScreenCatalog,
  type ScreenSettings,
  type ValidatedScreenCatalog,
} from "./screen-catalog.js";
import {
  scanScreenScenes,
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

export interface ScreenAudit {
  catalog_path: string;
  text_path: string;
  screens: number;
  /** Screens missing at least one capture output, by key. */
  incomplete: ScreenAuditGap[];
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
}

export interface ScreenAuditSummary {
  screens: number;
  incomplete: number;
  missing_screenshot: number;
  missing_capture: number;
  missing_text: number;
  /** Null when the scene scan did not complete, so a missing tag proves nothing. */
  missing_scene: number | null;
  text_mismatch: number;
  orphaned_text: number;
  environments: number;
  scene_scan: ScreenSceneScanStatus;
  text_issues: number;
}

/**
 * Finds what incremental capture cannot: screens with missing or inconsistent
 * capture outputs, without capturing anything. Pure over its inputs.
 */
export function auditScreenCaptures(input: {
  settings: ScreenSettings;
  catalog: ValidatedScreenCatalog;
  text: ScreenTextDirectory;
  scenes: ScreenSceneScan;
}): ScreenAudit {
  const { settings, catalog, text, scenes } = input;
  const sceneEvaluated = scenes.status === "complete";
  const incomplete: ScreenAuditGap[] = [];
  const mismatch: string[] = [];
  const fingerprints = new Map<string, number>();
  const keys = [...catalog.screens.keys()].sort((left, right) => left.localeCompare(right));
  for (const key of keys) {
    const { capability, entry } = catalog.screens.get(key)!;
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
  return {
    catalog_path: settings.catalogPath,
    text_path: settings.textPath,
    screens: keys.length,
    incomplete,
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
  };
}

export function summarizeScreenAudit(audit: ScreenAudit): ScreenAuditSummary {
  const count = (gap: ScreenCaptureGap): number =>
    audit.incomplete.filter((screen) => screen.missing.includes(gap)).length;
  return {
    screens: audit.screens,
    incomplete: audit.incomplete.length,
    missing_screenshot: count("screenshot"),
    missing_capture: count("capture"),
    missing_text: count("text"),
    missing_scene: audit.scene_scan.status === "complete" ? count("scene") : null,
    text_mismatch: audit.text_mismatch.length,
    orphaned_text: audit.orphaned_text.length,
    environments: audit.environments.length,
    scene_scan: audit.scene_scan.status,
    text_issues: audit.text_issues.length,
  };
}

/**
 * Loads the working-tree catalog, validated against the capabilities the spec
 * declares, and audits it; or returns the catalog's validation issues: an
 * invalid catalog cannot say which screens exist.
 */
export function loadScreenAudit(
  repositoryRoot: string,
  settings: ScreenSettings,
  capabilityKeys: ReadonlySet<string>
): { audit: ScreenAudit; issues: [] } | { audit: null; issues: string[] } {
  const { catalog, issues } = loadScreenCatalog(repositoryRoot, settings, capabilityKeys);
  if (issues.length > 0) return { audit: null, issues };
  return {
    audit: auditScreenCaptures({
      settings,
      catalog,
      text: readScreenTextDirectory(settings),
      scenes: scanScreenScenes(repositoryRoot, settings.sceneTests),
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

/**
 * One-line warnings for `tieline check`. They name counts, not keys: the full
 * list is what `tieline screens audit` is for.
 */
export function screenAuditWarnings(summary: ScreenAuditSummary, sceneDetail: string | null): string[] {
  const gaps: Array<[ScreenCaptureGap, number | null]> = [
    ["screenshot", summary.missing_screenshot],
    ["capture", summary.missing_capture],
    ["text", summary.missing_text],
    ["scene", summary.missing_scene],
  ];
  const parts = gaps
    .filter(([, count]) => count !== null && count > 0)
    .map(([gap, count]) => `${count} ${GAP_PHRASES[gap]}`);
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
          `The @screen tag scan did not complete (${sceneDetail ?? summary.scene_scan}), so screens without a scene test are not counted.`,
        ]
      : []),
  ];
}
