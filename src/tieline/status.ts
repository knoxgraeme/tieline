import { existsSync, readdirSync } from "node:fs";
import type { EmbeddingProvider } from "../config.js";
import { loadAcceptedContract } from "../contract/load.js";
import { readContractManifest } from "../contract/manifest.js";
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
  agent_onboarding_prompt: string | null;
}

const TIELINE_AGENT_ONBOARDING_PROMPT = [
  "Onboard this repository with Tieline.",
  "Use the bundled `tieline-author` skill or load the MCP prompt `tieline_author` when available; otherwise continue directly from this brief.",
  "Read `.tieline/config.json` and every configured context source, then inspect the configured source roots, README and product documentation, public code entry points, and tests.",
  "Run `tieline status --json`; before creating stable IDs, search local YAML and the compiled manifest for IDs, aliases, and related criteria, and disclose when database-backed organization-wide duplicate checking is unavailable.",
  "If `.tieline/spec/` is empty, author strict YAML under `.tieline/spec/` using repository-specific capabilities and Stories with separate actor, goal, and benefit fields; write each acceptance criterion as one observable `<subject> must <outcome>` and put code, test, or help links on the most specific criterion.",
  "Do not add generic starter content.",
  "Run `tieline contract validate .`, `tieline contract compile .`, `tieline contract coverage .`, `tieline contract reconcile . --base origin/main`, and `tieline check --base origin/main`.",
  "Summarize the sources used, proposed semantic boundaries, likely duplicates, mapping gaps, and changes for pull-request review.",
].join(" ");

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
  // Presence alone is not availability: an interrupted compile, malformed
  // shard, or legacy schema cannot answer manifest-backed reads. Status stays
  // recoverable and sends each of those states through the existing compile
  // action instead of throwing.
  const manifestExists = readableManifest(workspace.manifestPath);
  const agentOnboardingPrompt =
    stories.length === 0 ? TIELINE_AGENT_ONBOARDING_PROMPT : null;
  const nextAction =
    agentOnboardingPrompt
      ? "Register `.tieline/mcp.json` if your agent host does not load repository MCP configuration automatically, then give `agent_onboarding_prompt` to your coding agent."
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
    agent_onboarding_prompt: agentOnboardingPrompt,
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
