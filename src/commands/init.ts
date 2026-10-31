import type { EmbeddingProvider } from "../config.js";
import { reloadConfig } from "../config.js";
import {
  renderStatus,
  type TiepointCliDependencies,
  type TiepointCliIO,
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
  initWorkspace,
  normalizeContextLocations,
  slugifyRepoName,
} from "../tiepoint/init.js";
import {
  inspectRepositorySourceScope,
} from "../tiepoint/source-scope.js";
import {
  resolveEmbeddingProvider,
  runDatabasePreflight,
  type PreflightCheck,
} from "../tiepoint/preflight.js";
import {
  DATABASE_PROFILE_ENV_KEYS,
  loadWorkspaceProfileForCommand,
  readWorkspaceProfile,
} from "../tiepoint/profile.js";
import {
  filesMentioningLegacyName,
  findLegacySkillInstalls,
  legacyEnvironmentKeys,
  removeReplacedLegacySkills,
  replaceLegacyMcpServers,
  upgradeLegacyWorkspace,
  type LegacyWorkspaceUpgrade,
} from "../tiepoint/legacy-tieline.js";
import {
  configureWorkspaceRuntime,
  type DatabaseMode,
} from "../tiepoint/setup.js";
import {
  registerCodexMcpServer,
  writeMcpClientConfigs,
  type CodexMcpOutcome,
  type McpConfigOutcome,
  type RenamedMcpServerOutcome,
} from "../tiepoint/mcp-config.js";
import { TIEPOINT_PACKAGE_SPEC } from "../package-metadata.js";
import { writeWorkspaceReviewPage } from "../tiepoint/review.js";
import {
  detectRepositoryAgents,
  installTiepointSkill,
  normalizeSkillAgentIds,
  runSkillfishProcess,
  skippedSkillInstall,
  SUPPORTED_SKILL_AGENTS,
  type ProjectSkillInstall,
  type SkillAgentId,
  type SkillInstallOutcome,
  type SkillInstallScope,
} from "../tiepoint/skill-install.js";
import {
  getTiepointStatus,
  ONBOARDING_AGENT_INSTRUCTION,
  ONBOARDING_SKILL_INSTALL_COMMAND,
} from "../tiepoint/status.js";
import {
  findTiepointWorkspace,
  TIEPOINT_DIRECTORY,
  type TiepointWorkspace,
} from "../tiepoint/workspace.js";

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
        `MCP server: ${write.path} was left untouched (${write.reason}); add the 'tiepoint' entry manually.`
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
      `MCP server: ${joinLabels(mcp.manualAgents.map(agentLabel))} ${mcp.manualAgents.length === 1 ? "keeps" : "keep"} MCP configuration outside the repository; register 'npx -y ${TIEPOINT_PACKAGE_SPEC} serve' there manually.`
    );
  }
  return lines;
}

function renderSourceScopeAdvisory(
  roots: readonly string[],
  ui: Palette
): string[] {
  if (roots.length === 0) return [];
  return [
    ui.yellow(
      `Source scope: recognized code outside configured roots: ${roots.join(", ")}. Review repository.source_roots in ${TIEPOINT_DIRECTORY}/config.json.`
    ),
  ];
}

async function registerMcpClients(
  root: string,
  selection: SkillInstallSelection | null,
  env: NodeJS.ProcessEnv,
  dependencies: TiepointCliDependencies
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

interface LegacyUpgrade {
  root: string;
  workspace: LegacyWorkspaceUpgrade | null;
  mcp: RenamedMcpServerOutcome;
  skills: ProjectSkillInstall[];
}

/**
 * Upgrades a repository set up under the earlier tieline name. Each step is
 * idempotent, so a later init finishes what an earlier one left behind, such
 * as a skill that was not reinstalled.
 */
function upgradeLegacySetup(
  target: string,
  env: NodeJS.ProcessEnv
): LegacyUpgrade | null {
  const workspace = upgradeLegacyWorkspace(target, env);
  if (workspace?.movedProfile) {
    // The CLI loads profiles before dispatching init, when this one was
    // still under the earlier configuration home.
    loadWorkspaceProfileForCommand("init", target, env);
    reloadConfig(env);
  }
  const root = findTiepointWorkspace(target)?.root;
  if (!root) return null;
  const mcp = replaceLegacyMcpServers(root);
  const skills = findLegacySkillInstalls(root);
  if (
    !workspace &&
    mcp.replaced.length === 0 &&
    mcp.unrecognized.length === 0 &&
    skills.length === 0
  ) {
    return null;
  }
  return { root, workspace, mcp, skills };
}

/** Reinstalls the skill for agents that had the earlier one unless told otherwise. */
function withLegacySkillAgents(
  parsed: InitOptions,
  upgrade: LegacyUpgrade | null
): InitOptions {
  if (!upgrade || parsed.skipSkillInstall || parsed.agents.length > 0) {
    return parsed;
  }
  const agents = [...new Set(upgrade.skills.map((skill) => skill.agentId))];
  return agents.length > 0 ? { ...parsed, agents } : parsed;
}

function removeLegacySkills(
  upgrade: LegacyUpgrade | null,
  selection: SkillInstallSelection | null,
  skill: SkillInstallOutcome
): string[] {
  if (!upgrade || selection?.scope !== "project" || skill.status !== "installed") {
    return [];
  }
  return removeReplacedLegacySkills(upgrade.root, upgrade.skills, [
    ...skill.installedAgents,
    ...skill.alreadyPresentAgents,
  ]);
}

function renderLegacyUpgrade(
  upgrade: LegacyUpgrade | null,
  removedSkills: readonly string[],
  env: NodeJS.ProcessEnv,
  ui: Palette
): string[] {
  const done: string[] = [];
  const followUps: string[] = [];
  if (upgrade?.workspace) {
    const { movedProfile, retainedProfile, topologyCommitted } =
      upgrade.workspace;
    done.push(`  Workspace: moved .tieline/ to ${TIEPOINT_DIRECTORY}/`);
    if (movedProfile) done.push(`  Profile: moved to ${movedProfile.to}`);
    if (retainedProfile) {
      followUps.push(
        `The tieline profile at ${retainedProfile.path} was not moved because ${retainedProfile.reason}.`
      );
    }
    const compile = [
      `\`npx -y ${TIEPOINT_PACKAGE_SPEC} contract compile .\``,
      ...(topologyCommitted
        ? [`\`npx -y ${TIEPOINT_PACKAGE_SPEC} code compile .\``]
        : []),
    ].join(" and ");
    followUps.push(
      `Run ${compile}, then commit the move to ${TIEPOINT_DIRECTORY}/.`
    );
  }
  if (upgrade && upgrade.mcp.replaced.length > 0) {
    done.push(`  MCP: replaced the tieline server in ${upgrade.mcp.replaced.join(", ")}`);
  }
  if (upgrade && upgrade.mcp.unrecognized.length > 0) {
    followUps.push(
      `Point the custom tieline MCP entry in ${upgrade.mcp.unrecognized.join(", ")} at tiepoint.`
    );
  }
  if (removedSkills.length > 0) {
    done.push(`  Skill: replaced tieline at ${removedSkills.join(", ")}`);
  }
  const remainingSkills = (upgrade?.skills ?? []).filter(
    (skill) => !removedSkills.includes(skill.path)
  );
  if (remainingSkills.length > 0) {
    followUps.push(
      `The tieline skill remains at ${remainingSkills.map((skill) => skill.path).join(", ")}; rerun init with --agent to replace it.`
    );
  }
  const legacyKeys = legacyEnvironmentKeys(env);
  if (legacyKeys.length > 0) {
    followUps.push(
      `Rename environment variables that are no longer read: ${legacyKeys
        .map((key) => `${key} to ${key.replace(/^TIELINE_/, "TIEPOINT_")}`)
        .join(", ")}.`
    );
  }
  if (upgrade) {
    const mentions = filesMentioningLegacyName(upgrade.root);
    if (mentions.length > 0) {
      followUps.push(`Update tieline references in ${mentions.join(", ")}.`);
    }
  }
  if (upgrade?.workspace) {
    followUps.push(
      "Registrations outside the repository are unchanged: run `codex mcp remove tieline` if Codex has one, and remove any global tieline skill."
    );
  }
  if (done.length === 0 && followUps.length === 0) return [];
  return [
    ...(done.length > 0 ? [ui.green("Upgraded from tieline:"), ...done] : []),
    ...(followUps.length > 0
      ? [ui.yellow("To finish the rename:"), ...followUps.map((line) => `  - ${line}`)]
      : []),
    "",
  ];
}

interface InitSummary {
  preflight: PreflightCheck[];
  skill: SkillInstallOutcome;
  mcp: McpConfigOutcome;
  codex: CodexMcpOutcome | null;
  sourceScopeAdvisoryRoots: readonly string[];
}

function renderInitSummary(
  summary: InitSummary,
  io: TiepointCliIO
): void {
  const ui = paletteFor(io);
  const lines = [
    `${ui.green("Workspace:")} ready at ${TIEPOINT_DIRECTORY}/`,
    ...renderMcpSummary(summary.mcp, summary.codex, ui),
    ...renderSourceScopeAdvisory(
      summary.sourceScopeAdvisoryRoots,
      ui
    ),
  ];
  for (const check of summary.preflight) {
    if (
      check.status === "warning" &&
      DATABASE_PREFLIGHT_KEYS.has(check.key)
    ) {
      lines.push(ui.yellow(`Database: ${check.message}`));
    }
  }

  if (summary.skill.status === "installed") {
    const installed = summary.skill.installedAgents.map(agentLabel);
    const alreadyPresent = summary.skill.alreadyPresentAgents.map(agentLabel);
    const skillState = [
      ...(installed.length > 0
        ? [`installed for ${joinLabels(installed)}`]
        : []),
      ...(alreadyPresent.length > 0
        ? [`already present for ${joinLabels(alreadyPresent)}`]
        : []),
    ].join("; ");
    lines.push(
      `Skill: tiepoint ${skillState}`,
      "",
      ui.bold("Next steps"),
      "  1. Restart or reload your agent.",
      `  2. ${ONBOARDING_AGENT_INSTRUCTION}`
    );
  } else if (summary.skill.status === "failed") {
    lines.push(
      ui.yellow("Skill: tiepoint installation incomplete"),
      `Reason: ${summary.skill.reason}`,
      "",
      ui.bold("Next step"),
      "  Retry the install by running:",
      "",
      ...renderCopyCallout(
        ui,
        summary.skill.retryCommand ?? ONBOARDING_SKILL_INSTALL_COMMAND
      )
    );
  } else {
    lines.push(
      "Skill: not installed",
      "",
      ui.bold("Next step"),
      "  Install the tiepoint skill by running:",
      "",
      ...renderCopyCallout(ui, ONBOARDING_SKILL_INSTALL_COMMAND)
    );
  }
  io.write(`${lines.join("\n")}\n`);
}

export async function runInit(
  parsed: InitOptions,
  io: TiepointCliIO,
  env: NodeJS.ProcessEnv,
  dependencies: TiepointCliDependencies
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

  const upgrade = upgradeLegacySetup(parsed.target, env);
  const existing = findTiepointWorkspace(parsed.target);
  let skillSelection: SkillInstallSelection | null = null;

  if (existing) {
    const sourceScopeAdvisoryRoots = inspectRepositorySourceScope(
      existing.root,
      existing.config.repository.source_roots,
      existing.config.repository.ignore
    );
    const existingStatus = getTiepointStatus(existing, env);
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
    skillSelection = await resolveSkillSelection(
      withLegacySkillAgents(parsed, upgrade),
      io,
      Boolean(existingStatus.onboarding || shouldConfigure),
      env
    );
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
      io.write(`${[
        ...renderLegacyUpgrade(upgrade, [], env, ui),
        `Tiepoint is already initialized at ${existing.directory}.`,
        ...mcpLines,
        ...renderSourceScopeAdvisory(sourceScopeAdvisoryRoots, ui),
        renderStatus(getTiepointStatus(existing, env), ui),
      ].join("\n")}\n`);
      return 0;
    }
    const skill = await runSkillInstall(
      existing,
      skillSelection,
      env,
      dependencies
    );
    const removedLegacySkills = removeLegacySkills(
      upgrade,
      skillSelection,
      skill
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
    const legacyLines = renderLegacyUpgrade(
      upgrade,
      removedLegacySkills,
      env,
      paletteFor(io)
    );
    if (legacyLines.length > 0) io.write(`${legacyLines.join("\n")}\n`);
    renderInitSummary({
      preflight: await runDatabasePreflight(preflightEnv),
      skill,
      mcp,
      codex,
      sourceScopeAdvisoryRoots,
    }, io);
    return skill.status === "failed" ? 1 : 0;
  }

  const richInteractive = Boolean(io.interactive && !parsed.yes);
  if (richInteractive) {
    io.write(`${renderBanner(paletteFor(io))}\n\n`);
    await intro(io, "tiepoint init");
  }
  const product = parsed.product ?? detectProductName(parsed.target);
  const repoName = slugifyRepoName(
    parsed.repoName ?? detectRepositoryName(parsed.target)
  );
  const description = parsed.description;
  const context = normalizeContextLocations(parsed.target, parsed.context);
  const database = parsed.database;

  skillSelection = await resolveSkillSelection(
    parsed,
    io,
    true,
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
    sourceRoots:
      parsed.sourceRoots.length > 0 ? parsed.sourceRoots : undefined,
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
  // Close the Clack flow before the summary so the direct skill invocation is
  // the last thing on screen rather than trailing into the flow's end cap.
  if (richInteractive) await outro(io, "Tiepoint workspace ready");
  renderInitSummary({
    preflight: await runDatabasePreflight(initEnv),
    skill,
    mcp,
    codex,
    sourceScopeAdvisoryRoots: result.sourceScopeAdvisoryRoots,
  }, io);
  return skill.status === "failed" ? 1 : 0;
}

async function resolveSkillSelection(
  parsed: InitOptions,
  io: TiepointCliIO,
  requireSelection: boolean,
  env: NodeJS.ProcessEnv
): Promise<SkillInstallSelection | null> {
  if (parsed.skipSkillInstall) return null;
  let agents =
    parsed.agents.length > 0
      ? normalizeSkillAgentIds(parsed.agents)
      : [];
  if (agents.length === 0) {
    if (!requireSelection) return null;
    if (!io.interactive || parsed.yes) {
      throw new Error(
        "Non-interactive init requires at least one --agent <id>, or --skip-skill-install."
      );
    }
    agents = await multiselectChoice<SkillAgentId>(
      io,
      "Where should Tiepoint install its onboarding and authoring skill?",
      SKILL_AGENT_OPTIONS,
      detectRepositoryAgents(parsed.target, env)
    );
    if (agents.length === 0) {
      throw new Error(
        "Select at least one agent, or rerun with --skip-skill-install."
      );
    }
  }
  return { agents, scope: parsed.skillScope ?? "project" };
}

async function runSkillInstall(
  workspace: TiepointWorkspace,
  selection: SkillInstallSelection | null,
  env: NodeJS.ProcessEnv,
  dependencies: TiepointCliDependencies
): Promise<SkillInstallOutcome> {
  if (!selection) return skippedSkillInstall();
  return installTiepointSkill(
    {
      workspaceRoot: workspace.root,
      agentIds: selection.agents,
      scope: selection.scope,
      env,
    },
    dependencies.skillfishRunner
  );
}
