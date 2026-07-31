import { z } from "zod";
import {
  CONTRACT_AUTHORITIES,
  STORY_LIFECYCLES,
} from "./types.js";
import {
  codeTargetSchema,
  helpTargetSchema,
  testTargetSchema,
} from "./contract/schema.js";

const stableId = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const applicability = z.record(z.array(z.string().trim().min(1)));
const documentKind = z.enum([
  "story",
  "acceptance_criterion",
  "scenario",
  "backlog_item",
  "observation",
]);
const backlogStage = z.enum([
  "open",
  "planned",
  "in_progress",
  "done",
  "declined",
]);
const nonEmptyArray = <T extends z.ZodTypeAny>(item: T) =>
  z.array(item).min(1);
const semanticSelectionId = z.union([
  z.string().uuid(),
  z
    .string()
    .regex(
      /^candidate:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      "must be a suggestion UUID or candidate:<uuid> token"
    ),
]);
const semanticTarget = () =>
  z
    .object({
      repository: stableId,
      stable_id: stableId,
    })
    .strict();

export const findRelatedShape = {
  context: z.string().min(3).max(8_000),
  profile: z
    .enum(["support", "engineering", "discovery", "all"])
    .default("engineering"),
  authority: nonEmptyArray(z.enum(CONTRACT_AUTHORITIES)).optional(),
  lifecycle: nonEmptyArray(z.enum(STORY_LIFECYCLES)).optional(),
  repository: nonEmptyArray(z.string().min(1)).optional(),
  applicability: applicability.optional(),
  include_inactive: z.boolean().optional(),
  limit: z.number().int().min(1).max(20).default(5),
};
export const findRelatedSchema = z.object(findRelatedShape).strict();
export type FindRelatedInput = z.infer<typeof findRelatedSchema>;
export const findRelatedOutputShape = {
  query: z.object({
    profile: z.string(),
    profile_version: z.number(),
    filters: z.record(z.unknown()),
  }),
  results: z.array(z.record(z.unknown())),
  note: z.string().optional(),
};

export const semanticSearchAnchor = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("observation"),
      id: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("backlog_item"),
      stable_id: stableId,
    })
    .strict(),
  z
    .object({
      kind: z.literal("story"),
      repository: stableId,
      stable_id: stableId,
    })
    .strict(),
  z
    .object({
      kind: z.literal("acceptance_criterion"),
      repository: stableId,
      stable_id: stableId,
    })
    .strict(),
]);
const semanticSearchContext = z
  .object({
    anchor: semanticSearchAnchor.optional(),
    artifacts: z
      .array(
        z.discriminatedUnion("kind", [
          codeTargetSchema,
          testTargetSchema,
          helpTargetSchema,
        ])
      )
      .min(1)
      .max(50)
      .optional(),
  })
  .strict()
  .refine(
    (value) => value.anchor !== undefined || value.artifacts !== undefined,
    "context must contain an anchor or at least one artifact"
  );

export const searchKnowledgeShape = {
  query: z.string().trim().min(3).max(8_000),
  profile: z.string().trim().min(1),
  profile_version: z.number().int().positive().optional(),
  document_kind: nonEmptyArray(documentKind).optional(),
  authority: nonEmptyArray(z.enum(CONTRACT_AUTHORITIES)).optional(),
  lifecycle: nonEmptyArray(z.enum(STORY_LIFECYCLES)).optional(),
  backlog_stage: nonEmptyArray(backlogStage).optional(),
  repository: nonEmptyArray(z.string().min(1)).optional(),
  applicability: applicability.optional(),
  include_inactive: z.boolean().optional(),
  context: semanticSearchContext.optional(),
  limit: z.number().int().min(1).max(50).default(10),
};
export const searchKnowledgeSchema = z
  .object(searchKnowledgeShape)
  .strict();
export type SearchKnowledgeInput = z.infer<typeof searchKnowledgeSchema>;
export const searchKnowledgeOutputShape = {
  profile: z.object({ key: z.string(), version: z.number() }),
  applied_filters: z.record(z.unknown()),
  signals: z.object({
    lexical: z.literal("applied"),
    embedding: z.enum(["applied", "unavailable"]),
  }),
  results: z.array(
    z.object({
      entity_kind: documentKind,
      entity_id: z.string().uuid(),
      matched_level: documentKind,
      story_id: z.string().uuid().optional(),
      story_stable_id: z.string().optional(),
      acceptance_criterion_id: z.string().uuid().optional(),
      acceptance_criterion_stable_id: z.string().optional(),
      score: z.number(),
      features: z.object({
        vector: z.number(),
        lexical: z.number(),
        alias: z.number(),
        artifact: z.number(),
        graph: z.number(),
        applicability: z.number(),
        rrf: z.number(),
      }),
      why: z.array(z.string()),
      canonical_text: z.string(),
      context_anchor: semanticSearchAnchor.optional(),
      state: z.object({
        authority: z.string().nullable(),
        lifecycle: z.string().nullable(),
        backlog_stage: z.string().nullable(),
        observation_kind: z.string().nullable(),
        attribution_state: z.string().nullable(),
        active: z.boolean(),
        coverage: z.unknown().nullable(),
        freshness: z.string(),
      }),
    })
  ),
  note: z.string().optional(),
};

export const findHelpShape = {
  query: z.string().trim().min(3).max(2_000),
  source: z.array(z.string().trim().min(1)).optional(),
  limit: z.number().int().min(1).max(20).default(5),
};
export const findHelpSchema = z.object(findHelpShape).strict();
export type FindHelpInput = z.infer<typeof findHelpSchema>;
export const findHelpOutputShape = {
  query: z.object({
    source: z.array(z.string()).optional(),
  }),
  results: z.array(
    z.object({
      source: z.string(),
      external_id: z.string(),
      title: z.string().nullable(),
      url: z.string().nullable(),
      summary: z.string().nullable(),
      lexical_score: z.number(),
      linked_story_count: z.number(),
      linked_acceptance_criterion_count: z.number(),
    })
  ),
  note: z.string().optional(),
};

const helpArticleRef = () =>
  z
    .object({
      source: z.string().trim().min(1),
      external_id: z.string().trim().min(1),
    })
    .strict();
export const getHelpArticleShape = {
  articles: z.array(helpArticleRef()).min(1).max(10),
};
export const getHelpArticleSchema = z
  .object(getHelpArticleShape)
  .strict();
export type GetHelpArticleInput = z.infer<typeof getHelpArticleSchema>;
export const getHelpArticleOutputShape = {
  articles: z.array(z.record(z.unknown())),
  not_found: z.array(helpArticleRef()),
  note: z.string().optional(),
};

const contractFilterShape = {
  repository: nonEmptyArray(z.string().min(1)).optional(),
  capability: nonEmptyArray(z.string().min(1)).optional(),
  story_key: nonEmptyArray(z.string().min(1)).optional(),
  actor: nonEmptyArray(z.string().min(1)).optional(),
  lifecycle: nonEmptyArray(z.enum(STORY_LIFECYCLES)).optional(),
  authority: nonEmptyArray(z.enum(CONTRACT_AUTHORITIES)).optional(),
  code_path: z.string().min(1).optional(),
  help_source: z.string().min(1).optional(),
  help_external_id: z.string().min(1).optional(),
  has_direct_ac_links: z.boolean().optional(),
  include_inactive_criteria: z.boolean().optional(),
};
export const queryContractStoriesShape = z
  .object({
    ...contractFilterShape,
    group_by: z
      .enum(["repository", "capability", "lifecycle", "authority", "actor"])
      .nullish(),
    limit: z.number().int().min(1).max(200).default(25),
  })
  .strict();
export type QueryContractStoriesInput = z.infer<
  typeof queryContractStoriesShape
>;
export const queryContractStoriesOutputShape = {
  mode: z.enum(["records", "grouped"]),
  group_by: z.string().nullable(),
  applied_filters: z.record(z.unknown()),
  total: z.number().optional(),
  count: z.number().optional(),
  truncated: z.boolean().optional(),
  records: z.array(z.record(z.unknown())).optional(),
  groups: z
    .array(z.object({ group: z.string(), count: z.number() }))
    .optional(),
  note: z.string().optional(),
};

export const recordObservationShape = {
  kind: z.enum(["request", "bug", "question"]),
  schema_key: z.string().min(1),
  schema_version: z.number().int().positive().default(1),
  summary: z.string().min(1),
  source: z.string().min(1),
  external_id: z.string().min(1).nullish(),
  external_url: z.string().url().nullish(),
  observed_at: z.string().datetime().optional(),
  payload: z.record(z.unknown()).default({}),
  supersedes_observation_id: z.string().uuid().nullish(),
};
export const recordObservationSchema = z
  .object(recordObservationShape)
  .strict();
export type RecordObservationInput = z.infer<
  typeof recordObservationSchema
>;
export const recordObservationOutputShape = {
  observation: z.record(z.unknown()),
  suggestions: z.array(z.record(z.unknown())),
  matching_error: z.string().optional(),
  note: z.string().optional(),
};

export const decideAttributionShape = {
  observation_id: z.string().uuid(),
  target_kind: z.enum([
    "story",
    "acceptance_criterion",
    "backlog_item",
  ]),
  repository: z.string().min(1).optional(),
  target_stable_id: z.string().min(1),
  relation: z.enum([
    "violates",
    "requests_change",
    "asks_about",
    "supports",
  ]),
  decision: z.enum(["confirmed", "dismissed"]),
  decided_by: z.string().min(1).nullish(),
};
export const decideAttributionSchema = z
  .object(decideAttributionShape)
  .strict();
export type DecideAttributionInput = z.infer<
  typeof decideAttributionSchema
>;
export const decideAttributionOutputShape = {
  attribution: z.record(z.unknown()),
};

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
export const getBacklogItemSchema = z
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
export const updateBacklogItemSchema = z
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

const planningScenario = () =>
  z
    .object({
      name: z.string().trim().min(1).optional(),
      given: z.string().trim().min(1),
      when: z.string().trim().min(1),
      then: z.string().trim().min(1),
    })
    .strict();
const planningCriterion = () =>
  z
    .object({
      stable_id: stableId.optional(),
      criterion: z.string().trim().min(1).nullable().optional(),
      rationale: z.string().trim().min(1).nullable().optional(),
      aliases: z.array(z.string().trim().min(1)).default([]),
      applies_to: applicability.nullable().optional(),
      scenarios: z.array(planningScenario()).default([]),
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
export const updatePlanningStorySchema = z
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

export const listHandoffConflictsShape = {
  repository: stableId.optional(),
  story_stable_id: stableId.optional(),
  include_resolved: z.boolean().default(false),
  limit: z.number().int().min(1).max(200).default(50),
};
export const listHandoffConflictsSchema = z
  .object(listHandoffConflictsShape)
  .strict();
export type ListHandoffConflictsInput = z.infer<
  typeof listHandoffConflictsSchema
>;
export const listHandoffConflictsOutputShape = {
  conflicts: z.array(z.record(z.unknown())),
};
