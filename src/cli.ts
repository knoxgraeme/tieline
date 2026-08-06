#!/usr/bin/env node

import "./loadEnv.js";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Interface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { Command, CommanderError, Option } from "commander";
import type { EmbeddingProvider } from "./config.js";
import {
  ask,
  askList,
  askOptional,
  confirmChoice,
  createPalette,
  intro,
  multiselectChoice,
  outro,
  paletteFor,
  renderBanner,
  selectChoice,
  showNote,
} from "./cli-ui.js";
import type { Palette } from "./cli-ui.js";
import {
  detectProductName,
  detectRepositoryName,
  detectSourceRoots,
  initWorkspace,
  slugifyRepoName,
} from "./tieline/init.js";
import {
  resolveEmbeddingProvider,
  runInitPreflight,
  type PreflightCheck,
} from "./tieline/preflight.js";
import {
  DATABASE_PROFILE_ENV_KEYS,
  loadWorkspaceProfileForCommand,
  readWorkspaceProfile,
} from "./tieline/profile.js";
import {
  configureWorkspaceRuntime,
  type DatabaseMode,
} from "./tieline/setup.js";
import {
  installTielineAuthor,
  normalizeSkillAgentIds,
  skippedSkillInstall,
  SUPPORTED_SKILL_AGENTS,
  type SkillAgentId,
  type SkillfishProcessRunner,
  type SkillInstallOutcome,
  type SkillInstallScope,
} from "./tieline/skill-install.js";
import {
  getTielineStatus,
  statusFromPath,
  type TielineStatus,
} from "./tieline/status.js";
import {
  findTielineWorkspace,
  type TielineWorkspace,
} from "./tieline/workspace.js";

export interface TielineCliIO {
  write(message: string): void;
  error(message: string): void;
  question(message: string): Promise<string>;
  /** True when attached to a real terminal; enables Clack prompts and color. */
  interactive?: boolean;
  prompts?: TielineCliPrompts;
}

export interface TielineCliPromptOption {
  value: string;
  label: string;
  hint?: string;
}

export interface TielineCliPrompts {
  text(message: string, defaultValue: string): Promise<string | null>;
  confirm(message: string, initialValue: boolean): Promise<boolean | null>;
  select(
    message: string,
    options: readonly TielineCliPromptOption[],
    initialValue: string
  ): Promise<string | null>;
  multiselect(
    message: string,
    options: readonly TielineCliPromptOption[]
  ): Promise<string[] | null>;
  note(title: string, message: string): void;
}

const packageVersion = (
  JSON.parse(
    readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../package.json"),
      "utf8"
    )
  ) as { version: string }
).version;

async function reloadRuntimeConfig(
  env: NodeJS.ProcessEnv
): Promise<void> {
  const { reloadConfig } = await import("./config.js");
  reloadConfig(env);
}

interface InitOptions {
  target: string;
  product?: string;
  repoName?: string;
  description?: string;
  context: string[];
  sourceRoots: string[];
  ignore: string[];
  database: DatabaseMode;
  databaseExplicit: boolean;
  embedding: EmbeddingProvider;
  embeddingExplicit: boolean;
  yes: boolean;
  skipMigrate: boolean;
  installLocalEmbedder: boolean;
  agents: string[];
  skillScope?: SkillInstallScope;
  skipSkillInstall: boolean;
}

export interface TielineCliDependencies {
  skillfishRunner?: SkillfishProcessRunner;
}

interface SkillInstallSelection {
  agents: SkillAgentId[];
  scope: SkillInstallScope;
}

const DATABASE_MODE_OPTIONS = [
  {
    value: "offline",
    label: "Offline",
    hint: "Local authoring without organization-wide matching",
  },
  {
    value: "local",
    label: "Local PostgreSQL",
    hint: "Docker PostgreSQL with pgvector",
  },
  {
    value: "existing",
    label: "Existing PostgreSQL",
    hint: "Use operator-provided connection URLs",
  },
] as const;

const EMBEDDING_PROVIDER_OPTIONS = [
  { value: "local", label: "Local gte-small" },
  { value: "openai", label: "OpenAI" },
  { value: "supabase-edge", label: "Supabase Edge" },
  { value: "hash", label: "Hash (development only)" },
] as const;

const SKILL_AGENT_OPTIONS = SUPPORTED_SKILL_AGENTS.map((agent) => ({
  value: agent.id,
  label: agent.selector,
}));

const SKILL_SCOPE_OPTIONS = [
  {
    value: "project",
    label: "Project",
    hint: "Install for this repository",
  },
  {
    value: "global",
    label: "Global",
    hint: "Install for your user account",
  },
] as const;

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

function renderStatus(status: TielineStatus, ui: Palette): string {
  const state = (ok: boolean, good: string, bad: string): string =>
    ok ? ui.green(good) : ui.yellow(bad);
  const lines = [
    ui.bold(`Tieline: ${status.product} (${status.repo})`),
    `  root: ${status.root}`,
    `  runtime: profile=${state(status.runtime.profile_present, "present", "missing")}, database=${status.runtime.database_mode}, embedding=${status.runtime.embedding_provider}, setup=${state(status.runtime.setup_complete, "complete", "incomplete")}`,
    `  optional capabilities: organization_matching=${state(status.capabilities.semantic_matching_configured, "configured", "not configured")}, planning_writes=${state(status.capabilities.planning_writes_configured, "configured", "not configured")}`,
    `  integration: mcp_template=${state(status.integration.mcp_template_present, "present", "missing")}`,
    `  contract: ${status.contract.stories} Stories, ${status.contract.acceptance_criteria} ACs, manifest=${state(status.contract.manifest_exists, "present", "missing")}`,
    `${ui.cyan("Next:")} ${status.next_action}`,
  ];
  if (status.onboarding) {
    lines.push(`${ui.cyan("Install skill:")} ${status.onboarding.install_command}`);
  }
  return lines.join("\n");
}

function renderInitSummary(
  workspace: TielineWorkspace,
  preflight: PreflightCheck[],
  skill: SkillInstallOutcome,
  skillScope: SkillInstallScope | undefined,
  io: TielineCliIO,
  env: NodeJS.ProcessEnv
): void {
  const ui = paletteFor(io);
  const status = getTielineStatus(workspace, env);
  const runtimeDescription =
    status.runtime.database_mode === "offline"
      ? "offline — local contract authoring ready"
      : `${status.runtime.database_mode} — ${status.runtime.setup_complete ? "setup complete" : "setup incomplete"}`;
  const optional: string[] = [];
  if (!status.capabilities.semantic_matching_configured) {
    optional.push("organization-wide duplicate checks");
  }
  if (
    preflight.some(
      (check) =>
        check.key === "embedding_provider" && check.status === "warning"
    )
  ) {
    optional.push("semantic search");
  }
  const notes: string[] = [];
  if (workspace.config.repository.source_roots.join(",") === ".") {
    notes.push("review the detected source root before claiming coverage");
  }
  if (
    preflight.some(
      (check) => check.key === "repository" && check.status === "warning"
    )
  ) {
    notes.push("Git metadata was not detected");
  }
  const lines = [
    `${ui.green("Workspace:")} ready at ${workspace.directory}`,
    `${ui.green("Runtime:")} ${runtimeDescription}`,
    `Source roots: ${workspace.config.repository.source_roots.join(", ")}`,
  ];
  if (optional.length > 0) {
    lines.push(
      `Optional capabilities: ${joinLabels(optional)} ${optional.length === 1 ? "is" : "are"} not configured`
    );
  }
  if (notes.length > 0) lines.push(`Readiness notes: ${joinLabels(notes)}`);

  if (skill.status === "installed") {
    const labels = skill.requestedAgents.map(agentLabel);
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
      `${ui.cyan("Next:")} Restart or reload ${joinLabels(labels)}, then use $tieline-author to onboard this repository.`
    );
  } else if (skill.status === "failed") {
    lines.push(
      ui.yellow("Skill: tieline-author installation incomplete"),
      `Reason: ${skill.reason}`,
      `${ui.cyan("Retry:")} ${skill.retryCommand}`
    );
  } else {
    lines.push(
      "Skill: not installed",
      `${ui.cyan("Install later:")} tieline init .`
    );
  }
  io.write(`${lines.join("\n")}\n`);
}

function firstPositional(
  args: string[],
  valueOptions: Set<string>,
  startIndex = 0
): string | undefined {
  for (let index = startIndex; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) return arg;
    const name = arg.slice(2).split("=", 1)[0]!;
    if (!arg.includes("=") && valueOptions.has(name)) index++;
  }
  return undefined;
}

function optionValue(args: string[], option: string): string | undefined {
  const prefix = `--${option}=`;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
    if (arg === `--${option}`) return args[index + 1];
  }
  return undefined;
}

export function workspaceStartForCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv
): string {
  if (command !== "init" && env.TIELINE_WORKSPACE) {
    return env.TIELINE_WORKSPACE;
  }
  if (command === "init") {
    return (
      firstPositional(
        args,
        new Set([
          "product",
          "repo-name",
          "description",
          "context",
          "source-root",
          "ignore",
          "database",
          "embedding",
          "agent",
          "skill-scope",
        ])
      ) ?? process.cwd()
    );
  }
  if (command === "contract") {
    if (args[0] === "criteria") {
      return optionValue(args, "repository") ?? process.cwd();
    }
    return (
      firstPositional(
        args,
        new Set([
          "repo",
          "commit",
          "output",
          "spec",
          "base",
          "expected-previous-commit",
        ]),
        1
      ) ?? process.cwd()
    );
  }
  if (command === "check") {
    return (
      firstPositional(args, new Set(["base", "repo"])) ?? process.cwd()
    );
  }
  if (command === "status") {
    return firstPositional(args, new Set()) ?? process.cwd();
  }
  return process.cwd();
}

async function runInit(
  parsed: InitOptions,
  io: TielineCliIO,
  env: NodeJS.ProcessEnv,
  dependencies: TielineCliDependencies
): Promise<number> {
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
  if (parsed.agents.length > 0) normalizeSkillAgentIds(parsed.agents);
  if (
    parsed.agents.length > 0 &&
    !parsed.skillScope &&
    (parsed.yes || !io.interactive)
  ) {
    throw new Error(
      "--agent requires --skill-scope project|global for non-interactive initialization."
    );
  }

  const existing = findTielineWorkspace(parsed.target);
  let skillSelection: SkillInstallSelection | null = null;

  if (existing) {
    const existingStatus = getTielineStatus(existing, env);
    skillSelection = await resolveSkillSelection(
      parsed,
      io,
      Boolean(io.interactive && !parsed.yes && existingStatus.onboarding)
    );
    const stored = readWorkspaceProfile(existing, env);
    const databaseMode = parsed.databaseExplicit
      ? parsed.database
      : stored?.profile.runtime.database_mode ??
        existing.config.runtime.default_database_mode;
    const embeddingProvider = parsed.embeddingExplicit
      ? parsed.embedding
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
          ? `Runtime: configure ${databaseMode} database and ${embeddingProvider} embeddings`
          : "Runtime: keep completed setup",
        ...renderRuntimeRequirements(databaseMode, env),
        ...renderSkillReview(skillSelection),
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
        env,
        io,
      });
      await reloadRuntimeConfig(env);
    }
    if (!shouldConfigure && !skillSelection) {
      io.write(
        `Tieline is already initialized at ${existing.directory}.\n${renderStatus(existingStatus, paletteFor(io))}\n`
      );
      return 0;
    }
    const skill = await runSkillInstall(
      existing,
      skillSelection,
      env,
      dependencies
    );
    renderInitSummary(
      existing,
      runInitPreflight(
        existing.root,
        embeddingProvider,
        databaseMode === "offline"
          ? withoutDatabaseEnvironment(env)
          : env
      ),
      skill,
      skillSelection?.scope,
      io,
      env
    );
    return skill.status === "failed" ? 1 : 0;
  }

  const richInteractive = Boolean(io.interactive && !parsed.yes);
  const legacyPrompt = Boolean(
    !io.interactive && !parsed.yes && (!parsed.product || !parsed.repoName)
  );
  if (richInteractive) {
    io.write(`${renderBanner(paletteFor(io))}\n\n`);
  }
  if (richInteractive || legacyPrompt) await intro(io, "tieline init");
  const detectedProduct = detectProductName(parsed.target);
  const product =
    parsed.product ??
    (parsed.yes
      ? detectedProduct
      : await ask(io, "Company/product name", detectedProduct));
  const detectedRepo = detectRepositoryName(parsed.target);
  const repoName = slugifyRepoName(
    parsed.repoName ??
      (parsed.yes
        ? detectedRepo
        : await ask(io, "Stable repository name", detectedRepo))
  );
  const description =
    parsed.description ??
    (richInteractive
      ? await askOptional(io, "Product description (optional)")
      : undefined);
  let context = parsed.context;
  if (context.length === 0 && richInteractive) {
    context = await askList(
      io,
      "Additional context paths or URLs (comma-separated)"
    );
  }
  const detectedRoots = detectSourceRoots(parsed.target);
  let sourceRoots = parsed.sourceRoots;
  if (sourceRoots.length === 0) {
    sourceRoots = richInteractive
      ? await askList(io, "Source roots (comma-separated)", detectedRoots)
      : detectedRoots;
  }
  let database = parsed.database;
  if (!parsed.databaseExplicit && richInteractive) {
    database = await selectChoice<DatabaseMode>(
      io,
      "Database mode",
      DATABASE_MODE_OPTIONS,
      database
    );
  }
  let embedding = parsed.embedding;
  if (!parsed.embeddingExplicit && richInteractive) {
    embedding = await selectChoice<EmbeddingProvider>(
      io,
      "Embedding provider",
      EMBEDDING_PROVIDER_OPTIONS,
      embedding
    );
  }

  skillSelection = await resolveSkillSelection(
    parsed,
    io,
    richInteractive
  );

  if (richInteractive) {
    await confirmInitReview(
      io,
      [
        `Workspace: create .tieline for ${product} (${repoName})`,
        `Source roots: ${sourceRoots.join(", ")}`,
        `Runtime: ${database} database and ${embedding} embeddings`,
        ...renderRuntimeRequirements(database, env),
        ...renderSkillReview(skillSelection),
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
    env,
    io,
  });
  await reloadRuntimeConfig(env);
  const skill = await runSkillInstall(
    result.workspace,
    skillSelection,
    env,
    dependencies
  );
  renderInitSummary(
    result.workspace,
    runInitPreflight(result.workspace.root, embedding, initEnv),
    skill,
    skillSelection?.scope,
    io,
    env
  );
  if (richInteractive) await outro(io, "Tieline workspace ready");
  return skill.status === "failed" ? 1 : 0;
}

async function resolveSkillSelection(
  parsed: InitOptions,
  io: TielineCliIO,
  offerInteractive: boolean
): Promise<SkillInstallSelection | null> {
  if (parsed.skipSkillInstall) return null;
  let agents =
    parsed.agents.length > 0
      ? normalizeSkillAgentIds(parsed.agents)
      : [];
  if (agents.length === 0) {
    if (!offerInteractive) return null;
    const install = await confirmChoice(
      io,
      "Install tieline-author for coding agents?",
      true
    );
    if (!install) return null;
    agents = await multiselectChoice<SkillAgentId>(
      io,
      "Coding agents",
      SKILL_AGENT_OPTIONS
    );
    if (agents.length === 0) {
      throw new Error("Select at least one supported agent.");
    }
  }
  const scope =
    parsed.skillScope ??
    (await selectChoice<SkillInstallScope>(
      io,
      "Skill installation scope",
      SKILL_SCOPE_OPTIONS,
      "project"
    ));
  return { agents, scope };
}

function renderSkillReview(
  selection: SkillInstallSelection | null
): string[] {
  if (!selection) return ["Skill: do not install now"];
  return [
    "Skill source: github.com/knoxgraeme/tieline (default branch)",
    `Skill targets: ${joinLabels(selection.agents.map(agentLabel))}`,
    `Skill scope: ${selection.scope}`,
  ];
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

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

interface ContractActionOptions {
  repo?: string;
  commit?: string;
  output?: string;
  spec?: string;
  expectedPreviousCommit?: string;
  base?: string;
  emitScope?: boolean;
  verify?: string;
  strict?: boolean;
  json?: boolean;
  paths?: string[];
}

function buildProgram(
  io: TielineCliIO,
  env: NodeJS.ProcessEnv,
  dependencies: TielineCliDependencies,
  setExit: (code: number) => void,
  writeErr: (message: string) => void
): Command {
  const program = new Command("tieline");
  program
    .description("Tieline living-contract CLI")
    .version(packageVersion)
    .exitOverride()
    .configureOutput({
      writeOut: (message) => io.write(message),
      writeErr,
    })
    .addHelpText("before", () => `${renderBanner(paletteFor(io))}\n\n`)
    .addHelpText(
      "after",
      "\nRun `tieline init` for deterministic setup and optional agent-skill installation. Use $tieline-author for onboarding, planning Story/AC writes, implementation, and branch reconciliation."
    );

  program
    .command("init")
    .description("Create a Tieline workspace or resume runtime setup")
    .argument("[repository]", "repository path", process.cwd())
    .option("--product <name>", "company/product name")
    .option("--repo-name <name>", "stable repository name")
    .option("--description <text>", "product description")
    .option("--context <location>", "context source (repeatable)", collect, [])
    .option("--source-root <path>", "source root (repeatable)", collect, [])
    .option("--ignore <pattern>", "ignore pattern (repeatable)", collect, [])
    .addOption(
      new Option("--database <mode>", "database mode").choices([
        "local",
        "existing",
        "offline",
      ])
    )
    .addOption(
      new Option("--offline", "shorthand for --database offline").conflicts(
        "database"
      )
    )
    .addOption(
      new Option("--embedding <provider>", "embedding provider").choices([
        "local",
        "openai",
        "supabase-edge",
        "hash",
      ])
    )
    .option(
      "--agent <id>",
      `install tieline-author for a supported agent (repeatable: ${SUPPORTED_SKILL_AGENTS.map((agent) => agent.id).join(", ")})`,
      collect,
      []
    )
    .addOption(
      new Option(
        "--skill-scope <scope>",
        "agent skill installation scope"
      ).choices(["project", "global"])
    )
    .option(
      "--skip-skill-install",
      "skip the optional tieline-author installation"
    )
    .option("--yes", "accept detected defaults without prompting")
    .option("--skip-migrate", "skip applying database migrations")
    .option(
      "--install-local-embedder",
      "install the optional local embedding runtime"
    )
    .action(async (repository: string, opts) => {
      setExit(
        await runInit(
          {
            target: resolve(repository),
            product: opts.product,
            repoName: opts.repoName,
            description: opts.description,
            context: opts.context,
            sourceRoots: opts.sourceRoot,
            ignore: opts.ignore,
            database: opts.offline
              ? "offline"
              : ((opts.database as DatabaseMode | undefined) ?? "offline"),
            databaseExplicit: Boolean(opts.offline || opts.database),
            embedding:
              (opts.embedding as EmbeddingProvider | undefined) ??
              resolveEmbeddingProvider(env),
            embeddingExplicit: Boolean(opts.embedding),
            yes: Boolean(opts.yes),
            skipMigrate: Boolean(opts.skipMigrate),
            installLocalEmbedder: Boolean(opts.installLocalEmbedder),
            agents: opts.agent,
            skillScope: opts.skillScope as SkillInstallScope | undefined,
            skipSkillInstall: Boolean(opts.skipSkillInstall),
          },
          io,
          env,
          dependencies
        )
      );
    });

  program
    .command("status")
    .description("Show workspace, runtime, and contract status")
    .argument("[repository]", "repository path", process.cwd())
    .option("--json", "emit machine-readable JSON")
    .action((repository: string, opts) => {
      const status = statusFromPath(repository, env);
      io.write(
        opts.json
          ? `${JSON.stringify(status, null, 2)}\n`
          : `${renderStatus(status, paletteFor(io))}\n`
      );
    });

  const contract = program
    .command("contract")
    .description("Validate, review, compile, query, and sync the living contract");
  const contractAction = (
    name: string,
    description: string
  ): Command => {
    const sub = contract
      .command(name)
      .description(description)
      .argument("[repository]", "repository path")
      .option("--repo <key>", "stable repository key")
      .option(
        "--output <path>",
        "review page file, or manifest directory for every other action"
      )
      .option("--spec <dir>", "spec directory")
      .option("--json", "emit machine-readable JSON");
    sub.action(async (repository: string | undefined, opts) => {
      const { runContractCommand } = await import("./commands/contract.js");
      setExit(
        await runContractCommand(
          name as
            | "validate"
            | "review"
            | "compile"
            | "coverage"
            | "link-review"
            | "reconcile"
            | "criteria"
            | "grade"
            | "sync",
          { repository, ...(opts as ContractActionOptions) },
          io
        )
      );
    });
    return sub;
  };
  contractAction("validate", "Validate accepted contract YAML");
  contractAction("review", "Render a browser review page");
  contractAction("compile", "Compile the contract manifest");
  contractAction(
    "coverage",
    "Report evidence and mapping coverage with confidence tiers"
  );
  contractAction(
    "link-review",
    "Suggest contract links a human should re-read (advisory only)"
  );
  contractAction(
    "reconcile",
    "Report which changed paths the contract already claims (authoring input)"
  ).requiredOption("--base <ref>", "git base ref to diff against");
  contract
    .command("grade")
    .description(
      "Emit changed contract links for agent judgment or verify agent verdicts"
    )
    .argument("[repository]", "repository path")
    .requiredOption("--base <ref>", "git base ref to diff against")
    .addOption(
      new Option("--emit-scope", "emit the deterministic grading work list").conflicts(
        "verify"
      )
    )
    .addOption(
      new Option("--verify <verdicts.json>", "verify submitted agent verdicts").conflicts(
        "emitScope"
      )
    )
    .option("--strict", "exit non-zero when unsupported verdicts remain")
    .option("--repo <key>", "stable repository key")
    .option("--json", "emit machine-readable JSON")
    .action(async (repository: string | undefined, opts) => {
      const { runContractCommand } = await import("./commands/contract.js");
      setExit(
        await runContractCommand(
          "grade",
          {
            repository,
            base: opts.base,
            emitScope: Boolean(opts.emitScope),
            verify: opts.verify,
            strict: Boolean(opts.strict),
            repo: opts.repo,
            json: Boolean(opts.json),
          },
          io
        )
      );
    });
  contractAction("sync", "Sync the reviewed manifest to the database")
    .option("--commit <sha>", "repository commit recorded by this sync")
    .option(
      "--expected-previous-commit <sha>",
      "guard against concurrent syncs"
    );
  // `criteria` takes paths where the other actions take a repository, so it is
  // declared directly instead of through `contractAction`.
  contract
    .command("criteria")
    .description("Report the acceptance criteria for repository-relative paths")
    .argument("<paths...>", "repository-relative paths")
    .option("--repository <path>", "repository path")
    .option("--repo <key>", "stable repository key")
    .option("--json", "emit machine-readable JSON")
    .action(async (paths: string[], opts) => {
      const { runContractCommand } = await import("./commands/contract.js");
      setExit(
        await runContractCommand(
          "criteria",
          {
            paths,
            repository: opts.repository,
            repo: opts.repo,
            json: Boolean(opts.json),
          },
          io
        )
      );
    });

  program
    .command("check")
    .description("Evaluate semantic impact of changes against a base ref")
    .argument("[repository]", "repository path")
    .requiredOption("--base <ref>", "git base ref to diff against")
    .option("--repo <key>", "stable repository key")
    .option("--json", "emit machine-readable JSON")
    .option(
      "--no-fail-on-broken",
      "report broken links as warnings instead of failing"
    )
    .option(
      "--no-fail-on-stale-manifest",
      "report a stale manifest as a warning instead of failing"
    )
    .action(async (repository: string | undefined, opts) => {
      const { runCheckCommand } = await import("./commands/check.js");
      setExit(
        await runCheckCommand(
          {
            base: opts.base,
            repository,
            repo: opts.repo,
            json: Boolean(opts.json),
            failOnBroken: opts.failOnBroken !== false,
            failOnStaleManifest: opts.failOnStaleManifest !== false,
          },
          io
        )
      );
    });

  const profile = program
    .command("profile")
    .description("Manage stored search profiles");
  profile
    .command("list")
    .description("List stored profiles")
    .option("--json", "emit machine-readable JSON")
    .action(async (opts) => {
      const { runProfileListCommand } = await import(
        "./commands/profile.js"
      );
      setExit(await runProfileListCommand({ json: Boolean(opts.json) }, io));
    });
  profile
    .command("put")
    .description("Store a profile definition")
    .requiredOption("--key <key>", "profile key")
    .requiredOption("--file <definition.json>", "profile definition file")
    .requiredOption("--created-by <actor>", "actor recorded on the profile")
    .action(async (opts) => {
      const { runProfilePutCommand } = await import(
        "./commands/profile.js"
      );
      setExit(
        await runProfilePutCommand(
          { key: opts.key, file: opts.file, createdBy: opts.createdBy },
          io
        )
      );
    });

  program
    .command("migrate")
    .description("Apply or verify packaged database migrations")
    .option("--verify", "verify without applying")
    .action(async (opts) => {
      const { runMigrateCommand } = await import("./commands/migrate.js");
      setExit(await runMigrateCommand({ verify: Boolean(opts.verify) }));
    });

  program
    .command("import-help")
    .description("Import help articles from JSON or JSONL")
    .argument("<input>", "articles.json or articles.jsonl")
    .option("--batch-size <n>", "articles per batch (1-200)", "50")
    .action(async (inputPath: string, opts) => {
      const { runImportHelpCommand } = await import(
        "./commands/import-help.js"
      );
      setExit(
        await runImportHelpCommand(inputPath, {
          batchSize: Number(opts.batchSize),
        })
      );
    });

  program
    .command("serve")
    .description("Run the Tieline MCP server")
    .addOption(new Option("--http", "serve over HTTP").conflicts("stdio"))
    .option("--stdio", "serve over stdio")
    .action(async (opts) => {
      const { runServeCommand } = await import("./commands/serve.js");
      setExit(
        await runServeCommand({
          http: Boolean(opts.http),
          stdio: Boolean(opts.stdio),
        })
      );
    });

  return program;
}

export async function runCli(
  argv: string[],
  io: TielineCliIO,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: TielineCliDependencies = {}
): Promise<number> {
  let exitCode = 0;
  let commanderErr = "";
  const program = buildProgram(
    io,
    env,
    dependencies,
    (code) => {
      exitCode = code;
    },
    (message) => {
      commanderErr += message;
    }
  );
  const [command, ...args] = argv;
  if (
    !command ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    program.outputHelp();
    return 0;
  }
  loadWorkspaceProfileForCommand(
    command,
    workspaceStartForCommand(command, args, env),
    env
  );
  await reloadRuntimeConfig(env);
  try {
    await program.parseAsync(argv, { from: "user" });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) return 0;
      if (error.code === "commander.help") {
        io.error(commanderErr);
        return error.exitCode || 1;
      }
      throw new Error(
        (commanderErr.trim() || error.message).replace(/^error: /, "")
      );
    }
    throw error;
  }
}

/**
 * Buffers input lines so answers piped through stdin survive the gap
 * between questions, and rejects (instead of letting the process exit
 * silently) when input ends before an answer arrives.
 */
function createQuestioner(): {
  question(message: string): Promise<string>;
  close(): void;
} {
  let readline: Interface | undefined;
  const buffered: string[] = [];
  let waiter:
    | { resolve: (line: string) => void; reject: (error: Error) => void }
    | undefined;
  let closed = false;
  const endedEarly = () =>
    new Error(
      "Input ended before a response was received; pass flags or --yes for non-interactive runs."
    );
  const ensure = (): void => {
    if (readline) return;
    readline = createInterface({ input, output });
    readline.on("line", (line) => {
      if (waiter) {
        const current = waiter;
        waiter = undefined;
        current.resolve(line);
      } else {
        buffered.push(line);
      }
    });
    readline.on("close", () => {
      closed = true;
      if (waiter) {
        const current = waiter;
        waiter = undefined;
        current.reject(endedEarly());
      }
    });
  };
  return {
    question(message) {
      ensure();
      output.write(message);
      const line = buffered.shift();
      if (line !== undefined) return Promise.resolve(line);
      if (closed) return Promise.reject(endedEarly());
      return new Promise((resolve, reject) => {
        waiter = { resolve, reject };
      });
    },
    close() {
      readline?.close();
    },
  };
}

async function main(): Promise<void> {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const questioner = createQuestioner();
  const io: TielineCliIO = {
    write: (message) => process.stdout.write(message),
    error: (message) => process.stderr.write(message),
    question: (message) => questioner.question(message),
    interactive,
  };
  try {
    process.exitCode = await runCli(process.argv.slice(2), io);
  } catch (error) {
    const ui = createPalette(interactive);
    io.error(
      `${ui.red("Tieline error:")} ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  } finally {
    questioner.close();
  }
}

if (
  process.argv[1] &&
  realpathSync(resolve(process.argv[1])) ===
    fileURLToPath(import.meta.url)
) {
  void main();
}
