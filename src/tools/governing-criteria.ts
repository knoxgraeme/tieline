/**
 * Manifest-backed governing-criteria lookup. Workspace resolution happens only
 * inside the handler, so an MCP server can still start outside a workspace.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  lookupGoverningCriteria,
  type GoverningCriteriaReport,
} from "../contract/governs.js";
import { readContractManifest } from "../contract/manifest.js";
import {
  getGoverningCriteriaOutputShape,
  getGoverningCriteriaShape,
  type GetGoverningCriteriaInput,
} from "../schemas.js";
import { findTielineWorkspace } from "../tieline/workspace.js";
import {
  errorResult,
  formatError,
  jsonResult,
  type ToolResult,
} from "./shared.js";

const DESCRIPTION = `Deterministically list every Acceptance Criterion that governs one or more repository-relative paths, read straight from the compiled contract manifest. No database, network, or embedding is required.

This answers "what is true": the accepted contract records that link these exact paths. Each result carries link_scope "direct" when the link is on the Acceptance Criterion itself and "story_fallback" when it is only on the owning Story. Use search_knowledge instead to answer "what is related": that tool ranks semantically related records and treats a path as a relevance signal, not an exact lookup key.

Ask this before editing a file. An existing path with no contract link returns an explicit ungoverned answer, while a path that does not exist returns not_found. The manifest commit is returned so the caller knows which repository state answered.`;

export type GoverningCriteriaResolution =
  | { status: "resolved"; report: GoverningCriteriaReport }
  | { status: "no_workspace" | "no_manifest"; message: string };

/** Testable seam around the handler's lazy workspace resolution. */
export function resolveGoverningCriteria(input: {
  paths: string[];
  cwd: string;
}): GoverningCriteriaResolution {
  const workspace = findTielineWorkspace(input.cwd);
  if (!workspace) {
    return {
      status: "no_workspace",
      message: `No Tieline workspace was found at or above '${input.cwd}', so no acceptance criterion can be looked up. Start the MCP server inside a repository containing .tieline/config.json, or run \`tieline init\` there.`,
    };
  }
  try {
    const manifest = readContractManifest(workspace.manifestPath);
    return {
      status: "resolved",
      report: lookupGoverningCriteria({
        manifest,
        repositoryRoot: workspace.root,
        paths: input.paths,
      }),
    };
  } catch (error) {
    return {
      status: "no_manifest",
      message: `The contract manifest '${workspace.manifestPath}' is missing or unreadable, so no acceptance criterion can be looked up: ${formatError(error)} Run \`tieline contract compile .\` in ${workspace.root} and commit the manifest.`,
    };
  }
}

export function registerGetGoverningCriteria(server: McpServer): void {
  server.registerTool(
    "get_governing_criteria",
    {
      title: "Get the acceptance criteria governing a path",
      description: DESCRIPTION,
      inputSchema: getGoverningCriteriaShape,
      outputSchema: getGoverningCriteriaOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input: GetGoverningCriteriaInput): Promise<ToolResult> => {
      try {
        const resolved = resolveGoverningCriteria({
          paths: input.paths,
          cwd: process.env.TIELINE_WORKSPACE ?? process.cwd(),
        });
        if (resolved.status !== "resolved") {
          return errorResult(resolved.message);
        }
        const { report } = resolved;
        return jsonResult({
          repository: report.repository,
          governed_paths: report.governed_paths,
          ungoverned_paths: report.ungoverned_paths,
          results: report.results,
          ...(report.ungoverned_paths > 0
            ? {
                note: `${report.ungoverned_paths} of ${report.results.length} requested path(s) are governed by no acceptance criterion; see each result's status and answer.`,
              }
            : {}),
        });
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );
}
