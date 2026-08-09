import type { EmbeddingProvider } from "../config.js";
import { reloadConfig } from "../config.js";
import {
  renderStatus,
  type TielineCliDependencies,
  type TielineCliIO,
} from "../cli.js";
import {
  intro,
  multiselectChoice,
  outro,
  paletteFor,
  renderBanner,
  renderCopyCallout,
} from "../cli-ui.js";
import type { Palette } from "../cli-ui.js";
import {
  detectProductName,
  detectRepositoryName,
  detectSourceRoots,
  initWorkspace,
  normalizeContextLocations,
  slugifyRepoName,
} from "../tieline/init.js";
import {
  resolveEmbeddingProvider,
  runDatabasePreflight,
  type PreflightCheck,
} from "../tieline/preflight.js";
import {
  DATABASE_PROFILE_ENV_KEYS,
  readWorkspaceProfile,
} from "../tieline/profile.js";
import {
  configureWorkspaceRuntime,
  type DatabaseMode,
} from "../tieline/setup.js";
import {
  registerCodexMcpServer,
  writeMcpClientConfigs,
  type CodexMcpOutcome,
  type McpConfigOutcome,
} from "../tieline/mcp-config.js";
import { writeWorkspaceReviewPage } from "../tieline/review.js";
import {
  detectRepositoryAgents,
  installTielineAuthor,
  normalizeSkillAgentIds,
  runSkillfishProcess,
  skippedSkillInstall,
  SUPPORTED_SKILL_AGENTS,
  type SkillAgentId,
  type SkillInstallOutcome,
  type SkillInstallScope,
} from "../tieline/skill-install.js";
import {
  getTielineStatus,
  ONBOARDING_AGENT_PROMPT,
} from "../tieline/status.js";
import {
  findTielineWorkspace,
  TIELINE_DIRECTORY,
  type TielineWorkspace,
} from "../tieline/workspace.js";

export interface InitOptions {
  target: string;
  product?: string;
  repoName?: string;
  description?: string;
  context: string[];
  sourceRoots: string[];
  ignore: string[];
  database: DatabaseMode;
  databaseExplicit: boolean;
  embedding?: EmbeddingProvider;
  embeddingExplicit: boolean;
  yes: boolean;
  skipMigrate: boolean;
  installLocalEmbedder: boolean;
  provisionRoles: boolean;
  agents: string[];
  skillScope?: SkillInstallScope;
  skipSkillInstall: boolean;
}

interface SkillInstallSelection {
  agents: SkillAgentId[];
  scope: SkillInstallScope;
}

const SKILL_AGENT_OPTIONS = SUPPORTED_SKILL_AGENTS.map((agent) => ({
  value: agent.id,
  label: agent.selector,
}));

const DATABASE_PREFLIGHT_KEYS = new Set([
  "database_connection",
  "pgvector",
  "migrations",
]);

function withoutDatabaseEnvironment(
  env: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const isolated = { ...env };
  for (const key of DATABASE_PROFILE_ENV_KEYS) {
    delete isolated[key];
  }
  return isolated;
}

function agentLabel(agentId: SkillAgentId): string {
  return (
    SUPPORTED_SKILL_AGENTS.find((agent) => agent.id === agentId)?.selector ??
    agentId
  );
}

function joinLabels(values: readonly string[]): string {
  if (values.length < 2) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function renderMcpSummary(
  mcp: McpConfigOutcome,
  codex: CodexMcpOutcome | null,
  ui: Palette
): string[] {
  const configured = mcp.writes.some((write) => write.status !== "failed");
  const failed = mcp.writes.filter((write) => write.status === "failed");
  const lines: string[] = [];
  if (configured || codex?.status === "registered") {
    lines.push("MCP: configured");
  }
  for (const write of failed) {
    lines.push(
      ui.yellow(
        `MCP server: ${write.path} was left untouched (${write.reason}); add the 'tieline' entry manually.`
      )
    );
  }
  if (codex && codex.status !== "registered") {
    lines.push(
      ui.yellow(
        `MCP server: Codex registration failed (${codex.reason}); run: ${codex.retryCommand}`
      )
    );
  }
  if (mcp.manualAgents.length > 0) {
    lines.push(
      `MCP server: ${joinLabels(mcp.manualAgents.map(agentLabel))} ${mcp.manualAgents.length === 1 ? "keeps" : "keep"} MCP configuration outside the repository; register 'npx -y tieline serve' there manually.`
    );
  }
  return lines;
}

async function registerMcpClients(
  root: string,
  selection: SkillInstallSelection | null,
  env: NodeJS.ProcessEnv,
  dependencies: TielineCliDependencies
): Promise<{ mcp: McpConfigOutcome; codex: CodexMcpOutcome | null }> {
  const agents = selection?.agents ?? [];
  const mcp = writeMcpClientConfigs(root, agents);
  const codex = agents.includes("codex")
    ? await registerCodexMcpServer(
        root,
        dependencies.mcpCliRunner ?? runSkillfishProcess,
        env
      )
    : null;
  return { mcp, codex };
}

function renderInitSummary(
  preflight: PreflightCheck[],
  skill: SkillInstallOutcome,
  mcp: McpConfigOutcome,
  codex: CodexMcpOutcome | null,
  io: TielineCliIO
): void {
  const ui = paletteFor(io);
  const lines = [
    `${ui.green("Workspace:")} ready at ${TIELINE_DIRECTORY}/`,
    ...renderMcpSummary(mcp, codex, ui),
  ];
  for (const check of preflight) {
    if (
      check.status === "warning" &&
      DATABASE_PREFLIGHT_KEYS.has(check.key)
    ) {
      lines.push(ui.yellow(`Database: ${check.message}`));
    }
  }

  if (skill.status === "installed") {
    const installed = skill.installedAgents.map(agentLabel);
    const alreadyPresent = skill.alreadyPresentAgents.map(agentLabel);
    const skillState = [
      ...(installed.length > 0
        ? [`installed for ${joinLabels(installed)}`]
        : []),
      ...(alreadyPresent.length > 0
        ? [`already present for ${joinLabels(alreadyPresent)}`]
        : []),
    ].join("; ");
    lines.push(
      `Skill: tieline-author ${skillState}`,
      "",
      ui.bold("Next steps"),
      "  1. Restart or reload your agent.",
      "  2. Copy the prompt below and paste it to your agent.",
      "",
      ...renderCopyCallout(ui, ONBOARDING_AGENT_PROMPT)
    );
  } else if (skill.status === "failed") {
    lines.push(
      ui.yellow("Skill: tieline-author installation incomplete"),
      `Reason: ${skill.reason}`,
      "",
      ui.bold("Next step"),
      "  Retry the install by running:",
      "",
      ...renderCopyCallout(ui, skill.retryCommand ?? "tieline init .")
    );
  } else {
    lines.push(
      "Skill: not installed",
      "",
      ui.bold("Next step"),
      "  Install the tieline-author skill by running:",
      "",
      ...renderCopyCallout(ui, "tieline init .")
    );
  }
  io.write(`${lines.join("\n")}\n`);
}

export async function runInit(
  parsed: InitOptions,
  io: TielineCliIO,
  env: NodeJS.ProcessEnv,
  dependencies: TielineCliDependencies
): Promise<number> {
  const embedding = parsed.embedding ?? resolveEmbeddingProvider(env);
  if (
    parsed.skipSkillInstall &&
    (parsed.agents.length > 0 || parsed.skillScope)
  ) {
    throw new Error(
      "--skip-skill-install cannot be combined with --agent or --skill-scope."
    );
  }
  if (parsed.skillScope && parsed.agents.length === 0) {
    throw new Error("--skill-scope requires at least one --agent.");
  }
  if (
    parsed.provisionRoles &&
    !(parsed.databaseExplicit && parsed.database === "existing")
  ) {
    throw new Error("--provision-roles requires --database existing.");
  }
  if (parsed.agents.length > 0) normalizeSkillAgentIds(parsed.agents);

  const existing = findTielineWorkspace(parsed.target);
  let skillSelection: SkillInstallSelection | null = null;

  if (existing) {
    const existingStatus = getTielineStatus(existing, env);
    skillSelection = await resolveSkillSelection(
      parsed,
      io,
      Boolean(io.interactive && !parsed.yes && existingStatus.onboarding),
      env
    );
    const stored = readWorkspaceProfile(existing, env);
    const databaseMode = parsed.databaseExplicit
      ? parsed.database
      : stored?.profile.runtime.database_mode ??
        existing.config.runtime.default_database_mode;
    const embeddingProvider = parsed.embeddingExplicit
      ? embedding
      : stored?.profile.runtime.embedding_provider ??
        existing.config.runtime.default_embedding_provider;
    const shouldConfigure =
      !stored?.profile.runtime.setup_completed_at ||
      parsed.databaseExplicit ||
      parsed.embeddingExplicit ||
      parsed.installLocalEmbedder;
    if (shouldConfigure) {
      env.EMBEDDING_PROVIDER = embeddingProvider;
      await configureWorkspaceRuntime({
        workspace: existing,
        databaseMode,
        embeddingProvider,
        installLocalEmbedder: parsed.installLocalEmbedder,
        skipMigrate: parsed.skipMigrate,
        provisionRoles: parsed.provisionRoles,
        env,
        io,
      });
      reloadConfig(env);
    }
    if (!shouldConfigure && !skillSelection) {
      const ui = paletteFor(io);
      const { mcp } = await registerMcpClients(
        existing.root,
        null,
        env,
        dependencies
      );
      writeWorkspaceReviewPage(
        existing.root,
        existing.config.product.repo_name
      );
      const mcpLines = renderMcpSummary(mcp, null, ui);
      io.write(
        `Tieline is already initialized at ${existing.directory}.\n${mcpLines.length > 0 ? `${mcpLines.join("\n")}\n` : ""}${renderStatus(getTielineStatus(existing, env), ui)}\n`
      );
      return 0;
    }
    const skill = await runSkillInstall(
      existing,
      skillSelection,
      env,
      dependencies
    );
    const { mcp, codex } = await registerMcpClients(
      existing.root,
      skillSelection,
      env,
      dependencies
    );
    writeWorkspaceReviewPage(
      existing.root,
      existing.config.product.repo_name
    );
    const preflightEnv =
      databaseMode === "offline" ? withoutDatabaseEnvironment(env) : env;
    renderInitSummary(
      await runDatabasePreflight(preflightEnv),
      skill,
      mcp,
      codex,
      io
    );
    return skill.status === "failed" ? 1 : 0;
  }

  const richInteractive = Boolean(io.interactive && !parsed.yes);
  if (richInteractive) {
    io.write(`${renderBanner(paletteFor(io))}\n\n`);
    await intro(io, "tieline init");
  }
  const product = parsed.product ?? detectProductName(parsed.target);
  const repoName = slugifyRepoName(
    parsed.repoName ?? detectRepositoryName(parsed.target)
  );
  const description = parsed.description;
  const context = normalizeContextLocations(parsed.target, parsed.context);
  const sourceRoots =
    parsed.sourceRoots.length > 0
      ? parsed.sourceRoots
      : detectSourceRoots(parsed.target);
  const database = parsed.database;

  skillSelection = await resolveSkillSelection(
    parsed,
    io,
    richInteractive,
    env
  );

  env.EMBEDDING_PROVIDER = embedding;
  const initEnv =
    database === "offline"
      ? withoutDatabaseEnvironment(env)
      : env;
  const result = initWorkspace({
    targetPath: parsed.target,
    productName: product,
    repoName,
    description,
    contextLocations: context,
    sourceRoots,
    ignore: parsed.ignore.length > 0 ? parsed.ignore : undefined,
    databaseMode: database,
    env: initEnv,
  });
  await configureWorkspaceRuntime({
    workspace: result.workspace,
    databaseMode: database,
    embeddingProvider: embedding,
    installLocalEmbedder: parsed.installLocalEmbedder,
    skipMigrate: parsed.skipMigrate,
    provisionRoles: parsed.provisionRoles,
    env,
    io,
  });
  reloadConfig(env);
  const skill = await runSkillInstall(
    result.workspace,
    skillSelection,
    env,
    dependencies
  );
  const { mcp, codex } = await registerMcpClients(
    result.workspace.root,
    skillSelection,
    env,
    dependencies
  );
  writeWorkspaceReviewPage(
    result.workspace.root,
    result.workspace.config.product.repo_name
  );
  // Close the Clack flow before the summary so the paste-ready prompt is the
  // last thing on screen rather than trailing into the flow's end cap.
  if (richInteractive) await outro(io, "Tieline workspace ready");
  renderInitSummary(
    await runDatabasePreflight(initEnv),
    skill,
    mcp,
    codex,
    io
  );
  return skill.status === "failed" ? 1 : 0;
}

async function resolveSkillSelection(
  parsed: InitOptions,
  io: TielineCliIO,
  offerInteractive: boolean,
  env: NodeJS.ProcessEnv
): Promise<SkillInstallSelection | null> {
  if (parsed.skipSkillInstall) return null;
  let agents =
    parsed.agents.length > 0
      ? normalizeSkillAgentIds(parsed.agents)
      : [];
  if (agents.length === 0) {
    if (!offerInteractive) return null;
    agents = await multiselectChoice<SkillAgentId>(
      io,
      "Where should Tieline install its onboarding and authoring skill?",
      SKILL_AGENT_OPTIONS,
      detectRepositoryAgents(parsed.target, env)
    );
    // Deselecting everything is a choice, not an error: initialize the
    // workspace without pushing the skill into any agent.
    if (agents.length === 0) return null;
  }
  return { agents, scope: parsed.skillScope ?? "project" };
}

async function runSkillInstall(
  workspace: TielineWorkspace,
  selection: SkillInstallSelection | null,
  env: NodeJS.ProcessEnv,
  dependencies: TielineCliDependencies
): Promise<SkillInstallOutcome> {
  if (!selection) return skippedSkillInstall();
  return installTielineAuthor(
    {
      workspaceRoot: workspace.root,
      agentIds: selection.agents,
      scope: selection.scope,
      env,
    },
    dependencies.skillfishRunner
  );
}
