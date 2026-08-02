#!/usr/bin/env node

import "./loadEnv.js";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Interface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { Command, CommanderError, Option } from "commander";
import type { EmbeddingProvider } from "./config.js";
import {
  ask,
  createPalette,
  intro,
  outro,
  paletteFor,
  renderBanner,
} from "./cli-ui.js";
import type { Palette } from "./cli-ui.js";
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
  /** True when attached to a real terminal; enables Clack prompts and color. */
  interactive?: boolean;
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

function renderStatus(status: TielineStatus, ui: Palette): string {
  const state = (ok: boolean, good: string, bad: string): string =>
    ok ? ui.green(good) : ui.yellow(bad);
  return [
    ui.bold(`Tieline: ${status.product} (${status.repo})`),
    `  root: ${status.root}`,
    `  runtime: profile=${state(status.runtime.profile_present, "present", "missing")}, database=${status.runtime.database_mode}, embedding=${status.runtime.embedding_provider}, setup=${state(status.runtime.setup_complete, "complete", "incomplete")}`,
    `  capabilities: semantic_matching=${state(status.capabilities.semantic_matching_configured, "configured", "unconfigured")}, planning_writes=${state(status.capabilities.planning_writes_configured, "configured", "unconfigured")}`,
    `  integration: mcp_template=${state(status.integration.mcp_template_present, "present", "missing")}`,
    `  contract: ${status.contract.stories} Stories, ${status.contract.acceptance_criteria} ACs, manifest=${state(status.contract.manifest_exists, "present", "missing")}`,
    `${ui.cyan("Next:")} ${status.next_action}`,
  ].join("\n");
}

function renderInitSummary(
  workspace: TielineWorkspace,
  preflight: PreflightCheck[],
  io: TielineCliIO,
  env: NodeJS.ProcessEnv
): void {
  const ui = paletteFor(io);
  io.write(
    `Source scope: ${workspace.config.repository.source_roots.join(", ")}\n`
  );
  if (
    workspace.config.repository.source_roots.length === 1 &&
    workspace.config.repository.source_roots[0] === "."
  ) {
    io.write(
      ui.yellow(
        "Warning [source_scope]: no conventional source directory was detected; review repository.source_roots before claiming coverage.\n"
      )
    );
  }
  for (const check of preflight.filter(
    (candidate) => candidate.status === "warning"
  )) {
    io.write(ui.yellow(`Warning [${check.key}]: ${check.message}\n`));
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
    `${ui.cyan("Next:")} invoke MCP prompt \`tieline_author\` (or the bundled /tieline-author skill) to onboard or reconcile behavior.\n`
  );
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
          "base",
          "verify",
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
  env: NodeJS.ProcessEnv
): Promise<number> {
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
      `Tieline is already initialized at ${existing.directory}.\n${renderStatus(getTielineStatus(existing, env), paletteFor(io))}\n`
    );
    return 0;
  }
  const willPrompt =
    !parsed.yes && (!parsed.product || !parsed.repoName);
  if (willPrompt && io.interactive) {
    io.write(`${renderBanner(paletteFor(io))}\n\n`);
  }
  if (willPrompt) await intro(io, "tieline init");
  const detectedProduct = detectProductName(parsed.target);
  const product =
    parsed.product ??
    (parsed.yes
      ? detectedProduct
      : await ask(io, "Company/product name", detectedProduct));
  const detectedRepo = slugifyRepoName(basename(parsed.target));
  const repoName = slugifyRepoName(
    parsed.repoName ??
      (parsed.yes
        ? detectedRepo
        : await ask(io, "Stable repository name", detectedRepo))
  );
  if (willPrompt) {
    await outro(io, `Creating workspace for ${product} (${repoName})`);
  }
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

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

interface ContractActionOptions {
  repo?: string;
  commit?: string;
  output?: string;
  spec?: string;
  expectedPreviousCommit?: string;
  json?: boolean;
  base?: string;
  emitScope?: boolean;
  verify?: string;
  strict?: boolean;
}

function buildProgram(
  io: TielineCliIO,
  env: NodeJS.ProcessEnv,
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
      "\nUse /tieline-author for planning Story/AC writes, implementation, and branch reconciliation."
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
          },
          io,
          env
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
    .description("Validate, review, compile, and sync the living contract");
  const contractAction = (
    name: string,
    description: string
  ): Command => {
    const sub = contract
      .command(name)
      .description(description)
      .argument("[repository]", "repository path")
      .option("--repo <key>", "stable repository key")
      .option("--commit <sha>", "commit recorded in the manifest")
      .option("--output <path>", "output path")
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
  contractAction("coverage", "Report evidence and mapping coverage");
  contractAction("grade", "Grade impacted contract links with agent verdicts")
    .option("--base <ref>", "git base ref to diff against")
    .addOption(
      new Option(
        "--emit-scope",
        "emit the deterministic grading work list"
      ).conflicts("verify")
    )
    .addOption(
      new Option(
        "--verify <verdicts.json>",
        "verify submitted grade verdicts against the derived scope"
      ).conflicts("emitScope")
    )
    .option("--strict", "exit non-zero when an unsupported grade remains");
  contractAction("sync", "Sync the reviewed manifest to the database").option(
    "--expected-previous-commit <sha>",
    "guard against concurrent syncs"
  );

  program
    .command("check")
    .description("Evaluate semantic impact of changes against a base ref")
    .argument("[repository]", "repository path")
    .requiredOption("--base <ref>", "git base ref to diff against")
    .option("--repo <key>", "stable repository key")
    .option("--json", "emit machine-readable JSON")
    .option("--strict", "exit non-zero when the committed manifest is stale")
    .action(async (repository: string | undefined, opts) => {
      const { runCheckCommand } = await import("./commands/check.js");
      setExit(
        await runCheckCommand(
          {
            base: opts.base,
            repository,
            repo: opts.repo,
            json: Boolean(opts.json),
            strict: Boolean(opts.strict),
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
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  let exitCode = 0;
  let commanderErr = "";
  const program = buildProgram(
    io,
    env,
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
