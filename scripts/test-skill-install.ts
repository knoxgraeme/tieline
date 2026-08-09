import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  SUPPORTED_SKILL_AGENTS,
  SKILL_INSTALL_TIMEOUT_MS,
  buildSkillfishInvocation,
  detectRepositoryAgents,
  installTielineSkill,
  renderSkillInstallRetryCommand,
  runSkillfishProcess,
  skippedSkillInstall,
  type SkillfishProcessRunner,
} from "../src/tieline/skill-install.js";

const workspaceRoot = "/tmp/Example Repository";
const installWorkspaceRoot = mkdtempSync(
  resolve(tmpdir(), "tieline-skill-install-")
);
const sourceEnv: NodeJS.ProcessEnv = {
  PATH: "/usr/local/bin:/usr/bin",
  HOME: "/Users/example",
  TMPDIR: "/tmp/example",
  HTTPS_PROXY: "https://proxy.example.test",
  NPM_CONFIG_REGISTRY: "https://registry.npmjs.org",
  DO_NOT_TRACK: "1",
  CI: "true",
  DATABASE_URL: "postgresql://reader:secret@example.test/tieline",
  DATABASE_URL_ADMIN: "postgresql://admin:secret@example.test/tieline",
  EMBEDDING_API_KEY: "embedding-secret",
  SUPABASE_ANON_KEY: "supabase-secret",
  GITHUB_TOKEN: "github-secret",
  GH_TOKEN: "gh-secret",
  NODE_AUTH_TOKEN: "npm-secret",
  NPM_TOKEN: "npm-token-secret",
};

assert.deepEqual(
  SUPPORTED_SKILL_AGENTS.map(({ id, selector }) => [id, selector]),
  [
    ["claude-code", "Claude Code"],
    ["codex", "Codex"],
    ["cursor", "Cursor"],
    ["gemini-cli", "Gemini CLI"],
    ["github-copilot", "GitHub Copilot"],
    ["opencode", "OpenCode"],
    ["windsurf", "Windsurf"],
  ]
);

const invocation = buildSkillfishInvocation({
  workspaceRoot,
  agentIds: ["codex", "claude-code", "codex"],
  scope: "project",
  env: sourceEnv,
  platform: "darwin",
});
assert.equal(invocation.command, "npx");
assert.equal(invocation.cwd, workspaceRoot);
assert.equal(invocation.shell, false);
assert.equal(invocation.timeoutMs, SKILL_INSTALL_TIMEOUT_MS);
assert.deepEqual(invocation.args, [
  "--yes",
  "--package=skillfish@latest",
  "skillfish",
  "add",
  "knoxgraeme/tieline",
  "--path",
  "skills/tieline",
  "--agent",
  "Codex",
  "--agent",
  "Claude Code",
  "--project",
  "--yes",
  "--json",
]);
assert.deepEqual(invocation.env, {
  PATH: sourceEnv.PATH,
  HOME: sourceEnv.HOME,
  TMPDIR: sourceEnv.TMPDIR,
  HTTPS_PROXY: sourceEnv.HTTPS_PROXY,
  NPM_CONFIG_REGISTRY: sourceEnv.NPM_CONFIG_REGISTRY,
  DO_NOT_TRACK: sourceEnv.DO_NOT_TRACK,
  CI: sourceEnv.CI,
});

const timeoutStartedAt = Date.now();
const timedOutProcess = await runSkillfishProcess({
  command: process.execPath,
  args: ["-e", "setInterval(() => {}, 1_000)"],
  cwd: process.cwd(),
  env: process.env,
  shell: false,
  timeoutMs: 25,
});
assert.equal(timedOutProcess.timedOut, true);
assert.ok(Date.now() - timeoutStartedAt < 2_000);

const windowsInvocation = buildSkillfishInvocation({
  workspaceRoot,
  agentIds: ["windsurf"],
  scope: "global",
  env: { Path: "C:\\Windows\\System32", USERPROFILE: "C:\\Users\\example" },
  platform: "win32",
});
assert.equal(windowsInvocation.command, "npx.cmd");
assert.equal(windowsInvocation.shell, true);
assert.ok(windowsInvocation.args.includes("--global"));
assert.equal(windowsInvocation.args.includes("--project"), false);
assert.equal(windowsInvocation.env.Path, "C:\\Windows\\System32");

assert.throws(
  () =>
    buildSkillfishInvocation({
      workspaceRoot,
      agentIds: [],
      scope: "project",
      env: {},
    }),
  /at least one supported agent/i
);
assert.throws(
  () =>
    buildSkillfishInvocation({
      workspaceRoot,
      agentIds: ["unknown-agent"],
      scope: "project",
      env: {},
    }),
  /unsupported agent/i
);

assert.equal(
  renderSkillInstallRetryCommand({
    workspaceRoot,
    agentIds: ["codex", "claude-code"],
    scope: "project",
    platform: "darwin",
  }),
  "npx -y tieline@latest init '/tmp/Example Repository' --yes --agent codex --agent claude-code --skill-scope project"
);
assert.equal(
  renderSkillInstallRetryCommand({
    workspaceRoot,
    agentIds: ["codex"],
    scope: "global",
    platform: "win32",
  }),
  'npx -y tieline@latest init "/tmp/Example Repository" --yes --agent codex --skill-scope global'
);

let capturedInvocation = invocation;
const successRunner: SkillfishProcessRunner = async (received) => {
  capturedInvocation = received;
  return {
    code: 0,
    stdout: JSON.stringify({
      success: true,
      exit_code: 0,
      errors: [],
      installed: [
        {
          skill: "tieline",
          agent: "Codex",
          path: "/tmp/Example Repository/.codex/skills/tieline",
          location: "project",
        },
      ],
      skipped: [
        {
          skill: "tieline",
          agent: "Claude Code",
          reason: "Already installed",
        },
      ],
      skills_found: ["tieline"],
    }),
    stderr: "",
    timedOut: false,
  };
};
const success = await installTielineSkill(
  {
    workspaceRoot: installWorkspaceRoot,
    agentIds: ["codex", "claude-code"],
    scope: "project",
    env: sourceEnv,
    platform: "darwin",
  },
  successRunner
);
assert.equal(capturedInvocation.cwd, installWorkspaceRoot);
assert.equal(success.status, "installed");
assert.deepEqual(success.installedAgents, ["codex"]);
assert.deepEqual(success.alreadyPresentAgents, ["claude-code"]);
assert.equal(success.retryCommand, null);

const failureCases: Array<{
  name: string;
  runner: SkillfishProcessRunner;
  reason: RegExp;
}> = [
  {
    name: "missing executable",
    runner: async () => {
      throw new Error("spawn npx ENOENT");
    },
    reason: /could not start/i,
  },
  {
    name: "timeout",
    runner: async () => ({
      code: 1,
      stdout: "",
      stderr: "",
      timedOut: true,
    }),
    reason: /did not finish within 120 seconds/i,
  },
  {
    name: "non-zero exit",
    runner: async () => ({
      code: 3,
      stdout: "",
      stderr: "network failed",
      timedOut: false,
    }),
    reason: /exited with code 3/i,
  },
  {
    name: "structured non-zero exit",
    runner: async () => ({
      code: 1,
      stdout: JSON.stringify({
        success: false,
        errors: [
          "No agents detected in this project. Create an agent directory or use --global.",
        ],
      }),
      stderr: "private nested output",
      timedOut: false,
    }),
    reason: /No agents detected in this project/,
  },
  {
    name: "empty output",
    runner: async () => ({
      code: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    }),
    reason: /did not return JSON/i,
  },
  {
    name: "malformed output",
    runner: async () => ({
      code: 0,
      stdout: "not-json",
      stderr: "",
      timedOut: false,
    }),
    reason: /valid JSON/i,
  },
  {
    name: "unsuccessful output",
    runner: async () => ({
      code: 0,
      stdout: JSON.stringify({
        success: false,
        exit_code: 4,
        errors: ["not found"],
        installed: [],
        skipped: [],
      }),
      stderr: "",
      timedOut: false,
    }),
    reason: /not found/i,
  },
  {
    name: "missing requested target",
    runner: async () => ({
      code: 0,
      stdout: JSON.stringify({
        success: true,
        exit_code: 0,
        errors: [],
        installed: [],
        skipped: [],
      }),
      stderr: "",
      timedOut: false,
    }),
    reason: /did not account for every requested agent/i,
  },
];

for (const failureCase of failureCases) {
  const failed = await installTielineSkill(
    {
      workspaceRoot,
      agentIds: ["codex"],
      scope: "global",
      env: sourceEnv,
      platform: "darwin",
    },
    failureCase.runner
  );
  assert.equal(failed.status, "failed", failureCase.name);
  assert.match(failed.reason ?? "", failureCase.reason, failureCase.name);
  assert.match(failed.retryCommand ?? "", /--agent codex/, failureCase.name);
  assert.doesNotMatch(
    `${failed.reason}\n${failed.retryCommand}`,
    /secret|postgresql:\/\//i,
    failureCase.name
  );
}

const projectMarkers = [
  ["claude-code", ".claude"],
  ["codex", ".codex"],
  ["cursor", ".cursor"],
  ["gemini-cli", ".gemini"],
  ["github-copilot", ".github/skills"],
  ["opencode", ".opencode"],
  ["windsurf", ".windsurf"],
] as const;

for (const [agentId, marker] of projectMarkers) {
  const agentWorkspace = resolve(installWorkspaceRoot, agentId);
  const selector = SUPPORTED_SKILL_AGENTS.find(
    (agent) => agent.id === agentId
  )?.selector;
  assert.ok(selector);
  const installed = await installTielineSkill(
    {
      workspaceRoot: agentWorkspace,
      agentIds: [agentId],
      scope: "project",
      env: sourceEnv,
      platform: "darwin",
    },
    async () => {
      assert.ok(
        existsSync(resolve(agentWorkspace, marker)),
        `${agentId} marker must exist before Skillfish runs`
      );
      return {
        code: 0,
        stdout: JSON.stringify({
          success: true,
          exit_code: 0,
          errors: [],
          installed: [
            {
              skill: "tieline",
              agent: selector,
              path: resolve(agentWorkspace, marker, "skills/tieline"),
              location: "project",
            },
          ],
          skipped: [],
        }),
        stderr: "",
        timedOut: false,
      };
    }
  );
  assert.equal(installed.status, "installed", agentId);
  assert.ok(
    detectRepositoryAgents(agentWorkspace, {}).includes(agentId),
    `${agentId} must be detected from its installed project marker`
  );
}

const globalWorkspace = resolve(installWorkspaceRoot, "global");
const globalInstall = await installTielineSkill(
  {
    workspaceRoot: globalWorkspace,
    agentIds: projectMarkers.map(([agentId]) => agentId),
    scope: "global",
    env: sourceEnv,
    platform: "darwin",
  },
  async () => ({
    code: 0,
    stdout: JSON.stringify({
      success: true,
      exit_code: 0,
      errors: [],
      installed: projectMarkers.map(([agentId], index) => ({
        skill: "tieline",
        agent: SUPPORTED_SKILL_AGENTS[index].selector,
        path: `/global/${agentId}/tieline`,
        location: "global",
      })),
      skipped: [],
    }),
    stderr: "",
    timedOut: false,
  })
);
assert.equal(globalInstall.status, "installed");
for (const [, marker] of projectMarkers) {
  assert.equal(
    existsSync(resolve(globalWorkspace, marker)),
    false,
    `global install must not create ${marker}`
  );
}

const blockedMarkerWorkspace = resolve(installWorkspaceRoot, "blocked-marker");
writeFileSync(blockedMarkerWorkspace, "occupied");
let blockedMarkerRunnerCalled = false;
const blockedMarker = await installTielineSkill(
  {
    workspaceRoot: blockedMarkerWorkspace,
    agentIds: ["codex"],
    scope: "project",
    env: sourceEnv,
    platform: "darwin",
  },
  async () => {
    blockedMarkerRunnerCalled = true;
    throw new Error("runner must not start");
  }
);
assert.equal(blockedMarker.status, "failed");
assert.equal(blockedMarkerRunnerCalled, false);
assert.match(
  blockedMarker.reason ?? "",
  /Could not prepare the Codex project marker '\.codex'/
);
assert.doesNotMatch(blockedMarker.reason ?? "", /Node\.js|npx/i);

assert.deepEqual(skippedSkillInstall(), {
  status: "skipped",
  requestedAgents: [],
  installedAgents: [],
  alreadyPresentAgents: [],
  reason: "Skill installation was not requested.",
  retryCommand: null,
});

rmSync(installWorkspaceRoot, { recursive: true, force: true });

console.log("skill install adapter tests passed");
