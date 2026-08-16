import { z } from "zod";
import { scenarioSchema } from "../../contract/schema.js";
import {
  applicability,
  semanticSelectionId,
  stableId,
} from "./shared.js";

const planningCriterion = () =>
  z
    .object({
      stable_id: stableId.optional(),
      criterion: z.string().trim().min(1).nullable().optional(),
      rationale: z.string().trim().min(1).nullable().optional(),
      aliases: z.array(z.string().trim().min(1)).default([]),
      applies_to: applicability.nullable().optional(),
      scenarios: z.array(scenarioSchema).default([]),
    })
    .strict();
export const createPlanningStoryShape = {
  repository: stableId,
  capability_stable_id: stableId.nullish(),
  stable_id: stableId.optional(),
  title: z.string().trim().min(1).max(500),
  actor: z.string().trim().min(1).nullable().optional(),
  goal: z.string().trim().min(1).nullable().optional(),
  benefit: z.string().trim().min(1).nullable().optional(),
  aliases: z.array(z.string().trim().min(1)).default([]),
  applies_to: applicability.nullable().optional(),
  motivated_by: z.array(stableId).default([]),
  acceptance_criteria: z.array(planningCriterion()).default([]),
  selected_suggestion_id: semanticSelectionId.optional(),
  continue_without_match: z.boolean().default(false),
};
export const createPlanningStorySchema = z
  .object(createPlanningStoryShape)
  .strict();
export type CreatePlanningStoryToolInput = z.infer<
  typeof createPlanningStorySchema
>;
export const createPlanningStoryOutputShape = {
  outcome: z.enum([
    "created",
    "match_review_required",
    "reuse_selected",
  ]),
  story: z.record(z.unknown()).optional(),
  candidates: z.array(z.record(z.unknown())).optional(),
  selected: z.record(z.unknown()).optional(),
  indexing_error: z.string().optional(),
  note: z.string().optional(),
};

export const updatePlanningStoryShape = {
  repository: stableId,
  stable_id: stableId,
  expected_revision: z.number().int().nonnegative(),
  capability_stable_id: stableId.nullish(),
  title: z.string().trim().min(1).max(500).optional(),
  actor: z.string().trim().min(1).nullable().optional(),
  goal: z.string().trim().min(1).nullable().optional(),
  benefit: z.string().trim().min(1).nullable().optional(),
  aliases: z.array(z.string().trim().min(1)).optional(),
  applies_to: applicability.nullable().optional(),
  motivated_by: z.array(stableId).optional(),
  superseded_by: stableId.nullish(),
  acceptance_criteria: z.array(planningCriterion()).optional(),
};
const updatePlanningStorySchema = z
  .object(updatePlanningStoryShape)
  .strict();
export type UpdatePlanningStoryToolInput = z.infer<
  typeof updatePlanningStorySchema
>;
export const updatePlanningStoryOutputShape = {
  outcome: z.enum(["applied", "stale", "not_found", "no_fields"]),
  story: z.record(z.unknown()).optional(),
  current_revision: z.number().optional(),
  indexing_error: z.string().optional(),
  note: z.string().optional(),
};
