#!/usr/bin/env node

import "./loadEnv.js";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reloadConfig, type EmbeddingProvider, type StoryApprovalMode } from "./config.js";
import {
  detectProductName,
  detectSourceRoots,
  initWorkspace,
  slugifyRepoName,
  writeWorkspaceMcpConfig,
} from "./tieline/init.js";
import { resolveEmbeddingProvider, runDatabasePreflight } from "./tieline/preflight.js";
import { loadWorkspaceProfile } from "./tieline/profile.js";
import { configureWorkspaceRuntime, type DatabaseMode } from "./tieline/setup.js";
import { getTielineStatus, statusFromPath, type TielineStatus } from "./tieline/status.js";
import {
  approveProductContext,
  findTielineWorkspace,
} from "./tieline/workspace.js";

export interface TielineCliIO {
  write(message: string): void;
  error(message: string): void;
  question(message: string): Promise<string>;
}

interface ParsedOptions {
  positionals: string[];
  values: Map<string, string[]>;
  flags: Set<string>;
}

const VALUE_OPTIONS = new Set([
  "product",
  "repo-name",
  "description",
  "context",
  "source-root",
  "ignore",
  "database",
  "embedding",
  "approval",
]);
const BOOLEAN_OPTIONS = new Set([
  "yes",
  "force",
  "json",
  "prune",
  "help",
  "skip-db-check",
  "skip-migrate",
  "install-local-embedder",
  "offline",
]);

function parseOptions(args: string[]): ParsedOptions {
  const parsed: ParsedOptions = { positionals: [], values: new Map(), flags: new Set() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      parsed.positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    if (BOOLEAN_OPTIONS.has(name)) {
      if (eq !== -1) throw new Error(`--${name} does not take a value.`);
      parsed.flags.add(name);
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) throw new Error(`Unknown option: --${name}`);
    const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} requires a value.`);
    parsed.values.set(name, [...(parsed.values.get(name) ?? []), value]);
  }
  return parsed;
}

function first(parsed: ParsedOptions, name: string): string | undefined {
  return parsed.values.get(name)?.[0];
}

function splitList(value: string): string[] {
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

async function askWithDefault(io: TielineCliIO, prompt: string, fallback: string): Promise<string> {
  const answer = (await io.question(`${prompt} [${fallback}]: `)).trim();
  return answer || fallback;
}

async function confirm(io: TielineCliIO, prompt: string): Promise<boolean> {
  const answer = (await io.question(`${prompt} [y/N]: `)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

async function choose<T extends string>(
  io: TielineCliIO,
  prompt: string,
  options: Array<{ value: T; label: string }>,
  fallback: T
): Promise<T> {
  io.write(`${prompt}\n`);
  options.forEach((option, index) => io.write(`  ${index + 1}. ${option.label}\n`));
  const fallbackIndex = options.findIndex((option) => option.value === fallback) + 1;
  const answer = (await io.question(`Choose [${fallbackIndex}]: `)).trim();
  if (!answer) return fallback;
  const index = Number(answer) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= options.length) {
    throw new Error(`Choose a number from 1 to ${options.length}.`);
  }
  return options[index].value;
}

function selectedDatabaseMode(parsed: ParsedOptions, fallback: DatabaseMode): DatabaseMode {
  if (parsed.flags.has("offline") && first(parsed, "database")) {
    throw new Error("Use either --offline or --database, not both.");
  }
  const value = parsed.flags.has("offline") ? "offline" : first(parsed, "database") ?? fallback;
  if (value !== "local" && value !== "existing" && value !== "offline") {
    throw new Error("--database must be local, existing, or offline.");
  }
  return value;
}

function selectedEmbeddingProvider(parsed: ParsedOptions, fallback: EmbeddingProvider): EmbeddingProvider {
  const value = first(parsed, "embedding") ?? fallback;
  if (value !== "local" && value !== "openai" && value !== "supabase-edge" && value !== "hash") {
    throw new Error("--embedding must be local, openai, supabase-edge, or hash.");
  }
  return value;
}

function selectedApprovalMode(parsed: ParsedOptions, fallback: StoryApprovalMode): StoryApprovalMode {
  const value = first(parsed, "approval") ?? fallback;
  if (value !== "production" && value !== "all" && value !== "off") {
    throw new Error("--approval must be production, all, or off.");
  }
  return value;
}

function commandArtifactPath(command: string, args: string[]): string | undefined {
  if (command !== "import" && command !== "import-help") return args.find((arg) => !arg.startsWith("--"));
  return args.find(
    (arg, index) => !arg.startsWith("--") && args[index - 1] !== "--batch-size"
  );
}

function withoutDatabaseEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const isolated = { ...env };
  for (const key of [
    "DATABASE_URL",
    "DATABASE_URL_INGEST",
    "DATABASE_URL_WRITE",
    "DATABASE_URL_APPROVAL",
    "SUPABASE_DB_URL",
    "SUPABASE_DB_URL_INGEST",
    "SUPABASE_DB_URL_WRITE",
  ]) {
    delete isolated[key];
  }
  return isolated;
}

function renderStatus(status: TielineStatus): string {
  return [
    `Tieline: ${status.product} (${status.repo})`,
    `  root: ${status.root}`,
    `  runtime: database=${status.runtime.database_mode}, embedding=${status.runtime.embedding_provider}, approval=${status.runtime.approval_mode}, setup=${status.runtime.setup_complete ? "complete" : "incomplete"}`,
    `  product context: ${status.context.status}`,
    `  coverage: ${status.coverage.status} (${status.coverage.areas_examined} areas examined, ${status.coverage.uncertain_areas} uncertain; current: ${status.coverage.product_context_current ? "yes" : "no"})`,
    `  shards: ${status.shards.count} (${status.shards.stories} stories, ${status.shards.unreadable} unreadable; merged: ${status.shards.merged ? "yes" : "no"})`,
    `  stories: ${status.draft.stories} (${status.draft.approved} approved, ${status.draft.pending} pending, ${status.draft.rejected} rejected)`,
    `  context matches draft: ${status.draft.product_context_current ? "yes" : "no"}`,
    `  import: ${status.import.status ?? "not run"}${status.import.report_exists ? ` (current: ${status.import.current ? "yes" : "no"})` : ""}`,
    `Next: ${status.next_action}`,
  ].join("\n");
}

function printInitHelp(io: TielineCliIO): void {
  io.write(`Usage: tieline init [repository] [options]

Create a local .tieline/ workspace for agent-assisted product-context and story backfill.

Options:
  --product <name>          Combined company/product name
  --repo-name <slug>       Stable code-asset and import identity
  --description <text>     Initial product description
  --context <url-or-path>  Context source; repeatable
  --source-root <path>     Source root relative to repository; repeatable
  --ignore <path>          Ignored path; repeatable
  --yes                    Accept detected defaults without prompts
  --force                  Replace an existing .tieline/ workspace
  --database <mode>        local, existing, or offline
  --offline                Alias for --database offline
  --embedding <provider>   local, openai, supabase-edge, or hash
  --approval <mode>        production (default), all, or off
  --install-local-embedder Install the optional local embedding runtime
  --skip-migrate           Save configuration without applying database migrations
  --skip-db-check          Do not connect to configured ingest database during preflight
  --json                    Print machine-readable output
`);
}

function printHelp(io: TielineCliIO): void {
  io.write(`Tieline user-story mapping CLI

Usage:
  tieline init [repository] [options]
  tieline status [repository] [--json]
  tieline context approve [repository] [--yes] [--json]
  tieline merge [repository] [--prune] [--json]
  tieline migrate [--verify]
  tieline review [stories.draft.json]
  tieline import [stories.draft.json] [--all] [--batch-size 50]
  tieline import-help <articles.json|articles.jsonl> [--batch-size 50]
  tieline serve [--http|--stdio]

Run \`tieline init --help\` for init options.
`);
}

async function runInit(args: string[], io: TielineCliIO, env: NodeJS.ProcessEnv): Promise<number> {
  const parsed = parseOptions(args);
  if (parsed.flags.has("help")) {
    printInitHelp(io);
    return 0;
  }
  if (parsed.positionals.length > 1) throw new Error("tieline init accepts at most one repository path.");
  const targetPath = resolve(parsed.positionals[0] ?? process.cwd());
  const existing = findTielineWorkspace(targetPath);
  const reusableWorkspace =
    existing && existing.root === targetPath && !parsed.flags.has("force") ? existing : null;
  const reuseExisting = Boolean(reusableWorkspace);
  const runtimeRequested =
    parsed.flags.has("offline") ||
    parsed.flags.has("install-local-embedder") ||
    parsed.flags.has("skip-migrate") ||
    Boolean(first(parsed, "database") || first(parsed, "embedding") || first(parsed, "approval"));
  if (reusableWorkspace?.config.runtime.setup_completed_at && !runtimeRequested) {
    const status = getTielineStatus(reusableWorkspace);
    if (parsed.flags.has("json")) io.write(`${JSON.stringify({ created: false, status }, null, 2)}\n`);
    else {
      io.write(`Tieline is already initialized at ${reusableWorkspace.directory}. Resuming existing workspace.\n`);
      io.write(`${renderStatus(status)}\n`);
    }
    return 0;
  }

  const detectedProduct = detectProductName(targetPath);
  const nonInteractive = parsed.flags.has("yes");
  const productName =
    first(parsed, "product") ??
    (reuseExisting
      ? reusableWorkspace!.config.product.name
      : nonInteractive
        ? detectedProduct
        : await askWithDefault(io, "Company/product name", detectedProduct));
  const detectedRepo = slugifyRepoName(basename(targetPath));
  const repoName = slugifyRepoName(
    first(parsed, "repo-name") ??
      (reuseExisting
        ? reusableWorkspace!.config.product.repo_name
        : nonInteractive
          ? detectedRepo
          : await askWithDefault(io, "Stable repository name", detectedRepo))
  );
  const description =
    first(parsed, "description") ??
    (nonInteractive || reuseExisting
      ? undefined
      : (await io.question("Short product description (optional): ")).trim() || undefined);
  let contexts = parsed.values.get("context") ?? [];
  if (!nonInteractive && !reuseExisting && contexts.length === 0) {
    contexts = splitList(
      await io.question("Marketing/help URLs or local context paths, comma-separated (optional): ")
    );
  }
  let sourceRoots = parsed.values.get("source-root") ?? [];
  if (!nonInteractive && !reuseExisting && sourceRoots.length === 0) {
    const detected = detectSourceRoots(targetPath).join(",");
    sourceRoots = splitList(await askWithDefault(io, "Source roots", detected));
  }

  const envProvider = resolveEmbeddingProvider(env);
  const envApproval = selectedApprovalMode(
    parsed,
    (env.STORY_APPROVAL_MODE as StoryApprovalMode) ||
      reusableWorkspace?.config.runtime.approval_mode ||
      "production"
  );
  let databaseMode = selectedDatabaseMode(
    parsed,
    reuseExisting ? reusableWorkspace!.config.runtime.database_mode : "offline"
  );
  let embeddingProvider = selectedEmbeddingProvider(
    parsed,
    reuseExisting ? reusableWorkspace!.config.runtime.embedding_provider : envProvider
  );
  let approvalMode = envApproval;
  if (!nonInteractive) {
    if (!first(parsed, "database") && !parsed.flags.has("offline")) {
      databaseMode = await choose(
        io,
        "Database setup",
        [
          { value: "local", label: "Local Docker PostgreSQL + pgvector — Tieline runs the container for you (recommended)" },
          { value: "existing", label: "Connect your own PostgreSQL + pgvector — no Docker; reads DATABASE_URL_INGEST from the environment (Neon, Supabase, RDS, or any host)" },
          { value: "offline", label: "Offline workspace only; connect a database later" },
        ],
        reuseExisting ? databaseMode : env.DATABASE_URL_INGEST ? "existing" : "local"
      );
    }
    if (!first(parsed, "embedding")) {
      embeddingProvider = await choose(
        io,
        "Embedding provider (one 384-dimension provider must be used for ingest and search)",
        [
          { value: "local", label: "Local gte-small runtime (recommended, large optional install)" },
          { value: "openai", label: "OpenAI-compatible endpoint" },
          { value: "supabase-edge", label: "Existing Supabase embedding edge function" },
          { value: "hash", label: "Hash fallback (tests only; no semantic search)" },
        ],
        embeddingProvider
      );
    }
    if (!first(parsed, "approval")) {
      approvalMode = await choose(
        io,
        "Story write approval policy",
        [
          { value: "production", label: "Require approval for production-sensitive changes (recommended)" },
          { value: "all", label: "Require approval for every story mutation" },
          { value: "off", label: "Auto-apply through the separate approver credential" },
        ],
        envApproval
      );
    }
  }
  const installLocalEmbedder =
    embeddingProvider === "local" &&
    (parsed.flags.has("install-local-embedder") ||
      (!nonInteractive && (await confirm(io, "Install the optional local embedding runtime now?"))));

  env.EMBEDDING_PROVIDER = embeddingProvider;
  env.STORY_APPROVAL_MODE = approvalMode;

  if (!nonInteractive) {
    io.write(
      `\nTieline will ${reuseExisting ? "resume" : "create"} ${resolve(targetPath, ".tieline")} for ` +
        `'${productName}' (${repoName}); database=${databaseMode}, embedding=${embeddingProvider}, approval=${approvalMode}.\n`
    );
    if (!(await confirm(io, parsed.flags.has("force") ? "Replace the existing workspace?" : "Continue?"))) {
      io.write("Initialization cancelled.\n");
      return 0;
    }
  }

  const initEnv = databaseMode === "offline" ? withoutDatabaseEnvironment(env) : env;
  const result = initWorkspace({
    targetPath,
    productName,
    repoName,
    description,
    contextLocations: contexts,
    sourceRoots: sourceRoots.length ? sourceRoots : undefined,
    ignore: parsed.values.get("ignore"),
    force: parsed.flags.has("force"),
    databaseMode,
    approvalMode,
    env: initEnv,
  });
  writeWorkspaceMcpConfig(result.workspace);
  const runtime = await configureWorkspaceRuntime({
    workspace: result.workspace,
    databaseMode,
    embeddingProvider,
    approvalMode,
    installLocalEmbedder,
    skipMigrate: parsed.flags.has("skip-migrate"),
    env,
    io,
  });
  reloadConfig(env);
  const preflight = parsed.flags.has("skip-db-check") || databaseMode === "offline"
    ? result.preflight
    : [...result.preflight, ...(await runDatabasePreflight(env))];
  const status = getTielineStatus(result.workspace);
  if (parsed.flags.has("json")) {
    io.write(`${JSON.stringify({ created: result.created, profile: runtime.profilePath, preflight, status }, null, 2)}\n`);
    return 0;
  }

  io.write(`\nCreated ${result.workspace.directory}\n`);
  for (const check of preflight) {
    io.write(`  ${check.status === "pass" ? "ok" : "warn"}  ${check.message}\n`);
  }
  io.write(`\nAgent handoff: ${result.workspace.handoffPath}\n`);
  io.write(`MCP config: ${result.workspace.mcpConfigPath}\n`);
  io.write(`Private runtime profile: ${runtime.profilePath}\n`);
  io.write("Next: ask your coding agent to follow .tieline/AGENT_HANDOFF.md.\n");
  return 0;
}

async function runMerge(args: string[], io: TielineCliIO): Promise<number> {
  const parsed = parseOptions(args);
  if (parsed.positionals.length > 1) throw new Error("tieline merge accepts at most one repository path.");
  const workspace = findTielineWorkspace(parsed.positionals[0] ?? process.cwd());
  if (!workspace) throw new Error("No .tieline/config.json found.");
  const { mergeShards } = await import("./tieline/merge.js");
  const result = mergeShards(workspace, { prune: parsed.flags.has("prune") });
  const status = getTielineStatus(workspace);
  if (parsed.flags.has("json")) {
    io.write(`${JSON.stringify({ merge: result, status }, null, 2)}\n`);
    return 0;
  }
  io.write(`Merged ${result.shards.length} shard(s) into ${result.draft_path}\n`);
  for (const shard of result.shards) {
    io.write(`  ${shard.shard}: ${shard.stories} stories, ${shard.sections} sections\n`);
  }
  io.write(
    `\n${result.stories} stories in ${result.sections} sections ` +
      `(${result.approved} approved, ${result.pending} pending, ${result.rejected} rejected).\n`
  );
  if (result.preserved > 0) io.write(`Kept ${result.preserved} existing review decision(s).\n`);
  if (result.dropped.length > 0) io.write(`Pruned ${result.dropped.length} story/stories no shard produces.\n`);
  for (const duplicate of result.duplicate_titles) {
    io.write(
      `  warn  '${duplicate.title}' appears ${duplicate.ids.length}x in section ` +
        `'${duplicate.section_key}' (${duplicate.ids.join(", ")})\n`
    );
  }
  io.write(`Next: ${status.next_action}\n`);
  return 0;
}

async function runStatus(args: string[], io: TielineCliIO): Promise<number> {
  const parsed = parseOptions(args);
  if (parsed.positionals.length > 1) throw new Error("tieline status accepts at most one repository path.");
  const status = statusFromPath(parsed.positionals[0] ?? process.cwd());
  io.write(parsed.flags.has("json") ? `${JSON.stringify(status, null, 2)}\n` : `${renderStatus(status)}\n`);
  return 0;
}

async function runContext(args: string[], io: TielineCliIO): Promise<number> {
  const action = args[0];
  if (action !== "approve") throw new Error("Usage: tieline context approve [repository] [--yes] [--json]");
  const parsed = parseOptions(args.slice(1));
  if (parsed.positionals.length > 1) throw new Error("context approve accepts at most one repository path.");
  const workspace = findTielineWorkspace(parsed.positionals[0] ?? process.cwd());
  if (!workspace) throw new Error("No .tieline/config.json found.");
  if (!parsed.flags.has("yes")) {
    const approved = await confirm(
      io,
      `Has a human reviewed and approved ${workspace.config.product.name}'s product context?`
    );
    if (!approved) {
      io.write("Context remains draft.\n");
      return 0;
    }
  }
  const checksum = approveProductContext(workspace);
  const status = getTielineStatus(workspace);
  if (parsed.flags.has("json")) io.write(`${JSON.stringify({ checksum, status }, null, 2)}\n`);
  else {
    io.write(`Product context approved.\nChecksum: ${checksum}\n`);
    io.write("Next: have the agent generate .tieline/stories.draft.json using this checksum.\n");
  }
  return 0;
}

export async function runCli(
  argv: string[],
  io: TielineCliIO,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp(io);
    return 0;
  }
  const firstPositional = commandArtifactPath(command, args);
  const parsedWorkspacePath =
    command === "init" || command === "status" || command === "merge"
      ? parseOptions(args).positionals[0]
      : command === "context"
        ? parseOptions(args.slice(1)).positionals[0]
        : firstPositional;
  const workspaceStart =
    env.TIELINE_WORKSPACE ||
    parsedWorkspacePath ||
    process.cwd();
  loadWorkspaceProfile(workspaceStart, env);
  reloadConfig(env);
  if (command === "init") return runInit(args, io, env);
  if (command === "status") return runStatus(args, io);
  if (command === "context") return runContext(args, io);
  if (command === "merge") return runMerge(args, io);
  if (command === "migrate") {
    const { runMigrateCommand } = await import("./commands/migrate.js");
    return runMigrateCommand(args);
  }
  if (command === "review") {
    const { runReviewCommand } = await import("./commands/review.js");
    return runReviewCommand(args);
  }
  if (command === "import") {
    const { runImportCommand } = await import("./commands/import-stories.js");
    return runImportCommand(args);
  }
  if (command === "import-help") {
    const { runImportHelpCommand } = await import("./commands/import-help.js");
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
    io.error(`Tieline error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    readline.close();
  }
}

if (
  process.argv[1] &&
  realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)
) {
  void main();
}
