import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { z } from "zod";

export const SUPPORTED_SKILL_AGENTS = [
  { id: "claude-code", selector: "Claude Code" },
  { id: "codex", selector: "Codex" },
  { id: "cursor", selector: "Cursor" },
  { id: "gemini-cli", selector: "Gemini CLI" },
  { id: "github-copilot", selector: "GitHub Copilot" },
  { id: "opencode", selector: "OpenCode" },
  { id: "windsurf", selector: "Windsurf" },
] as const;

export type SkillAgentId = (typeof SUPPORTED_SKILL_AGENTS)[number]["id"];
export type SkillInstallScope = "project" | "global";

export interface SkillfishInvocation {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface SkillfishProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type SkillfishProcessRunner = (
  invocation: SkillfishInvocation
) => Promise<SkillfishProcessResult>;

export interface SkillInstallOptions {
  workspaceRoot: string;
  agentIds: readonly string[];
  scope: SkillInstallScope;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export interface SkillInstallOutcome {
  status: "installed" | "skipped" | "failed";
  requestedAgents: SkillAgentId[];
  installedAgents: SkillAgentId[];
  alreadyPresentAgents: SkillAgentId[];
  reason: string | null;
  retryCommand: string | null;
}

const agentById = new Map(
  SUPPORTED_SKILL_AGENTS.map((agent) => [agent.id, agent])
);
const agentIdBySelector = new Map<string, SkillAgentId>(
  SUPPORTED_SKILL_AGENTS.map((agent) => [agent.selector, agent.id])
);

const SAFE_CHILD_ENV_KEYS = [
  "PATH",
  "Path",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "NPM_CONFIG_REGISTRY",
  "npm_config_registry",
  "NPM_CONFIG_CACHE",
  "npm_config_cache",
  "NPM_CONFIG_CAFILE",
  "npm_config_cafile",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  "DO_NOT_TRACK",
  "CI",
] as const;

const installedSkillSchema = z
  .object({
    skill: z.string().min(1),
    agent: z.string().min(1),
    path: z.string().min(1),
    location: z.enum(["global", "project"]).optional(),
  })
  .strict();

const skippedSkillSchema = z
  .object({
    skill: z.string().min(1),
    agent: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

const skillfishOutputSchema = z
  .object({
    success: z.boolean(),
    exit_code: z.number().int(),
    errors: z.array(z.string()),
    installed: z.array(installedSkillSchema),
    skipped: z.array(skippedSkillSchema),
    skills_found: z.array(z.string()).optional(),
  })
  .strict();

function normalizedAgents(agentIds: readonly string[]): Array<{
  id: SkillAgentId;
  selector: string;
}> {
  const seen = new Set<SkillAgentId>();
  const agents: Array<{ id: SkillAgentId; selector: string }> = [];
  for (const candidate of agentIds) {
    const agent = agentById.get(candidate as SkillAgentId);
    if (!agent) throw new Error(`Unsupported agent '${candidate}'.`);
    if (seen.has(agent.id)) continue;
    seen.add(agent.id);
    agents.push(agent);
  }
  if (agents.length === 0) {
    throw new Error("Select at least one supported agent for skill installation.");
  }
  return agents;
}

function sanitizedChildEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const key of SAFE_CHILD_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) sanitized[key] = value;
  }
  return sanitized;
}

export function buildSkillfishInvocation(
  options: SkillInstallOptions
): SkillfishInvocation {
  const agents = normalizedAgents(options.agentIds);
  const platform = options.platform ?? process.platform;
  const args = [
    "--yes",
    "--package=skillfish@latest",
    "skillfish",
    "add",
    "knoxgraeme/tieline",
    "--path",
    "skills/tieline-author",
  ];
  for (const agent of agents) args.push("--agent", agent.selector);
  args.push(options.scope === "project" ? "--project" : "--global");
  args.push("--yes", "--json");
  return {
    command: platform === "win32" ? "npx.cmd" : "npx",
    args,
    cwd: resolve(options.workspaceRoot),
    env: sanitizedChildEnvironment(options.env ?? process.env),
  };
}

function quoteShellArgument(value: string, platform: NodeJS.Platform): string {
  if (/^[A-Za-z0-9_./:\\-]+$/.test(value)) return value;
  if (platform === "win32") return `"${value.replaceAll('"', '""')}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function renderSkillInstallRetryCommand(
  options: SkillInstallOptions
): string {
  const agents = normalizedAgents(options.agentIds);
  const platform = options.platform ?? process.platform;
  const args = [
    "tieline",
    "init",
    resolve(options.workspaceRoot),
    "--yes",
  ];
  for (const agent of agents) args.push("--agent", agent.id);
  args.push("--skill-scope", options.scope);
  return args.map((value) => quoteShellArgument(value, platform)).join(" ");
}

export function skippedSkillInstall(): SkillInstallOutcome {
  return {
    status: "skipped",
    requestedAgents: [],
    installedAgents: [],
    alreadyPresentAgents: [],
    reason: "Skill installation was not requested.",
    retryCommand: null,
  };
}

async function runSkillfishProcess(
  invocation: SkillfishInvocation
): Promise<SkillfishProcessResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) =>
      resolveResult({ code: code ?? 1, stdout, stderr })
    );
  });
}

function failedOutcome(
  requestedAgents: SkillAgentId[],
  retryCommand: string,
  reason: string,
  installedAgents: SkillAgentId[] = [],
  alreadyPresentAgents: SkillAgentId[] = []
): SkillInstallOutcome {
  return {
    status: "failed",
    requestedAgents,
    installedAgents,
    alreadyPresentAgents,
    reason,
    retryCommand,
  };
}

export async function installTielineAuthor(
  options: SkillInstallOptions,
  runner: SkillfishProcessRunner = runSkillfishProcess
): Promise<SkillInstallOutcome> {
  const requestedAgents = normalizedAgents(options.agentIds).map(
    (agent) => agent.id
  );
  const retryCommand = renderSkillInstallRetryCommand(options);
  const invocation = buildSkillfishInvocation(options);
  let processResult: SkillfishProcessResult;
  try {
    processResult = await runner(invocation);
  } catch {
    return failedOutcome(
      requestedAgents,
      retryCommand,
      "Skillfish could not start. Ensure Node.js and npx are available."
    );
  }
  if (processResult.code !== 0) {
    return failedOutcome(
      requestedAgents,
      retryCommand,
      `Skillfish exited with code ${processResult.code}.`
    );
  }
  if (!processResult.stdout.trim()) {
    return failedOutcome(
      requestedAgents,
      retryCommand,
      "Skillfish did not return JSON output."
    );
  }

  let rawOutput: unknown;
  try {
    rawOutput = JSON.parse(processResult.stdout);
  } catch {
    return failedOutcome(
      requestedAgents,
      retryCommand,
      "Skillfish did not return valid JSON."
    );
  }
  const parsed = skillfishOutputSchema.safeParse(rawOutput);
  if (!parsed.success) {
    return failedOutcome(
      requestedAgents,
      retryCommand,
      "Skillfish did not return valid Skillfish JSON."
    );
  }
  if (!parsed.data.success || parsed.data.exit_code !== 0) {
    return failedOutcome(
      requestedAgents,
      retryCommand,
      "Skillfish reported an unsuccessful installation."
    );
  }

  const installedAgents = parsed.data.installed
    .filter((item) => item.skill === "tieline-author")
    .map((item) => agentIdBySelector.get(item.agent))
    .filter((id): id is SkillAgentId => id !== undefined);
  const alreadyPresentAgents = parsed.data.skipped
    .filter(
      (item) =>
        item.skill === "tieline-author" && /already|exist/i.test(item.reason)
    )
    .map((item) => agentIdBySelector.get(item.agent))
    .filter((id): id is SkillAgentId => id !== undefined);
  const accountedFor = new Set([...installedAgents, ...alreadyPresentAgents]);
  if (requestedAgents.some((agent) => !accountedFor.has(agent))) {
    return failedOutcome(
      requestedAgents,
      retryCommand,
      "Skillfish did not account for every requested agent.",
      installedAgents,
      alreadyPresentAgents
    );
  }
  return {
    status: "installed",
    requestedAgents,
    installedAgents,
    alreadyPresentAgents,
    reason: null,
    retryCommand: null,
  };
}
