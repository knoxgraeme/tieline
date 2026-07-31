#!/usr/bin/env node

import "./loadEnv.js";
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import type { EmbeddingProvider } from "./config.js";
import {
  detectProductName,
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
}

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
}

function optionValue(args: string[], index: number, name: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`--${name} requires a value.`);
  }
  return value;
}

function parseInit(
  args: string[],
  env: NodeJS.ProcessEnv
): InitOptions {
  let target: string | undefined;
  let product: string | undefined;
  let repoName: string | undefined;
  let description: string | undefined;
  let database: DatabaseMode = "offline";
  let databaseExplicit = false;
  let embedding = resolveEmbeddingProvider(env);
  let embeddingExplicit = false;
  const context: string[] = [];
  const sourceRoots: string[] = [];
  const ignore: string[] = [];
  let yes = false;
  let skipMigrate = false;
  let installLocalEmbedder = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) {
      if (target) throw new Error("tieline init accepts one repository path.");
      target = arg;
      continue;
    }
    if (arg === "--yes") {
      yes = true;
      continue;
    }
    if (arg === "--offline") {
      database = "offline";
      databaseExplicit = true;
      continue;
    }
    if (arg === "--skip-migrate") {
      skipMigrate = true;
      continue;
    }
    if (arg === "--install-local-embedder") {
      installLocalEmbedder = true;
      continue;
    }
    const [name, inline] = arg.slice(2).split("=", 2);
    if (
      ![
        "product",
        "repo-name",
        "description",
        "context",
        "source-root",
        "ignore",
        "database",
        "embedding",
      ].includes(name)
    ) {
      throw new Error(`Unknown init option: --${name}`);
    }
    const value = inline ?? optionValue(args, index, name);
    if (inline === undefined) index++;
    if (name === "product") product = value;
    if (name === "repo-name") repoName = value;
    if (name === "description") description = value;
    if (name === "context") context.push(value);
    if (name === "source-root") sourceRoots.push(value);
    if (name === "ignore") ignore.push(value);
    if (name === "database") {
      if (!["local", "existing", "offline"].includes(value)) {
        throw new Error("--database must be local, existing, or offline.");
      }
      database = value as DatabaseMode;
      databaseExplicit = true;
    }
    if (name === "embedding") {
      if (
        !["local", "openai", "supabase-edge", "hash"].includes(value)
      ) {
        throw new Error(
          "--embedding must be local, openai, supabase-edge, or hash."
        );
      }
      embedding = value as EmbeddingProvider;
      embeddingExplicit = true;
    }
  }
  return {
    target: resolve(target ?? process.cwd()),
    product,
    repoName,
    description,
    context,
    sourceRoots,
    ignore,
    database,
    databaseExplicit,
    embedding,
    embeddingExplicit,
    yes,
    skipMigrate,
    installLocalEmbedder,
  };
}

function withoutDatabaseEnvironment(
  env: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const isolated = { ...env };
  for (const key of DATABASE_PROFILE_ENV_KEYS) {
    delete isolated[key];
  }
  return isolated;
}

function renderStatus(status: TielineStatus): string {
  return [
    `Tieline: ${status.product} (${status.repo})`,
    `  root: ${status.root}`,
    `  runtime: profile=${status.runtime.profile_present ? "present" : "missing"}, database=${status.runtime.database_mode}, embedding=${status.runtime.embedding_provider}, setup=${status.runtime.setup_complete ? "complete" : "incomplete"}`,
    `  capabilities: semantic_matching=${status.capabilities.semantic_matching_configured ? "configured" : "unconfigured"}, planning_writes=${status.capabilities.planning_writes_configured ? "configured" : "unconfigured"}`,
    `  integration: mcp_template=${status.integration.mcp_template_present ? "present" : "missing"}`,
    `  contract: ${status.contract.stories} Stories, ${status.contract.acceptance_criteria} ACs, manifest=${status.contract.manifest_exists ? "present" : "missing"}`,
    `Next: ${status.next_action}`,
  ].join("\n");
}

function renderInitSummary(
  workspace: TielineWorkspace,
  preflight: PreflightCheck[],
  io: TielineCliIO,
  env: NodeJS.ProcessEnv
): void {
  io.write(
    `Source scope: ${workspace.config.repository.source_roots.join(", ")}\n`
  );
  if (
    workspace.config.repository.source_roots.length === 1 &&
    workspace.config.repository.source_roots[0] === "."
  ) {
    io.write(
      "Warning [source_scope]: no conventional source directory was detected; review repository.source_roots before claiming coverage.\n"
    );
  }
  for (const check of preflight.filter(
    (candidate) => candidate.status === "warning"
  )) {
    io.write(`Warning [${check.key}]: ${check.message}\n`);
  }
  const status = getTielineStatus(workspace, env);
  if (status.contract.stories === 0) {
    io.write(
      "Semantic onboarding has not started: the empty spec is intentional until repository-specific capabilities, Stories, and ACs are authored.\n"
    );
  }
  io.write(
    "MCP template: register `.tieline/mcp.json` with your host and ensure its `tieline` command resolves this package.\n"
  );
  io.write(
    "Next: invoke MCP prompt `tieline_author` (or the bundled /tieline-author skill) to onboard or reconcile behavior.\n"
  );
}

function printHelp(io: TielineCliIO): void {
  io.write(`Tieline living-contract CLI

Usage:
  tieline init [repository] [options]
  tieline status [repository] [--json]
  tieline contract <validate|review|compile|coverage|sync> [repository] [options]
  tieline check --base <ref> [repository] [--json]
  tieline profile <list|put> [options]
  tieline migrate [--verify]
  tieline import-help <articles.json|articles.jsonl> [--batch-size 50]
  tieline serve [--http|--stdio]

Use /tieline-author for planning Story/AC writes, implementation, and branch reconciliation.
`);
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
        ])
      ) ?? process.cwd()
    );
  }
  if (command === "contract") {
    return (
      firstPositional(
        args,
        new Set([
          "repo",
          "commit",
          "output",
          "spec",
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
  args: string[],
  io: TielineCliIO,
  env: NodeJS.ProcessEnv
): Promise<number> {
  const parsed = parseInit(args, env);
  const existing = findTielineWorkspace(parsed.target);
  if (existing) {
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
    if (shouldConfigure) {
      env.EMBEDDING_PROVIDER = embeddingProvider;
      const runtime = await configureWorkspaceRuntime({
        workspace: existing,
        databaseMode,
        embeddingProvider,
        installLocalEmbedder: parsed.installLocalEmbedder,
        skipMigrate: parsed.skipMigrate,
        env,
        io,
      });
      await reloadRuntimeConfig(env);
      io.write(`Completed Tieline runtime setup at ${existing.directory}.\n`);
      io.write(`Private runtime profile: ${runtime.profilePath}\n`);
      renderInitSummary(
        existing,
        runInitPreflight(
          existing.root,
          embeddingProvider,
          databaseMode === "offline"
            ? withoutDatabaseEnvironment(env)
            : env
        ),
        io,
        env
      );
      return 0;
    }
    io.write(
      `Tieline is already initialized at ${existing.directory}.\n${renderStatus(getTielineStatus(existing, env))}\n`
    );
    return 0;
  }
  const detectedProduct = detectProductName(parsed.target);
  const product =
    parsed.product ??
    (parsed.yes
      ? detectedProduct
      : (await io.question(`Company/product name [${detectedProduct}]: `)).trim() ||
        detectedProduct);
  const detectedRepo = slugifyRepoName(basename(parsed.target));
  const repoName = slugifyRepoName(
    parsed.repoName ??
      (parsed.yes
        ? detectedRepo
        : (await io.question(`Stable repository name [${detectedRepo}]: `)).trim() ||
          detectedRepo)
  );
  env.EMBEDDING_PROVIDER = parsed.embedding;
  const initEnv =
    parsed.database === "offline"
      ? withoutDatabaseEnvironment(env)
      : env;
  const result = initWorkspace({
    targetPath: parsed.target,
    productName: product,
    repoName,
    description: parsed.description,
    contextLocations: parsed.context,
    sourceRoots:
      parsed.sourceRoots.length > 0
        ? parsed.sourceRoots
        : detectSourceRoots(parsed.target),
    ignore: parsed.ignore.length > 0 ? parsed.ignore : undefined,
    databaseMode: parsed.database,
    env: initEnv,
  });
  const runtime = await configureWorkspaceRuntime({
    workspace: result.workspace,
    databaseMode: parsed.database,
    embeddingProvider: parsed.embedding,
    installLocalEmbedder: parsed.installLocalEmbedder,
    skipMigrate: parsed.skipMigrate,
    env,
    io,
  });
  await reloadRuntimeConfig(env);
  io.write(`Created ${result.workspace.directory}\n`);
  io.write(`Contract directory: ${result.workspace.specDirectoryPath}\n`);
  io.write(`Private runtime profile: ${runtime.profilePath}\n`);
  renderInitSummary(result.workspace, result.preflight, io, env);
  return 0;
}

function parseStatusArgs(args: string[]): {
  path: string;
  json: boolean;
} {
  const positionals = args.filter((arg) => !arg.startsWith("--"));
  if (positionals.length > 1) {
    throw new Error("tieline status accepts one repository path.");
  }
  const unknown = args.filter(
    (arg) => arg.startsWith("--") && arg !== "--json"
  );
  if (unknown[0]) throw new Error(`Unknown status option: ${unknown[0]}`);
  return {
    path: positionals[0] ?? process.cwd(),
    json: args.includes("--json"),
  };
}

export async function runCli(
  argv: string[],
  io: TielineCliIO,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const [command, ...args] = argv;
  if (
    !command ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    printHelp(io);
    return 0;
  }
  loadWorkspaceProfileForCommand(
    command,
    workspaceStartForCommand(command, args, env),
    env
  );
  await reloadRuntimeConfig(env);

  if (command === "init") return runInit(args, io, env);
  if (command === "status") {
    const parsed = parseStatusArgs(args);
    const status = statusFromPath(parsed.path, env);
    io.write(
      parsed.json
        ? `${JSON.stringify(status, null, 2)}\n`
        : `${renderStatus(status)}\n`
    );
    return 0;
  }
  if (command === "contract") {
    const { runContractCommand } = await import("./commands/contract.js");
    return runContractCommand(args, io);
  }
  if (command === "check") {
    const { runCheckCommand } = await import("./commands/check.js");
    return runCheckCommand(args, io);
  }
  if (command === "profile") {
    const { runProfileCommand } = await import("./commands/profile.js");
    return runProfileCommand(args, io);
  }
  if (command === "migrate") {
    const { runMigrateCommand } = await import("./commands/migrate.js");
    return runMigrateCommand(args);
  }
  if (command === "import-help") {
    const { runImportHelpCommand } = await import(
      "./commands/import-help.js"
    );
    return runImportHelpCommand(args);
  }
  if (command === "serve") {
    const { runServeCommand } = await import("./commands/serve.js");
    return runServeCommand(args);
  }
  throw new Error(`Unknown command '${command}'. Run \`tieline --help\`.`);
}

async function main(): Promise<void> {
  const readline = createInterface({ input, output });
  const io: TielineCliIO = {
    write: (message) => process.stdout.write(message),
    error: (message) => process.stderr.write(message),
    question: (message) => readline.question(message),
  };
  try {
    process.exitCode = await runCli(process.argv.slice(2), io);
  } catch (error) {
    io.error(
      `Tieline error: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  } finally {
    readline.close();
  }
}

if (
  process.argv[1] &&
  realpathSync(resolve(process.argv[1])) ===
    fileURLToPath(import.meta.url)
) {
  void main();
}
