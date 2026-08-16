import { z } from "zod";
import { linkProvenanceSchema } from "../../contract/schema.js";

/**
 * Deterministic path -> Acceptance Criterion lookup. There is deliberately no
 * query string, retrieval profile, or ranking control: the path is an exact
 * manifest key rather than a relevance signal.
 */
export const getPathCriteriaShape = {
  paths: z.array(z.string().trim().min(1).max(1_000)).min(1).max(50),
};
const getPathCriteriaSchema = z
  .object(getPathCriteriaShape)
  .strict();
export type GetPathCriteriaInput = z.infer<typeof getPathCriteriaSchema>;
export const getPathCriteriaOutputShape = {
  repository: z.object({ key: z.string() }),
  manifest_digest: z.string().regex(/^[a-f0-9]{64}$/),
  has_criteria_paths: z.number(),
  no_criteria_paths: z.number(),
  not_found_paths: z.number(),
  results: z.array(
    z.object({
      requested_path: z.string(),
      path: z.string(),
      status: z.enum(["has_criteria", "no_criteria", "not_found"]),
      exists: z.boolean(),
      acceptance_criterion_count: z.number(),
      answer: z.string(),
      criteria: z.array(
        z.object({
          path: z.string(),
          target_kind: z.enum(["code", "test"]),
          repository: z.string(),
          selector: z.string().nullable(),
          framework_hint: z.string().nullable(),
          capability_stable_id: z.string(),
          story_stable_id: z.string(),
          story_title: z.string(),
          acceptance_criterion_stable_id: z.string(),
          criterion: z.string(),
          relation: z.enum(["implements", "enforces", "tests"]),
          provenance: linkProvenanceSchema,
          link_scope: z.enum(["direct", "story_fallback"]),
        })
      ),
    })
  ),
  note: z.string().optional(),
};
