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
import { resolve } from "node:path";
import {
  runCli,
  workspaceStartForCommand,
  type TielineCliIO,
} from "../src/cli.js";
import {
  loadWorkspaceProfileForCommand,
  loadWorkspaceProfile,
  readWorkspaceProfile,
} from "../src/tieline/profile.js";
import { configureWorkspaceRuntime } from "../src/tieline/setup.js";
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
      }
    ),
    0
  );
  const workspace = findTielineWorkspace(target);
  assert.ok(workspace);
  assert.equal(workspace.config.product.repo_name, "example-repository");
  assert.equal(workspace.config.context.sources[0]?.type, "description");
  assert.ok(statSync(workspace.specDirectoryPath).isDirectory());
  assert.ok(existsSync(workspace.mcpConfigPath));

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
    JSON.parse(readFileSync(workspace.mcpConfigPath, "utf8")),
    {
      mcpServers: {
        tieline: {
          command: "tieline",
          args: ["serve"],
          env: { TIELINE_WORKSPACE: "." },
        },
      },
    }
  );
  assert.match(first.output.join(""), /source scope: src/i);
  assert.match(first.output.join(""), /warning.*duplicate checks/i);
  assert.match(first.output.join(""), /MCP prompt `tieline_author`/);
  assert.match(first.output.join(""), /semantic onboarding has not started/i);

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
  assert.match(resumed.output.join(""), /completed tieline runtime setup/i);
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
  const parsedStatus = JSON.parse(status.output.join("")) as {
    runtime: { profile_present: boolean; setup_complete: boolean };
    capabilities: {
      semantic_matching_configured: boolean;
      planning_writes_configured: boolean;
    };
    contract: { stories: number; acceptance_criteria: number };
    next_action: string;
  };
  assert.equal(parsedStatus.runtime.profile_present, true);
  assert.equal(parsedStatus.runtime.setup_complete, true);
  assert.equal(
    parsedStatus.capabilities.semantic_matching_configured,
    false
  );
  assert.equal(parsedStatus.capabilities.planning_writes_configured, false);
  assert.equal(parsedStatus.contract.stories, 0);
  assert.equal(parsedStatus.contract.acceptance_criteria, 0);
  assert.match(parsedStatus.next_action, /tieline_author/);

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
    /Unknown init option: --force/
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
    env: { TIELINE_CONFIG_HOME: configHome },
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
  assert.match(authorSkill, /\.tieline\/config\.json/);
  assert.match(authorSkill, /allow_external_fetch/);
  assert.match(authorSkill, /local YAML.*manifest/i);
  assert.match(authorSkill, /semantic matching.*unavailable/i);

  for (const removed of ["merge", "review", "import", "context"]) {
    await assert.rejects(
      runCli([removed], io().adapter, {
        TIELINE_CONFIG_HOME: configHome,
      }),
      /Unknown command/
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("tieline workspace tests passed");
