import assert from "node:assert/strict";
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
import { dirname, resolve } from "node:path";
import { runCli, type TiepointCliIO } from "../../../src/cli.js";
import { profileIdForWorkspace } from "../../../src/tiepoint/profile.js";
import type {
  SkillfishInvocation,
  SkillfishProcessResult,
} from "../../../src/tiepoint/skill-install.js";
import { workspaceFromConfig } from "../../../src/tiepoint/workspace.js";

const runningPackageSpec = `tiepoint@${
  (
    JSON.parse(
      readFileSync(resolve(process.cwd(), "package.json"), "utf8")
    ) as { version: string }
  ).version
}`;

function io(): { adapter: TiepointCliIO; output: string[] } {
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

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function skillfish(
  invocations: SkillfishInvocation[],
  succeed = true
): (invocation: SkillfishInvocation) => Promise<SkillfishProcessResult> {
  return (invocation) => {
    invocations.push(invocation);
    const selectors = invocation.args.flatMap((arg, index) =>
      arg === "--agent" ? [invocation.args[index + 1]!] : []
    );
    return Promise.resolve(
      succeed
        ? {
            code: 0,
            stdout: JSON.stringify({
              success: true,
              exit_code: 0,
              errors: [],
              installed: selectors.map((agent) => ({
                skill: "tiepoint",
                agent,
                path: `/test/${agent}`,
              })),
              skipped: [],
            }),
            stderr: "",
            timedOut: false,
          }
        : { code: 1, stdout: "", stderr: "offline", timedOut: false }
    );
  };
}

function mcpCli(): Promise<SkillfishProcessResult> {
  return Promise.resolve({ code: 0, stdout: "", stderr: "", timedOut: false });
}

const LEGACY_SKILL = "---\nname: tieline\ndescription: Earlier skill.\n---\n\nBody\n";

/** A repository exactly as tieline 0.2.x left it after `tieline init`. */
function createLegacyRepository(
  root: string,
  name: string,
  legacyHome: string
): { repository: string; profileId: string } {
  const repository = resolve(root, name);
  mkdirSync(resolve(repository, "src"), { recursive: true });
  writeFileSync(resolve(repository, "src", "index.ts"), "export {};\n");
  const configPath = resolve(repository, ".tieline", "config.json");
  writeJson(configPath, {
    version: 1,
    product: { name: "Legacy Product", repo_name: name },
    repository: {
      root: "..",
      source_roots: ["src"],
      ignore: [".git", ".tieline", "node_modules"],
    },
    context: { sources: [] },
    runtime: {
      default_embedding_provider: "hash",
      default_database_mode: "offline",
    },
    files: { spec_directory: "spec", manifest: "manifest" },
    topology_mode: "committed",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  });
  writeFileSync(resolve(repository, ".tieline", ".gitignore"), "review.html\n");
  const workspace = workspaceFromConfig(configPath);
  const profileId = profileIdForWorkspace(workspace);
  writeJson(resolve(legacyHome, "profiles", `${profileId}.json`), {
    version: 1,
    profile_id: profileId,
    repository_root: workspace.root,
    repo_name: name,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    runtime: {
      database_mode: "offline",
      embedding_provider: "hash",
      setup_completed_at: "2026-01-01T00:00:00.000Z",
    },
    env: {
      EMBEDDING_PROVIDER: "hash",
      TIELINE_LOCAL_EMBEDDER_ROOT: "/legacy/runtime",
    },
  });
  return { repository, profileId };
}

const root = mkdtempSync(resolve(tmpdir(), "tiepoint-legacy-migration-"));
try {
  // A complete upgrade moves repository and clone-local state, replaces the
  // recognized MCP and skill registrations, and lists what remains manual.
  {
    const legacyHome = resolve(root, "legacy-home");
    const configHome = resolve(root, "config-home");
    const { repository, profileId } = createLegacyRepository(
      root,
      "upgrade-product",
      legacyHome
    );
    writeJson(resolve(repository, ".mcp.json"), {
      mcpServers: {
        tieline: {
          command: "npx",
          args: ["-y", "tieline@0.2.2", "serve"],
          env: { TIELINE_WORKSPACE: "." },
        },
        unrelated: { command: "unrelated-server" },
      },
    });
    writeJson(resolve(repository, "opencode.json"), {
      mcp: {
        tieline: {
          type: "local",
          command: ["npx", "-y", "tieline@latest", "serve"],
          enabled: true,
        },
      },
    });
    const customCursorConfig = {
      mcpServers: {
        tieline: { command: "node", args: ["/work/tieline/dist/cli.js", "serve"] },
      },
    };
    writeJson(resolve(repository, ".cursor", "mcp.json"), customCursorConfig);
    mkdirSync(resolve(repository, ".claude", "skills", "tieline", "references"), {
      recursive: true,
    });
    writeFileSync(
      resolve(repository, ".claude", "skills", "tieline", "SKILL.md"),
      LEGACY_SKILL
    );
    mkdirSync(resolve(repository, ".claude", "skills", "unrelated"), {
      recursive: true,
    });
    writeFileSync(
      resolve(repository, ".claude", "skills", "unrelated", "SKILL.md"),
      "---\nname: unrelated\n---\n"
    );
    mkdirSync(resolve(repository, ".gemini", "skills", "tieline"), {
      recursive: true,
    });
    writeFileSync(
      resolve(repository, ".gemini", "skills", "tieline", "SKILL.md"),
      "---\nname: someone-elses-skill\n---\n"
    );
    mkdirSync(resolve(repository, ".github", "workflows"), { recursive: true });
    writeFileSync(
      resolve(repository, ".github", "workflows", "contract.yml"),
      "steps:\n  - run: npx -y tieline@latest check --base origin/main .\n"
    );

    const invocations: SkillfishInvocation[] = [];
    const run = io();
    assert.equal(
      await runCli(["init", repository, "--yes"], run.adapter, {
        TIEPOINT_CONFIG_HOME: configHome,
        TIELINE_CONFIG_HOME: legacyHome,
        TIELINE_WORKSPACE: ".",
      }, { skillfishRunner: skillfish(invocations), mcpCliRunner: mcpCli }),
      0
    );
    const output = run.output.join("");

    assert.equal(existsSync(resolve(repository, ".tieline")), false);
    assert.equal(
      readFileSync(resolve(repository, ".tiepoint", ".gitignore"), "utf8"),
      "review.html\n",
      "workspace contents move with the directory"
    );
    const config = readJson(resolve(repository, ".tiepoint", "config.json")) as {
      repository: { ignore: string[] };
      product: { repo_name: string };
    };
    assert.deepEqual(config.repository.ignore, [".git", ".tiepoint", "node_modules"]);
    assert.equal(config.product.repo_name, "upgrade-product");

    const legacyProfile = resolve(legacyHome, "profiles", `${profileId}.json`);
    const profile = resolve(configHome, "profiles", `${profileId}.json`);
    assert.equal(existsSync(legacyProfile), false, "credentials are not left behind");
    assert.deepEqual(
      (readJson(profile) as { env: Record<string, string> }).env,
      { EMBEDDING_PROVIDER: "hash", TIEPOINT_LOCAL_EMBEDDER_ROOT: "/legacy/runtime" }
    );
    if (process.platform !== "win32") {
      assert.equal(statSync(profile).mode & 0o777, 0o600);
    }

    assert.equal(invocations.length, 1, "the earlier skill's agent is reinstalled");
    assert.deepEqual(
      invocations[0]!.args.slice(4, 7),
      ["knoxgraeme/tieline", "--path", "skills/tiepoint"]
    );
    assert.ok(invocations[0]!.args.includes("Claude Code"));
    assert.ok(invocations[0]!.args.includes("--project"));
    assert.equal(existsSync(resolve(repository, ".claude", "skills", "tieline")), false);
    assert.ok(existsSync(resolve(repository, ".claude", "skills", "unrelated", "SKILL.md")));
    assert.ok(
      existsSync(resolve(repository, ".gemini", "skills", "tieline", "SKILL.md")),
      "a folder whose SKILL.md names another skill is not ours to remove"
    );

    const mcp = readJson(resolve(repository, ".mcp.json")) as {
      mcpServers: Record<string, { args?: string[]; env?: Record<string, string> }>;
    };
    assert.deepEqual(Object.keys(mcp.mcpServers).sort(), ["tiepoint", "unrelated"]);
    assert.deepEqual(mcp.mcpServers.tiepoint?.args, ["-y", runningPackageSpec, "serve"]);
    assert.deepEqual(mcp.mcpServers.tiepoint?.env, { TIEPOINT_WORKSPACE: "." });
    const opencode = readJson(resolve(repository, "opencode.json")) as {
      mcp: Record<string, { command?: string[] }>;
    };
    assert.deepEqual(Object.keys(opencode.mcp), ["tiepoint"]);
    assert.deepEqual(opencode.mcp.tiepoint?.command, ["npx", "-y", runningPackageSpec, "serve"]);
    assert.deepEqual(
      readJson(resolve(repository, ".cursor", "mcp.json")),
      customCursorConfig,
      "a hand-maintained command is reported, not rewritten"
    );

    assert.match(output, /Upgraded from tieline:/);
    assert.match(output, /Workspace: moved \.tieline\/ to \.tiepoint\//);
    assert.match(output, /MCP: replaced the tieline server in \.mcp\.json, opencode\.json/);
    assert.match(output, /Skill: replaced tieline at \.claude\/skills\/tieline/);
    assert.match(output, /contract compile \.` and `npx -y tiepoint@[^`]+ code compile \.`/);
    assert.match(output, /custom tieline MCP entry in \.cursor\/mcp\.json/);
    assert.match(output, /TIELINE_CONFIG_HOME to TIEPOINT_CONFIG_HOME/);
    assert.match(output, /TIELINE_WORKSPACE to TIEPOINT_WORKSPACE/);
    assert.match(output, /Update tieline references in \.github\/workflows\/contract\.yml/);
    assert.match(output, /codex mcp remove tieline/);

    // Upgrading is idempotent: a second run moves nothing.
    const rerun = io();
    assert.equal(
      await runCli(["init", repository, "--yes", "--skip-skill-install"], rerun.adapter, {
        TIEPOINT_CONFIG_HOME: configHome,
        TIELINE_CONFIG_HOME: legacyHome,
      }, { skillfishRunner: skillfish([]), mcpCliRunner: mcpCli }),
      0
    );
    const rerunOutput = rerun.output.join("");
    assert.doesNotMatch(rerunOutput, /Upgraded from tieline/);
    assert.match(rerunOutput, /Tiepoint is already initialized/);
    assert.match(rerunOutput, /custom tieline MCP entry in \.cursor\/mcp\.json/);
  }

  // A failed reinstall keeps the earlier skill so the agent is never left
  // without one, and reports how to finish.
  {
    const legacyHome = resolve(root, "failed-install-legacy-home");
    const { repository } = createLegacyRepository(
      root,
      "failed-install-product",
      legacyHome
    );
    const skillDirectory = resolve(repository, ".claude", "skills", "tieline");
    mkdirSync(skillDirectory, { recursive: true });
    writeFileSync(resolve(skillDirectory, "SKILL.md"), LEGACY_SKILL);
    const run = io();
    assert.equal(
      await runCli(["init", repository, "--yes"], run.adapter, {
        TIEPOINT_CONFIG_HOME: resolve(root, "failed-install-config-home"),
        TIELINE_CONFIG_HOME: legacyHome,
      }, { skillfishRunner: skillfish([], false), mcpCliRunner: mcpCli }),
      1
    );
    assert.ok(existsSync(resolve(skillDirectory, "SKILL.md")));
    assert.ok(existsSync(resolve(repository, ".tiepoint", "config.json")));
    assert.match(
      run.output.join(""),
      /tieline skill remains at \.claude\/skills\/tieline; rerun init with --agent/
    );
  }

  // --skip-skill-install leaves the earlier skill untouched.
  {
    const legacyHome = resolve(root, "skip-legacy-home");
    const { repository } = createLegacyRepository(root, "skip-product", legacyHome);
    const skillDirectory = resolve(repository, ".codex", "skills", "tieline");
    mkdirSync(skillDirectory, { recursive: true });
    writeFileSync(resolve(skillDirectory, "SKILL.md"), LEGACY_SKILL);
    const invocations: SkillfishInvocation[] = [];
    const run = io();
    assert.equal(
      await runCli(["init", repository, "--yes", "--skip-skill-install"], run.adapter, {
        TIEPOINT_CONFIG_HOME: resolve(root, "skip-config-home"),
        TIELINE_CONFIG_HOME: legacyHome,
      }, { skillfishRunner: skillfish(invocations), mcpCliRunner: mcpCli }),
      0
    );
    assert.equal(invocations.length, 0);
    assert.ok(existsSync(resolve(skillDirectory, "SKILL.md")));
    assert.match(run.output.join(""), /tieline skill remains at \.codex\/skills\/tieline/);
  }

  // An existing tiepoint profile wins; the earlier one stays and is reported.
  {
    const legacyHome = resolve(root, "retained-legacy-home");
    const configHome = resolve(root, "retained-config-home");
    const { repository, profileId } = createLegacyRepository(
      root,
      "retained-product",
      legacyHome
    );
    const legacyProfile = resolve(legacyHome, "profiles", `${profileId}.json`);
    const currentProfile = resolve(configHome, "profiles", `${profileId}.json`);
    writeJson(currentProfile, {
      ...readJson(legacyProfile),
      env: { EMBEDDING_PROVIDER: "hash" },
    });
    const currentContent = readFileSync(currentProfile, "utf8");
    const run = io();
    assert.equal(
      await runCli(["init", repository, "--yes", "--skip-skill-install"], run.adapter, {
        TIEPOINT_CONFIG_HOME: configHome,
        TIELINE_CONFIG_HOME: legacyHome,
      }, { mcpCliRunner: mcpCli }),
      0
    );
    assert.ok(existsSync(legacyProfile));
    assert.equal(readFileSync(currentProfile, "utf8"), currentContent);
    assert.match(
      run.output.join(""),
      /tieline profile at .+ was not moved because a tiepoint profile already exists/
    );
  }

  // Ambiguous or invalid earlier workspaces are refused before anything moves.
  {
    const legacyHome = resolve(root, "conflict-legacy-home");
    const { repository } = createLegacyRepository(root, "conflict-product", legacyHome);
    mkdirSync(resolve(repository, ".tiepoint"), { recursive: true });
    await assert.rejects(
      runCli(["init", repository, "--yes", "--skip-skill-install"], io().adapter, {
        TIEPOINT_CONFIG_HOME: resolve(root, "conflict-config-home"),
        TIELINE_CONFIG_HOME: legacyHome,
      }),
      /Both .+\.tieline and .+\.tiepoint exist/
    );
    assert.ok(existsSync(resolve(repository, ".tieline", "config.json")));

    const invalid = resolve(root, "invalid-product");
    mkdirSync(resolve(invalid, ".tieline"), { recursive: true });
    writeFileSync(resolve(invalid, ".tieline", "config.json"), "{\"version\": 2}\n");
    await assert.rejects(
      runCli(["init", invalid, "--yes", "--skip-skill-install"], io().adapter, {
        TIEPOINT_CONFIG_HOME: resolve(root, "invalid-config-home"),
        TIELINE_CONFIG_HOME: resolve(root, "invalid-legacy-home"),
      })
    );
    assert.ok(existsSync(resolve(invalid, ".tieline", "config.json")));
    assert.equal(existsSync(resolve(invalid, ".tiepoint")), false);
  }

  // Other commands refuse an un-upgraded workspace instead of silently
  // running without its contract.
  {
    const { repository } = createLegacyRepository(
      root,
      "unmigrated-product",
      resolve(root, "unmigrated-legacy-home")
    );
    const env = { TIEPOINT_CONFIG_HOME: resolve(root, "unmigrated-config-home") };
    for (const argv of [
      ["status", repository],
      ["contract", "validate", repository],
      ["check", "--base", "HEAD", repository],
    ]) {
      await assert.rejects(
        runCli(argv, io().adapter, env),
        /\.tieline was created by tieline.+init/,
        `${argv[0]} must name the upgrade`
      );
    }
    assert.ok(existsSync(resolve(repository, ".tieline", "config.json")));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("legacy tieline migration tests passed");
