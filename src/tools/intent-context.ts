/**
 * Primitive, manifest-backed intent context reads. Workspace discovery and
 * manifest loading are deliberately handler-local so server construction does
 * not require a repository, Postgres, embeddings, or network access.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  lookupAcceptanceCriterionIntentContext,
  lookupAssetIntentContext,
} from "../contract/intent-context.js";
import {
  readContractManifest,
  type ContractManifest,
} from "../contract/manifest.js";
import {
  getAcceptanceCriterionContextOutputShape,
  getAcceptanceCriterionContextShape,
  getAssetIntentContextOutputShape,
  getAssetIntentContextShape,
  type GetAcceptanceCriterionContextInput,
  type GetAssetIntentContextInput,
} from "../schemas.js";
import { findTielineWorkspace } from "../tieline/workspace.js";
import {
  errorResult,
  formatError,
  jsonResult,
  type ToolResult,
} from "./shared.js";

const ASSET_DESCRIPTION = `Read the exact reviewed intent neighborhood for one repository-relative code or test path, optionally narrowed by kind and canonical selector. The result preserves exact-selector and file-level contract coupling, linked Acceptance Criteria, their directly associated assets, and separate current assurance states.

Use this exact manifest-backed read before search_knowledge when a path or selector is already known. It is a bounded intent neighborhood, not generic graph traversal, runtime dependency analysis, or comprehensive blast radius. It works offline without Postgres, embeddings, a database, network access, or the knowledge store.`;

const ACCEPTANCE_CRITERION_DESCRIPTION = `Read one exact Acceptance Criterion and its reviewed intent neighborhood by stable ID. The result includes product ancestry, scenarios, direct and Story-fallback contract coupling, associated code/tests, and separate current assurance states.

Use this exact manifest-backed read before search_knowledge when the Acceptance Criterion stable ID is already known. It is a bounded intent neighborhood, not generic graph traversal, runtime dependency analysis, or comprehensive blast radius. It works offline without Postgres, embeddings, a database, network access, or the knowledge store.`;

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export type ManifestIntentContextResolution =
  | {
      status: "resolved";
      repositoryRoot: string;
      manifest: ContractManifest;
    }
  | { status: "no_workspace" | "no_manifest"; message: string };

/** Testable seam around handler-local workspace and manifest resolution. */
export function resolveManifestIntentContext(
  cwd: string
): ManifestIntentContextResolution {
  const workspace = findTielineWorkspace(cwd);
  if (!workspace) {
    return {
      status: "no_workspace",
      message: `No Tieline workspace was found at or above '${cwd}', so exact intent context cannot be read. Start the MCP server inside a repository containing .tieline/config.json, set TIELINE_WORKSPACE to that repository, or run \`tieline init\` there.`,
    };
  }
  try {
    return {
      status: "resolved",
      repositoryRoot: workspace.root,
      manifest: readContractManifest(workspace.manifestPath),
    };
  } catch (error) {
    return {
      status: "no_manifest",
      message: `The contract manifest '${workspace.manifestPath}' is missing or unreadable, so exact intent context cannot be read: ${formatError(error)} Run \`tieline contract compile .\` in ${workspace.root} and commit the manifest.`,
    };
  }
}

function resolveForHandler(): ManifestIntentContextResolution {
  return resolveManifestIntentContext(
    process.env.TIELINE_WORKSPACE ?? process.cwd()
  );
}

function registerAssetIntentContext(server: McpServer): void {
  server.registerTool(
    "get_asset_intent_context",
    {
      title: "Get exact asset intent context",
      description: ASSET_DESCRIPTION,
      inputSchema: getAssetIntentContextShape,
      outputSchema: getAssetIntentContextOutputShape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input: GetAssetIntentContextInput): Promise<ToolResult> => {
      try {
        const resolved = resolveForHandler();
        if (resolved.status !== "resolved") {
          return errorResult(resolved.message);
        }
        return jsonResult({
          ...lookupAssetIntentContext({
            manifest: resolved.manifest,
            repositoryRoot: resolved.repositoryRoot,
            locator: {
              path: input.path,
              ...(input.kind === undefined ? {} : { kind: input.kind }),
              ...(input.selector === undefined
                ? {}
                : { selector: input.selector }),
            },
          }),
        });
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );
}

function registerAcceptanceCriterionContext(server: McpServer): void {
  server.registerTool(
    "get_acceptance_criterion_context",
    {
      title: "Get exact Acceptance Criterion context",
      description: ACCEPTANCE_CRITERION_DESCRIPTION,
      inputSchema: getAcceptanceCriterionContextShape,
      outputSchema: getAcceptanceCriterionContextOutputShape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (
      input: GetAcceptanceCriterionContextInput
    ): Promise<ToolResult> => {
      try {
        const resolved = resolveForHandler();
        if (resolved.status !== "resolved") {
          return errorResult(resolved.message);
        }
        return jsonResult({
          ...lookupAcceptanceCriterionIntentContext({
            manifest: resolved.manifest,
            repositoryRoot: resolved.repositoryRoot,
            stableId: input.stable_id,
          }),
        });
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );
}

/** Register both separate primitive reads; no generic traversal is exposed. */
export function registerIntentContextTools(server: McpServer): void {
  registerAssetIntentContext(server);
  registerAcceptanceCriterionContext(server);
}
