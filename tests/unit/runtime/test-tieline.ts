import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  renderStatus,
  runCli,
  workspaceStartForCommand,
  type TielineCliIO,
} from "../../../src/cli.js";
import { createPalette } from "../../../src/cli-ui.js";
import {
  detectRepositoryName,
  normalizeContextLocations,
} from "../../../src/tieline/init.js";
import {
  loadWorkspaceProfileForCommand,
  loadWorkspaceProfile,
  readWorkspaceProfile,
} from "../../../src/tieline/profile.js";
import { configureWorkspaceRuntime } from "../../../src/tieline/setup.js";
import {
  detectRepositoryAgents,
  type SkillfishInvocation,
  type SkillfishProcessResult,
} from "../../../src/tieline/skill-install.js";
import type { TielineStatus } from "../../../src/tieline/status.js";
import {
  findTielineWorkspace,
  type TielineWorkspace,
} from "../../../src/tieline/workspace.js";

const runningPackageVersion = (
  JSON.parse(
    readFileSync(resolve(process.cwd(), "package.json"), "utf8")
  ) as { version: string }
).version;
const runningPackageSpec = `tieline@${runningPackageVersion}`;

function io(): { adapter: TielineCliIO; output: string[] } {
  const output: string[] = [];
  return {
    output,
    adapter: {
      write: (message) => output.push(message),
      error: (message) => output.push(message),
      question: async () => {
        throw new Error("Unexpected interactive prompt.");
      },
    },
  };
}

interface InteractiveResponses {
  text: string[];
  confirm: boolean[];
  select: string[];
  multiselect: string[][];
}

function interactiveIo(responses: InteractiveResponses): {
  adapter: TielineCliIO;
  output: string[];
  prompts: string[];
  choices: Record<string, readonly { value: string; label: string }[]>;
} {
  const output: string[] = [];
  const prompts: string[] = [];
  const choices: Record<
    string,
    readonly { value: string; label: string }[]
  > = {};
  return {
    output,
    prompts,
    choices,
    adapter: {
      interactive: true,
      write: (message) => output.push(message),
      error: (message) => output.push(message),
      question: async () => {
        throw new Error("Unexpected legacy text question.");
      },
      prompts: {
        text: async (message: string) => {
          prompts.push(message);
          return responses.text.shift() ?? "";
        },
        confirm: async (message: string) => {
          prompts.push(message);
          return responses.confirm.shift() ?? false;
        },
        select: async (message: string, options) => {
          prompts.push(message);
          choices[message] = [...options];
          return responses.select.shift() ?? null;
        },
        multiselect: async (message: string, options) => {
          prompts.push(message);
          choices[message] = [...options];
          return responses.multiselect.shift() ?? null;
        },
        note: (title: string, message: string) => {
          prompts.push(`${title}: ${message}`);
        },
      },
    } as TielineCliIO,
  };
}

function successfulMcpCli(): Promise<SkillfishProcessResult> {
  return Promise.resolve({
    code: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
  });
}

function successfulSkillfish(
  invocation: SkillfishInvocation
): Promise<SkillfishProcessResult> {
  const selectors = invocation.args.flatMap((arg, index) =>
    arg === "--agent" ? [invocation.args[index + 1]!] : []
  );
  return Promise.resolve({
    code: 0,
    stdout: JSON.stringify({
      success: true,
      exit_code: 0,
      errors: [],
      installed: selectors.map((agent) => ({
        skill: "tieline",
        agent,
        path: `/test/${agent}`,
      })),
      skipped: [],
    }),
    stderr: "",
  });
}

assert.equal(
  workspaceStartForCommand(
    "init",
    ["--product", "Example", "/tmp/example-repo"],
    {}
  ),
  "/tmp/example-repo"
);
assert.equal(
  workspaceStartForCommand(
    "contract",
    ["context", "--repository", "/tmp/context-repo", "--path", "src/a.ts"],
    {}
  ),
  "/tmp/context-repo"
);
assert.equal(
  workspaceStartForCommand(
    "contract",
    [
      "sync",
      "--expected-previous-commit",
      "abc123",
      "/tmp/example-repo",
    ],
    {}
  ),
  "/tmp/example-repo"
);
assert.equal(
  workspaceStartForCommand(
    "check",
    ["--base", "origin/main", "/tmp/example-repo"],
    {}
  ),
  "/tmp/example-repo"
);

const root = mkdtempSync(resolve(tmpdir(), "tieline-workspace-"));
try {
  const remoteTarget = resolve(root, "Remote Checkout");
  mkdirSync(remoteTarget, { recursive: true });
  assert.equal(
    spawnSync("git", ["init", "-q", remoteTarget]).status,
    0
  );
  assert.equal(
    spawnSync("git", ["-C", remoteTarget, "remote", "add", "origin", "git@github.com:example/remote-product.git"]).status,
    0
  );
  assert.equal(detectRepositoryName(remoteTarget), "remote-product");
  assert.equal(
    spawnSync("git", ["-C", remoteTarget, "remote", "set-url", "origin", "malformed"]).status,
    0
  );
  assert.equal(detectRepositoryName(remoteTarget), "remote-checkout");

  const detectionTarget = resolve(root, "agent-detection");
  mkdirSync(resolve(detectionTarget, ".cursor"), { recursive: true });
  mkdirSync(resolve(detectionTarget, ".agents", "skills"), {
    recursive: true,
  });
  assert.deepEqual(
    detectRepositoryAgents(detectionTarget, {}),
    ["codex", "cursor"],
    "preselection must come from repository evidence, not machine installs"
  );
  assert.deepEqual(
    detectRepositoryAgents(detectionTarget, { CLAUDECODE: "1" }),
    ["claude-code", "codex", "cursor"],
    "an agent session running init preselects that agent"
  );
  const bareTarget = resolve(detectionTarget, "bare");
  mkdirSync(bareTarget, { recursive: true });
  assert.deepEqual(
    detectRepositoryAgents(bareTarget, {}),
    [],
    "a repository without agent evidence preselects nothing"
  );

  const validationTarget = resolve(root, "validation-target");
  mkdirSync(resolve(validationTarget, "src"), { recursive: true });
  await assert.rejects(
    runCli(
      ["init", validationTarget, "--yes", "--provision-roles"],
      io().adapter,
      { TIELINE_CONFIG_HOME: resolve(root, "validation-config") }
    ),
    /--provision-roles requires --database existing/
  );
  assert.equal(existsSync(resolve(validationTarget, ".tieline")), false);
  await assert.rejects(
    runCli(
      ["init", validationTarget, "--yes", "--skill-scope", "project"],
      io().adapter,
      { TIELINE_CONFIG_HOME: resolve(root, "validation-config") }
    ),
    /requires.*--agent/i
  );
  await assert.rejects(
    runCli(
      [
        "init",
        validationTarget,
        "--yes",
        "--agent",
        "unknown-agent",
        "--skill-scope",
        "project",
      ],
      io().adapter,
      { TIELINE_CONFIG_HOME: resolve(root, "validation-config") }
    ),
    /unsupported agent/i
  );
  assert.equal(existsSync(resolve(validationTarget, ".tieline")), false);

  await assert.rejects(
    runCli(
      [
        "init",
        validationTarget,
        "--yes",
        "--agent",
        "codex",
        "--skill-scope",
        "project",
        "--skip-skill-install",
      ],
      io().adapter,
      { TIELINE_CONFIG_HOME: resolve(root, "validation-config") }
    ),
    /skip-skill-install.*cannot be combined/i
  );
  assert.equal(existsSync(resolve(validationTarget, ".tieline")), false);

  const invalidContextTarget = resolve(root, "Invalid Context Checkout");
  mkdirSync(resolve(invalidContextTarget, "src"), { recursive: true });
  await assert.rejects(
    runCli(
      ["init", invalidContextTarget, "--yes", "--context", "product.md"],
      io().adapter,
      { TIELINE_CONFIG_HOME: resolve(root, "invalid-context-config") }
    ),
    /existing repository path or explicit HTTP\(S\) URL: product\.md/
  );
  assert.equal(existsSync(resolve(invalidContextTarget, ".tieline")), false);
  assert.throws(
    () =>
      normalizeContextLocations(invalidContextTarget, ["mcpmarket.com/hub"]),
    /explicit HTTP\(S\) URL/
  );
  assert.deepEqual(
    normalizeContextLocations(invalidContextTarget, [
      "https://mcpmarket.com/hub",
    ]),
    ["https://mcpmarket.com/hub"]
  );
  writeFileSync(resolve(root, "outside-context.md"), "outside\n");
  assert.throws(
    () =>
      normalizeContextLocations(invalidContextTarget, [
        "../outside-context.md",
      ]),
    /escapes the target repository/
  );

  const repositoryContextTarget = resolve(root, "Repository Context Checkout");
  mkdirSync(resolve(repositoryContextTarget, "src"), { recursive: true });
  assert.equal(
    await runCli(
      [
        "init",
        repositoryContextTarget,
        "--yes",
        "--context",
        ".",
        "--skip-skill-install",
      ],
      io().adapter,
      { TIELINE_CONFIG_HOME: resolve(root, "repository-context-config") }
    ),
    0
  );
  const repositoryContextWorkspace = findTielineWorkspace(
    repositoryContextTarget
  );
  assert.ok(repositoryContextWorkspace);
  assert.equal(
    repositoryContextWorkspace.config.context.sources[0]?.type,
    "local"
  );
  assert.equal(
    repositoryContextWorkspace.config.context.sources[0]?.location,
    "."
  );

  const interactiveTarget = resolve(root, "Interactive Checkout");
  const interactiveConfigHome = resolve(root, "interactive-config");
  mkdirSync(resolve(interactiveTarget, "src"), { recursive: true });
  writeFileSync(resolve(interactiveTarget, "src", "index.ts"), "export {};\n");
  writeFileSync(resolve(interactiveTarget, "README.md"), "# Interactive\n");
  const interactive = interactiveIo({
    text: [],
    confirm: [],
    select: [],
    multiselect: [["codex", "claude-code"]],
  });
  const interactiveInvocations: SkillfishInvocation[] = [];
  assert.equal(
    await runCli(
      [
        "init",
        interactiveTarget,
        "--description",
        "A useful product",
        "--context",
        "README.md",
        "--context",
        "https://mcpmarket.com/hub",
      ],
      interactive.adapter,
      { TIELINE_CONFIG_HOME: interactiveConfigHome },
      {
        skillfishRunner: async (invocation) => {
          interactiveInvocations.push(invocation);
          const currentWorkspace = findTielineWorkspace(interactiveTarget);
          assert.ok(currentWorkspace, "workspace must exist before Skillfish runs");
          assert.ok(
            readWorkspaceProfile(currentWorkspace, {
              TIELINE_CONFIG_HOME: interactiveConfigHome,
            }),
            "runtime profile must exist before Skillfish runs"
          );
          assert.ok(
            existsSync(resolve(interactiveTarget, ".claude")),
            "selected project agents must be detectable before Skillfish runs"
          );
          assert.ok(
            existsSync(resolve(interactiveTarget, ".codex")),
            "every selected project agent must be prepared before Skillfish runs"
          );
          return successfulSkillfish(invocation);
        },
        mcpCliRunner: successfulMcpCli,
      }
    ),
    0
  );
  assert.equal(interactiveInvocations.length, 1);
  const interactiveWorkspace = findTielineWorkspace(interactiveTarget);
  assert.ok(interactiveWorkspace);
  assert.equal(
    interactiveWorkspace.config.product.name,
    "Interactive Checkout"
  );
  assert.equal(
    interactiveWorkspace.config.product.repo_name,
    "interactive-checkout"
  );
  assert.deepEqual(interactiveWorkspace.config.repository.source_roots, [
    "src",
  ]);
  assert.deepEqual(
    interactiveWorkspace.config.context.sources.map((source) => source.type),
    ["description", "local", "website"]
  );
  assert.equal(
    interactiveWorkspace.config.context.sources[2]?.location,
    "https://mcpmarket.com/hub"
  );
  assert.equal(
    interactive.prompts[0],
    "Where should Tieline install its onboarding and authoring skill?",
    "the agent selector must be the only interactive question"
  );
  assert.equal(
    interactive.prompts.length,
    1,
    "selecting agents is consent; init must not repeat the setup as a confirmation"
  );
  assert.equal(
    interactive.prompts.some((prompt) =>
      [
        "Company/product name",
        "Stable repository name",
        "Database mode",
        "Embedding provider",
        "Onboarding skill installation scope",
        "Product description (optional)",
        "Source roots (comma-separated)",
      ].includes(prompt)
    ),
    false,
    "identity and runtime must be detected, not asked"
  );
  const interactiveOutput = stripVTControlCharacters(
    interactive.output.join("")
  );
  assert.match(
    interactiveOutput,
    /Skill: tieline installed for Codex and Claude Code/
  );
  assert.doesNotMatch(
    interactiveOutput,
    /Context:|Runtime:|Code scope:|Skill source:|Skill targets:|Skill scope:/,
    "init output must report outcomes rather than semantic defaults or integration internals"
  );
  assert.match(
    interactiveOutput,
    /Next steps\n {2}1\. Restart or reload your agent\.\n {2}2\. Ask your agent to use the installed tieline skill to onboard this repository\. In Claude Code, run \/tieline; in Codex, run \$tieline\./
  );

  const cancelledTarget = resolve(root, "Cancelled Checkout");
  mkdirSync(resolve(cancelledTarget, "src"), { recursive: true });
  const cancelled = interactiveIo({
    text: [],
    confirm: [],
    select: [],
    multiselect: [],
  });
  await assert.rejects(
    runCli(["init", cancelledTarget], cancelled.adapter, {
      TIELINE_CONFIG_HOME: resolve(root, "cancelled-config"),
    }),
    /Cancelled/
  );
  assert.equal(existsSync(resolve(cancelledTarget, ".tieline")), false);

  const noAgentTarget = resolve(root, "No Agent Checkout");
  mkdirSync(resolve(noAgentTarget, "src"), { recursive: true });
  const noAgent = interactiveIo({
    text: [],
    confirm: [],
    select: [],
    multiselect: [[]],
  });
  await assert.rejects(
    runCli(["init", noAgentTarget], noAgent.adapter, {
      TIELINE_CONFIG_HOME: resolve(root, "no-agent-config"),
    }),
    /select at least one agent/i
  );
  assert.equal(
    existsSync(resolve(noAgentTarget, ".tieline")),
    false,
    "an empty agent choice must stop before workspace mutation"
  );

  const automatedTarget = resolve(root, "Automated Checkout");
  const automatedConfigHome = resolve(root, "automated-config");
  mkdirSync(resolve(automatedTarget, "src"), { recursive: true });
  let automatedCalls = 0;
  const automated = io();
  assert.equal(
    await runCli(
      [
        "init",
        automatedTarget,
        "--yes",
        "--embedding",
        "hash",
        "--agent",
        "codex",
        "--skill-scope",
        "global",
      ],
      automated.adapter,
      { TIELINE_CONFIG_HOME: automatedConfigHome },
      {
        skillfishRunner: async (invocation) => {
          automatedCalls++;
          const currentWorkspace = findTielineWorkspace(automatedTarget);
          assert.ok(currentWorkspace);
          assert.ok(
            readWorkspaceProfile(currentWorkspace, {
              TIELINE_CONFIG_HOME: automatedConfigHome,
            })
          );
          return successfulSkillfish(invocation);
        },
        mcpCliRunner: successfulMcpCli,
      }
    ),
    0
  );
  assert.equal(automatedCalls, 1);
  assert.match(
    automated.output.join(""),
    /Skill: tieline installed for Codex/
  );
  const automatedWorkspace = findTielineWorkspace(automatedTarget);
  assert.ok(automatedWorkspace);
  const automatedConfig = readFileSync(automatedWorkspace.configPath, "utf8");
  const alreadyPresent = io();
  assert.equal(
    await runCli(
      [
        "init",
        automatedTarget,
        "--yes",
        "--agent",
        "codex",
        "--skill-scope",
        "global",
      ],
      alreadyPresent.adapter,
      { TIELINE_CONFIG_HOME: automatedConfigHome },
      {
        skillfishRunner: async () => ({
          code: 0,
          stdout: JSON.stringify({
            success: true,
            exit_code: 0,
            errors: [],
            installed: [],
            skipped: [
              {
                skill: "tieline",
                agent: "Codex",
                reason: "Already exists",
              },
            ],
          }),
          stderr: "",
        }),
        mcpCliRunner: successfulMcpCli,
      }
    ),
    0
  );
  assert.match(
    alreadyPresent.output.join(""),
    /Skill: tieline already present for Codex/
  );
  assert.equal(
    readFileSync(automatedWorkspace.configPath, "utf8"),
    automatedConfig,
    "skill retry must preserve shared workspace configuration"
  );

  const failedTarget = resolve(root, "Failed Install Checkout");
  const failedConfigHome = resolve(root, "failed-config");
  mkdirSync(resolve(failedTarget, "src"), { recursive: true });
  const failed = io();
  assert.equal(
    await runCli(
      [
        "init",
        failedTarget,
        "--yes",
        "--embedding",
        "hash",
        "--agent",
        "codex",
        "--skill-scope",
        "project",
      ],
      failed.adapter,
      { TIELINE_CONFIG_HOME: failedConfigHome },
      {
        skillfishRunner: async () => ({
          code: 7,
          stdout: "",
          stderr: "private nested output",
          timedOut: false,
        }),
        mcpCliRunner: async () => ({
          code: 3,
          stdout: "",
          stderr: "",
          timedOut: false,
        }),
      }
    ),
    1
  );
  const failedWorkspace = findTielineWorkspace(failedTarget);
  assert.ok(failedWorkspace);
  assert.ok(
    readWorkspaceProfile(failedWorkspace, {
      TIELINE_CONFIG_HOME: failedConfigHome,
    })
  );
  const failedOutput = failed.output.join("");
  assert.match(failedOutput, /Workspace: ready/i);
  assert.match(failedOutput, /installation incomplete/i);
  assert.match(
    failedOutput,
    /Codex registration failed \(codex mcp add exited with code 3\); run: codex mcp add tieline --env/
  );
  assert.match(
    failedOutput,
    /Retry the install by running:\n\n─+\nnpx -y tieline@latest init .*Failed Install Checkout.*--yes --agent codex --skill-scope project\n─+/
  );
  assert.doesNotMatch(failedOutput, /private nested output|Agent handoff prompt/);

  const mcpMergeTarget = resolve(root, "Mcp Merge Checkout");
  const mcpMergeConfigHome = resolve(root, "mcp-merge-config");
  mkdirSync(resolve(mcpMergeTarget, "src"), { recursive: true });
  writeFileSync(
    resolve(mcpMergeTarget, ".mcp.json"),
    `${JSON.stringify(
      { mcpServers: { other: { command: "other-server" } } },
      null,
      2
    )}\n`
  );
  const mcpMerge = io();
  const codexInvocations: SkillfishInvocation[] = [];
  assert.equal(
    await runCli(
      [
        "init",
        mcpMergeTarget,
        "--yes",
        "--embedding",
        "hash",
        "--agent",
        "cursor",
        "--agent",
        "codex",
        "--agent",
        "github-copilot",
        "--agent",
        "gemini-cli",
        "--agent",
        "opencode",
        "--agent",
        "windsurf",
      ],
      mcpMerge.adapter,
      { TIELINE_CONFIG_HOME: mcpMergeConfigHome },
      {
        skillfishRunner: successfulSkillfish,
        mcpCliRunner: async (invocation) => {
          codexInvocations.push(invocation);
          return successfulMcpCli();
        },
      }
    ),
    0
  );
  assert.equal(codexInvocations.length, 1);
  assert.equal(codexInvocations[0]!.command, "codex");
  assert.deepEqual(codexInvocations[0]!.args, [
    "mcp",
    "add",
    "tieline",
    "--env",
    `TIELINE_WORKSPACE=${mcpMergeTarget}`,
    "--",
    "npx",
    "-y",
    runningPackageSpec,
    "serve",
  ]);
  const tielineServerEntry = {
    command: "npx",
    args: ["-y", runningPackageSpec, "serve"],
    env: { TIELINE_WORKSPACE: "." },
  };
  assert.deepEqual(
    JSON.parse(readFileSync(resolve(mcpMergeTarget, ".mcp.json"), "utf8")),
    {
      mcpServers: {
        other: { command: "other-server" },
        tieline: tielineServerEntry,
      },
    },
    "registration must preserve unrelated MCP servers"
  );
  assert.deepEqual(
    JSON.parse(
      readFileSync(resolve(mcpMergeTarget, ".cursor/mcp.json"), "utf8")
    ),
    { mcpServers: { tieline: tielineServerEntry } }
  );
  assert.deepEqual(
    JSON.parse(
      readFileSync(resolve(mcpMergeTarget, ".vscode/mcp.json"), "utf8")
    ),
    {
      servers: {
        tieline: { ...tielineServerEntry, type: "stdio" },
      },
    }
  );
  assert.deepEqual(
    JSON.parse(
      readFileSync(resolve(mcpMergeTarget, ".gemini/settings.json"), "utf8")
    ),
    { mcpServers: { tieline: tielineServerEntry } }
  );
  assert.deepEqual(
    JSON.parse(
      readFileSync(resolve(mcpMergeTarget, "opencode.json"), "utf8")
    ),
    {
      mcp: {
        tieline: {
          type: "local",
          command: ["npx", "-y", runningPackageSpec, "serve"],
          enabled: true,
          environment: { TIELINE_WORKSPACE: "." },
        },
      },
    }
  );
  const mcpMergeOutput = mcpMerge.output.join("");
  assert.match(
    mcpMergeOutput,
    /Skill: tieline installed for Cursor, Codex, GitHub Copilot, Gemini CLI, OpenCode, and Windsurf/,
    "--agent without --skill-scope must default to the project scope"
  );
  assert.match(mcpMergeOutput, /MCP: configured/);
  assert.match(
    mcpMergeOutput,
    new RegExp(
      `Windsurf keeps MCP configuration outside the repository; register 'npx -y ${runningPackageSpec.replaceAll(".", "\\.")} serve' there manually\\.`
    )
  );
  const mergedRootBody = readFileSync(
    resolve(mcpMergeTarget, ".mcp.json"),
    "utf8"
  );
  const mcpRepeat = io();
  assert.equal(
    await runCli(
      ["init", mcpMergeTarget, "--yes", "--skip-skill-install"],
      mcpRepeat.adapter,
      {
        TIELINE_CONFIG_HOME: mcpMergeConfigHome,
      }
    ),
    0
  );
  assert.equal(
    readFileSync(resolve(mcpMergeTarget, ".mcp.json"), "utf8"),
    mergedRootBody,
    "re-running init must not rewrite an up-to-date MCP config"
  );
  assert.match(mcpRepeat.output.join(""), /MCP: configured/);

  writeFileSync(
    resolve(mcpMergeTarget, ".cursor/mcp.json"),
    JSON.stringify({
      mcpServers: {
        tieline: {
          ...tielineServerEntry,
          args: ["-y", "tieline@0.0.0", "serve"],
        },
      },
    })
  );
  writeFileSync(
    resolve(mcpMergeTarget, "opencode.json"),
    JSON.stringify({
      mcp: {
        tieline: {
          type: "local",
          command: ["npx", "-y", "tieline@0.0.0", "serve"],
          enabled: true,
          environment: { TIELINE_WORKSPACE: "." },
        },
      },
    })
  );
  assert.equal(
    await runCli(
      ["init", mcpMergeTarget, "--yes", "--skip-skill-install"],
      io().adapter,
      { TIELINE_CONFIG_HOME: mcpMergeConfigHome }
    ),
    0
  );
  assert.deepEqual(
    JSON.parse(
      readFileSync(resolve(mcpMergeTarget, ".cursor/mcp.json"), "utf8")
    ),
    { mcpServers: { tieline: tielineServerEntry } },
    "re-running init refreshes an existing repository-local client pin"
  );
  assert.deepEqual(
    JSON.parse(readFileSync(resolve(mcpMergeTarget, "opencode.json"), "utf8")),
    {
      mcp: {
        tieline: {
          type: "local",
          command: ["npx", "-y", runningPackageSpec, "serve"],
          enabled: true,
          environment: { TIELINE_WORKSPACE: "." },
        },
      },
    },
    "re-running init refreshes an existing OpenCode pin"
  );

  const mcpInvalidTarget = resolve(root, "Mcp Invalid Checkout");
  mkdirSync(resolve(mcpInvalidTarget, "src"), { recursive: true });
  mkdirSync(resolve(mcpInvalidTarget, ".vscode"), { recursive: true });
  writeFileSync(resolve(mcpInvalidTarget, ".mcp.json"), "{ not json\n");
  const unrelatedVsCodeConfig = `${JSON.stringify({
    servers: { other: { command: "other-server" } },
  })}\n`;
  writeFileSync(
    resolve(mcpInvalidTarget, ".vscode/mcp.json"),
    unrelatedVsCodeConfig
  );
  const mcpInvalid = io();
  assert.equal(
    await runCli(
      [
        "init",
        mcpInvalidTarget,
        "--yes",
        "--embedding",
        "hash",
        "--skip-skill-install",
      ],
      mcpInvalid.adapter,
      { TIELINE_CONFIG_HOME: resolve(root, "mcp-invalid-config") },
      {
        skillfishRunner: async () => {
          throw new Error("--yes without agents must not invoke Skillfish");
        },
      }
    ),
    0
  );
  assert.equal(
    readFileSync(resolve(mcpInvalidTarget, ".mcp.json"), "utf8"),
    "{ not json\n",
    "an unparseable MCP config must never be overwritten"
  );
  assert.equal(
    readFileSync(resolve(mcpInvalidTarget, ".vscode/mcp.json"), "utf8"),
    unrelatedVsCodeConfig,
    "init must not register Tieline with an unselected client"
  );
  assert.match(
    mcpInvalid.output.join(""),
    /\.mcp\.json was left untouched \(the existing file is not valid JSON\)/
  );

  const target = resolve(root, "Product");
  const configHome = resolve(root, "config-home");
  mkdirSync(resolve(target, "src"), { recursive: true });
  writeFileSync(
    resolve(target, "package.json"),
    JSON.stringify({ name: "example-product" })
  );
  const first = io();
  assert.equal(
    await runCli(
      [
        "init",
        target,
        "--yes",
        "--product",
        "Example Product",
        "--repo-name",
        "example-repository",
        "--description",
        "A product with a living semantic contract.",
        "--embedding",
        "hash",
        "--skip-skill-install",
      ],
      first.adapter,
      {
        TIELINE_CONFIG_HOME: configHome,
        EMBEDDING_PROVIDER: "hash",
      },
      {
        skillfishRunner: async () => {
          throw new Error("--yes without agents must not invoke Skillfish");
        },
      }
    ),
    0
  );
  const workspace = findTielineWorkspace(target);
  assert.ok(workspace);
  assert.equal(workspace.config.product.repo_name, "example-repository");
  assert.equal(workspace.config.context.sources[0]?.type, "description");
  assert.ok(statSync(workspace.specDirectoryPath).isDirectory());
  assert.ok(existsSync(resolve(target, ".mcp.json")));
  assert.equal(existsSync(resolve(target, ".tieline/mcp.json")), false);

  for (const obsolete of [
    ".tieline/drafts",
    ".tieline/stories.draft.json",
    ".tieline/coverage.json",
    ".tieline/AGENT_HANDOFF.md",
  ]) {
    assert.equal(existsSync(resolve(target, obsolete)), false, obsolete);
  }
  const configBody = readFileSync(workspace.configPath, "utf8");
  assert.doesNotMatch(configBody, /approval|draft|proposal/i);
  assert.doesNotMatch(configBody, /DATABASE_URL|postgresql:\/\//);
  assert.doesNotMatch(configBody, /profile_id|setup_completed_at/);
  assert.deepEqual(workspace.config.runtime, {
    default_embedding_provider: "hash",
    default_database_mode: "offline",
  });
  assert.deepEqual(
    JSON.parse(readFileSync(resolve(target, ".mcp.json"), "utf8")),
    {
      mcpServers: {
        tieline: {
          command: "npx",
          args: ["-y", runningPackageSpec, "serve"],
          env: { TIELINE_WORKSPACE: "." },
        },
      },
    }
  );
  const reviewPage = readFileSync(
    resolve(target, ".tieline/review.html"),
    "utf8"
  );
  assert.match(reviewPage, /No capabilities yet/);
  assert.match(
    reviewPage,
    /Ask your agent to use the installed tieline skill to onboard this repository\. In Claude Code, run \/tieline; in Codex, run \$tieline\./
  );
  assert.equal(
    readFileSync(resolve(target, ".tieline/.gitignore"), "utf8"),
    "review.html\n"
  );
  const firstOutput = first.output.join("");
  assert.match(firstOutput, /MCP: configured/);
  assert.match(firstOutput, /Workspace: ready at \.tieline\//);
  assert.doesNotMatch(
    firstOutput,
    new RegExp(target.replaceAll("\\", "\\\\")),
    "the summary must not print absolute paths"
  );
  assert.doesNotMatch(
    firstOutput,
    /Mode:|Runtime:|Context:|Code scope:|Optional capabilities|Review: open|Skill source:|Skill targets:|Skill scope:/,
    "the summary leads to the skill invocation without setup internals"
  );
  assert.match(firstOutput, /skill: not installed/i);
  assert.match(
    firstOutput,
    /Install the tieline skill by running:\n\n─+\nnpx -y tieline@latest init \.\n─+/
  );
  assert.doesNotMatch(firstOutput, /Warning \[/);
  assert.doesNotMatch(firstOutput, /Agent handoff prompt:/);
  assert.doesNotMatch(firstOutput, /otherwise continue directly from this brief/i);

  const stored = readWorkspaceProfile(workspace, {
    TIELINE_CONFIG_HOME: configHome,
  });
  assert.ok(stored);
  assert.equal(stored.profile.env.EMBEDDING_PROVIDER, "hash");
  assert.deepEqual(stored.profile.runtime, {
    database_mode: "offline",
    embedding_provider: "hash",
    setup_completed_at: stored.profile.runtime.setup_completed_at,
  });
  assert.ok(stored.profile.runtime.setup_completed_at);
  if (process.platform !== "win32") {
    assert.equal(statSync(stored.path).mode & 0o777, 0o600);
  }

  const explicitEnv: NodeJS.ProcessEnv = {
    TIELINE_CONFIG_HOME: configHome,
    EMBEDDING_PROVIDER: "openai",
  };
  const loaded = loadWorkspaceProfile(target, explicitEnv);
  assert.ok(loaded);
  assert.equal(explicitEnv.EMBEDDING_PROVIDER, "openai");
  assert.equal(loaded.loaded.includes("EMBEDDING_PROVIDER"), false);

  const second = io();
  assert.equal(
    await runCli(
      ["init", target, "--yes", "--skip-skill-install"],
      second.adapter,
      { TIELINE_CONFIG_HOME: configHome }
    ),
    0
  );
  assert.match(second.output.join(""), /already initialized/i);

  const existingInteractive = interactiveIo({
    text: [],
    confirm: [],
    select: [],
    multiselect: [["codex"]],
  });
  let existingInstallCalls = 0;
  assert.equal(
    await runCli(
      ["init", target],
      existingInteractive.adapter,
      { TIELINE_CONFIG_HOME: configHome },
      {
        skillfishRunner: async (invocation) => {
          existingInstallCalls++;
          return successfulSkillfish(invocation);
        },
        mcpCliRunner: successfulMcpCli,
      }
    ),
    0
  );
  assert.equal(existingInstallCalls, 1);
  assert.equal(
    existingInteractive.prompts.some((prompt) =>
      [
        "Company/product name",
        "Stable repository name",
        "Product description (optional)",
        "Source roots (comma-separated)",
        "Database mode",
        "Embedding provider",
      ].includes(prompt)
    ),
    false,
    "existing empty workspaces should offer only agent installation"
  );
  assert.equal(readFileSync(workspace.configPath, "utf8"), configBody);

  const freshConfigHome = resolve(root, "fresh-clone-config-home");
  const unconfiguredStatus = io();
  assert.equal(
    await runCli(["status", target, "--json"], unconfiguredStatus.adapter, {
      TIELINE_CONFIG_HOME: freshConfigHome,
      DATABASE_URL: " ",
      DATABASE_URL_WRITE: " ",
    }),
    0
  );
  const parsedUnconfiguredStatus = JSON.parse(
    unconfiguredStatus.output.join("")
  ) as {
    runtime: { profile_present: boolean; setup_complete: boolean };
    capabilities: {
      semantic_matching_configured: boolean;
      planning_writes_configured: boolean;
    };
  };
  assert.equal(parsedUnconfiguredStatus.runtime.profile_present, false);
  assert.equal(parsedUnconfiguredStatus.runtime.setup_complete, false);
  assert.equal(
    parsedUnconfiguredStatus.capabilities.semantic_matching_configured,
    false
  );
  assert.equal(
    parsedUnconfiguredStatus.capabilities.planning_writes_configured,
    false
  );

  const pendingOnboardingInit = io();
  await assert.rejects(
    runCli(["init", target, "--yes"], pendingOnboardingInit.adapter, {
      TIELINE_CONFIG_HOME: freshConfigHome,
    }),
    /non-interactive init requires.*--agent.*--skip-skill-install/i
  );
  assert.equal(
    readWorkspaceProfile(workspace, {
      TIELINE_CONFIG_HOME: freshConfigHome,
    }),
    null,
    "an existing onboarding workspace must reject before writing a local profile"
  );

  const resumed = io();
  assert.equal(
    await runCli(
      ["init", target, "--yes", "--skip-skill-install"],
      resumed.adapter,
      {
        TIELINE_CONFIG_HOME: freshConfigHome,
      }
    ),
    0
  );
  assert.doesNotMatch(resumed.output.join(""), /Mode:|Runtime:|Code scope:/);
  assert.ok(
    readWorkspaceProfile(workspace, {
      TIELINE_CONFIG_HOME: freshConfigHome,
    })?.profile.runtime.setup_completed_at
  );

  const status = io();
  assert.equal(
    await runCli(["status", target, "--json"], status.adapter, {
      TIELINE_CONFIG_HOME: configHome,
    }),
    0
  );
  const parsedStatus = JSON.parse(
    status.output.join("")
  ) as TielineStatus;
  assert.equal(parsedStatus.runtime.profile_present, true);
  assert.equal(parsedStatus.runtime.setup_complete, true);
  assert.equal(parsedStatus.runtime.cli_version, runningPackageVersion);
  assert.deepEqual(parsedStatus.integration.mcp_configs, [
    {
      path: ".mcp.json",
      package_spec: runningPackageSpec,
      package_version: runningPackageVersion,
      version_status: "current",
    },
  ]);
  assert.equal(
    parsedStatus.capabilities.semantic_matching_configured,
    false
  );
  assert.equal(parsedStatus.capabilities.planning_writes_configured, false);
  assert.equal(parsedStatus.contract.stories, 0);
  assert.equal(parsedStatus.contract.acceptance_criteria, 0);
  assert.equal(
    parsedStatus.next_action,
    "Ask your agent to use the installed tieline skill to onboard this repository. In Claude Code, run /tieline; in Codex, run $tieline."
  );
  assert.deepEqual(parsedStatus.onboarding, {
    required: true,
    skill: "tieline",
    instruction:
      "Ask your agent to use the installed tieline skill to onboard this repository. In Claude Code, run /tieline; in Codex, run $tieline.",
    install_command: "npx -y tieline@latest init .",
  });
  assert.equal("agent_onboarding_prompt" in parsedStatus, false);

  const generatedMcpConfig = readFileSync(
    resolve(target, ".mcp.json"),
    "utf8"
  );
  const readJsonStatus = async (): Promise<TielineStatus> => {
    const statusIo = io();
    assert.equal(
      await runCli(["status", target, "--json"], statusIo.adapter, {
        TIELINE_CONFIG_HOME: configHome,
      }),
      0
    );
    return JSON.parse(statusIo.output.join("")) as TielineStatus;
  };
  const diagnosticCases = [
    {
      name: "mismatched exact version",
      args: ["-y", "tieline@0.0.0", "serve"],
      expected: {
        path: ".mcp.json",
        package_spec: "tieline@0.0.0",
        package_version: "0.0.0",
        version_status: "mismatch",
      },
      rendered: /mcp=tieline@0\.0\.0 \(mismatch\)/,
    },
    {
      name: "legacy bare package",
      args: ["-y", "tieline", "serve"],
      expected: {
        path: ".mcp.json",
        package_spec: "tieline",
        package_version: null,
        version_status: "unpinned",
      },
      rendered: /mcp=tieline \(unpinned\)/,
    },
    {
      name: "npm tag",
      args: ["-y", "tieline@latest", "serve"],
      expected: {
        path: ".mcp.json",
        package_spec: "tieline@latest",
        package_version: null,
        version_status: "unpinned",
      },
      rendered: /mcp=tieline@latest \(unpinned\)/,
    },
    {
      name: "Tieline argument to another npx package",
      args: ["-y", "some-wrapper", runningPackageSpec],
      expected: {
        path: ".mcp.json",
        package_spec: null,
        package_version: null,
        version_status: "unrecognized",
      },
      rendered: /mcp=unrecognized package \(unrecognized\)/,
    },
    {
      name: "explicit long package option",
      args: ["--package=tieline@0.0.0", "tieline", "serve"],
      expected: {
        path: ".mcp.json",
        package_spec: "tieline@0.0.0",
        package_version: "0.0.0",
        version_status: "mismatch",
      },
      rendered: /mcp=tieline@0\.0\.0 \(mismatch\)/,
    },
    {
      name: "explicit short package option",
      args: ["-p", runningPackageSpec, "tieline", "serve"],
      expected: {
        path: ".mcp.json",
        package_spec: runningPackageSpec,
        package_version: runningPackageVersion,
        version_status: "current",
      },
      rendered: new RegExp(
        `mcp=${runningPackageSpec.replaceAll(".", "\\.")} \\(current\\)`
      ),
    },
  ] as const;
  for (const diagnosticCase of diagnosticCases) {
    writeFileSync(
      resolve(target, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          tieline: { command: "npx", args: diagnosticCase.args },
        },
      })
    );
    const diagnosticStatus = await readJsonStatus();
    assert.deepEqual(
      diagnosticStatus.integration.mcp_configs,
      [diagnosticCase.expected],
      diagnosticCase.name
    );
    assert.match(
      renderStatus(diagnosticStatus, createPalette(false)),
      diagnosticCase.rendered,
      diagnosticCase.name
    );
  }
  writeFileSync(resolve(target, ".mcp.json"), generatedMcpConfig);

  const openCodeConfigPath = resolve(target, "opencode.json");
  writeFileSync(
    openCodeConfigPath,
    JSON.stringify({
      mcp: {
        tieline: {
          type: "local",
          command: ["npx", "-y", runningPackageSpec, "serve"],
        },
      },
    })
  );
  const multiClientStatus = await readJsonStatus();
  assert.deepEqual(multiClientStatus.integration.mcp_configs, [
    {
      path: ".mcp.json",
      package_spec: runningPackageSpec,
      package_version: runningPackageVersion,
      version_status: "current",
    },
    {
      path: "opencode.json",
      package_spec: runningPackageSpec,
      package_version: runningPackageVersion,
      version_status: "current",
    },
  ]);
  writeFileSync(
    openCodeConfigPath,
    JSON.stringify({
      mcp: {
        tieline: {
          type: "local",
          command: ["npx", "-y", "some-wrapper", runningPackageSpec],
        },
      },
    })
  );
  assert.equal(
    (await readJsonStatus()).integration.mcp_configs?.[1]?.version_status,
    "unrecognized",
    "OpenCode array commands must inspect the executed npx package only"
  );
  rmSync(openCodeConfigPath, { force: true });

  const humanStatus = io();
  assert.equal(
    await runCli(["status", target], humanStatus.adapter, {
      TIELINE_CONFIG_HOME: configHome,
    }),
    0
  );
  assert.match(
    humanStatus.output.join(""),
    /Next: Ask your agent to use the installed tieline skill to onboard this repository\. In Claude Code, run \/tieline; in Codex, run \$tieline\./
  );
  assert.doesNotMatch(humanStatus.output.join(""), /Copy the prompt/);
  assert.match(
    humanStatus.output.join(""),
    /Install skill: npx -y tieline@latest init \./
  );
  assert.match(
    humanStatus.output.join(""),
    new RegExp(
      `cli=${runningPackageVersion.replaceAll(".", "\\.")}, mcp=${runningPackageSpec.replaceAll(".", "\\.")} \\(current\\)`
    )
  );
  assert.doesNotMatch(humanStatus.output.join(""), /Agent handoff prompt:/);

  const missingMcpStatus = renderStatus(
    {
      ...parsedStatus,
      integration: { mcp_clients: [] },
    },
    createPalette(false)
  );
  assert.match(
    missingMcpStatus,
    /not registered \(rerun `npx -y tieline@latest init \.`\)/
  );
  assert.doesNotMatch(missingMcpStatus, /rerun `tieline init \.`/);

  writeFileSync(
    resolve(workspace.specDirectoryPath, "status.yaml"),
    `version: 1
capability:
  key: STATUS
  name: Workspace status
  description: Workspace readiness reflects readable contract state.
  stories:
    - key: STATUS-001
      title: Recover an unreadable manifest
      actor: maintainer
      goal: see when the compiled manifest must be regenerated
      benefit: manifest-backed commands are usable after an upgrade
      lifecycle: production
      acceptance_criteria:
        - key: STATUS-001-AC1
          criterion: Tieline must direct maintainers to compile an unreadable manifest.
`
  );

  const onboardedCloneConfigHome = resolve(
    root,
    "onboarded-clone-config-home"
  );
  await assert.rejects(
    runCli(["init", target, "--yes"], io().adapter, {
      TIELINE_CONFIG_HOME: onboardedCloneConfigHome,
    }),
    /non-interactive init requires.*--agent.*--skip-skill-install/i
  );
  assert.equal(
    readWorkspaceProfile(workspace, {
      TIELINE_CONFIG_HOME: onboardedCloneConfigHome,
    }),
    null,
    "a configured repository clone must require an agent or explicit skip before local setup"
  );
  assert.equal(
    await runCli(
      ["init", target, "--yes", "--skip-skill-install"],
      io().adapter,
      { TIELINE_CONFIG_HOME: onboardedCloneConfigHome }
    ),
    0
  );
  mkdirSync(workspace.manifestPath, { recursive: true });
  const legacyIndex = `${JSON.stringify(
    {
      schema_version: 1,
      repository: { key: "example-repository", commit: "legacy-commit" },
    },
    null,
    2
  )}\n`;
  const legacyIndexPath = resolve(workspace.manifestPath, "index.json");
  writeFileSync(legacyIndexPath, legacyIndex);

  const legacyManifestStatus = io();
  assert.equal(
    await runCli(
      ["status", target, "--json"],
      legacyManifestStatus.adapter,
      { TIELINE_CONFIG_HOME: configHome }
    ),
    0
  );
  const parsedLegacyManifestStatus = JSON.parse(
    legacyManifestStatus.output.join("")
  ) as TielineStatus;
  assert.equal(parsedLegacyManifestStatus.contract.manifest_exists, false);
  assert.equal(parsedLegacyManifestStatus.onboarding, null);
  assert.match(
    parsedLegacyManifestStatus.next_action,
    /tieline contract compile \./
  );
  assert.equal(readFileSync(legacyIndexPath, "utf8"), legacyIndex);

  const onboardedHumanStatus = io();
  assert.equal(
    await runCli(["status", target], onboardedHumanStatus.adapter, {
      TIELINE_CONFIG_HOME: configHome,
    }),
    0
  );
  assert.doesNotMatch(
    onboardedHumanStatus.output.join(""),
    /Agent handoff prompt:/
  );

  const onboardedInit = interactiveIo({
    text: [],
    confirm: [],
    select: [],
    multiselect: [],
  });
  assert.equal(
    await runCli(["init", target], onboardedInit.adapter, {
      TIELINE_CONFIG_HOME: configHome,
    }),
    0
  );
  assert.match(onboardedInit.output.join(""), /already initialized/i);
  assert.deepEqual(
    onboardedInit.prompts,
    [],
    "a configured, onboarded workspace must report status without prompting"
  );

  const environmentStatus = io();
  assert.equal(
    await runCli(["status", target, "--json"], environmentStatus.adapter, {
      TIELINE_CONFIG_HOME: configHome,
      DATABASE_URL: "postgresql://reader:private@example.test/tieline",
      DATABASE_URL_WRITE:
        "postgresql://writer:private@example.test/tieline",
    }),
    0
  );
  const parsedEnvironmentStatus = JSON.parse(
    environmentStatus.output.join("")
  ) as {
    capabilities: {
      semantic_matching_configured: boolean;
      planning_writes_configured: boolean;
    };
  };
  assert.equal(
    parsedEnvironmentStatus.capabilities.semantic_matching_configured,
    true
  );
  assert.equal(
    parsedEnvironmentStatus.capabilities.planning_writes_configured,
    true
  );

  await assert.rejects(
    runCli(["init", target, "--yes", "--force"], io().adapter, {
      TIELINE_CONFIG_HOME: configHome,
    }),
    /unknown option '--force'/
  );

  await assert.rejects(
    configureWorkspaceRuntime({
      workspace: workspace as TielineWorkspace,
      databaseMode: "existing",
      embeddingProvider: "hash",
      installLocalEmbedder: false,
      skipMigrate: true,
      env: { TIELINE_CONFIG_HOME: configHome },
      io: { write: () => undefined },
    }),
    /Postgres 16 \+ pgvector.*DATABASE_URL_ADMIN.*local Postgres.*Neon.*Supabase/s
  );

  const calls: string[] = [];
  const localDependencies = {
    startLocalDatabase: async () => {
      calls.push("start");
      return {
        ownerUrl:
          "postgresql://owner:private@127.0.0.1:5432/tieline",
        container: "tieline-test",
        waitUntilReady: async () => undefined,
      };
    },
    migrateDatabase: async () => {
      calls.push("migrate");
    },
    provisionDatabaseRoles: async () => {
      calls.push("roles");
      return {
        DATABASE_URL:
          "postgresql://reader:private@127.0.0.1:5432/tieline",
        DATABASE_URL_WRITE:
          "postgresql://writer:private@127.0.0.1:5432/tieline",
        DATABASE_URL_SYNC:
          "postgresql://sync:private@127.0.0.1:5432/tieline",
        DATABASE_URL_ADMIN:
          "postgresql://owner:private@127.0.0.1:5432/tieline",
      };
    },
  };
  await configureWorkspaceRuntime({
    workspace: workspace as TielineWorkspace,
    databaseMode: "local",
    embeddingProvider: "hash",
    installLocalEmbedder: false,
    skipMigrate: true,
    env: {
      TIELINE_CONFIG_HOME: configHome,
      DATABASE_URL:
        "postgresql://stale-reader@example.test/tieline",
      DATABASE_URL_WRITE:
        "postgresql://stale-writer@example.test/tieline",
      DATABASE_URL_SYNC:
        "postgresql://stale-sync@example.test/tieline",
    },
    io: { write: () => undefined },
    dependencies: localDependencies,
  });
  assert.deepEqual(calls, ["start"]);
  assert.equal(
    readFileSync(workspace.configPath, "utf8"),
    configBody,
    "clone-local setup must not mutate tracked workspace configuration"
  );
  assert.equal(
    readWorkspaceProfile(workspace, {
      TIELINE_CONFIG_HOME: configHome,
    })?.profile.runtime.setup_completed_at,
    null
  );
  assert.equal(
    readWorkspaceProfile(workspace, {
      TIELINE_CONFIG_HOME: configHome,
    })?.profile.env.DATABASE_URL_ADMIN,
    "postgresql://owner:private@127.0.0.1:5432/tieline"
  );
  const pendingLocalProfile = readWorkspaceProfile(workspace, {
    TIELINE_CONFIG_HOME: configHome,
  });
  assert.equal(pendingLocalProfile?.profile.env.DATABASE_URL, undefined);
  assert.equal(
    pendingLocalProfile?.profile.env.DATABASE_URL_WRITE,
    undefined
  );
  assert.equal(
    pendingLocalProfile?.profile.env.DATABASE_URL_SYNC,
    undefined
  );

  const interruptedConfigHome = resolve(root, "interrupted-local-config");
  const interruptedOwnerUrl =
    "postgresql://owner:pending@127.0.0.1:5433/tieline";
  await assert.rejects(
    configureWorkspaceRuntime({
      workspace: workspace as TielineWorkspace,
      databaseMode: "local",
      embeddingProvider: "hash",
      installLocalEmbedder: false,
      skipMigrate: false,
      env: {
        TIELINE_CONFIG_HOME: interruptedConfigHome,
        DATABASE_URL:
          "postgresql://stale-reader@example.test/tieline",
        DATABASE_URL_WRITE:
          "postgresql://stale-writer@example.test/tieline",
        DATABASE_URL_SYNC:
          "postgresql://stale-sync@example.test/tieline",
      },
      io: { write: () => undefined },
      dependencies: {
        startLocalDatabase: async () => ({
          ownerUrl: interruptedOwnerUrl,
          container: "tieline-interrupted-test",
          waitUntilReady: async () => {
            assert.equal(
              readWorkspaceProfile(workspace, {
                TIELINE_CONFIG_HOME: interruptedConfigHome,
              })?.profile.env.DATABASE_URL_ADMIN,
              interruptedOwnerUrl,
              "container ownership must be durable before readiness checks"
            );
            throw new Error("simulated local database readiness timeout");
          },
        }),
      },
    }),
    /simulated local database readiness timeout/
  );
  assert.equal(
    readWorkspaceProfile(workspace, {
      TIELINE_CONFIG_HOME: interruptedConfigHome,
    })?.profile.runtime.setup_completed_at,
    null
  );
  const interruptedProfile = readWorkspaceProfile(workspace, {
    TIELINE_CONFIG_HOME: interruptedConfigHome,
  });
  assert.equal(
    interruptedProfile?.profile.env.DATABASE_URL_ADMIN,
    interruptedOwnerUrl
  );
  assert.equal(interruptedProfile?.profile.env.DATABASE_URL, undefined);
  assert.equal(interruptedProfile?.profile.env.DATABASE_URL_WRITE, undefined);
  assert.equal(interruptedProfile?.profile.env.DATABASE_URL_SYNC, undefined);

  calls.length = 0;
  await configureWorkspaceRuntime({
    workspace: workspace as TielineWorkspace,
    databaseMode: "local",
    embeddingProvider: "hash",
    installLocalEmbedder: false,
    skipMigrate: false,
    env: { TIELINE_CONFIG_HOME: configHome },
    io: { write: () => undefined },
    dependencies: localDependencies,
  });
  assert.deepEqual(calls, ["start", "migrate", "roles"]);
  assert.ok(
    readWorkspaceProfile(workspace, {
      TIELINE_CONFIG_HOME: configHome,
    })?.profile.runtime.setup_completed_at
  );

  const provisionCalls: string[] = [];
  const provisionConfigHome = resolve(root, "provision-config-home");
  await configureWorkspaceRuntime({
    workspace: workspace as TielineWorkspace,
    databaseMode: "existing",
    embeddingProvider: "hash",
    installLocalEmbedder: false,
    skipMigrate: false,
    provisionRoles: true,
    env: {
      TIELINE_CONFIG_HOME: provisionConfigHome,
      DATABASE_URL_ADMIN:
        "postgresql://neon-owner:private@example.neon.tech/neondb",
    },
    io: { write: () => undefined },
    dependencies: {
      migrateDatabase: async () => {
        provisionCalls.push("migrate");
      },
      provisionDatabaseRoles: async (ownerUrl: string) => {
        provisionCalls.push(`roles:${ownerUrl}`);
        return {
          DATABASE_URL:
            "postgresql://reader:private@example.neon.tech/neondb",
          DATABASE_URL_WRITE:
            "postgresql://writer:private@example.neon.tech/neondb",
        };
      },
    },
  });
  assert.deepEqual(
    provisionCalls,
    [
      "migrate",
      "roles:postgresql://neon-owner:private@example.neon.tech/neondb",
    ],
    "existing mode with --provision-roles must provision after migrating"
  );
  const provisionedProfile = readWorkspaceProfile(workspace, {
    TIELINE_CONFIG_HOME: provisionConfigHome,
  });
  assert.ok(provisionedProfile?.profile.runtime.setup_completed_at);
  assert.match(provisionedProfile?.profile.env.DATABASE_URL ?? "", /reader/);
  assert.match(
    provisionedProfile?.profile.env.DATABASE_URL_WRITE ?? "",
    /writer/
  );
  const serveEnv: NodeJS.ProcessEnv = {
    TIELINE_CONFIG_HOME: configHome,
    DATABASE_URL_SYNC: "postgresql://explicit-sync@example.test/tieline",
    DATABASE_URL_ADMIN: "postgresql://explicit-admin@example.test/tieline",
  };
  const serveProfile = loadWorkspaceProfileForCommand(
    "serve",
    target,
    serveEnv
  );
  assert.ok(serveProfile);
  assert.match(serveEnv.DATABASE_URL ?? "", /reader:private/);
  assert.match(serveEnv.DATABASE_URL_WRITE ?? "", /writer:private/);
  assert.equal(serveEnv.DATABASE_URL_SYNC, undefined);
  assert.equal(serveEnv.DATABASE_URL_ADMIN, undefined);
  assert.ok(!serveProfile.loaded.includes("DATABASE_URL_SYNC"));
  assert.ok(!serveProfile.loaded.includes("DATABASE_URL_ADMIN"));

  const tielineSkill = readFileSync(
    resolve(process.cwd(), "skills/tieline/SKILL.md"),
    "utf8"
  );
  const onboardingReference = readFileSync(
    resolve(
      process.cwd(),
      "skills/tieline/references/onboarding.md"
    ),
    "utf8"
  );
  assert.match(tielineSkill, /\.tieline\/config\.json/);
  assert.match(tielineSkill, /allow_external_fetch/);
  assert.match(tielineSkill, /local YAML.*manifest/i);
  assert.match(tielineSkill, /semantic matching.*unavailable/i);
  assert.match(tielineSkill, /after `tieline init`/i);
  assert.match(tielineSkill, /installed skill or MCP prompt/i);
  assert.match(tielineSkill, /semantic onboarding/i);
  assert.match(tielineSkill, /references\/onboarding\.md/);
  assert.match(tielineSkill, /get_asset_intent_context/);
  assert.match(tielineSkill, /get_acceptance_criterion_context/);
  assert.match(tielineSkill, /tieline contract context --path/);
  assert.match(tielineSkill, /tieline contract context --ac/);
  assert.match(tielineSkill, /Only use `search_knowledge`[\s\S]*exact path, selector, or AC[\s\S]*unknown/i);
  assert.match(tielineSkill, /intent neighborhood[\s\S]*contract coupling/i);
  assert.match(tielineSkill, /not a runtime dependency graph or comprehensive blast radius/i);
  assert.match(tielineSkill, /not_assessed[\s\S]*not semantic proof/i);
  assert.match(tielineSkill, /linked test[\s\S]*not a claim that it ran or passed/i);
  assert.match(
    tielineSkill,
    /before handing off implementation, committing, pushing, or opening or updating a pull request/i,
    "the installed skill must trigger semantic closeout before implementation leaves the agent"
  );
  assert.match(
    tielineSkill,
    /project installation of this skill, or explicit invocation through the\s+equivalent MCP prompt, is the trigger[\s\S]*do not add a separate\s+`\.tieline\/config\.json` existence check/i,
    "the installed skill and equivalent MCP prompt must trigger closeout without a redundant config guard"
  );
  assert.match(
    tielineSkill,
    /covered[\s\S]*exclude[\s\S]*update[\s\S]*add[\s\S]*unresolved/i,
    "semantic closeout must classify every changed behavior cluster"
  );
  assert.match(
    tielineSkill,
    /edit the repository YAML and compile its manifest\s+directly[\s\S]*do not post a comment or request separate approval first/i,
    "justified contract changes must be reviewable branch changes rather than comment-only proposals"
  );
  assert.match(
    tielineSkill,
    /git ls-files --others --exclude-standard[\s\S]*relevant untracked file[\s\S]*behavior cluster[\s\S]*exclusion reason/i,
    "semantic closeout must classify behavior in new untracked files"
  );
  assert.match(
    tielineSkill,
    /push that follow-up without asking again only when[\s\S]*explicitly includes push or opening or updating a pull request[\s\S]*pull request for the branch is already open and the active request is not[\s\S]*commit-only/i,
    "already-authorized push and PR flows must carry follow-up closeout changes without another approval round"
  );
  assert.match(
    tielineSkill,
    /commit-only request always overrides the open-pull-request[\s\S]*exception:[\s\S]*stop after the local follow-up commit and do not push/i,
    "commit-only closeout must preserve the local-only authorization ceiling"
  );
  assert.match(
    tielineSkill,
    /implementation diff changes after closeout[\s\S]*run closeout again/i,
    "later implementation changes must invalidate an earlier semantic closeout"
  );
  assert.match(
    onboardingReference,
    /Discover these repository sources directly/
  );
  assert.match(
    onboardingReference,
    /maximum coherent, accurate coverage/i,
    "semantic onboarding must optimize for repository-wide behavioral coverage"
  );
  assert.match(
    onboardingReference,
    /every configured\s+source root[\s\S]*each discovered (?:application|app), service, worker, CLI, and\s+shared package boundary/i,
    "semantic onboarding must assess every monorepo boundary before authoring"
  );
  assert.match(
    onboardingReference,
    /working coverage ledger[\s\S]*cover[\s\S]*exclude/i,
    "semantic onboarding must account for discovered behavior rather than stopping at a valid seed"
  );
  assert.match(
    onboardingReference,
    /Repeated evidence increases confidence[\s\S]*not a prerequisite for\s+inclusion/i,
    "one strong repository source must be enough to preserve observable behavior"
  );
  assert.match(
    onboardingReference,
    /mapping coverage[\s\S]*not a proxy for semantic completeness/i,
    "path mapping must diagnose possible gaps without becoming the coverage objective"
  );
  assert.match(
    onboardingReference,
    /small contract for a large or multi-application repository is a reassessment\s+signal/i,
    "suspiciously narrow monorepo output must trigger another discovery pass"
  );
  assert.match(
    onboardingReference,
    /Audit semantic coverage before completion[\s\S]*every coverage-ledger\s+row[\s\S]*each high-confidence behavior cluster must\s+be represented by a Story and AC or have an explicit exclusion reason[\s\S]*every application boundary must have been assessed/i,
    "semantic onboarding must reconcile every discovered high-confidence behavior before completion"
  );
  assert.match(
    onboardingReference,
    /until no known high-confidence behavior remains unrepresented\s+or unexplained/i,
    "semantic onboarding must continue discovery until the behavioral gap audit is clear"
  );
  assert.match(onboardingReference, /Ask focused questions only/);
  assert.match(
    onboardingReference,
    /Set expectations first/,
    "onboarding must open by orienting the user before asking questions"
  );
  assert.match(
    onboardingReference,
    /send it before\s+reading repository files or running commands/,
    "the orientation must precede repository work, not follow it"
  );
  assert.match(
    onboardingReference,
    /init \. --yes --skip-skill-install --database local/,
    "agent-led runtime configuration must explicitly preserve the installed skill"
  );
  assert.match(
    onboardingReference,
    /init \. --yes --skip-skill-install --database existing/,
    "agent-led existing-database setup must not trigger skill selection"
  );
  assert.match(
    onboardingReference,
    /handoff so the coming silence is expected/,
    "setup must end with a handoff into the autonomous phase"
  );
  assert.match(
    tielineSkill,
    /starts with a\s+conversation, not with repository reading/,
    "the skill dispatch must order conversation before orientation steps"
  );
  assert.match(onboardingReference, /merge\s+is the approval/);
  assert.match(
    onboardingReference,
    /start here, connect later.*never as the whole\s+product/s,
    "the database question must sell what the database unlocks, not settle for offline"
  );
  assert.match(
    onboardingReference,
    /Great — let's get you set up with Tieline\./,
    "the orientation script is locked verbatim"
  );
  assert.match(
    onboardingReference,
    /production source of[\s>]+truth lives in this repository/,
    "the orientation explains the model before any question"
  );
  assert.ok(
    onboardingReference.indexOf(
      "Great — let's get you set up with Tieline."
    ) <
      onboardingReference.indexOf(
        "Where should Tieline keep your Observations?"
      ) &&
      onboardingReference.includes(
        "Where should Tieline keep your Observations?"
      ),
    "orientation must come before the database question"
  );
  assert.match(
    onboardingReference,
    /production Stories synced alongside/,
    "the orientation must explain the contract syncs to the database"
  );
  assert.match(
    onboardingReference,
    /stored outside the repository in a Postgres database/,
    "the orientation must state observations are database-only"
  );
  assert.match(
    onboardingReference,
    /\*\*Local Postgres\*\*/,
    "local Docker Postgres is a first-class answer"
  );
  assert.match(
    onboardingReference,
    /from request to[\s>]+production/,
    "the pitch is solo-first, not org-first"
  );
  assert.doesNotMatch(
    onboardingReference,
    /teammates|organization-wide/i,
    "onboarding phrasing must not assume a team"
  );
  assert.match(
    onboardingReference,
    /Do not enumerate the authored\s+Stories or acceptance\s+criteria inline/,
    "onboarding must deliver the review page, not an inline listing"
  );
  assert.doesNotMatch(
    onboardingReference,
    /pin the CLI|npm install --save-dev tieline/i,
    "semantic onboarding must not ask to modify the repository's dependencies"
  );
  assert.match(
    tielineSkill,
    /npx -y tieline@latest init/,
    "skill-driven bootstrap must explicitly resolve the latest Tieline release"
  );
  assert.match(
    onboardingReference,
    /npx -y tieline@latest init/,
    "semantic setup commands must explicitly resolve the latest Tieline release"
  );
  assert.match(
    tielineSkill,
    /pointing at `\.tieline\/review\.html`/,
    "the skill must present contract content through the review page"
  );
  const reportReference = readFileSync(
    resolve(
      process.cwd(),
      "skills/tieline/references/report.md"
    ),
    "utf8"
  );
  assert.match(reportReference, /Deliverable first/);
  assert.match(reportReference, /Fifteen lines or fewer/);
  assert.match(
    reportReference,
    /Never\s+describe it as stale and never tell the user to regenerate it by\s+hand/,
    "compile keeps the page current; the report must not claim otherwise"
  );
  assert.match(reportReference, /pull-request body/);
  assert.match(tielineSkill, /references\/report\.md/);
  assert.match(onboardingReference, /references\/report\.md/);
  const provisioningReference = readFileSync(
    resolve(
      process.cwd(),
      "skills/tieline/references/provisioning.md"
    ),
    "utf8"
  );
  assert.match(
    provisioningReference,
    /provision option in the database question is the consent/,
    "picking the menu option is the consent; no double-ask"
  );
  assert.match(provisioningReference, /neonctl orgs list.*--output json/);
  assert.match(
    provisioningReference,
    /exactly one.*--org-id/s,
    "hosted provisioning must automatically select an unambiguous Neon organization"
  );
  assert.match(
    provisioningReference,
    /more than one.*ask\s+the user/s,
    "hosted provisioning must preserve the ownership boundary when several organizations are available"
  );
  assert.match(
    provisioningReference,
    /no organization.*report that result.*continue in offline mode.*never create an\s+organization without explicit consent/s,
    "hosted provisioning must fail safely when the Neon account has no organization"
  );
  assert.match(
    provisioningReference,
    /neonctl projects create.*--org-id/s,
    "Neon project creation must pass the resolved organization explicitly"
  );
  assert.match(
    provisioningReference,
    /DATABASE_URL_ADMIN=<uri>[^\n]*npx -y tieline@latest init[^\n]*--skip-skill-install[^\n]*--database existing[^\n]*--provision-roles/,
    "hosted provisioning must pass the captured URI through the explicit existing-database role-provisioning command"
  );
  assert.match(
    provisioningReference,
    /never write it into any\s+repository file/,
    "provisioning must keep provider artifacts out of the repository"
  );
  assert.match(
    provisioningReference,
    /at most once per database/,
    "provisioning must warn about credential rotation on re-run"
  );
  assert.match(onboardingReference, /provisioning\.md/);
  const gradingReference = readFileSync(
    resolve(process.cwd(), "skills/tieline/references/grading.md"),
    "utf8"
  );
  assert.match(tielineSkill, /references\/grading\.md/);
  assert.match(tielineSkill, /For grading an existing contract change/);
  assert.match(tielineSkill, /grading-only flow returns after its report/);
  assert.match(gradingReference, /Dispatch fresh subagents/);
  assert.match(gradingReference, /tieline contract grade/);
  assert.match(gradingReference, /code_evidence/);
  assert.match(
    gradingReference,
    /JavaScript.*TypeScript.*Python.*Rust.*SQL/s,
    "grading guidance must name every parser-backed language family"
  );
  assert.match(
    gradingReference,
    /exact canonical parser selector/,
    "grading guidance must keep emitted citations closed and parser-backed"
  );
  assert.match(
    gradingReference,
    /not\s+semantic satisfaction of the Acceptance\s+Criterion/,
    "grading guidance must leave semantic satisfaction to the host agent"
  );
  assert.doesNotMatch(tielineSkill, /agent handoff printed/i);

  // Public documentation structure is under test: keep the README concise while ensuring the
  // linked guides retain setup and assurance details.
  const readme = readFileSync(resolve(process.cwd(), "README.md"), "utf8");
  const setupGuide = readFileSync(resolve(process.cwd(), "docs/setup.md"), "utf8");
  const conceptsGuide = readFileSync(resolve(process.cwd(), "docs/concepts.md"), "utf8");
  const cliGuide = readFileSync(resolve(process.cwd(), "docs/cli.md"), "utf8");
  const mcpGuide = readFileSync(resolve(process.cwd(), "docs/mcp.md"), "utf8");
  const operationsGuide = readFileSync(resolve(process.cwd(), "docs/operations.md"), "utf8");
  const publicDocs = [
    readme,
    setupGuide,
    conceptsGuide,
    cliGuide,
    mcpGuide,
    operationsGuide,
  ].join("\n");
  const howItWorksIndex = readme.indexOf("## How it works");
  const quickstartIndex = readme.indexOf("## Quickstart");
  const firstSectionIndex = readme.search(/^## /m);
  assert.ok(howItWorksIndex > 0, "README must explain how assurance works near the top");
  assert.equal(
    howItWorksIndex,
    firstSectionIndex,
    "README How it works must be the first section after the value proposition"
  );
  assert.ok(
    quickstartIndex > howItWorksIndex,
    "README assurance model must precede Quickstart"
  );
  assert.match(
    readme,
    /\[Setup\]\(docs\/setup\.md\)/,
    "README must link the detailed setup guide"
  );
  assert.match(
    readme,
    /\[Setup's post-merge sync\]\(docs\/setup\.md#post-merge-contract-sync\)/,
    "README must direct hosted readers to the post-merge sync setup"
  );
  assert.match(
    readme,
    /npx -y tieline@latest init/,
    "README bootstrap must explicitly resolve the latest Tieline release"
  );
  assert.doesNotMatch(
    `${readme}\n${setupGuide}`,
    /npx -y tieline init/,
    "public setup docs must not leave a first-time init command on implicit package resolution"
  );
  assert.doesNotMatch(
    `${readme}\n${setupGuide}`,
    /^tieline init /m,
    "public setup docs must not require a global Tieline install"
  );
  assert.doesNotMatch(
    `${readme}\n${setupGuide}`,
    /npm install --save-dev tieline|pin the CLI as a dev dependency/i,
    "public setup docs must not make dependency pinning part of onboarding"
  );
  assert.match(
    readme,
    /proposes new Stories and ACs[\s\S]*updates existing definitions/i,
    "README must explain that the installed skill maintains product intent as behavior changes"
  );
  assert.match(setupGuide, /--agent codex[\s\S]*--agent claude-code/);
  assert.match(setupGuide, /--skill-scope project/);
  assert.match(
    setupGuide,
    /## Post-merge contract sync[\s\S]*protected post-merge job[\s\S]*tieline@latest contract sync[\s\S]*--expected-previous-commit/,
    "Setup must require a protected post-merge projection sync"
  );
  assert.match(
    setupGuide,
    /DATABASE_URL_SYNC[\s\S]*MCP runtime processes receive only[\s\S]*DATABASE_URL[\s\S]*DATABASE_URL_WRITE[\s\S]*not sync or admin credentials/,
    "Setup must keep sync and admin credentials out of MCP runtime"
  );
  assert.match(readme, /get_asset_intent_context/);
  assert.match(readme, /get_acceptance_criterion_context/);
  assert.match(cliGuide, /tieline contract context --path/);
  assert.match(cliGuide, /tieline contract context --ac/);
  assert.match(cliGuide, /Use semantic discovery only when the exact path, selector, or AC ID is unknown/i);
  assert.match(cliGuide, /intent neighborhood[\s\S]*contract coupling/i);
  assert.match(cliGuide, /not a runtime dependency graph or a[\s\S]*comprehensive blast radius/i);
  assert.match(cliGuide, /not_assessed[\s\S]*No state proves the AC is implemented correctly/i);
  assert.match(cliGuide, /linked test is an evidence\s+locator[\s\S]*not a receipt that the test ran or passed/i);
  assert.match(conceptsGuide, /From proposed intent to accepted evidence/);
  assert.match(mcpGuide, /agents that do not have[\s\S]*checkout/i);
  assert.match(operationsGuide, /Run the MCP server/);
  assert.doesNotMatch(
    publicDocs,
    /retrieval profiles?|help articles?|help content/i,
    "public documentation must not promote internal retrieval profiles or help content"
  );
  assert.doesNotMatch(readme, /agent_onboarding_prompt/);
  assert.doesNotMatch(readme, /copyable,? self-contained prompt/i);

  const packageConfig = JSON.parse(
    readFileSync(resolve(process.cwd(), "package.json"), "utf8")
  ) as { scripts: Record<string, string> };
  assert.equal(
    packageConfig.scripts["check:generated-artifacts"],
    "tsx scripts/generated-artifact-gate.ts",
    "the derivation command must not accept an external compiler output path"
  );
  assert.match(
    packageConfig.scripts.test,
    /test:generated-artifacts/,
    "the complete offline suite must retain focused derivation-gate coverage"
  );
  const contractWorkflow = readFileSync(
    resolve(process.cwd(), ".github/workflows/contract.yml"),
    "utf8"
  );
  assert.match(contractWorkflow, /^  pull_request:\s*$/m);
  assert.match(contractWorkflow, /^  merge_group:\s*$/m);
  assert.match(contractWorkflow, /^  push:\s*\n    branches: \[main\]$/m);
  assert.doesNotMatch(contractWorkflow, /pull_request_target/);
  assert.match(
    contractWorkflow,
    /^permissions:\s*\n  contents: read$/m,
    "proposed-change jobs receive only explicit read access to repository contents"
  );
  const derivationJob = contractWorkflow.match(
    /\n  derivation:\n([\s\S]*?)\n  contract:/
  )?.[1];
  assert.ok(derivationJob, "the protected workflow must include a derivation job");
  assert.match(derivationJob, /npm run check:generated-artifacts/);
  assert.doesNotMatch(
    derivationJob,
    /\benv:|\benvironment:|\bsecrets?:|DATABASE_URL|postgres|publish/i,
    "the derivation job must remain credential-free and independent of Postgres or publication"
  );
  const derivationGate = readFileSync(
    resolve(process.cwd(), "scripts/generated-artifact-gate.ts"),
    "utf8"
  );
  assert.match(derivationGate, /mkdtempSync/);
  assert.match(derivationGate, /\.tieline\/manifest/);
  assert.match(derivationGate, /\.tieline\/topology/);
  assert.match(derivationGate, /generated_artifact_mismatch/);
  assert.doesNotMatch(
    derivationGate,
    /["'`]--output(?:["'`]|\s)/,
    "the derivation gate must never pass an arbitrary output path to a compiler"
  );

  for (const removed of ["merge", "review", "import", "context"]) {
    await assert.rejects(
      runCli([removed], io().adapter, {
        TIELINE_CONFIG_HOME: configHome,
      }),
      /unknown command/i
    );
  }

  // The stdin questioner lives in main(), so runCli-based tests bypass it;
  // spawn the built CLI with piped stdin to exercise buffering and EOF.
  const cliBin = resolve(process.cwd(), "dist/cli.js");
  const packagedCompile = spawnSync(
    "node",
    [
      cliBin,
      "contract",
      "compile",
      target,
      "--repo",
      "example-repository",
      "--json",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, TIELINE_CONFIG_HOME: configHome },
    }
  );
  assert.equal(packagedCompile.status, 0, packagedCompile.stderr);
  const topologyLockPath = resolve(target, ".tieline/topology.lock");
  writeFileSync(
    topologyLockPath,
    `${JSON.stringify({
      pid: process.pid,
      host: hostname(),
      created_at: new Date().toISOString(),
      nonce: "packaged-cli-live-owner",
    })}\n`
  );
  const packagedTopologyCompile = (() => {
    try {
      return spawnSync(
        process.execPath,
        [cliBin, "code", "compile", target, "--json"],
        {
          encoding: "utf8",
          env: { ...process.env, TIELINE_CONFIG_HOME: configHome },
        }
      );
    } finally {
      rmSync(topologyLockPath, { force: true });
    }
  })();
  assert.equal(packagedTopologyCompile.status, 1, packagedTopologyCompile.stderr);
  const packagedTopologyCompileResult = JSON.parse(
    packagedTopologyCompile.stdout
  );
  assert.equal(packagedTopologyCompileResult.status, "topology_invalid");
  assert.match(packagedTopologyCompileResult.detail, /owned or contended/i);
  const packagedContext = spawnSync(
    "node",
    [
      cliBin,
      "contract",
      "context",
      "--repository",
      target,
      "--ac",
      "STATUS-001-AC1",
      "--json",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, TIELINE_CONFIG_HOME: configHome },
    }
  );
  assert.equal(packagedContext.status, 0, packagedContext.stderr);
  const packagedContextResult = JSON.parse(packagedContext.stdout);
  assert.equal(packagedContextResult.status, "found");
  assert.equal(packagedContextResult.requested_stable_id, "STATUS-001-AC1");
  assert.equal(packagedContextResult.repository.key, "example-repository");
  assert.match(packagedContextResult.manifest_digest, /^[a-f0-9]{64}$/);

  const pipedTarget = resolve(root, "piped-init");
  mkdirSync(resolve(pipedTarget, "src"), { recursive: true });
  writeFileSync(
    resolve(pipedTarget, "package.json"),
    JSON.stringify({ name: "piped-product" })
  );
  const piped = spawnSync(
    "node",
    [cliBin, "init", pipedTarget, "--embedding", "hash"],
    {
      input: "",
      encoding: "utf8",
      env: { ...process.env, TIELINE_CONFIG_HOME: configHome },
    }
  );
  assert.notEqual(piped.status, 0, piped.stdout);
  assert.match(
    piped.stderr,
    /non-interactive init requires.*--agent.*--skip-skill-install/i
  );
  assert.equal(
    existsSync(resolve(pipedTarget, ".tieline")),
    false,
    "headless init without an explicit agent or skip must not leave a partial workspace"
  );

  const explicitlySkipped = spawnSync(
    "node",
    [
      cliBin,
      "init",
      pipedTarget,
      "--embedding",
      "hash",
      "--skip-skill-install",
    ],
    {
      input: "",
      encoding: "utf8",
      env: { ...process.env, TIELINE_CONFIG_HOME: configHome },
    }
  );
  assert.equal(explicitlySkipped.status, 0, explicitlySkipped.stderr);
  const pipedWorkspace = findTielineWorkspace(pipedTarget);
  assert.ok(pipedWorkspace);
  assert.equal(
    pipedWorkspace.config.product.name,
    "piped-product",
    "piped init must auto-detect identity instead of reading stdin answers"
  );
  assert.equal(pipedWorkspace.config.product.repo_name, "piped-init");

  // Bare group commands print clean help on stderr, not a "Tieline error:".
  const bareContract = spawnSync("node", [cliBin, "contract"], {
    encoding: "utf8",
    env: { ...process.env, TIELINE_CONFIG_HOME: configHome },
  });
  assert.equal(bareContract.status, 1);
  assert.match(bareContract.stderr, /Usage: tieline contract/);
  assert.doesNotMatch(bareContract.stderr, /Tieline error:/);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("tieline workspace tests passed");
