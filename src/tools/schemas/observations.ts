import { z } from "zod";

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
const recordObservationSchema = z
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
const decideAttributionSchema = z
  .object(decideAttributionShape)
  .strict();
export type DecideAttributionInput = z.infer<
  typeof decideAttributionSchema
>;
export const decideAttributionOutputShape = {
  attribution: z.record(z.unknown()),
};
