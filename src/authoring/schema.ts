/**
 * Canonical authoring shapes for the draft -> review -> lock -> import pipeline.
 *
 * The story payload here IS the import contract: the exact fields the importer
 * writes to Postgres. A draft wraps each record with a `_review` sidecar
 * (approval state + comment + provenance) that the importer ignores, so the same
 * object flows through generation, review, locking, and import with no mapping
 * step. JSON (not CSV) is the interchange format: slugs/paths are real arrays.
 */

import { z } from "zod";
import { STORY_STATUSES } from "../types.js";
export { STORY_STATUSES };

/** A section definition (created/updated on import if new). */
export const sectionRecordSchema = z.object({
  section_key: z.string().min(1),
  section_name: z.string().min(1),
  parent_area: z.string().nullish(),
  actor: z.string().nullish(), // the section's default_actor
  definition: z.string().nullish(),
  routes: z.array(z.string()).default([]),
  status: z.enum(STORY_STATUSES).nullish(), // sections.status (defaults to 'production' in DB)
  backfill_wave: z.number().nullish(),
});
export type SectionRecord = z.infer<typeof sectionRecordSchema>;

/** THE IMPORT CONTRACT — one user story. Identical at lock and import time. */
export const storyRecordSchema = z.object({
  import_ref: z.string().min(1).nullish(), // stable idempotency key for keyless batch records
  story_key: z.string().nullish(), // minted on import if absent
  section_key: z.string().min(1),
  title: z.string().min(1),
  story_text: z.string().min(1),
  actor: z.string().nullish(),
  status: z.enum(STORY_STATUSES).default("idea"),
  entity_slugs: z.array(z.string()).default([]),
  code_paths: z.array(z.string()).default([]),
});
export type StoryRecord = z.infer<typeof storyRecordSchema>;

/** Review-only metadata. Stripped at import time. */
export const reviewStateSchema = z.enum(["pending", "approved", "rejected"]);
export type ReviewState = z.infer<typeof reviewStateSchema>;

export const storyReviewSchema = z.object({
  id: z.string().min(1),
  state: reviewStateSchema.default("pending"),
  comment: z.string().default(""),
  confidence: z.number().nullish(),
  provenance: z.string().nullish(),
});

/** A story as it lives in a draft: the import contract + the review sidecar. */
export const draftStorySchema = storyRecordSchema.extend({ _review: storyReviewSchema });
export type DraftStory = z.infer<typeof draftStorySchema>;

export const draftSchema = z.object({
  version: z.literal(1).default(1),
  mode: z.enum(["backfill", "generate"]).default("backfill"),
  repo: z.string().nullish(),
  // Tieline init pins a generated draft to the exact human-approved product
  // context. Legacy drafts omit it and continue through the legacy import path.
  product_context_checksum: z.string().regex(/^[a-f0-9]{64}$/).nullish(),
  generated_at: z.string().nullish(),
  sections: z.array(sectionRecordSchema).default([]),
  stories: z.array(draftStorySchema).default([]),
});
export type Draft = z.infer<typeof draftSchema>;

/** The locked / importable payload: approved records only, `_review` stripped. */
export const importPayloadSchema = z.object({
  import_source: z.string().min(1).nullish(),
  product_context_checksum: z.string().regex(/^[a-f0-9]{64}$/).nullish(),
  sections: z.array(sectionRecordSchema).default([]),
  stories: z.array(storyRecordSchema).default([]),
});
export type ImportPayload = z.infer<typeof importPayloadSchema>;

/** Parse + validate an arbitrary object as an ImportPayload (throws on mismatch). */
export function parseImportPayload(data: unknown): ImportPayload {
  return importPayloadSchema.parse(data);
}

/**
 * Reduce a draft to what import consumes: kept stories (`_review` stripped) + the
 * sections they use. `include` selects which stories are kept:
 *   "approved"     (default) — only state === "approved"
 *   "not-rejected"           — everything except state === "rejected"
 */
export function toImportPayload(
  draft: Draft,
  opts: { include?: "approved" | "not-rejected" } = {}
): ImportPayload {
  const include = opts.include ?? "approved";
  const kept = draft.stories.filter((s) =>
    include === "approved" ? s._review.state === "approved" : s._review.state !== "rejected"
  );
  const stories: StoryRecord[] = kept.map(({ _review, ...record }) => ({
    ...record,
    import_ref: record.import_ref ?? (!record.story_key ? _review.id : null),
  }));
  const usedSectionKeys = new Set(stories.map((s) => s.section_key));
  const sections = draft.sections.filter((sec) => usedSectionKeys.has(sec.section_key));
  return {
    import_source: draft.repo ?? `${draft.mode}-draft`,
    product_context_checksum: draft.product_context_checksum,
    sections,
    stories,
  };
}

/** Parse + validate an arbitrary object as a Draft (throws on mismatch). */
export function parseDraft(data: unknown): Draft {
  return draftSchema.parse(data);
}
