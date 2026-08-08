import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  quoteShellArgument,
  sanitizedChildEnvironment,
  type SkillAgentId,
  type SkillfishProcessRunner,
} from "./skill-install.js";

const TIELINE_MCP_SERVER_NAME = "tieline";
const CODEX_MCP_TIMEOUT_MS = 30_000;

const TIELINE_SERVE_COMMAND = ["npx", "-y", "tieline", "serve"] as const;

interface McpClientTarget {
  /** null: written for every initialization, independent of agent choice. */
  agentId: SkillAgentId | null;
  path: string;
  serversKey: "mcpServers" | "servers" | "mcp";
  entry: () => Record<string, unknown>;
}

function tielineMcpServerEntry(
  extras: Record<string, unknown> = {}
): Record<string, unknown> {
  const [command, ...args] = TIELINE_SERVE_COMMAND;
  return {
    ...extras,
    command,
    // -y keeps non-interactive MCP hosts from hanging on npx's first-run
    // install prompt.
    args,
    // "." resolves against the host's working directory; hosts that spawn
    // servers outside the repository need an absolute path here instead.
    env: { TIELINE_WORKSPACE: "." },
  };
}

function opencodeServerEntry(): Record<string, unknown> {
  return {
    type: "local",
    command: [...TIELINE_SERVE_COMMAND],
    enabled: true,
    environment: { TIELINE_WORKSPACE: "." },
  };
}

/**
 * Repository-level MCP configuration files. The root .mcp.json is always
 * written: Claude Code loads it automatically and it doubles as the copyable
 * server definition for hosts without repository-level configuration.
 */
const MCP_CLIENT_TARGETS: readonly McpClientTarget[] = [
  {
    agentId: null,
    path: ".mcp.json",
    serversKey: "mcpServers",
    entry: tielineMcpServerEntry,
  },
  {
    agentId: "cursor",
    path: ".cursor/mcp.json",
    serversKey: "mcpServers",
    entry: tielineMcpServerEntry,
  },
  {
    agentId: "github-copilot",
    path: ".vscode/mcp.json",
    serversKey: "servers",
    entry: () => tielineMcpServerEntry({ type: "stdio" }),
  },
  {
    agentId: "gemini-cli",
    path: ".gemini/settings.json",
    serversKey: "mcpServers",
    entry: tielineMcpServerEntry,
  },
  {
    agentId: "opencode",
    path: "opencode.json",
    serversKey: "mcp",
    entry: opencodeServerEntry,
  },
];

/** Agents with no repository-level MCP file and no registration CLI. */
const MANUAL_MCP_AGENTS: ReadonlySet<SkillAgentId> = new Set(["windsurf"]);

export interface McpConfigWrite {
  path: string;
  status: "written" | "updated" | "unchanged" | "failed";
  reason: string | null;
}

export interface McpConfigOutcome {
  writes: McpConfigWrite[];
  manualAgents: SkillAgentId[];
}

function targetsFor(
  agentIds: readonly SkillAgentId[]
): McpClientTarget[] {
  const selected = new Set(agentIds);
  return MCP_CLIENT_TARGETS.filter(
    (target) => target.agentId === null || selected.has(target.agentId)
  );
}

function manualAgentsFor(
  agentIds: readonly SkillAgentId[]
): SkillAgentId[] {
  return agentIds.filter((agentId) => MANUAL_MCP_AGENTS.has(agentId));
}

export function plannedMcpTargets(agentIds: readonly SkillAgentId[]): {
  paths: string[];
  codex: boolean;
  manualAgents: SkillAgentId[];
} {
  return {
    paths: targetsFor(agentIds).map((target) => target.path),
    codex: agentIds.includes("codex"),
    manualAgents: manualAgentsFor(agentIds),
  };
}

function mergeServerEntry(
  filePath: string,
  serversKey: string,
  entry: Record<string, unknown>
): { status: McpConfigWrite["status"]; reason: string | null } {
  const exists = existsSync(filePath);
  let parsed: unknown = {};
  if (exists) {
    const raw = readFileSync(filePath, "utf8");
    if (raw.trim()) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        return {
          status: "failed",
          reason: "the existing file is not valid JSON",
        };
      }
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      status: "failed",
      reason: "the existing file is not a JSON object",
    };
  }
  const config = parsed as Record<string, unknown>;
  const existingServers = config[serversKey];
  const servers =
    typeof existingServers === "object" &&
    existingServers !== null &&
    !Array.isArray(existingServers)
      ? (existingServers as Record<string, unknown>)
      : {};
  if (isDeepStrictEqual(servers[TIELINE_MCP_SERVER_NAME], entry)) {
    return { status: "unchanged", reason: null };
  }
  servers[TIELINE_MCP_SERVER_NAME] = entry;
  config[serversKey] = servers;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`);
  return { status: exists ? "updated" : "written", reason: null };
}

/**
 * Merges the tieline server definition into each applicable client file,
 * preserving unrelated entries. Unparseable files are reported and left
 * untouched so initialization never destroys a hand-maintained config.
 */
export function writeMcpClientConfigs(
  root: string,
  agentIds: readonly SkillAgentId[]
): McpConfigOutcome {
  const writes = targetsFor(agentIds).map((target): McpConfigWrite => {
    const result = mergeServerEntry(
      resolve(root, target.path),
      target.serversKey,
      target.entry()
    );
    return { path: target.path, ...result };
  });
  return { writes, manualAgents: manualAgentsFor(agentIds) };
}

/** Repository-relative client config files that register the tieline server. */
export function detectMcpClientConfigs(root: string): string[] {
  const found: string[] = [];
  for (const target of MCP_CLIENT_TARGETS) {
    const filePath = resolve(root, target.path);
    if (!existsSync(filePath)) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      if (typeof parsed !== "object" || parsed === null) continue;
      const servers = (parsed as Record<string, unknown>)[target.serversKey];
      if (
        typeof servers === "object" &&
        servers !== null &&
        TIELINE_MCP_SERVER_NAME in servers
      ) {
        found.push(target.path);
      }
    } catch {
      // An unreadable client config cannot register the server.
    }
  }
  return found;
}

export interface CodexMcpOutcome {
  status: "registered" | "failed";
  reason: string | null;
  retryCommand: string;
}

function codexMcpAddArgs(root: string): string[] {
  return [
    "mcp",
    "add",
    TIELINE_MCP_SERVER_NAME,
    "--env",
    // Codex configuration is global, so the server can be spawned from any
    // directory and needs the absolute repository path.
    `TIELINE_WORKSPACE=${resolve(root)}`,
    "--",
    ...TIELINE_SERVE_COMMAND,
  ];
}

/**
 * Registers the server through `codex mcp add`, the supported way to reach
 * Codex's global ~/.codex/config.toml. Failure never aborts initialization;
 * the outcome carries the exact command for the user to run themselves.
 */
export async function registerCodexMcpServer(
  root: string,
  runner: SkillfishProcessRunner,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Promise<CodexMcpOutcome> {
  const args = codexMcpAddArgs(root);
  const retryCommand = ["codex", ...args]
    .map((value) => quoteShellArgument(value, platform))
    .join(" ");
  let result;
  try {
    result = await runner({
      command: "codex",
      args,
      cwd: resolve(root),
      env: sanitizedChildEnvironment(env),
      shell: platform === "win32",
      timeoutMs: CODEX_MCP_TIMEOUT_MS,
    });
  } catch {
    return {
      status: "failed",
      reason: "the codex command could not start; is the Codex CLI installed?",
      retryCommand,
    };
  }
  if (result.timedOut) {
    return {
      status: "failed",
      reason: `codex mcp add did not finish within ${CODEX_MCP_TIMEOUT_MS / 1_000} seconds`,
      retryCommand,
    };
  }
  if (result.code !== 0) {
    return {
      status: "failed",
      reason: `codex mcp add exited with code ${result.code}`,
      retryCommand,
    };
  }
  return { status: "registered", reason: null, retryCommand };
}
