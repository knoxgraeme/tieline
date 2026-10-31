import { existsSync, readdirSync } from "node:fs";
import type { EmbeddingProvider } from "../config.js";
import { TIEPOINT_VERSION } from "../package-metadata.js";
import { loadAcceptedContract } from "../contract/load.js";
import { readContractManifest } from "../contract/manifest.js";
import {
  inspectMcpClientConfigs,
  type McpClientConfigDiagnostic,
} from "./mcp-config.js";
import {
  findTiepointWorkspace,
  type TiepointWorkspace,
} from "./workspace.js";
import { readWorkspaceProfile } from "./profile.js";
import { rejectLegacyWorkspace } from "./legacy-tieline.js";
import type { DatabaseMode } from "./setup.js";

export interface TiepointStatus {
  initialized: true;
  root: string;
  product: string;
  repo: string;
  runtime: {
    /** Present in current CLI output; optional for older serialized callers. */
    cli_version?: string;
    profile_present: boolean;
    database_mode: DatabaseMode;
    embedding_provider: EmbeddingProvider;
    setup_complete: boolean;
  };
  capabilities: {
    semantic_matching_configured: boolean;
    planning_writes_configured: boolean;
  };
  integration: {
    /** Repository-relative client config files that register the MCP server. */
    mcp_clients: string[];
    /** Local package/version diagnostics for each registered client file. */
    mcp_configs?: McpClientConfigDiagnostic[];
  };
  contract: {
    documents: number;
    stories: number;
    acceptance_criteria: number;
    manifest_exists: boolean;
  };
  next_action: string;
  onboarding: {
    required: true;
    skill: "tiepoint";
    instruction: typeof ONBOARDING_AGENT_INSTRUCTION;
    install_command: typeof ONBOARDING_SKILL_INSTALL_COMMAND;
  } | null;
}

export const ONBOARDING_AGENT_INSTRUCTION =
  "Ask your agent to use the installed tiepoint skill to onboard this repository. In Claude Code, run /tiepoint; in Codex, run $tiepoint.";
export const ONBOARDING_SKILL_INSTALL_COMMAND =
  "npx -y tiepoint@latest init .";

function configured(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function readableManifest(directory: string): boolean {
  try {
    readContractManifest(directory);
    return true;
  } catch {
    return false;
  }
}

export function getTiepointStatus(
  workspace: TiepointWorkspace,
  env: NodeJS.ProcessEnv = process.env
): TiepointStatus {
  const stored = readWorkspaceProfile(workspace, env);
  const runtime =
    stored?.profile.runtime ??
    {
      database_mode: workspace.config.runtime.default_database_mode,
      embedding_provider:
        workspace.config.runtime.default_embedding_provider,
      setup_completed_at: null,
    };
  const hasContractFiles =
    existsSync(workspace.specDirectoryPath) &&
    readdirSync(workspace.specDirectoryPath, { recursive: true }).some(
      (entry) =>
        String(entry).endsWith(".yaml") ||
        String(entry).endsWith(".yml")
    );
  const loaded = hasContractFiles
    ? loadAcceptedContract(
        workspace.root,
        `.tiepoint/${workspace.config.files.spec_directory}`
      )
    : { documents: [], warnings: [] };
  const stories = loaded.documents.flatMap(
    (document) => document.capability.stories
  );
  const acceptanceCriteria = stories.flatMap(
    (story) => story.acceptance_criteria
  );
  // Presence alone is not availability: an interrupted compile, malformed
  // shard, or legacy schema cannot answer manifest-backed reads. Status stays
  // recoverable and sends each of those states through the existing compile
  // action instead of throwing.
  const manifestExists = readableManifest(workspace.manifestPath);
  const onboarding =
    stories.length === 0
      ? ({
          required: true,
          skill: "tiepoint",
          instruction: ONBOARDING_AGENT_INSTRUCTION,
          install_command: ONBOARDING_SKILL_INSTALL_COMMAND,
        } as const)
      : null;
  const nextAction =
    onboarding
      ? onboarding.instruction
      : !manifestExists
        ? "Run `tiepoint contract compile .` and review the semantic diff."
        : "Use $tiepoint to reconcile branch work; the pull request is the approval boundary.";
  const mcpConfigs = inspectMcpClientConfigs(workspace.root);
  return {
    initialized: true,
    root: workspace.root,
    product: workspace.config.product.name,
    repo: workspace.config.product.repo_name,
    runtime: {
      cli_version: TIEPOINT_VERSION,
      profile_present: Boolean(stored),
      database_mode: runtime.database_mode,
      embedding_provider: runtime.embedding_provider,
      setup_complete: Boolean(runtime.setup_completed_at),
    },
    capabilities: {
      semantic_matching_configured: configured(
        env.DATABASE_URL ?? stored?.profile.env.DATABASE_URL
      ),
      planning_writes_configured: configured(
        env.DATABASE_URL_WRITE ?? stored?.profile.env.DATABASE_URL_WRITE
      ),
    },
    integration: {
      mcp_clients: mcpConfigs.map((config) => config.path),
      mcp_configs: mcpConfigs,
    },
    contract: {
      documents: loaded.documents.length,
      stories: stories.length,
      acceptance_criteria: acceptanceCriteria.length,
      manifest_exists: manifestExists,
    },
    next_action: nextAction,
    onboarding,
  };
}

export function statusFromPath(
  path: string,
  env: NodeJS.ProcessEnv = process.env
): TiepointStatus {
  const workspace = findTiepointWorkspace(path);
  if (!workspace) {
    rejectLegacyWorkspace(path);
    throw new Error(`No .tiepoint/config.json found from ${path}.`);
  }
  return getTiepointStatus(workspace, env);
}
