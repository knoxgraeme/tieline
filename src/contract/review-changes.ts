import type {
  ContractManifest,
  ManifestScreen,
  ManifestScreenLink,
} from "./manifest.js";

/**
 * What a branch changed in the reviewed contract, relative to a base ref, for
 * the review page. It compares two compiled manifests — the base ref's
 * committed one and the working tree's — by stable ID and content hash, so it
 * needs git and nothing else: no database, no network, and no screenshots.
 */

export type ReviewChangeStatus = "added" | "changed" | "removed";

/** Why a Story or acceptance criterion counts as changed. */
export type ContractChangeAspect = "content" | "screens";

/** Why a screen counts as changed. */
export type ScreenChangeAspect = "details" | "image";

export interface ContractRecordChange {
  kind: "story" | "acceptance_criterion";
  stable_id: string;
  story_stable_id: string;
  /** The Story title, or the criterion text. */
  title: string;
  status: ReviewChangeStatus;
  /** Empty unless `status` is `changed`. */
  aspects: ContractChangeAspect[];
}

export interface ScreenRecordChange {
  stable_id: string;
  capability: string;
  title: string;
  status: ReviewChangeStatus;
  /** Empty unless `status` is `changed`. */
  aspects: ScreenChangeAspect[];
}

export interface ReviewChanges {
  base: string;
  /** False when the base ref has no compiled manifest: everything is new. */
  base_has_manifest: boolean;
  records: ContractRecordChange[];
  screens: ScreenRecordChange[];
}

interface ContractRecord {
  kind: ContractRecordChange["kind"];
  story: string;
  title: string;
  hash: string;
  shows: string;
}

interface ScreenRecord {
  capability: string;
  screen: ManifestScreen;
}

function showsIdentity(shows: ManifestScreenLink[] | undefined): string {
  return JSON.stringify(
    (shows ?? []).map((link) => [link.provenance, link.target.key]).sort()
  );
}

function contractRecords(manifest: ContractManifest | null): Map<string, ContractRecord> {
  const records = new Map<string, ContractRecord>();
  for (const capability of manifest?.capabilities ?? []) {
    for (const story of capability.stories) {
      records.set(story.stable_id, {
        kind: "story",
        story: story.stable_id,
        title: story.title,
        hash: story.contract_hash,
        shows: showsIdentity(story.shows),
      });
      for (const criterion of story.acceptance_criteria) {
        records.set(criterion.stable_id, {
          kind: "acceptance_criterion",
          story: story.stable_id,
          title: criterion.criterion,
          hash: criterion.contract_hash,
          shows: showsIdentity(criterion.shows),
        });
      }
    }
  }
  return records;
}

function screenRecords(manifest: ContractManifest | null): Map<string, ScreenRecord> {
  const records = new Map<string, ScreenRecord>();
  for (const catalog of manifest?.screen_catalogs ?? []) {
    for (const screen of catalog.screens) {
      records.set(screen.stable_id, { capability: catalog.capability, screen });
    }
  }
  return records;
}

/**
 * Whether the reviewed picture moved. When both sides record a digest, the
 * digest decides, so renaming a file is not a visual change; otherwise any
 * locator difference is reported, because nothing better is known.
 */
function imageChanged(before: ManifestScreen["image"], after: ManifestScreen["image"]): boolean {
  if (before?.sha256 !== undefined && after?.sha256 !== undefined) {
    return before.sha256 !== after.sha256;
  }
  return JSON.stringify(before) !== JSON.stringify(after);
}

function byId<T extends { stable_id: string }>(left: T, right: T): number {
  return left.stable_id.localeCompare(right.stable_id);
}

export function diffReviewManifests(
  base: ContractManifest | null,
  current: ContractManifest,
  baseRef: string
): ReviewChanges {
  const before = contractRecords(base);
  const after = contractRecords(current);
  const records: ContractRecordChange[] = [];
  for (const [stableId, record] of after) {
    const previous = before.get(stableId);
    const aspects: ContractChangeAspect[] = [];
    if (previous && previous.hash !== record.hash) aspects.push("content");
    if (previous && previous.shows !== record.shows) aspects.push("screens");
    if (previous && aspects.length === 0) continue;
    records.push({
      kind: record.kind,
      stable_id: stableId,
      story_stable_id: record.story,
      title: record.title,
      status: previous ? "changed" : "added",
      aspects,
    });
  }
  for (const [stableId, record] of before) {
    if (after.has(stableId)) continue;
    records.push({
      kind: record.kind,
      stable_id: stableId,
      story_stable_id: record.story,
      title: record.title,
      status: "removed",
      aspects: [],
    });
  }

  const screensBefore = screenRecords(base);
  const screensAfter = screenRecords(current);
  const screens: ScreenRecordChange[] = [];
  for (const [stableId, { capability, screen }] of screensAfter) {
    const previous = screensBefore.get(stableId)?.screen;
    const aspects: ScreenChangeAspect[] = [];
    if (previous && previous.contract_hash !== screen.contract_hash) aspects.push("details");
    if (previous && imageChanged(previous.image, screen.image)) aspects.push("image");
    if (previous && aspects.length === 0) continue;
    screens.push({
      stable_id: stableId,
      capability,
      title: screen.title,
      status: previous ? "changed" : "added",
      aspects,
    });
  }
  for (const [stableId, { capability, screen }] of screensBefore) {
    if (screensAfter.has(stableId)) continue;
    screens.push({
      stable_id: stableId,
      capability,
      title: screen.title,
      status: "removed",
      aspects: [],
    });
  }

  return {
    base: baseRef,
    base_has_manifest: base !== null,
    records: records.sort(
      (left, right) =>
        left.story_stable_id.localeCompare(right.story_stable_id) ||
        Number(left.kind === "acceptance_criterion") - Number(right.kind === "acceptance_criterion") ||
        byId(left, right)
    ),
    screens: screens.sort(
      (left, right) => left.capability.localeCompare(right.capability) || byId(left, right)
    ),
  };
}

/** Counts by status, for command output. */
export function summarizeReviewChanges(changes: ReviewChanges): {
  base: string;
  base_has_manifest: boolean;
  stories: Record<ReviewChangeStatus, number>;
  acceptance_criteria: Record<ReviewChangeStatus, number>;
  screens: Record<ReviewChangeStatus, number>;
} {
  const count = (statuses: ReviewChangeStatus[]): Record<ReviewChangeStatus, number> => ({
    added: statuses.filter((status) => status === "added").length,
    changed: statuses.filter((status) => status === "changed").length,
    removed: statuses.filter((status) => status === "removed").length,
  });
  return {
    base: changes.base,
    base_has_manifest: changes.base_has_manifest,
    stories: count(changes.records.filter((record) => record.kind === "story").map((record) => record.status)),
    acceptance_criteria: count(
      changes.records
        .filter((record) => record.kind === "acceptance_criterion")
        .map((record) => record.status)
    ),
    screens: count(changes.screens.map((screen) => screen.status)),
  };
}
