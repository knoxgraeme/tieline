#!/usr/bin/env node

import "./load-env.js";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Interface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { Command, CommanderError, Option } from "commander";
import type { EmbeddingProvider } from "./config.js";
import {
  createPalette,
  paletteFor,
  renderBanner,
  renderCopyCallout,
} from "./cli-ui.js";
import type { Palette } from "./cli-ui.js";
import { loadWorkspaceProfileForCommand } from "./tieline/profile.js";
import type { DatabaseMode } from "./tieline/setup.js";
import {
  SUPPORTED_SKILL_AGENTS,
  type SkillfishProcessRunner,
  type SkillInstallScope,
} from "./tieline/skill-install.js";
import {
  ONBOARDING_SKILL_INSTALL_COMMAND,
  statusFromPath,
  type TielineStatus,
} from "./tieline/status.js";
import type {
  ContractAction,
  ContractCommandOptions,
} from "./commands/contract.js";
import { TIELINE_VERSION } from "./package-metadata.js";

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
    options: readonly TielineCliPromptOption[],
    initialValues?: readonly string[]
  ): Promise<string[] | null>;
  note(title: string, message: string): void;
}

async function reloadRuntimeConfig(
  env: NodeJS.ProcessEnv
): Promise<void> {
  const { reloadConfig } = await import("./config.js");
  reloadConfig(env);
}

export interface TielineCliDependencies {
  skillfishRunner?: SkillfishProcessRunner;
  /** Runs agent registration CLIs such as `codex mcp add`. */
  mcpCliRunner?: SkillfishProcessRunner;
}

export function renderStatus(status: TielineStatus, ui: Palette): string {
  const state = (ok: boolean, good: string, bad: string): string =>
    ok ? ui.green(good) : ui.yellow(bad);
  const mcpConfigs = status.integration.mcp_configs ?? [];
  const mcpConfigLabel = (
    config: (typeof mcpConfigs)[number]
  ): string =>
    `${config.package_spec ?? "unrecognized package"} (${config.version_status})`;
  const mcpVersion =
    mcpConfigs.length === 1
      ? mcpConfigLabel(mcpConfigs[0]!)
      : mcpConfigs.length > 1
        ? mcpConfigs
            .map((config) => `${config.path}=${mcpConfigLabel(config)}`)
            .join(", ")
        : status.integration.mcp_clients.length > 0
          ? "unrecognized package"
          : "not registered";
  const lines = [
    ui.bold(`Tieline: ${status.product} (${status.repo})`),
    `  root: ${status.root}`,
    `  version: cli=${status.runtime.cli_version ?? "unknown"}, mcp=${mcpVersion}`,
    `  runtime: profile=${state(status.runtime.profile_present, "present", "missing")}, database=${status.runtime.database_mode}, embedding=${status.runtime.embedding_provider}, setup=${state(status.runtime.setup_complete, "complete", "incomplete")}`,
    `  optional capabilities: organization_matching=${state(status.capabilities.semantic_matching_configured, "configured", "not configured")}, planning_writes=${state(status.capabilities.planning_writes_configured, "configured", "not configured")}`,
    `  integration: mcp=${state(status.integration.mcp_clients.length > 0, status.integration.mcp_clients.join(", "), `not registered (rerun \`${ONBOARDING_SKILL_INSTALL_COMMAND}\`)`)}`,
    `  contract: ${status.contract.stories} Stories, ${status.contract.acceptance_criteria} ACs, manifest=${state(status.contract.manifest_exists, "present", "missing")}`,
  ];
  if (status.onboarding) {
    lines.push(
      `${ui.cyan("Next:")} ${status.onboarding.instruction}`,
      `${ui.cyan("Install skill:")} ${status.onboarding.install_command}`
    );
  } else {
    lines.push(`${ui.cyan("Next:")} ${status.next_action}`);
  }
  return lines.join("\n");
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
    if (args[0] === "criteria" || args[0] === "context") {
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
  if (command === "code") {
    if (args[0] === "compile" || args[0] === "validate") {
      return firstPositional(args, new Set(), 1) ?? process.cwd();
    }
    return optionValue(args, "repository") ?? process.cwd();
  }
  if (command === "status") {
    return firstPositional(args, new Set()) ?? process.cwd();
  }
  if (command === "screens" || command === "hosted") {
    return optionValue(args, "repository") ?? process.cwd();
  }
  return process.cwd();
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

type SharedContractAction = Exclude<
  ContractAction,
  "criteria" | "context" | "grade"
>;
type ContractActionOptions = Omit<ContractCommandOptions, "repository">;

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
    .version(TIELINE_VERSION)
    .exitOverride()
    .configureOutput({
      writeOut: (message) => io.write(message),
      writeErr,
    })
    .addHelpText("before", () => `${renderBanner(paletteFor(io))}\n\n`)
    .addHelpText(
      "after",
      "\nRun `tieline init` for deterministic setup and agent-skill installation. Use $tieline for onboarding, planning Story/AC writes, implementation, and branch reconciliation."
    );

  program
    .command("init")
    .description("Create a Tieline workspace or resume runtime setup")
    .argument("[repository]", "repository path", process.cwd())
    .option("--product <name>", "company/product name")
    .option("--repo-name <name>", "stable repository name")
    .option("--description <text>", "product description")
    .option("--context <location>", "context source (repeatable)", collect, [])
    .option(
      "--source-root <path>",
      "code directory included in coverage (repeatable)",
      collect,
      []
    )
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
      `install tieline for a supported agent (repeatable: ${SUPPORTED_SKILL_AGENTS.map((agent) => agent.id).join(", ")})`,
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
      "initialize without installing tieline"
    )
    .option(
      "--yes",
      "accept detected defaults without prompting (pair with --agent or --skip-skill-install when setup needs a skill)"
    )
    .option("--skip-migrate", "skip applying database migrations")
    .option(
      "--install-local-embedder",
      "install the optional local embedding runtime"
    )
    .option(
      "--provision-roles",
      "assign generated login passwords to the tieline database roles (requires --database existing)"
    )
    .action(async (repository: string, opts) => {
      const { runInit } = await import("./commands/init.js");
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
            embedding: opts.embedding as EmbeddingProvider | undefined,
            embeddingExplicit: Boolean(opts.embedding),
            yes: Boolean(opts.yes),
            skipMigrate: Boolean(opts.skipMigrate),
            installLocalEmbedder: Boolean(opts.installLocalEmbedder),
            provisionRoles: Boolean(opts.provisionRoles),
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
    name: SharedContractAction,
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
          name,
          { repository, ...(opts as ContractActionOptions) },
          io
        )
      );
    });
    return sub;
  };
  contractAction("validate", "Validate accepted contract YAML");
  contractAction("review", "Render a browser review page").option(
    "--base <ref>",
    "highlight Stories, acceptance criteria, and screens changed since this git ref"
  );
  contractAction("compile", "Compile the contract manifest");
  contractAction(
    "coverage",
    "Report evidence and mapping coverage with confidence tiers"
  );
  contractAction(
    "link-review",
    "Suggest contract links a human should re-read (advisory only)"
  ).option("--save", "persist review candidates as attribution suggestions");
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
  contract
    .command("context")
    .description(
      "Inspect the exact intent neighborhood for an asset or Acceptance Criterion"
    )
    .option("--path <repository-relative-path>", "exact repository asset path")
    .option("--kind <kind>", "asset kind (with --path): code or test")
    .option(
      "--selector <canonical-selector>",
      "canonical asset selector (with --path)"
    )
    .option("--ac <stable-id>", "exact Acceptance Criterion stable ID")
    .option("--repository <path>", "repository path")
    .option("--repo <key>", "stable repository key")
    .option("--json", "emit machine-readable JSON")
    .action(async (opts) => {
      const { runContractCommand } = await import("./commands/contract.js");
      setExit(
        await runContractCommand(
          "context",
          {
            repository: opts.repository,
            repo: opts.repo,
            path: opts.path,
            kind: opts.kind,
            selector: opts.selector,
            ac: opts.ac,
            json: Boolean(opts.json),
          },
          io
        )
      );
    });

  const screens = program
    .command("screens")
    .description("Manage the optional screen catalog (requires screens.enabled)");
  screens
    .command("import")
    .description("Create or update screen catalog entries from a JSON file")
    .argument("<file>", "screen import JSON: an array of screen entries")
    .option("--repository <path>", "repository path")
    .option(
      "--prune",
      "remove catalog entries the file omits, within the capabilities it names"
    )
    .option(
      "--skip-unknown-capabilities",
      "skip entries for capabilities the contract does not declare instead of failing"
    )
    .option("--dry-run", "report the changes without writing")
    .option("--json", "emit machine-readable JSON")
    .action(async (file: string, opts) => {
      const { runScreensImportCommand } = await import("./commands/screens.js");
      setExit(
        await runScreensImportCommand(
          file,
          {
            repository: opts.repository,
            prune: Boolean(opts.prune),
            skipUnknownCapabilities: Boolean(opts.skipUnknownCapabilities),
            dryRun: Boolean(opts.dryRun),
            json: Boolean(opts.json),
          },
          io
        )
      );
    });

  screens
    .command("capture")
    .description(
      "Capture screens with the repository's Playwright tests tagged @screen:<key>"
    )
    .option("--all", "select every catalogued screen")
    .option("--changed", "select the screens a branch may have changed (needs --base)")
    .option("--base <ref>", "with --changed: compare from where the branch left this ref")
    .option("--screen <key>", "select a screen by key (repeatable)", collect, [])
    .option("--dry-run", "report the selection and each reason without capturing")
    .option(
      "--verify",
      "compare a fresh capture with the committed outputs; write nothing and fail on any difference"
    )
    .option(
      "--repeat <n>",
      "capture n times (1-5) and keep only screens every run captured identically"
    )
    .option("--repository <path>", "repository path")
    .option("--json", "emit machine-readable JSON")
    .action(async (opts) => {
      const { runScreensCaptureCommand } = await import("./commands/screens-capture.js");
      setExit(
        await runScreensCaptureCommand(
          {
            repository: opts.repository,
            all: Boolean(opts.all),
            changed: Boolean(opts.changed),
            base: opts.base,
            screens: opts.screen,
            dryRun: Boolean(opts.dryRun),
            verify: Boolean(opts.verify),
            ...(opts.repeat === undefined ? {} : { repeat: Number(opts.repeat) }),
            json: Boolean(opts.json),
          },
          io
        )
      );
    });

  screens
    .command("scenes")
    .description(
      "Generate a scene for each catalogued page no other test captures (screens.capture.generated_scenes)"
    )
    .option("--check", "write nothing; fail when the generated file is out of date with the catalog")
    .option("--repository <path>", "repository path")
    .option("--json", "emit machine-readable JSON")
    .action(async (opts) => {
      const { runScreensScenesCommand } = await import("./commands/screens.js");
      setExit(
        runScreensScenesCommand(
          { repository: opts.repository, check: Boolean(opts.check), json: Boolean(opts.json) },
          io
        )
      );
    });

  screens
    .command("audit")
    .description(
      "List screens whose capture outputs are missing or inconsistent, without capturing"
    )
    .option(
      "--capture",
      "re-capture every screen and report the ones that drifted (writes the outputs)"
    )
    .option(
      "--strict",
      "fail when any screen, page file, or UI acceptance criterion is unaccounted for"
    )
    .option("--repository <path>", "repository path")
    .option("--json", "emit machine-readable JSON")
    .action(async (opts) => {
      if (opts.capture && opts.strict) {
        throw new Error("--strict checks coverage without capturing; run it separately from --capture.");
      }
      if (opts.capture) {
        const { runScreensAuditCaptureCommand } = await import("./commands/screens-capture.js");
        setExit(
          await runScreensAuditCaptureCommand(
            { repository: opts.repository, json: Boolean(opts.json) },
            io
          )
        );
        return;
      }
      const { runScreensAuditCommand } = await import("./commands/screens.js");
      setExit(
        await runScreensAuditCommand(
          { repository: opts.repository, json: Boolean(opts.json), strict: Boolean(opts.strict) },
          io
        )
      );
    });

  const hosted = program
    .command("hosted")
    .description("Set up and check the hosted screens site (requires screens.hosted)");
  hosted
    .command("init")
    .description("Write a site that serves hosted screens, for a host to deploy")
    .requiredOption("--host <host>", "the host to deploy to: netlify")
    .option("--directory <path>", "where to write the site (default: .tieline/hosted)")
    .option("--force", "replace files that already exist with other content")
    .option("--repository <path>", "repository path")
    .option("--json", "emit machine-readable JSON")
    .action(async (opts) => {
      const { runHostedInitCommand } = await import("./commands/hosted.js");
      setExit(
        runHostedInitCommand(
          {
            repository: opts.repository,
            host: opts.host,
            directory: opts.directory,
            force: Boolean(opts.force),
            json: Boolean(opts.json),
          },
          io
        )
      );
    });
  hosted
    .command("check")
    .description(
      "Check the bucket, the database credentials set here, and that the site asks visitors to log in"
    )
    .option("--url <url>", "the deployed site (default: screens.hosted.site_url)")
    .option("--repository <path>", "repository path")
    .option("--json", "emit machine-readable JSON")
    .action(async (opts) => {
      const { runHostedCheckCommand } = await import("./commands/hosted.js");
      setExit(
        await runHostedCheckCommand(
          { repository: opts.repository, url: opts.url, json: Boolean(opts.json) },
          io
        )
      );
    });

  screens
    .command("publish")
    .description(
      "Publish a pull request's or branch's review page and screenshots to hosted screens (requires screens.hosted)"
    )
    .option("--pull-request <number>", "publish as this pull request")
    .option("--branch <name>", "publish as this branch")
    .option("--commit <sha>", "the commit published (default: HEAD)")
    .option("--summary-file <path>", "once published, write a Markdown summary for a pull-request comment")
    .option("--repository <path>", "repository path")
    .option("--json", "emit machine-readable JSON")
    .action(async (opts) => {
      const { runScreensPublishCommand } = await import("./commands/screens-hosting.js");
      setExit(
        await runScreensPublishCommand(
          {
            repository: opts.repository,
            pullRequest: opts.pullRequest,
            branch: opts.branch,
            commit: opts.commit,
            summaryFile: opts.summaryFile,
            json: Boolean(opts.json),
          },
          io
        )
      );
    });

  screens
    .command("close")
    .description("Mark a pull request's hosted page closed, so prune deletes it")
    .requiredOption("--pull-request <number>", "the closed pull request")
    .option("--repository <path>", "repository path")
    .option("--json", "emit machine-readable JSON")
    .action(async (opts) => {
      const { runScreensCloseCommand } = await import("./commands/screens-hosting.js");
      setExit(
        await runScreensCloseCommand(
          { repository: opts.repository, pullRequest: opts.pullRequest, json: Boolean(opts.json) },
          io
        )
      );
    });

  screens
    .command("prune")
    .description(
      "Delete hosted pages and screenshots retention no longer keeps (run after sync on main)"
    )
    .option("--repository <path>", "repository path")
    .option("--json", "emit machine-readable JSON")
    .action(async (opts) => {
      const { runScreensPruneCommand } = await import("./commands/screens-hosting.js");
      setExit(
        await runScreensPruneCommand(
          { repository: opts.repository, json: Boolean(opts.json) },
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

  const code = program
    .command("code")
    .description("Read bounded derived code topology and advisory AC impact");
  for (const [action, description] of [
    ["compile", "Compile the repository topology artifact"],
    ["validate", "Validate topology integrity and freshness without parsing"],
  ] as const) {
    code
      .command(action)
      .description(description)
      .argument("[repository]", "repository path")
      .option("--json", "emit machine-readable JSON")
      .action(async (repository: string | undefined, opts) => {
        const { runCodeTopologyArtifactCommand } = await import("./commands/code-topology-artifact.js");
        setExit(await runCodeTopologyArtifactCommand(action, {
          repository,
          json: Boolean(opts.json),
        }, io));
      });
  }
  const addTopologyLimits = (command: Command): Command => command
    .option("--depth <n>", "maximum traversal depth (1-8)")
    .option("--nodes <n>", "maximum visited nodes (1-1000)")
    .option("--edges <n>", "maximum edges and unresolved frontiers (1-4000)")
    .option("--paths <n>", "maximum returned paths (1-200)");
  addTopologyLimits(
    code
      .command("trace")
      .description("Trace exact code dependencies or dependents")
      .requiredOption("--path <repository-relative-path>", "exact code/test path")
      .option("--selector <canonical-selector>", "exact canonical selector")
      .addOption(new Option("--kind <kind>", "asset kind").choices(["code", "test"]).default("code"))
      .option("--framework-hint <hint>", "framework identity dimension")
      .addOption(new Option("--direction <direction>", "traversal direction").choices(["dependencies", "dependents"]).default("dependencies"))
      .addOption(new Option("--generation-role <role>", "reported generation role").choices(["base", "current"]).default("current"))
      .option("--revision <git-ref>", "analyze an exact local Git revision")
      .option("--generation <identity>", "read a complete persisted generation")
      .option("--repository <path>", "repository workspace path")
      .option("--repo <key>", "stable repository key")
      .option("--json", "emit machine-readable JSON")
  ).action(async (opts) => {
    const { findTielineWorkspace } = await import("./tieline/workspace.js");
    const { runDependencyTraceCommand } = await import("./commands/code-topology.js");
    const workspace = findTielineWorkspace(opts.repository ?? process.cwd());
    const repository = opts.repo ?? workspace?.config.product.repo_name;
    if (!repository) {
      throw new Error("`code trace` requires --repo <key> when no Tieline workspace is available.");
    }
    setExit(await runDependencyTraceCommand({
      repositoryRoot: opts.repository,
      repository,
      locator: {
        path: opts.path,
        kind: opts.kind,
        selector: opts.selector,
        frameworkHint: opts.frameworkHint,
      },
      direction: opts.direction,
      role: opts.generationRole,
      revision: opts.revision,
      generation: opts.generation,
      limits: {
        ...(opts.depth === undefined ? {} : { depth: Number(opts.depth) }),
        ...(opts.nodes === undefined ? {} : { nodes: Number(opts.nodes) }),
        ...(opts.edges === undefined ? {} : { edges: Number(opts.edges) }),
        ...(opts.paths === undefined ? {} : { paths: Number(opts.paths) }),
      },
      json: Boolean(opts.json),
    }, io));
  });
  addTopologyLimits(
    code
      .command("blast-radius")
      .description("Analyze advisory AC-aware impact from a Git base or changed paths")
      .addOption(new Option("--base <git-ref>", "compare the workspace to this Git ref").conflicts("changed"))
      .option("--changed <path>", "explicit changed repository path (repeatable)", collect, [])
      .addOption(new Option("--kind <kind>", "asset kind for explicit paths").choices(["code", "test"]).default("code"))
      .option("--selector <canonical-selector>", "selector for the explicit changed path")
      .addOption(new Option("--direction <direction>", "traversal direction").choices(["dependencies", "dependents"]).default("dependents"))
      .option("--repository <path>", "repository workspace path")
      .option("--repo <key>", "stable repository key")
      .option("--json", "emit machine-readable JSON")
  ).action(async (opts) => {
    const { findTielineWorkspace } = await import("./tieline/workspace.js");
    const { runBlastRadiusCommand } = await import("./commands/code-topology.js");
    const workspace = findTielineWorkspace(opts.repository ?? process.cwd());
    const repository = opts.repo ?? workspace?.config.product.repo_name;
    if (!repository) {
      throw new Error("`code blast-radius` requires --repo <key> when no Tieline workspace is available.");
    }
    setExit(await runBlastRadiusCommand({
      repositoryRoot: opts.repository,
      repository,
      base: opts.base,
      changes: opts.changed.length > 0
        ? opts.changed.map((path: string) => ({ path, kind: opts.kind, selector: opts.selector, status: "modified" as const }))
        : undefined,
      direction: opts.direction,
      limits: {
        ...(opts.depth === undefined ? {} : { depth: Number(opts.depth) }),
        ...(opts.nodes === undefined ? {} : { nodes: Number(opts.nodes) }),
        ...(opts.edges === undefined ? {} : { edges: Number(opts.edges) }),
        ...(opts.paths === undefined ? {} : { paths: Number(opts.paths) }),
      },
      json: Boolean(opts.json),
    }, io));
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
