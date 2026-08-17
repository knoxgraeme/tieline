import { z } from "zod";
import {
  CONTRACT_AUTHORITIES,
  STORY_LIFECYCLES,
  nonEmptyArray,
} from "./shared.js";

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
