import { z } from "zod";
import { stableId } from "./shared.js";

export const listHandoffConflictsShape = {
  repository: stableId.optional(),
  story_stable_id: stableId.optional(),
  include_resolved: z.boolean().default(false),
  limit: z.number().int().min(1).max(200).default(50),
};
const listHandoffConflictsSchema = z
  .object(listHandoffConflictsShape)
  .strict();
export type ListHandoffConflictsInput = z.infer<
  typeof listHandoffConflictsSchema
>;
export const listHandoffConflictsOutputShape = {
  conflicts: z.array(z.record(z.unknown())),
};
