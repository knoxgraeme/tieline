import { z } from "zod";
import {
  CONTRACT_AUTHORITIES,
  STORY_LIFECYCLES,
  applicability,
  nonEmptyArray,
} from "./shared.js";

export const findRelatedShape = {
  context: z.string().min(3).max(8_000),
  profile: z
    .enum(["support", "engineering", "discovery", "all"])
    .default("all"),
  authority: nonEmptyArray(z.enum(CONTRACT_AUTHORITIES)).optional(),
  lifecycle: nonEmptyArray(z.enum(STORY_LIFECYCLES)).optional(),
  repository: nonEmptyArray(z.string().min(1)).optional(),
  applicability: applicability.optional(),
  include_inactive: z.boolean().optional(),
  limit: z.number().int().min(1).max(20).default(5),
};
const findRelatedSchema = z.object(findRelatedShape).strict();
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
