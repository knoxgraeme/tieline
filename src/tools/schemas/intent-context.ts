import { z } from "zod";
import { linkProvenanceSchema } from "../../contract/schema.js";
import { exactAssetPath, exactAssetSelector } from "./locators.js";
import { applicability, stableId } from "./shared.js";

/** Exact, bounded locator input: no ranking, traversal, or retrieval controls. */
export const getAssetIntentContextShape = {
  path: exactAssetPath,
  kind: z.enum(["code", "test"]).optional(),
  selector: exactAssetSelector.optional(),
};
const getAssetIntentContextSchema = z
  .object(getAssetIntentContextShape)
  .strict();
export type GetAssetIntentContextInput = z.infer<
  typeof getAssetIntentContextSchema
>;

/** Exact Acceptance Criterion input keyed only by its stable identifier. */
export const getAcceptanceCriterionContextShape = {
  stable_id: stableId,
};
const getAcceptanceCriterionContextSchema = z
  .object(getAcceptanceCriterionContextShape)
  .strict();
export type GetAcceptanceCriterionContextInput = z.infer<
  typeof getAcceptanceCriterionContextSchema
>;


const intentContextHash = z.string().regex(/^[a-f0-9]{64}$/);
const intentContextApplicability = applicability.nullable();
const intentContextRepository = z.object({ key: z.string().min(1) }).strict();
const intentContextTarget = z
  .object({
    kind: z.enum(["code", "test"]),
    repository: z.string().min(1),
    path: z.string().min(1),
    selector: z.string().nullable(),
    framework_hint: z.string().nullable(),
  })
  .strict();
const intentContextPosition = z
  .object({
    utf16Offset: z.number().int().nonnegative(),
    utf8ByteOffset: z.number().int().nonnegative(),
    line: z.number().int().nonnegative(),
    utf16Column: z.number().int().nonnegative(),
    utf8ByteColumn: z.number().int().nonnegative(),
  })
  .strict();
const intentContextRange = z
  .object({
    utf16: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }).strict(),
    utf8Bytes: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }).strict(),
    start: intentContextPosition,
    end: intentContextPosition,
  })
  .strict();
const intentContextDiagnostic = z
  .object({
    identity: z.string().min(1),
    kind: z.enum(["error", "missing"]),
    nativeKind: z.string().min(1),
    range: intentContextRange,
    message: z.string().min(1),
  })
  .strict();
const intentContextLocatorMatch = z
  .object({
    identity: z.string().min(1),
    selector: z.string().min(1),
    native_kind: z.string().min(1),
    name_range: intentContextRange.nullable(),
    range: intentContextRange,
  })
  .strict();
const intentContextSourceEvidence = z
  .object({
    language: z.enum(["javascript", "jsx", "typescript", "tsx", "python", "rust", "sql"]),
    canonical_selector: z.string().min(1),
    symbol_identity: z.string().min(1),
    native_kind: z.string().min(1),
    syntax_status: z.enum(["exact", "recovered"]),
    name_range: intentContextRange.nullable(),
    range: intentContextRange,
    snippet: z
      .object({
        text: z.string(),
        range: intentContextRange,
        truncated: z.boolean(),
      })
      .strict(),
    analyzed_content_hash: intentContextHash,
    compatibility: z
      .object({ parser: z.string().min(1), query: z.string().min(1), identity: z.string().min(1) })
      .strict(),
    diagnostics: z.array(intentContextDiagnostic),
  })
  .strict();
const intentContextAssurance = z
  .object({
    freshness: z.enum(["current", "stale", "unknown", "broken"]),
    freshness_reason: z
      .enum(["cross_repository", "unreadable"])
      .nullable(),
    broken_cause: z
      .enum(["missing", "not_file", "outside_repository"])
      .nullable(),
    locator_resolution: z.enum([
      "resolved",
      "ambiguous",
      "unresolved",
      "not_checked",
      "not_applicable",
    ]),
    locator_reason: z
      .enum([
        "invalid_selector",
        "kind_not_resolvable",
        "name_not_identifier",
        "unsupported_language",
        "file_missing",
        "not_a_file",
        "unreadable",
        "binary_content",
        "file_too_large",
        "no_symbols_extracted",
        "parse_incomplete",
        "cross_repository",
        "outside_repository",
      ])
      .nullable(),
    locator_matches: z.array(intentContextLocatorMatch),
    source_evidence: intentContextSourceEvidence.nullable(),
    semantic_support: z.literal("not_assessed"),
  })
  .strict();
const intentContextClaimShape = {
  relation: z.enum(["implements", "enforces", "tests"]),
  provenance: linkProvenanceSchema,
  link_scope: z.enum(["direct", "story_fallback"]),
  target: intentContextTarget,
  reviewed_content_hash: intentContextHash.nullable(),
  assurance: intentContextAssurance,
};
const intentContextClaim = z.object(intentContextClaimShape).strict();
const matchingIntentContextClaim = z
  .object({
    capability_stable_id: stableId,
    story_stable_id: stableId,
    acceptance_criterion_stable_id: stableId,
    match_precision: z.enum([
      "exact_selector",
      "file_level",
      "path_only",
    ]),
    ...intentContextClaimShape,
  })
  .strict();
const intentContextScenario = z
  .object({
    stable_id: stableId,
    position: z.number().int().nonnegative(),
    name: z.string().min(1).optional(),
    given: z.string().min(1),
    when: z.string().min(1),
    then: z.string().min(1),
  })
  .strict();
const intentContextNeighborhood = z
  .object({
    capability: z
      .object({
        stable_id: stableId,
        name: z.string().min(1),
        description: z.string().min(1),
        aliases: z.array(z.string()),
        applies_to: intentContextApplicability,
        supersedes: stableId.nullable(),
        contract_hash: intentContextHash,
      })
      .strict(),
    story: z
      .object({
        stable_id: stableId,
        title: z.string().min(1),
        actor: z.string().min(1),
        goal: z.string().min(1),
        benefit: z.string().min(1),
        lifecycle: z.enum(["in_progress", "production", "retired"]),
        aliases: z.array(z.string()),
        applies_to: intentContextApplicability,
        motivated_by: z.array(stableId),
        supersedes: stableId.nullable(),
        planning_origin: z
          .object({
            record_id: z.string().uuid(),
            revision: z.number().int().nonnegative(),
          })
          .strict()
          .nullable(),
        contract_hash: intentContextHash,
      })
      .strict(),
    acceptance_criterion: z
      .object({
        stable_id: stableId,
        criterion: z.string().min(1),
        rationale: z.string().nullable(),
        aliases: z.array(z.string()),
        applies_to: intentContextApplicability,
        position: z.number().int().nonnegative(),
        supersedes: stableId.nullable(),
        scenarios: z.array(intentContextScenario),
        contract_hash: intentContextHash,
      })
      .strict(),
    direct_claims: z.array(intentContextClaim),
    story_fallback_claims: z.array(intentContextClaim),
  })
  .strict();

export const getAssetIntentContextOutputShape = {
  repository: intentContextRepository,
  manifest_digest: intentContextHash,
  relationship: z.literal("contract_coupling"),
  locator: z
    .object({
      repository: z.string().min(1),
      path: z.string().min(1),
      kind: z.enum(["code", "test"]).nullable(),
      selector: z.string().nullable(),
    })
    .strict(),
  status: z.enum(["has_context", "no_criteria", "not_found"]),
  exists: z.boolean(),
  answer: z.string().min(1),
  matching_claims: z.array(matchingIntentContextClaim),
  intent_neighborhood: z.array(intentContextNeighborhood),
};

export const getAcceptanceCriterionContextOutputShape = {
  repository: intentContextRepository,
  manifest_digest: intentContextHash,
  relationship: z.literal("contract_coupling"),
  requested_stable_id: stableId,
  status: z.enum(["found", "not_found"]),
  answer: z.string().min(1),
  intent_neighborhood: intentContextNeighborhood.nullable(),
};
