import { z } from "zod";
import {
  codeTargetSchema,
  helpTargetSchema,
  testTargetSchema,
} from "../../contract/schema.js";
import {
  CONTRACT_AUTHORITIES,
  STORY_LIFECYCLES,
  applicability,
  backlogStage,
  documentKind,
  nonEmptyArray,
  stableId,
} from "./shared.js";

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
      kind: z.literal("help_article"),
      source: z.string().trim().min(1),
      external_id: z.string().trim().min(1),
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
  help_source: nonEmptyArray(z.string().trim().min(1)).optional(),
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
      help_article: z
        .object({
          source: z.string(),
          external_id: z.string(),
          title: z.string().nullable(),
          url: z.string().nullable(),
          summary: z.string().nullable(),
          linked_story_count: z.number(),
          linked_acceptance_criterion_count: z.number(),
        })
        .optional(),
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
