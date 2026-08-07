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
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  runCli,
  workspaceStartForCommand,
  type TielineCliIO,
} from "../src/cli.js";
import {
  detectRepositoryName,
  normalizeContextLocations,
} from "../src/tieline/init.js";
import {
  loadWorkspaceProfileForCommand,
  loadWorkspaceProfile,
  readWorkspaceProfile,
} from "../src/tieline/profile.js";
import { configureWorkspaceRuntime } from "../src/tieline/setup.js";
import {
  detectRepositoryAgents,
  type SkillfishInvocation,
  type SkillfishProcessResult,
} from "../src/tieline/skill-install.js";
import type { TielineStatus } from "../src/tieline/status.js";
import {
  findTielineWorkspace,
  type TielineWorkspace,
} from "../src/tieline/workspace.js";

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
        skill: "tieline-author",
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
      ["init", repositoryContextTarget, "--yes", "--context", "."],
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
  writeFileSync(resolve(interactiveTarget, "README.md"), "# Interactive\n");
  const interactive = interactiveIo({
    text: [],
    confirm: [true],
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
  const interactiveReview =
    interactive.prompts.find((prompt) => prompt.startsWith("Review:")) ?? "";
  assert.match(
    interactiveReview,
    /Context: product description, README\.md, https:\/\/mcpmarket\.com\/hub.*Code scope: src/s
  );
  assert.match(
    interactiveReview,
    /create \.tieline for Interactive Checkout \(interactive-checkout\) \(auto-detected\)/
  );
  assert.match(
    interactive.output.join(""),
    /Skill: tieline-author installed for Codex and Claude Code \(project\)/
  );
  // The onboarding prompt has to stand alone on its own line so it is
  // obviously the thing to copy; keep it out of the surrounding prose.
  assert.match(
    interactive.output.join(""),
    /Next steps\n {2}1\. Restart or reload your agent\.\n {2}2\. Copy the prompt below and paste it to your agent\.\n\n─+\nUse the tieline-author skill to onboard this repository to Tieline\.\n─+/
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
    confirm: [true],
    select: [],
    multiselect: [[]],
  });
  assert.equal(
    await runCli(["init", noAgentTarget], noAgent.adapter, {
      TIELINE_CONFIG_HOME: resolve(root, "no-agent-config"),
    }),
    0,
    "deselecting every agent must skip the skill install, not fail"
  );
  assert.match(noAgent.output.join(""), /Skill: not installed/);
  assert.ok(existsSync(resolve(noAgentTarget, ".mcp.json")));

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
    /Skill: tieline-author installed for Codex \(global\)/
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
                skill: "tieline-author",
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
    /Skill: tieline-author already present for Codex \(global\)/
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
    /Retry the install by running:\n\n─+\ntieline init .*Failed Install Checkout.*--yes --agent codex --skill-scope project\n─+/
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
        "opencode",
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
    "tieline",
    "serve",
  ]);
  const tielineServerEntry = {
    command: "npx",
    args: ["-y", "tieline", "serve"],
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
      readFileSync(resolve(mcpMergeTarget, "opencode.json"), "utf8")
    ),
    {
      mcp: {
        tieline: {
          type: "local",
          command: ["npx", "-y", "tieline", "serve"],
          enabled: true,
          environment: { TIELINE_WORKSPACE: "." },
        },
      },
    }
  );
  const mcpMergeOutput = mcpMerge.output.join("");
  assert.match(
    mcpMergeOutput,
    /Skill: tieline-author installed for Cursor, Codex, and OpenCode \(project\)/,
    "--agent without --skill-scope must default to the project scope"
  );
  assert.match(
    mcpMergeOutput,
    /MCP server: \.mcp\.json updated; \.cursor\/mcp\.json written; opencode\.json written/
  );
  assert.match(
    mcpMergeOutput,
    /MCP server: Codex registered globally via 'codex mcp add'/
  );
  const mergedRootBody = readFileSync(
    resolve(mcpMergeTarget, ".mcp.json"),
    "utf8"
  );
  const mcpRepeat = io();
  assert.equal(
    await runCli(["init", mcpMergeTarget, "--yes"], mcpRepeat.adapter, {
      TIELINE_CONFIG_HOME: mcpMergeConfigHome,
    }),
    0
  );
  assert.equal(
    readFileSync(resolve(mcpMergeTarget, ".mcp.json"), "utf8"),
    mergedRootBody,
    "re-running init must not rewrite an up-to-date MCP config"
  );
  assert.match(mcpRepeat.output.join(""), /\.mcp\.json unchanged/);

  const mcpInvalidTarget = resolve(root, "Mcp Invalid Checkout");
  mkdirSync(resolve(mcpInvalidTarget, "src"), { recursive: true });
  writeFileSync(resolve(mcpInvalidTarget, ".mcp.json"), "{ not json\n");
  const mcpInvalid = io();
  assert.equal(
    await runCli(
      ["init", mcpInvalidTarget, "--yes", "--embedding", "hash"],
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
          args: ["-y", "tieline", "serve"],
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
    /Use the tieline-author skill to onboard this repository to Tieline\./
  );
  assert.equal(
    readFileSync(resolve(target, ".tieline/.gitignore"), "utf8"),
    "review.html\n"
  );
  const firstOutput = first.output.join("");
  assert.match(firstOutput, /MCP server: \.mcp\.json written/);
  assert.match(firstOutput, /Review: open \.tieline\/review\.html/);
  assert.match(firstOutput, /workspace: ready/i);
  assert.match(firstOutput, /runtime: offline.*local contract authoring ready/i);
  assert.match(firstOutput, /code scope: src/i);
  assert.match(firstOutput, /optional capabilities:.*duplicate checks/i);
  assert.match(firstOutput, /skill: not installed/i);
  assert.match(
    firstOutput,
    /Install the tieline-author skill by running:\n\n─+\ntieline init \.\n─+/
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
      ["init", target, "--yes"],
      second.adapter,
      { TIELINE_CONFIG_HOME: configHome }
    ),
    0
  );
  assert.match(second.output.join(""), /already initialized/i);

  const existingInteractive = interactiveIo({
    text: [],
    confirm: [true],
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

  const resumed = io();
  assert.equal(
    await runCli(["init", target, "--yes"], resumed.adapter, {
      TIELINE_CONFIG_HOME: freshConfigHome,
    }),
    0
  );
  assert.match(
    resumed.output.join(""),
    /Runtime: offline.*local contract authoring ready/i
  );
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
  assert.equal(
    parsedStatus.capabilities.semantic_matching_configured,
    false
  );
  assert.equal(parsedStatus.capabilities.planning_writes_configured, false);
  assert.equal(parsedStatus.contract.stories, 0);
  assert.equal(parsedStatus.contract.acceptance_criteria, 0);
  assert.equal(
    parsedStatus.next_action,
    'Paste this prompt to your agent to finish onboarding: "Use the tieline-author skill to onboard this repository to Tieline."'
  );
  assert.deepEqual(parsedStatus.onboarding, {
    required: true,
    skill: "tieline-author",
    instruction:
      "Use the tieline-author skill to onboard this repository to Tieline.",
    install_command: "tieline init .",
  });
  assert.equal("agent_onboarding_prompt" in parsedStatus, false);

  const humanStatus = io();
  assert.equal(
    await runCli(["status", target], humanStatus.adapter, {
      TIELINE_CONFIG_HOME: configHome,
    }),
    0
  );
  assert.match(
    humanStatus.output.join(""),
    /Next: Copy the prompt below and paste it to your agent to finish onboarding\./
  );
  assert.match(
    humanStatus.output.join(""),
    /─+\nUse the tieline-author skill to onboard this repository to Tieline\.\n─+/
  );
  assert.match(humanStatus.output.join(""), /Install skill: tieline init \./);
  assert.doesNotMatch(humanStatus.output.join(""), /Agent handoff prompt:/);

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
    provisionLocalRoles: async () => {
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

  const authorSkill = readFileSync(
    resolve(process.cwd(), "skills/tieline-author/SKILL.md"),
    "utf8"
  );
  const onboardingReference = readFileSync(
    resolve(
      process.cwd(),
      "skills/tieline-author/references/onboarding.md"
    ),
    "utf8"
  );
  assert.match(authorSkill, /\.tieline\/config\.json/);
  assert.match(authorSkill, /allow_external_fetch/);
  assert.match(authorSkill, /local YAML.*manifest/i);
  assert.match(authorSkill, /semantic matching.*unavailable/i);
  assert.match(authorSkill, /after `tieline init`/i);
  assert.match(authorSkill, /installed skill or MCP prompt/i);
  assert.match(authorSkill, /semantic onboarding/i);
  assert.match(authorSkill, /references\/onboarding\.md/);
  assert.match(
    onboardingReference,
    /Discover these repository sources directly/
  );
  assert.match(onboardingReference, /Ask focused questions only/);
  assert.match(
    onboardingReference,
    /Do not enumerate the authored Stories or acceptance\s+criteria inline/,
    "onboarding must deliver the review page, not an inline listing"
  );
  assert.match(
    authorSkill,
    /pointing at `\.tieline\/review\.html`/,
    "the skill must present contract content through the review page"
  );
  assert.doesNotMatch(authorSkill, /agent handoff printed/i);

  const readme = readFileSync(resolve(process.cwd(), "README.md"), "utf8");
  assert.match(
    readme,
    /npx --yes --package=skillfish@latest skillfish add knoxgraeme\/tieline/
  );
  assert.match(readme, /--agent codex[\s\S]*--agent claude-code/);
  assert.match(readme, /--skill-scope project/);
  assert.doesNotMatch(readme, /agent_onboarding_prompt/);
  assert.doesNotMatch(readme, /copyable,? self-contained prompt/i);

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
  assert.equal(piped.status, 0, piped.stderr);
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
