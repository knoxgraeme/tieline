/**
 * Manifest-backed path-criteria lookup. Workspace resolution happens only
 * inside the handler, so an MCP server can still start outside a workspace.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  lookupPathCriteria,
  type PathCriteriaReport,
} from "../contract/path-criteria.js";
import { readContractManifest } from "../contract/manifest.js";
import {
  getPathCriteriaOutputShape,
  getPathCriteriaShape,
  type GetPathCriteriaInput,
} from "../schemas.js";
import { findTielineWorkspace } from "../tieline/workspace.js";
import {
  errorResult,
  formatError,
  jsonResult,
  type ToolResult,
} from "./shared.js";

const DESCRIPTION = `Deterministically list every Acceptance Criterion recorded for one or more exact repository-relative paths, read straight from the compiled contract manifest. No database, network, or embedding is required.

This answers "what is true": the accepted contract records that link these exact paths. Each result carries link_scope "direct" when the link is on the Acceptance Criterion itself and "story_fallback" when it is only on the owning Story. Use search_knowledge instead to answer "what is related": that tool ranks semantically related records and treats a path as a relevance signal, not an exact lookup key.

Ask this before editing a file. A path with criteria returns has_criteria, an existing path with no contract link returns no_criteria, and a path that does not exist returns not_found. The manifest commit is returned so the caller knows which repository state answered.`;

export type PathCriteriaResolution =
  | { status: "resolved"; report: PathCriteriaReport }
  | { status: "no_workspace" | "no_manifest"; message: string };

/** Testable seam around the handler's lazy workspace resolution. */
export function resolvePathCriteria(input: {
  paths: string[];
  cwd: string;
}): PathCriteriaResolution {
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
      report: lookupPathCriteria({
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

function negativeResultNote(report: PathCriteriaReport): string | undefined {
  const notes: string[] = [];
  if (report.no_criteria_paths > 0) {
    const subject =
      report.no_criteria_paths === 1
        ? "1 existing path has"
        : `${report.no_criteria_paths} existing paths have`;
    notes.push(`${subject} no acceptance criteria.`);
  }
  if (report.not_found_paths > 0) {
    const subject =
      report.not_found_paths === 1
        ? "1 requested path was"
        : `${report.not_found_paths} requested paths were`;
    notes.push(`${subject} not found.`);
  }
  return notes.length > 0 ? notes.join(" ") : undefined;
}

export function registerGetPathCriteria(server: McpServer): void {
  server.registerTool(
    "get_path_criteria",
    {
      title: "Get the acceptance criteria for a path",
      description: DESCRIPTION,
      inputSchema: getPathCriteriaShape,
      outputSchema: getPathCriteriaOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input: GetPathCriteriaInput): Promise<ToolResult> => {
      try {
        const resolved = resolvePathCriteria({
          paths: input.paths,
          cwd: process.env.TIELINE_WORKSPACE ?? process.cwd(),
        });
        if (resolved.status !== "resolved") {
          return errorResult(resolved.message);
        }
        const { report } = resolved;
        const note = negativeResultNote(report);
        return jsonResult({
          repository: report.repository,
          has_criteria_paths: report.has_criteria_paths,
          no_criteria_paths: report.no_criteria_paths,
          not_found_paths: report.not_found_paths,
          results: report.results,
          ...(note ? { note } : {}),
        });
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );
}
