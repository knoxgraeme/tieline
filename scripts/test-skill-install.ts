import assert from "node:assert/strict";
import {
  SUPPORTED_SKILL_AGENTS,
  buildSkillfishInvocation,
  installTielineAuthor,
  renderSkillInstallRetryCommand,
  skippedSkillInstall,
  type SkillfishProcessRunner,
} from "../src/tieline/skill-install.js";

const workspaceRoot = "/tmp/Example Repository";
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
assert.deepEqual(invocation.args, [
  "--yes",
  "--package=skillfish@latest",
  "skillfish",
  "add",
  "knoxgraeme/tieline",
  "--path",
  "skills/tieline-author",
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

const windowsInvocation = buildSkillfishInvocation({
  workspaceRoot,
  agentIds: ["windsurf"],
  scope: "global",
  env: { Path: "C:\\Windows\\System32", USERPROFILE: "C:\\Users\\example" },
  platform: "win32",
});
assert.equal(windowsInvocation.command, "npx.cmd");
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
  "tieline init '/tmp/Example Repository' --yes --agent codex --agent claude-code --skill-scope project"
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
          skill: "tieline-author",
          agent: "Codex",
          path: "/tmp/Example Repository/.codex/skills/tieline-author",
          location: "project",
        },
      ],
      skipped: [
        {
          skill: "tieline-author",
          agent: "Claude Code",
          reason: "Already installed",
        },
      ],
      skills_found: ["tieline-author"],
    }),
    stderr: "",
  };
};
const success = await installTielineAuthor(
  {
    workspaceRoot,
    agentIds: ["codex", "claude-code"],
    scope: "project",
    env: sourceEnv,
    platform: "darwin",
  },
  successRunner
);
assert.equal(capturedInvocation.cwd, workspaceRoot);
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
    name: "non-zero exit",
    runner: async () => ({ code: 3, stdout: "", stderr: "network failed" }),
    reason: /exited with code 3/i,
  },
  {
    name: "empty output",
    runner: async () => ({ code: 0, stdout: "", stderr: "" }),
    reason: /did not return JSON/i,
  },
  {
    name: "malformed output",
    runner: async () => ({ code: 0, stdout: "not-json", stderr: "" }),
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
    }),
    reason: /reported an unsuccessful installation/i,
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
    }),
    reason: /did not account for every requested agent/i,
  },
];

for (const failureCase of failureCases) {
  const failed = await installTielineAuthor(
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

assert.deepEqual(skippedSkillInstall(), {
  status: "skipped",
  requestedAgents: [],
  installedAgents: [],
  alreadyPresentAgents: [],
  reason: "Skill installation was not requested.",
  retryCommand: null,
});

console.log("skill install adapter tests passed");
