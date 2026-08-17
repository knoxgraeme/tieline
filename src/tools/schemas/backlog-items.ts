import { z } from "zod";
import {
  backlogStage,
  semanticSelectionId,
  semanticTarget,
  stableId,
} from "./shared.js";

const backlogItem = () =>
  z.object({
    id: z.string().uuid(),
    stable_id: z.string(),
    title: z.string(),
    summary: z.string(),
    stage: backlogStage,
    revision: z.number().int().nonnegative(),
    superseded_by: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  });
export const getBacklogItemShape = {
  stable_id: stableId,
};
const getBacklogItemSchema = z
  .object(getBacklogItemShape)
  .strict();
export type GetBacklogItemInput = z.infer<
  typeof getBacklogItemSchema
>;
export const getBacklogItemOutputShape = {
  item: backlogItem(),
  links: z.object({
    observation_ids: z.array(z.string().uuid()),
    stories: z.array(semanticTarget()),
    acceptance_criteria: z.array(semanticTarget()),
  }),
};

export const createBacklogItemShape = {
  stable_id: stableId.optional(),
  title: z.string().trim().min(1).max(500),
  summary: z.string().trim().min(1).max(16_000),
  stage: backlogStage.default("open"),
  selected_suggestion_id: semanticSelectionId.optional(),
  continue_without_match: z.boolean().default(false),
};
export const createBacklogItemSchema = z
  .object(createBacklogItemShape)
  .strict();
export type CreateBacklogItemInput = z.infer<
  typeof createBacklogItemSchema
>;
export const createBacklogItemOutputShape = {
  outcome: z.enum([
    "created",
    "match_review_required",
    "reuse_selected",
  ]),
  item: backlogItem().optional(),
  candidates: z.array(z.record(z.unknown())).optional(),
  selected: z.record(z.unknown()).optional(),
  indexing_error: z.string().optional(),
  note: z.string().optional(),
};

export const updateBacklogItemShape = {
  stable_id: stableId,
  expected_revision: z.number().int().nonnegative(),
  title: z.string().trim().min(1).max(500).optional(),
  summary: z.string().trim().min(1).max(16_000).optional(),
  stage: backlogStage.optional(),
  superseded_by: stableId.nullish(),
};
const updateBacklogItemSchema = z
  .object(updateBacklogItemShape)
  .strict();
export type UpdateBacklogItemInput = z.infer<
  typeof updateBacklogItemSchema
>;
export const updateBacklogItemOutputShape = {
  outcome: z.enum(["applied", "stale", "not_found", "no_fields"]),
  item: backlogItem().optional(),
  current_revision: z.number().optional(),
  indexing_error: z.string().optional(),
  note: z.string().optional(),
};

export const setBacklogItemLinksShape = {
  stable_id: stableId,
  expected_revision: z.number().int().nonnegative(),
  observation_ids: z.array(z.string().uuid()).default([]),
  stories: z.array(semanticTarget()).default([]),
  acceptance_criteria: z.array(semanticTarget()).default([]),
};
export const setBacklogItemLinksSchema = z
  .object(setBacklogItemLinksShape)
  .strict();
export type SetBacklogItemLinksInput = z.infer<
  typeof setBacklogItemLinksSchema
>;
export const setBacklogItemLinksOutputShape = {
  outcome: z.enum(["applied", "stale", "not_found", "no_fields"]),
  item: backlogItem().optional(),
  links: z.record(z.unknown()).optional(),
  current_revision: z.number().optional(),
  note: z.string().optional(),
};
