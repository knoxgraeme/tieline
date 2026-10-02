import { z } from "zod";
import { parseSelector } from "./selector.js";

export const stableKeySchema = z
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

export const LINK_PROVENANCES = [
  "authored",
  "inferred",
  "materialized",
] as const;
export const linkProvenanceSchema = z.enum(LINK_PROVENANCES);

export const contractLinkSchema = z.union([
  z
    .object({
      relation: z.enum(["implements", "enforces"]),
      provenance: linkProvenanceSchema,
      target: codeTargetSchema,
    })
    .strict(),
  z
    .object({
      relation: z.literal("tests"),
      provenance: linkProvenanceSchema,
      target: testTargetSchema,
    })
    .strict(),
  z
    .object({
      relation: z.literal("documents"),
      provenance: linkProvenanceSchema,
      target: helpTargetSchema,
    })
    .strict(),
]);

/**
 * A `shows` link from a Story or AC to a screen in the repository's screen
 * catalog. Screens are an opt-in feature, so this is deliberately not a member
 * of `contractLinkSchema`: every consumer of evidence links (sync, impact,
 * coverage, grading, assurance) keeps seeing exactly the code, test, and help
 * links it always has. Whether the repository enabled screens, and whether the
 * key names a catalogued screen, is checked in `validate.ts`, which has the
 * repository's configuration and catalog in hand.
 */
export const screenTargetSchema = z
  .object({
    kind: z.literal("screen"),
    key: stableKeySchema,
  })
  .strict();

export const screenLinkSchema = z
  .object({
    relation: z.literal("shows"),
    provenance: linkProvenanceSchema,
    target: screenTargetSchema,
  })
  .strict();

/**
 * What a Story or AC may author under `links`. The screen member is last, so a
 * malformed evidence link reports exactly the issues it did before screens
 * existed: the screen branch fails on its `relation` literal and never wins.
 */
const authoredLinksSchema = z
  .array(z.union([...contractLinkSchema.options, screenLinkSchema]))
  .default([]);

/**
 * Moves authored `shows` links out of `links` into their own `shows` list.
 * `shows` is present only when something was moved, so a Story or AC without
 * screen links parses to exactly the object it did before the feature existed —
 * including every hash computed from its `links`.
 */
function splitScreenLinks<T extends { links: Array<ContractLink | ScreenLink> }>(
  value: T
): Omit<T, "links"> & { links: ContractLink[]; shows?: ScreenLink[] } {
  const links: ContractLink[] = [];
  const shows: ScreenLink[] = [];
  for (const link of value.links) {
    if (link.relation === "shows") shows.push(link);
    else links.push(link);
  }
  return shows.length > 0 ? { ...value, links, shows } : { ...value, links };
}

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
    links: authoredLinksSchema,
    supersedes: stableKeySchema.optional(),
  })
  .strict()
  .transform(splitScreenLinks);

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
    links: authoredLinksSchema,
    supersedes: stableKeySchema.optional(),
    planning_origin: planningOriginSchema.optional(),
    acceptance_criteria: z.array(acceptanceCriterionSchema).min(1),
  })
  .strict()
  .transform(splitScreenLinks);

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
export type LinkProvenance = z.infer<typeof linkProvenanceSchema>;
export type ContractLink = z.infer<typeof contractLinkSchema>;
export type ContractTarget = ContractLink["target"];
export type ScreenLink = z.infer<typeof screenLinkSchema>;
export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>;
export type AcceptedStory = z.infer<typeof acceptedStorySchema>;
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
