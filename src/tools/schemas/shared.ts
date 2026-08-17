import { z } from "zod";
import {
  CONTRACT_AUTHORITIES,
  STORY_LIFECYCLES,
} from "../../types.js";
import { stableKeySchema } from "../../contract/schema.js";

export const stableId = stableKeySchema;
export const applicability = z.record(z.array(z.string().trim().min(1)));
export const documentKind = z.enum([
  "story",
  "acceptance_criterion",
  "scenario",
  "backlog_item",
  "observation",
  "help_article",
]);
export const backlogStage = z.enum([
  "open",
  "planned",
  "in_progress",
  "done",
  "declined",
]);
export const nonEmptyArray = <T extends z.ZodTypeAny>(item: T) =>
  z.array(item).min(1);
export const semanticSelectionId = z.union([
  z.string().uuid(),
  z
    .string()
    .regex(
      /^candidate:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      "must be a suggestion UUID or candidate:<uuid> token"
    ),
]);
export const semanticTarget = () =>
  z
    .object({
      repository: stableId,
      stable_id: stableId,
    })
    .strict();

export { CONTRACT_AUTHORITIES, STORY_LIFECYCLES };
