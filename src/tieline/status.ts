import { existsSync, readdirSync } from "node:fs";
import type { EmbeddingProvider } from "../config.js";
import { loadAcceptedContract } from "../contract/load.js";
import {
  findTielineWorkspace,
  type TielineWorkspace,
} from "./workspace.js";
import { readWorkspaceProfile } from "./profile.js";
import type { DatabaseMode } from "./setup.js";

export interface TielineStatus {
  initialized: true;
  root: string;
  product: string;
  repo: string;
  runtime: {
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
    mcp_template_present: boolean;
  };
  contract: {
    documents: number;
    stories: number;
    acceptance_criteria: number;
    manifest_exists: boolean;
  };
  next_action: string;
}

function configured(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

export function getTielineStatus(
  workspace: TielineWorkspace,
  env: NodeJS.ProcessEnv = process.env
): TielineStatus {
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
        `.tieline/${workspace.config.files.spec_directory}`
      )
    : { documents: [], warnings: [] };
  const stories = loaded.documents.flatMap(
    (document) => document.capability.stories
  );
  const acceptanceCriteria = stories.flatMap(
    (story) => story.acceptance_criteria
  );
  const manifestExists = existsSync(workspace.manifestPath);
  const nextAction =
    stories.length === 0
      ? "Connect the MCP template, then invoke the `tieline_author` prompt (or use the bundled /tieline-author skill) to onboard the first Story and AC."
      : !manifestExists
        ? "Run `tieline contract compile .` and review the semantic diff."
        : "Use /tieline-author to reconcile branch work; the pull request is the approval boundary.";
  return {
    initialized: true,
    root: workspace.root,
    product: workspace.config.product.name,
    repo: workspace.config.product.repo_name,
    runtime: {
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
      mcp_template_present: existsSync(workspace.mcpConfigPath),
    },
    contract: {
      documents: loaded.documents.length,
      stories: stories.length,
      acceptance_criteria: acceptanceCriteria.length,
      manifest_exists: manifestExists,
    },
    next_action: nextAction,
  };
}

export function statusFromPath(
  path: string,
  env: NodeJS.ProcessEnv = process.env
): TielineStatus {
  const workspace = findTielineWorkspace(path);
  if (!workspace) {
    throw new Error(`No .tieline/config.json found from ${path}.`);
  }
  return getTielineStatus(workspace, env);
}
