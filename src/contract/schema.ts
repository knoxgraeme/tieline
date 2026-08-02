import { z } from "zod";
import { parseSelector } from "./selector.js";

const stableKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a stable identifier");

const nonEmptyText = z.string().trim().min(1);

/**
 * A link selector, narrowing a file-level link to a named thing inside it.
 *
 * This schema enforces SHAPE and produces the CANONICAL form; it deliberately
 * does not check whether the kind is one this repository allows. Zod schemas are
 * static values shared by manifest compilation and manifest re-reading, so
 * baking a repository's configured vocabulary into one of them would mean either
 * a global mutable schema or a schema factory threaded through every consumer.
 * Kind membership is instead enforced in `validate.ts`, which is the one place
 * that has repository configuration in hand. See `selector.ts` for why the
 * canonical form must stay independent of configuration.
 */
const selectorSchema = z
  .string()
  .superRefine((value, ctx) => {
    const parsed = parseSelector(value);
    if (parsed.ok) return;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: parsed.error });
  })
  .transform((value) => {
    const parsed = parseSelector(value);
    return parsed.ok ? parsed.selector.canonical : value.trim();
  });

export const applicabilitySchema = z
  .record(z.string().trim().min(1), z.array(nonEmptyText).min(1))
  .refine((value) => Object.keys(value).length > 0, "must contain at least one dimension");

export const scenarioSchema = z
  .object({
    name: nonEmptyText.optional(),
    given: nonEmptyText,
    when: nonEmptyText,
    then: nonEmptyText,
  })
  .strict();

export const codeTargetSchema = z
  .object({
    kind: z.literal("code"),
    repository: stableKeySchema,
    path: nonEmptyText,
    selector: selectorSchema.optional(),
  })
  .strict();

export const testTargetSchema = z
  .object({
    kind: z.literal("test"),
    repository: stableKeySchema,
    path: nonEmptyText,
    selector: selectorSchema.optional(),
    framework_hint: nonEmptyText.optional(),
  })
  .strict();

export const helpTargetSchema = z
  .object({
    kind: z.literal("help"),
    source: stableKeySchema,
    external_id: nonEmptyText,
    url: z.string().url().optional(),
  })
  .strict();

export const contractLinkSchema = z.union([
  z
    .object({
      relation: z.enum(["implements", "enforces"]),
      target: codeTargetSchema,
    })
    .strict(),
  z
    .object({
      relation: z.literal("tests"),
      target: testTargetSchema,
    })
    .strict(),
  z
    .object({
      relation: z.literal("documents"),
      target: helpTargetSchema,
    })
    .strict(),
]);

const aliasesSchema = z.array(nonEmptyText).default([]);
const applicabilityOptionalSchema = applicabilitySchema.optional();

export const acceptanceCriterionSchema = z
  .object({
    key: stableKeySchema,
    criterion: nonEmptyText.refine(
      (value) => /\bmust\b/i.test(value),
      "must state one observable outcome using '<subject> must <outcome>'"
    ),
    rationale: nonEmptyText.optional(),
    aliases: aliasesSchema,
    applies_to: applicabilityOptionalSchema,
    scenarios: z.array(scenarioSchema).default([]),
    links: z.array(contractLinkSchema).default([]),
    supersedes: stableKeySchema.optional(),
  })
  .strict();

export const planningAcceptanceCriterionSchema = z
  .object({
    key: stableKeySchema,
    criterion: nonEmptyText.optional(),
    rationale: nonEmptyText.optional(),
    aliases: aliasesSchema,
    applies_to: applicabilityOptionalSchema,
    scenarios: z.array(scenarioSchema).default([]),
    links: z.array(contractLinkSchema).default([]),
    supersedes: stableKeySchema.optional(),
  })
  .strict();

export const planningOriginSchema = z
  .object({
    record_id: z.string().uuid(),
    revision: z.number().int().nonnegative(),
  })
  .strict();

export const acceptedStorySchema = z
  .object({
    key: stableKeySchema,
    title: nonEmptyText,
    actor: nonEmptyText,
    goal: nonEmptyText,
    benefit: nonEmptyText,
    lifecycle: z.enum(["in_progress", "production", "retired"]),
    aliases: aliasesSchema,
    applies_to: applicabilityOptionalSchema,
    motivated_by: z.array(stableKeySchema).default([]),
    links: z.array(contractLinkSchema).default([]),
    supersedes: stableKeySchema.optional(),
    planning_origin: planningOriginSchema.optional(),
    acceptance_criteria: z.array(acceptanceCriterionSchema).min(1),
  })
  .strict();

export const planningStorySchema = z
  .object({
    key: stableKeySchema,
    title: nonEmptyText,
    actor: nonEmptyText.optional(),
    goal: nonEmptyText.optional(),
    benefit: nonEmptyText.optional(),
    lifecycle: z.literal("backlog"),
    aliases: aliasesSchema,
    applies_to: applicabilityOptionalSchema,
    motivated_by: z.array(stableKeySchema).default([]),
    links: z.array(contractLinkSchema).default([]),
    supersedes: stableKeySchema.optional(),
    acceptance_criteria: z.array(planningAcceptanceCriterionSchema).default([]),
  })
  .strict();

export const capabilitySchema = z
  .object({
    key: stableKeySchema,
    name: nonEmptyText,
    description: nonEmptyText,
    aliases: aliasesSchema,
    applies_to: applicabilityOptionalSchema,
    supersedes: stableKeySchema.optional(),
    stories: z.array(acceptedStorySchema).min(1),
  })
  .strict();

export const acceptedContractDocumentSchema = z
  .object({
    version: z.literal(1),
    capability: capabilitySchema,
  })
  .strict();

export type Applicability = z.infer<typeof applicabilitySchema>;
export type ContractScenario = z.infer<typeof scenarioSchema>;
export type ContractLink = z.infer<typeof contractLinkSchema>;
export type ContractTarget = ContractLink["target"];
export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>;
export type PlanningAcceptanceCriterion = z.infer<typeof planningAcceptanceCriterionSchema>;
export type AcceptedStory = z.infer<typeof acceptedStorySchema>;
export type PlanningStory = z.infer<typeof planningStorySchema>;
export type Capability = z.infer<typeof capabilitySchema>;
export type AcceptedContractDocument = z.infer<typeof acceptedContractDocumentSchema>;

function withoutTerminalPunctuation(value: string): string {
  return value.trim().replace(/[.!?]+$/u, "");
}

export function renderUserStory(input: {
  actor: string;
  goal: string;
  benefit: string;
}): string {
  return `As a ${withoutTerminalPunctuation(input.actor)}, I want to ${withoutTerminalPunctuation(
    input.goal
  )}, so that ${withoutTerminalPunctuation(input.benefit)}.`;
}
