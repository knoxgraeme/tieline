import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  executeChangeBlastRadius,
  executeDependencyTrace,
} from "../commands/code-topology.js";
import {
  analyzeCodeBlastRadiusOutputSchema,
  analyzeCodeBlastRadiusOutputShape,
  analyzeCodeBlastRadiusShape,
  traceCodeDependenciesOutputSchema,
  traceCodeDependenciesOutputShape,
  traceCodeDependenciesShape,
  type AnalyzeCodeBlastRadiusToolInput,
  type TraceCodeDependenciesInput,
} from "./schemas/code-topology.js";
import { errorResult, formatError, jsonResult, type ToolResult } from "./shared.js";

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const TRACE_DESCRIPTION = `Trace statically derived project-local code dependencies or dependents from one exact path and optional canonical selector. The traversal is bounded, cycle-safe, generation-identified, and retains unresolved or ambiguous frontiers.

This is derived_code_dependency evidence, not contract authority or proof that implementation satisfies an Acceptance Criterion. Repository reads select the existing committed topology artifact and never compile, parse source, repair, or write. Hosted reads preserve complete persisted-generation selection when DATABASE_URL is configured. Lifecycle failures are returned as structured read results.`;

const BLAST_DESCRIPTION = `Analyze advisory AC-aware code blast radius from either a Git base or explicit changed locators. Code reachability is computed first, then visited exact locators are joined to authored direct or Story-fallback contract_coupling claims.

Results mean may_be_impacted with semantic_support:not_assessed. Sharing an Acceptance Criterion never creates a code dependency. The default direction is dependents. Base and current topology and manifest roles are selected independently from matching immutable snapshots; repository reads never compile, parse source, repair, or write. Lifecycle failures are returned as structured read results.`;

function limits(input: {
  depth?: number;
  nodes?: number;
  edges?: number;
  paths?: number;
}) {
  return {
    ...(input.depth === undefined ? {} : { depth: input.depth }),
    ...(input.nodes === undefined ? {} : { nodes: input.nodes }),
    ...(input.edges === undefined ? {} : { edges: input.edges }),
    ...(input.paths === undefined ? {} : { paths: input.paths }),
  };
}

export function registerCodeTopologyTools(server: McpServer): void {
  server.registerTool(
    "trace_code_dependencies",
    {
      title: "Trace exact code dependencies",
      description: TRACE_DESCRIPTION,
      inputSchema: traceCodeDependenciesShape,
      outputSchema: traceCodeDependenciesOutputShape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input: TraceCodeDependenciesInput): Promise<ToolResult> => {
      try {
        const result = await executeDependencyTrace({
          repository: input.repository,
          locator: {
            path: input.path,
            kind: input.kind,
            selector: input.selector,
            frameworkHint: input.framework_hint,
          },
          direction: input.direction,
          role: input.generation_role,
          revision: input.revision,
          generation: input.generation_identity,
          limits: limits(input),
        });
        return jsonResult({ ...traceCodeDependenciesOutputSchema.parse(result) });
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );

  server.registerTool(
    "analyze_code_blast_radius",
    {
      title: "Analyze AC-aware code blast radius",
      description: BLAST_DESCRIPTION,
      inputSchema: analyzeCodeBlastRadiusShape,
      outputSchema: analyzeCodeBlastRadiusOutputShape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input: AnalyzeCodeBlastRadiusToolInput): Promise<ToolResult> => {
      try {
        if (Boolean(input.base) === Boolean(input.changed?.length)) {
          return errorResult("Provide exactly one of base or changed.");
        }
        const result = await executeChangeBlastRadius({
          repository: input.repository,
          base: input.base,
          changes: input.changed?.map((change) => ({
            path: change.path,
            kind: change.kind,
            selector: change.selector,
            frameworkHint: change.framework_hint,
            status: change.status,
          })),
          direction: input.direction,
          limits: limits(input),
        });
        return jsonResult({ ...analyzeCodeBlastRadiusOutputSchema.parse(result) });
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );
}
