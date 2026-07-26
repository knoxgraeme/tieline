/**
 * Sharded drafting: `.tieline/drafts/<shard>.draft.json` -> `.tieline/stories.draft.json`.
 *
 * A whole-repository backfill is a single whole-file write today, so a drafting
 * session that dies partway through leaves nothing behind. Shards make each unit
 * of analysis its own committed artifact: one draft per product area, merged into
 * the canonical draft that review and import already consume.
 *
 * Merge is deterministic and idempotent. `_review.id` values are namespaced by
 * shard because a keyless story's review id becomes its `import_ref` — two shards
 * both minting `d-0001` would collide on (import_source, import_ref) and the
 * importer would silently treat the second story as already committed.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  draftSchema,
  type Draft,
  type DraftStory,
  type SectionRecord,
} from "../authoring/schema.js";
import type { TielineWorkspace } from "./workspace.js";

export const SHARD_SUFFIX = ".draft.json";
const SHARD_ID = /^[a-z0-9][a-z0-9._-]*$/i;
/** Composite map key for duplicate-title reporting; NUL cannot occur in either part. */
const KEY_SEPARATOR = "\u0000";

export interface ShardSummary {
  shard: string;
  path: string;
  sections: number;
  stories: number;
}

export interface ShardError {
  shard: string;
  path: string;
  message: string;
}

export interface CollectedShards {
  directoryExists: boolean;
  shards: Array<{ id: string; path: string; draft: Draft }>;
  errors: ShardError[];
}

export interface MergeResult {
  shards: ShardSummary[];
  sections: number;
  stories: number;
  pending: number;
  approved: number;
  rejected: number;
  /** Review decisions carried over from the previous merged draft. */
  preserved: number;
  /** Merged-draft stories no longer produced by any shard. */
  dropped: string[];
  /** Same section + title across shards: reported, never merged away. */
  duplicate_titles: Array<{ section_key: string; title: string; ids: string[] }>;
  draft_path: string;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}

/** Namespace a shard-local review id. Re-merging an already-merged id is a no-op. */
export function shardReviewId(shardId: string, reviewId: string): string {
  const prefix = `${shardId}/`;
  return reviewId.startsWith(prefix) ? reviewId : `${prefix}${reviewId}`;
}

/**
 * Read every shard in the drafts directory. Tolerant by design: a half-written
 * shard is an expected state mid-drafting, so unreadable files are reported
 * rather than thrown. `merge` refuses to write while any error is present;
 * `status` just reports progress.
 */
export function collectShards(workspace: TielineWorkspace): CollectedShards {
  const directory = workspace.draftsDirPath;
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    return { directoryExists: false, shards: [], errors: [] };
  }
  const shards: CollectedShards["shards"] = [];
  const errors: ShardError[] = [];
  const names = readdirSync(directory)
    .filter((name) => name.endsWith(SHARD_SUFFIX))
    .sort();
  for (const name of names) {
    const path = resolve(directory, name);
    if (path === workspace.draftPath) continue;
    const id = name.slice(0, -SHARD_SUFFIX.length);
    if (!SHARD_ID.test(id)) {
      errors.push({ shard: id, path, message: `Shard name '${name}' is not a usable shard id.` });
      continue;
    }
    try {
      shards.push({ id, path, draft: draftSchema.parse(JSON.parse(readFileSync(path, "utf8"))) });
    } catch (error) {
      errors.push({ shard: id, path, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { directoryExists: true, shards, errors };
}

interface CombinedShards {
  sections: SectionRecord[];
  stories: DraftStory[];
  summaries: ShardSummary[];
  duplicateTitles: MergeResult["duplicate_titles"];
  mode: Draft["mode"];
}

/** Combine parsed shards into one draft body, failing loudly on any collision. */
function combineShards(
  workspace: TielineWorkspace,
  collected: CollectedShards["shards"]
): CombinedShards {
  const repo = workspace.config.product.repo_name;
  const sections = new Map<string, { record: SectionRecord; shard: string; shape: string }>();
  const stories: DraftStory[] = [];
  const summaries: ShardSummary[] = [];
  const reviewIds = new Map<string, string>();
  const importRefs = new Map<string, string>();
  const byTitle = new Map<string, { section_key: string; title: string; ids: string[] }>();
  const modes = new Set<Draft["mode"]>();

  for (const { id, path, draft } of collected) {
    if (draft.repo && draft.repo !== repo) {
      throw new Error(
        `Shard '${id}' declares repo '${draft.repo}' but the workspace repository is '${repo}'.`
      );
    }
    modes.add(draft.mode);

    for (const section of draft.sections) {
      const shape = stableStringify(section);
      const prior = sections.get(section.section_key);
      if (!prior) {
        sections.set(section.section_key, { record: section, shard: id, shape });
        continue;
      }
      if (prior.shape !== shape) {
        throw new Error(
          `Section '${section.section_key}' is defined differently in shards '${prior.shard}' and '${id}'. ` +
            "Make the definitions identical, or keep each section in exactly one shard."
        );
      }
    }

    for (const story of draft.stories) {
      const reviewId = shardReviewId(id, story._review.id);
      const owner = reviewIds.get(reviewId);
      if (owner) {
        throw new Error(
          `Review id '${reviewId}' appears in both shard '${owner}' and shard '${id}'. ` +
            "Review ids become import refs and must be unique."
        );
      }
      reviewIds.set(reviewId, id);
      if (story.import_ref) {
        const refOwner = importRefs.get(story.import_ref);
        if (refOwner) {
          throw new Error(
            `import_ref '${story.import_ref}' appears in both shard '${refOwner}' and shard '${id}'.`
          );
        }
        importRefs.set(story.import_ref, id);
      }
      const titleKey = `${story.section_key}${KEY_SEPARATOR}${story.title}`;
      const seen = byTitle.get(titleKey);
      if (seen) seen.ids.push(reviewId);
      else byTitle.set(titleKey, { section_key: story.section_key, title: story.title, ids: [reviewId] });
      stories.push({ ...story, _review: { ...story._review, id: reviewId } });
    }

    summaries.push({
      shard: id,
      path,
      sections: draft.sections.length,
      stories: draft.stories.length,
    });
  }

  if (modes.size > 1) {
    throw new Error(`Shards disagree on draft mode: ${[...modes].sort().join(", ")}.`);
  }

  return {
    sections: [...sections.values()].map((entry) => entry.record),
    stories,
    summaries,
    // A story may legitimately reference a section that already exists in the
    // brain, so an unmatched section_key is import's call, not merge's.
    duplicateTitles: [...byTitle.values()].filter((entry) => entry.ids.length > 1),
    mode: [...modes][0] ?? "backfill",
  };
}

function resolveChecksum(
  workspace: TielineWorkspace,
  collected: CollectedShards["shards"]
): string | null {
  const declared = new Set(
    collected.flatMap((entry) =>
      entry.draft.product_context_checksum ? [entry.draft.product_context_checksum] : []
    )
  );
  if (declared.size > 1) {
    throw new Error(
      "Shards were generated from different product-context checksums. " +
        "Regenerate them against the currently approved context."
    );
  }
  const approved = workspace.config.context.approved_checksum ?? null;
  const shardChecksum = [...declared][0] ?? null;
  if (shardChecksum && approved && shardChecksum !== approved) {
    throw new Error(
      "Shards were generated from a product context that is no longer approved. " +
        "Regenerate them using context.approved_checksum from .tieline/config.json."
    );
  }
  return shardChecksum ?? approved;
}

export interface MergeOptions {
  /** Allow dropping merged-draft stories that no shard produces any more. */
  prune?: boolean;
  now?: string;
}

/**
 * Merge every shard into the canonical draft, preserving human review decisions.
 *
 * Approval state and reviewer comments live on the merged draft, not in shards,
 * so re-merging after regenerating one area must not silently reset the rest of
 * the board back to `pending`.
 */
export function mergeShards(workspace: TielineWorkspace, options: MergeOptions = {}): MergeResult {
  const collected = collectShards(workspace);
  if (!collected.directoryExists) {
    throw new Error(
      `No shard directory at ${workspace.draftsDirPath}. ` +
        "Write one draft per product area there, or draft straight into stories.draft.json."
    );
  }
  if (collected.errors.length > 0) {
    const detail = collected.errors.map((error) => `${error.shard}: ${error.message}`).join("; ");
    throw new Error(`${collected.errors.length} shard(s) could not be read: ${detail}`);
  }
  if (collected.shards.length === 0) {
    throw new Error(`No '*${SHARD_SUFFIX}' shards found in ${workspace.draftsDirPath}.`);
  }

  const combined = combineShards(workspace, collected.shards);
  const checksum = resolveChecksum(workspace, collected.shards);

  const priorReviews = new Map<string, DraftStory["_review"]>();
  if (existsSync(workspace.draftPath)) {
    const prior = draftSchema.parse(JSON.parse(readFileSync(workspace.draftPath, "utf8")));
    for (const story of prior.stories) priorReviews.set(story._review.id, story._review);
  }

  const producedIds = new Set(combined.stories.map((story) => story._review.id));
  const dropped = [...priorReviews.keys()].filter((id) => !producedIds.has(id));
  if (dropped.length > 0 && !options.prune) {
    throw new Error(
      `${dropped.length} story/stories in stories.draft.json are no longer produced by any shard ` +
        `(${dropped.slice(0, 5).join(", ")}${dropped.length > 5 ? ", ..." : ""}). ` +
        "Restore the shard, or rerun with --prune to drop them."
    );
  }

  let preserved = 0;
  const stories = combined.stories.map((story) => {
    const prior = priorReviews.get(story._review.id);
    if (!prior || (prior.state === "pending" && !prior.comment)) return story;
    preserved++;
    return { ...story, _review: { ...story._review, state: prior.state, comment: prior.comment } };
  });

  const draft: Draft = {
    version: 1,
    mode: combined.mode,
    repo: workspace.config.product.repo_name,
    product_context_checksum: checksum,
    generated_at: options.now ?? new Date().toISOString(),
    sections: combined.sections,
    stories,
  };
  writeFileSync(workspace.draftPath, `${JSON.stringify(draft, null, 2)}\n`);

  let pending = 0;
  let approved = 0;
  let rejected = 0;
  for (const story of stories) {
    if (story._review.state === "approved") approved++;
    else if (story._review.state === "rejected") rejected++;
    else pending++;
  }

  return {
    shards: combined.summaries,
    sections: combined.sections.length,
    stories: stories.length,
    pending,
    approved,
    rejected,
    preserved,
    dropped,
    duplicate_titles: combined.duplicateTitles,
    draft_path: workspace.draftPath,
  };
}

/**
 * Whether stories.draft.json already reflects every shard. Used by `status` to
 * decide whether the next action is "keep drafting" or "merge what you have".
 */
export function mergedDraftIsCurrent(
  workspace: TielineWorkspace,
  collected: CollectedShards
): boolean {
  if (!collected.directoryExists || collected.errors.length > 0 || collected.shards.length === 0) {
    return false;
  }
  if (!existsSync(workspace.draftPath)) return false;
  try {
    const expected = new Set(
      combineShards(workspace, collected.shards).stories.map((story) => story._review.id)
    );
    const draft = draftSchema.parse(JSON.parse(readFileSync(workspace.draftPath, "utf8")));
    const actual = new Set(draft.stories.map((story) => story._review.id));
    if (actual.size !== expected.size) return false;
    for (const id of expected) if (!actual.has(id)) return false;
    return true;
  } catch {
    return false;
  }
}
