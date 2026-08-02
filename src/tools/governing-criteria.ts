/**
 * get_governing_criteria — the first Tieline MCP tool that needs no database.
 *
 * Every other tool resolves a store inside its handler and fails at call time
 * without Postgres; this one answers from `.tieline/manifest.json` alone, which
 * is what makes an offline `tieline serve` genuinely useful rather than merely
 * bootable.
 *
 * Naming follows the convention the surface already half-encodes:
 * `get_` is a deterministic lookup (`get_help_article`), `find_`/`search_` are
 * ranked (`find_help`, `find_related`, `search_knowledge`). Both this tool and
 * `search_knowledge` accept a path, so the description has to make the
 * difference unmistakable or an agent will reach for the wrong one.
 *
 * The workspace is resolved lazily inside the handler, never at registration,
 * so the server still starts outside a Tieline workspace and reports a usable
 * message instead of failing to boot.
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

This answers "what is true": the contract records that link these exact paths. Each result carries link_scope "direct" when the link is on the Acceptance Criterion itself and "story_fallback" when it is only on the owning Story. Use search_knowledge instead to answer "what is related": that tool ranks semantically similar records and treats an artifact path as one weak relevance signal, not as a lookup key.

Ask this before editing a file, so a contradiction with accepted behavior is prevented rather than reported afterwards. A path that no Acceptance Criterion links returns an explicit ungoverned answer, and a path that does not exist in the repository is reported distinctly from one that exists but is unlinked. The manifest commit is returned so the caller knows which repository state answered.`;

export type GoverningCriteriaResolution =
  | { status: "resolved"; report: GoverningCriteriaReport }
  | { status: "no_workspace" | "no_manifest"; message: string };

/**
 * Pure seam around the handler: resolving the workspace from an explicit `cwd`
 * keeps the lookup testable without a server, a database, or a chdir.
 */
export function resolveGoverningCriteria(input: {
  paths: string[];
  cwd: string;
}): GoverningCriteriaResolution {
  const workspace = findTielineWorkspace(input.cwd);
  if (!workspace) {
    return {
      status: "no_workspace",
      message: `No Tieline workspace was found at or above '${input.cwd}', so no acceptance criterion can be looked up. Start the MCP server from inside a repository that contains .tieline/config.json, or run \`tieline init\` there.`,
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
      message: `The contract manifest '${workspace.manifestPath}' is missing or unreadable, so no acceptance criterion can be looked up: ${formatError(error)} Run \`tieline contract compile\` in ${workspace.root} and commit the manifest.`,
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
          cwd: process.cwd(),
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
                note: `${report.ungoverned_paths} of ${report.results.length} requested path(s) are governed by no acceptance criterion; see each result's 'answer'.`,
              }
            : {}),
        });
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );
}
