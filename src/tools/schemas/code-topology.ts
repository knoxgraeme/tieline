import { z } from "zod";
import { linkProvenanceSchema } from "../../contract/schema.js";
import { exactAssetPath, exactAssetSelector } from "./locators.js";

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
