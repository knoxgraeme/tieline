import { z } from "zod";
import {
  CONTRACT_AUTHORITIES,
  STORY_LIFECYCLES,
} from "./types.js";
import {
  codeTargetSchema,
  helpTargetSchema,
  linkProvenanceSchema,
  stableKeySchema,
  testTargetSchema,
} from "./contract/schema.js";
import { parseSelector } from "./contract/selector.js";
import { canonicalRepositoryRelativePath } from "./contract/paths.js";

const stableId = stableKeySchema;
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
const findHelpSchema = z.object(findHelpShape).strict();
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
const getHelpArticleSchema = z
  .object(getHelpArticleShape)
  .strict();
export type GetHelpArticleInput = z.infer<typeof getHelpArticleSchema>;
export const getHelpArticleOutputShape = {
  articles: z.array(z.record(z.unknown())),
  not_found: z.array(helpArticleRef()),
  note: z.string().optional(),
};

/**
 * Deterministic path -> Acceptance Criterion lookup. There is deliberately no
 * query string, retrieval profile, or ranking control: the path is an exact
 * manifest key rather than a relevance signal.
 */
export const getPathCriteriaShape = {
  paths: z.array(z.string().trim().min(1).max(1_000)).min(1).max(50),
};
const getPathCriteriaSchema = z
  .object(getPathCriteriaShape)
  .strict();
export type GetPathCriteriaInput = z.infer<typeof getPathCriteriaSchema>;
export const getPathCriteriaOutputShape = {
  repository: z.object({ key: z.string() }),
  manifest_digest: z.string().regex(/^[a-f0-9]{64}$/),
  has_criteria_paths: z.number(),
  no_criteria_paths: z.number(),
  not_found_paths: z.number(),
  results: z.array(
    z.object({
      requested_path: z.string(),
      path: z.string(),
      status: z.enum(["has_criteria", "no_criteria", "not_found"]),
      exists: z.boolean(),
      acceptance_criterion_count: z.number(),
      answer: z.string(),
      criteria: z.array(
        z.object({
          path: z.string(),
          target_kind: z.enum(["code", "test"]),
          repository: z.string(),
          selector: z.string().nullable(),
          framework_hint: z.string().nullable(),
          capability_stable_id: z.string(),
          story_stable_id: z.string(),
          story_title: z.string(),
          acceptance_criterion_stable_id: z.string(),
          criterion: z.string(),
          relation: z.enum(["implements", "enforces", "tests"]),
          provenance: linkProvenanceSchema,
          link_scope: z.enum(["direct", "story_fallback"]),
        })
      ),
    })
  ),
  note: z.string().optional(),
};

const exactAssetPath = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .refine(
    (value) => canonicalRepositoryRelativePath(value) !== null,
    "must name a file inside the repository"
  );

const exactAssetSelector = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .superRefine((value, ctx) => {
    const parsed = parseSelector(value);
    if (!parsed.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: parsed.error });
    }
  });

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

const topologyLimitShape = {
  depth: z.number().int().min(1).max(8).optional(),
  nodes: z.number().int().min(1).max(1_000).optional(),
  edges: z.number().int().min(1).max(4_000).optional(),
  paths: z.number().int().min(1).max(200).optional(),
};

const topologyLocatorShape = {
  path: exactAssetPath,
  kind: z.enum(["code", "test"]).default("code"),
  selector: exactAssetSelector.nullable().optional(),
  framework_hint: z.string().trim().min(1).max(200).nullable().optional(),
};

/** Exact, bounded dependency traversal; it never accepts a generic graph query. */
export const traceCodeDependenciesShape = {
  repository: z.string().trim().min(1).max(200),
  ...topologyLocatorShape,
  direction: z.enum(["dependencies", "dependents"]).default("dependencies"),
  generation_role: z.enum(["base", "current"]).default("current"),
  revision: z.string().trim().min(1).max(200).optional(),
  generation_identity: z.string().trim().min(1).max(200).optional(),
  ...topologyLimitShape,
};
const traceCodeDependenciesSchema = z
  .object(traceCodeDependenciesShape)
  .strict()
  .refine(
    (value) => !(value.revision && value.generation_identity),
    "choose either revision or generation_identity"
  );
export type TraceCodeDependenciesInput = z.infer<
  typeof traceCodeDependenciesSchema
>;

const changedCodeLocator = z
  .object({
    ...topologyLocatorShape,
    status: z.enum(["added", "modified"]).default("modified"),
  })
  .strict();

/** Advisory blast radius from either a Git base or explicit changed locators. */
export const analyzeCodeBlastRadiusShape = {
  repository: z.string().trim().min(1).max(200),
  base: z.string().trim().min(1).max(200).optional(),
  changed: z.array(changedCodeLocator).min(1).max(50).optional(),
  direction: z.enum(["dependencies", "dependents"]).default("dependents"),
  ...topologyLimitShape,
};
const analyzeCodeBlastRadiusSchema = z
  .object(analyzeCodeBlastRadiusShape)
  .strict()
  .refine(
    (value) => Boolean(value.base) !== Boolean(value.changed),
    "provide exactly one of base or changed"
  );
export type AnalyzeCodeBlastRadiusToolInput = z.infer<
  typeof analyzeCodeBlastRadiusSchema
>;

const topologyLocatorOutput = z.object({
  repository: z.string(),
  kind: z.enum(["code", "test"]),
  path: z.string(),
  selector: z.string().nullable(),
  framework_hint: z.string().nullable(),
});
const topologyNodeOutput = z.object({
  generation_role: z.enum(["base", "current"]),
  generation_identity: z.string(),
  symbol_identity: z.string(),
  locator: topologyLocatorOutput,
  native_kind: z.string(),
});
const topologyEndpointOutput = z.object({
  generation_identity: z.string(),
  symbol_identity: z.string(),
});
const topologyEdgeOutput = z.object({
  identity: z.string(),
  kind: z.string(),
  source: topologyEndpointOutput,
  target: topologyEndpointOutput,
  reference_identity: z.string().nullable(),
  generation_role: z.enum(["base", "current"]),
  relationship: z.literal("derived_code_dependency"),
});
const topologyPathOutput = z.object({
  relationship: z.literal("derived_code_dependency"),
  nodes: z.array(topologyNodeOutput),
  edges: z.array(topologyEdgeOutput),
});
const topologyFrontierOutput = z.object({
  reference_identity: z.string(),
  source_symbol_identity: z.string(),
  file_path: z.string(),
  kind: z.string(),
  module_specifier: z.string().nullable(),
  status: z.enum(["ambiguous", "unresolved", "external"]),
  rule: z.string(),
  candidate_targets: z.array(z.string()),
  diagnostics: z.array(z.string()),
  generation_role: z.enum(["base", "current"]),
  generation_identity: z.string(),
  relationship: z.literal("derived_code_dependency"),
});
const topologyDimensionOutput = z.object({
  limit: z.number().int(),
  truncated: z.boolean(),
  omitted: z.number().int(),
});
const topologyTruncationOutput = z.object({
  truncated: z.boolean(),
  reasons: z.array(z.enum(["depth", "nodes", "edges", "paths"])),
  depth: topologyDimensionOutput,
  nodes: topologyDimensionOutput,
  edges: topologyDimensionOutput,
  paths: topologyDimensionOutput,
});
const topologyRoleProvenanceOutput = z.object({
  source: z.enum(["workspace", "git", "persisted"]),
  queried_revision: z.string().nullable(),
  generation_identity: z.string(),
  selected_input_digest: z.string().nullable(),
  artifact_digest: z.string().nullable(),
  projection_digest: z.string().nullable(),
  warnings: z.array(z.string()),
});
const contractRoleProvenanceOutput = z.object({
  source: z.enum(["workspace", "git"]),
  queried_revision: z.string().nullable(),
  manifest_digest: z.string(),
});
const traceUnavailableStatus = z.enum([
  "no_workspace",
  "generation_unavailable",
  "incompatible_generation",
  "capacity_exceeded",
  "source_unavailable",
  "workspace_changed",
  "topology_missing",
  "topology_missing_at_revision",
  "topology_stale",
  "topology_incompatible",
  "topology_invalid",
  "topology_capacity_exceeded",
  "topology_unsafe_path",
  "repository_mismatch",
  "unresolved_start",
  "ambiguous_start",
]);

/** Fully shaped transport contract for the shared trace-domain result. */
const completeTraceCodeDependenciesOutput = z.object({
  status: z.literal("complete"),
  repository: z.string(),
  generation_identity: z.string(),
  generation_revision: z.string(),
  generation_role: z.enum(["base", "current"]),
  direction: z.enum(["dependencies", "dependents"]),
  limits: z.object({
    depth: z.number().int(),
    nodes: z.number().int(),
    edges: z.number().int(),
    paths: z.number().int(),
  }),
  start: topologyNodeOutput,
  visited: z.array(topologyNodeOutput),
  paths: z.array(topologyPathOutput),
  frontiers: z.array(topologyFrontierOutput),
  truncation: topologyTruncationOutput,
  topology_provenance: topologyRoleProvenanceOutput,
});
export const traceCodeDependenciesOutputSchema = z.union([
  completeTraceCodeDependenciesOutput,
  z.object({ status: traceUnavailableStatus }).passthrough(),
]);
export const traceCodeDependenciesOutputShape = {
  ...completeTraceCodeDependenciesOutput.partial().shape,
  status: z.union([z.literal("complete"), traceUnavailableStatus]),
  detail: z.string().optional(),
  locator: topologyLocatorOutput.optional(),
  matches: z.array(topologyNodeOutput).optional(),
  topology_provenance: topologyRoleProvenanceOutput.optional(),
};

const topologyFileChangeOutput = z.union([
  z.object({
    status: z.enum(["added", "deleted", "modified"]),
    path: z.string(),
  }),
  z.object({
    status: z.literal("renamed"),
    path: z.string(),
    previous_path: z.string(),
  }),
]);
const topologyEdgeChangeOutput = z.object({
  status: z.enum(["added", "deleted"]),
  kind: z.string(),
  source: topologyLocatorOutput,
  target: topologyLocatorOutput,
});
const topologyStartOutcomeOutput = z.object({
  locator: topologyLocatorOutput,
  status: z.enum(["resolved", "unresolved", "ambiguous", "repository_mismatch"]),
  matches: z.array(topologyNodeOutput),
});
const topologyIntentImpactOutput = z.object({
  impact: z.literal("may_be_impacted"),
  relationship: z.literal("contract_coupling"),
  via_relationship: z.enum(["derived_code_dependency", "changed_locator"]),
  semantic_support: z.literal("not_assessed"),
  generation_role: z.enum(["base", "current"]),
  generation_identity: z.string(),
  locator: topologyLocatorOutput,
  capability_stable_id: z.string(),
  story_stable_id: z.string(),
  story_title: z.string(),
  acceptance_criterion_stable_id: z.string(),
  acceptance_criterion: z.string(),
  relation: z.enum(["implements", "enforces", "tests"]),
  provenance: linkProvenanceSchema,
  link_scope: z.enum(["direct", "story_fallback"]),
  match_precision: z.enum(["exact_selector", "file_level"]),
});

/** Fully shaped transport contract for the shared advisory blast result. */
const blastUnavailableStatus = z.enum([
  "no_workspace",
  "no_manifest",
  "contract_unavailable",
  "generation_unavailable",
  "capacity_exceeded",
  "source_unavailable",
  "workspace_changed",
  "repository_mismatch",
  "incompatible_generations",
  "topology_missing",
  "topology_missing_at_revision",
  "topology_stale",
  "topology_incompatible",
  "topology_invalid",
  "topology_capacity_exceeded",
  "topology_unsafe_path",
  "base_manifest_missing",
  "base_manifest_stale",
  "base_manifest_incompatible",
  "base_manifest_invalid",
  "current_manifest_missing",
  "current_manifest_stale",
  "current_manifest_incompatible",
  "current_manifest_invalid",
]);
const authoredContractRoleOutput = z.object({
  manifest_digest: z.string(),
  checkpoint_identity: z.string().nullable(),
  revision: z.string().nullable(),
});
const intentCoverageOutput = z.object({
  visited_locators: z.array(z.object({
    locator: topologyLocatorOutput,
    claim_scope: z.enum(["direct", "story_fallback", "no_claim"]),
  })),
  counts: z.object({
    direct: z.number().int(),
    story_fallback: z.number().int(),
    no_claim: z.number().int(),
  }),
});
const completeAnalyzeCodeBlastRadiusOutput = z.object({
  status: z.literal("complete"),
  advisory: z.literal(true),
  impact: z.literal("may_be_impacted"),
  direction: z.enum(["dependencies", "dependents"]),
  topology_changes: z.object({
    source: z.enum(["explicit", "generation_comparison"]),
    files: z.array(topologyFileChangeOutput),
    edges: z.array(topologyEdgeChangeOutput),
  }),
  generations: z.object({
    base: z.object({ identity: z.string(), revision: z.string() }).nullable(),
    current: z.object({ identity: z.string(), revision: z.string() }),
  }),
  authored_contracts: z.object({
    base: authoredContractRoleOutput.nullable(),
    current: authoredContractRoleOutput,
  }),
  revision_divergence: z.object({
    base: z.enum(["aligned", "diverged", "unknown"]).nullable(),
    current: z.enum(["aligned", "diverged", "unknown"]),
  }),
  visited: z.array(topologyNodeOutput),
  paths: z.array(topologyPathOutput),
  frontiers: z.array(topologyFrontierOutput),
  start_outcomes: z.array(topologyStartOutcomeOutput),
  intent_impacts: z.array(topologyIntentImpactOutput),
  intent_coverage: z.object({
    base: intentCoverageOutput.nullable(),
    current: intentCoverageOutput,
  }),
  topology_provenance: z.object({
    base: topologyRoleProvenanceOutput.nullable(),
    current: topologyRoleProvenanceOutput,
  }),
  contract_provenance: z.object({
    base: contractRoleProvenanceOutput.nullable(),
    current: contractRoleProvenanceOutput,
  }),
  truncation: topologyTruncationOutput.extend({
    omitted_starts: z.number().int(),
  }),
});
export const analyzeCodeBlastRadiusOutputSchema = z.union([
  completeAnalyzeCodeBlastRadiusOutput,
  z.object({ status: blastUnavailableStatus }).passthrough(),
]);
export const analyzeCodeBlastRadiusOutputShape = {
  ...completeAnalyzeCodeBlastRadiusOutput.partial().shape,
  status: z.union([z.literal("complete"), blastUnavailableStatus]),
  repository: z.string().optional(),
  detail: z.string().optional(),
  generation_identity: z.string().optional(),
  generation_role: z.enum(["base", "current"]).optional(),
  base_generation_identity: z.string().optional(),
  current_generation_identity: z.string().optional(),
};

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
    language: z.enum(["javascript", "jsx", "typescript", "tsx", "python", "rust"]),
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
const getBacklogItemSchema = z
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
const updateBacklogItemSchema = z
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
const updatePlanningStorySchema = z
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
const listHandoffConflictsSchema = z
  .object(listHandoffConflictsShape)
  .strict();
export type ListHandoffConflictsInput = z.infer<
  typeof listHandoffConflictsSchema
>;
export const listHandoffConflictsOutputShape = {
  conflicts: z.array(z.record(z.unknown())),
};
