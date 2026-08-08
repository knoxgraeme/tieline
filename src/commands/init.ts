import type { EmbeddingProvider } from "../config.js";
import { reloadConfig } from "../config.js";
import {
  renderStatus,
  type TielineCliDependencies,
  type TielineCliIO,
} from "../cli.js";
import {
  confirmChoice,
  intro,
  multiselectChoice,
  outro,
  paletteFor,
  renderBanner,
  renderCopyCallout,
  showNote,
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
  runInitPreflight,
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
  plannedMcpTargets,
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

const EMBEDDING_PROVIDER_OPTIONS = [
  { value: "local", label: "Local gte-small" },
  { value: "openai", label: "OpenAI" },
  { value: "supabase-edge", label: "Supabase Edge Function" },
] as const;

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

function databaseModeLabel(database: DatabaseMode): string {
  if (database === "existing") return "hosted / remote PostgreSQL";
  if (database === "local") return "local PostgreSQL";
  return "offline";
}

function embeddingProviderLabel(provider: EmbeddingProvider): string {
  if (provider === "local") return "local gte-small";
  return (
    EMBEDDING_PROVIDER_OPTIONS.find((option) => option.value === provider)
      ?.label ?? "hash (development only)"
  );
}

function codeScopeLabel(sourceRoots: readonly string[]): string {
  return sourceRoots.length === 1 && sourceRoots[0] === "."
    ? "entire repository"
    : sourceRoots.join(", ");
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
  const merged = mcp.writes.filter((write) => write.status !== "failed");
  const failed = mcp.writes.filter((write) => write.status === "failed");
  const lines: string[] = [];
  if (merged.length > 0) {
    lines.push(
      `MCP server: ${merged
        .map((write) => `${write.path} ${write.status}`)
        .join("; ")}`,
      "MCP tools load when your client starts its next session; the tieline CLI works immediately."
    );
  }
  for (const write of failed) {
    lines.push(
      ui.yellow(
        `MCP server: ${write.path} was left untouched (${write.reason}); add the 'tieline' entry manually.`
      )
    );
  }
  if (codex?.status === "registered") {
    lines.push(
      "MCP server: Codex registered globally via 'codex mcp add'"
    );
  } else if (codex) {
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
  workspace: TielineWorkspace,
  preflight: PreflightCheck[],
  skill: SkillInstallOutcome,
  skillScope: SkillInstallScope | undefined,
  mcp: McpConfigOutcome,
  codex: CodexMcpOutcome | null,
  io: TielineCliIO,
  env: NodeJS.ProcessEnv
): void {
  const ui = paletteFor(io);
  const status = getTielineStatus(workspace, env);
  const modeDescription =
    status.runtime.database_mode === "offline"
      ? "offline — local contract authoring ready"
      : `${databaseModeLabel(status.runtime.database_mode)} — ${status.runtime.setup_complete ? "setup complete" : "setup incomplete"}`;
  const notes: string[] = [];
  if (
    preflight.some(
      (check) => check.key === "repository" && check.status === "warning"
    )
  ) {
    notes.push("Git metadata was not detected");
  }
  const lines = [
    `${ui.green("Workspace:")} ready at ${TIELINE_DIRECTORY}/`,
    `${ui.green("Mode:")} ${modeDescription}`,
    `Code scope: ${codeScopeLabel(workspace.config.repository.source_roots)}`,
    ...renderMcpSummary(mcp, codex, ui),
  ];
  if (notes.length > 0) lines.push(`Readiness notes: ${joinLabels(notes)}`);
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
      `Skill: tieline-author ${skillState} (${skillScope})`,
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
    if (io.interactive && !parsed.yes && (shouldConfigure || skillSelection)) {
      const review = [
        `Workspace: reuse ${existing.directory}`,
        shouldConfigure
          ? `Runtime: configure ${databaseModeLabel(databaseMode)} with ${embeddingProviderLabel(embeddingProvider)} embeddings`
          : "Runtime: keep completed setup",
        ...renderRuntimeRequirements(databaseMode, env),
        ...renderSkillReview(skillSelection),
        ...renderMcpReview(skillSelection),
      ].join("\n");
      await confirmInitReview(io, review);
    }
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
      existing,
      [
        ...runInitPreflight(existing.root, embeddingProvider, preflightEnv),
        ...(await runDatabasePreflight(preflightEnv)),
      ],
      skill,
      skillSelection?.scope,
      mcp,
      codex,
      io,
      env
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

  if (richInteractive) {
    const contextReview = [
      ...(description?.trim() ? ["product description"] : []),
      ...context,
    ];
    await confirmInitReview(
      io,
      [
        `Workspace: create .tieline for ${product} (${repoName})${parsed.product ? "" : " (auto-detected)"}`,
        `Context: ${contextReview.length > 0 ? contextReview.join(", ") : "discover during semantic onboarding"}`,
        `Code scope: ${codeScopeLabel(sourceRoots)}${parsed.sourceRoots.length === 0 ? " (auto-detected)" : ""}`,
        `Runtime: ${databaseModeLabel(database)} with ${embeddingProviderLabel(embedding)} embeddings`,
        ...renderRuntimeRequirements(database, env),
        ...renderSkillReview(skillSelection),
        ...renderMcpReview(skillSelection),
      ].join("\n")
    );
  }
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
    result.workspace,
    [
      ...runInitPreflight(result.workspace.root, embedding, initEnv),
      ...(await runDatabasePreflight(initEnv)),
    ],
    skill,
    skillSelection?.scope,
    mcp,
    codex,
    io,
    env
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

function renderSkillReview(
  selection: SkillInstallSelection | null
): string[] {
  if (!selection) return ["Skill: do not install now"];
  return [
    "Skill: tieline-author (onboarding and authoring)",
    "Skill source: github.com/knoxgraeme/tieline (default branch)",
    `Skill targets: ${joinLabels(selection.agents.map(agentLabel))}`,
    `Skill scope: ${selection.scope}`,
  ];
}

function renderMcpReview(
  selection: SkillInstallSelection | null
): string[] {
  const planned = plannedMcpTargets(selection?.agents ?? []);
  const lines = [
    `MCP: register the 'tieline' server (npx -y tieline serve) in ${planned.paths.join(", ")}`,
  ];
  if (planned.codex) {
    lines.push(
      "MCP: register with Codex globally via 'codex mcp add' (~/.codex/config.toml)"
    );
  }
  if (planned.manualAgents.length > 0) {
    lines.push(
      `MCP: ${joinLabels(planned.manualAgents.map(agentLabel))} require${planned.manualAgents.length === 1 ? "s" : ""} manual MCP registration`
    );
  }
  return lines;
}

function renderRuntimeRequirements(
  database: DatabaseMode,
  env: NodeJS.ProcessEnv
): string[] {
  if (database === "local") {
    return ["Runtime requirement: Docker with PostgreSQL 16 and pgvector"];
  }
  if (database === "existing" && !env.DATABASE_URL_ADMIN?.trim()) {
    return [
      "Runtime requirement: configure DATABASE_URL_ADMIN for PostgreSQL 16 with pgvector",
    ];
  }
  return [];
}

async function confirmInitReview(
  io: TielineCliIO,
  review: string
): Promise<void> {
  await showNote(io, "Review", review);
  if (!(await confirmChoice(io, "Apply this setup?", true))) {
    throw new Error("Cancelled.");
  }
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
