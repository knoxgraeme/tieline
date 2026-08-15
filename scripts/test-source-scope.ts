import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runCli, type TielineCliIO } from "../src/cli.js";
import {
  discoverRepositorySourceScope,
  sourceScopeAdvisoryCandidates,
  sourceScopeFromPaths,
} from "../src/tieline/source-scope.js";
import { findTielineWorkspace } from "../src/tieline/workspace.js";

function io(): { adapter: TielineCliIO; output: string[] } {
  const output: string[] = [];
  return {
    output,
    adapter: {
      write: (message) => output.push(message),
      error: (message) => output.push(message),
      question: async () => {
        throw new Error("Source-scope discovery must not add a prompt.");
      },
    },
  };
}

const generic = sourceScopeFromPaths([
  "zebra/entry.ts",
  "orchard/jobs.py",
  "foundry/core.rs",
  "tooling.config.js",
  "zebra/another.tsx",
]);
assert.deepEqual(generic.sourceRoots, ["foundry", "orchard", "zebra"]);
assert.deepEqual(
  generic.candidates,
  [
    {
      root: ".",
      files: ["tooling.config.js"],
    },
    { root: "foundry", files: ["foundry/core.rs"] },
    { root: "orchard", files: ["orchard/jobs.py"] },
    {
      root: "zebra",
      files: ["zebra/another.tsx", "zebra/entry.ts"],
    },
  ],
  "arbitrary directory names and supported languages must produce stable roots"
);

assert.deepEqual(
  sourceScopeFromPaths(
    ["kept/main.ts", "generated/client.ts", "cache/job.py"],
    ["generated", "cache/**"]
  ).sourceRoots,
  ["kept"],
  "effective ignore rules must remove paths before roots are inferred"
);
assert.deepEqual(
  sourceScopeFromPaths(["README.md", "pyproject.toml"]).sourceRoots,
  ["."],
  "repositories without recognized code must fall back to the repository root"
);
assert.deepEqual(
  sourceScopeAdvisoryCandidates(generic.candidates, generic.sourceRoots),
  [{ root: ".", files: ["tooling.config.js"] }],
  "root-level code remains advisory without widening directory-backed scope"
);

const explicitScope = sourceScopeFromPaths([
  "api/main.ts",
  "worker/jobs.py",
  "worker/native.rs",
]);
assert.deepEqual(
  sourceScopeAdvisoryCandidates(explicitScope.candidates, ["api"]),
  [
    {
      root: "worker",
      files: ["worker/jobs.py", "worker/native.rs"],
    },
  ],
  "explicit roots must remain authoritative while omitted roots are advisory"
);

const root = mkdtempSync(resolve(tmpdir(), "tieline-source-scope-"));
try {
  const gitRepository = resolve(root, "git-repository");
  mkdirSync(resolve(gitRepository, "visible"), { recursive: true });
  mkdirSync(resolve(gitRepository, "ignored"), { recursive: true });
  mkdirSync(resolve(gitRepository, "deleted"), { recursive: true });
  mkdirSync(resolve(gitRepository, "build"), { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q", gitRepository]).status, 0);
  writeFileSync(resolve(gitRepository, ".gitignore"), "ignored/\n");
  writeFileSync(resolve(gitRepository, "visible", "main.ts"), "export {};\n");
  writeFileSync(resolve(gitRepository, "ignored", "job.py"), "pass\n");
  writeFileSync(resolve(gitRepository, "build", "generated.ts"), "export {};\n");
  writeFileSync(resolve(gitRepository, "deleted", "stale.rs"), "fn stale() {}\n");
  assert.equal(
    spawnSync("git", ["-C", gitRepository, "add", "deleted/stale.rs"])
      .status,
    0
  );
  rmSync(resolve(gitRepository, "deleted"), { recursive: true, force: true });
  symlinkSync(
    resolve(gitRepository, "visible", "main.ts"),
    resolve(gitRepository, "linked.ts")
  );
  const gitDiscovery = discoverRepositorySourceScope(gitRepository);
  assert.deepEqual(gitDiscovery.sourceRoots, ["visible"]);
  assert.deepEqual(gitDiscovery.candidates[0]?.files, ["visible/main.ts"]);
  assert.deepEqual(
    discoverRepositorySourceScope(gitRepository, []).sourceRoots,
    ["build", "visible"],
    "an existing configuration's explicit empty ignore list must stay empty"
  );

  assert.deepEqual(
    sourceScopeFromPaths(["build/generated.ts"], []).sourceRoots,
    ["build"],
    "an explicit empty ignore list must remain empty"
  );

  const plainRepository = resolve(root, "plain-repository");
  mkdirSync(resolve(plainRepository, "alpha"), { recursive: true });
  mkdirSync(resolve(plainRepository, "ignored"), { recursive: true });
  mkdirSync(resolve(plainRepository, "linked-target"), { recursive: true });
  writeFileSync(resolve(plainRepository, "alpha", "main.rs"), "fn main() {}\n");
  writeFileSync(resolve(plainRepository, "ignored", "main.py"), "pass\n");
  writeFileSync(resolve(plainRepository, "linked-target", "main.ts"), "export {};\n");
  symlinkSync(
    resolve(plainRepository, "linked-target"),
    resolve(plainRepository, "linked-directory")
  );
  const fallbackDiscovery = discoverRepositorySourceScope(plainRepository, [
    "ignored",
    "linked-target",
  ]);
  assert.deepEqual(fallbackDiscovery.sourceRoots, ["alpha"]);

  const initRepository = resolve(root, "init-repository");
  const configHome = resolve(root, "config-home");
  mkdirSync(resolve(initRepository, "api"), { recursive: true });
  mkdirSync(resolve(initRepository, "worker"), { recursive: true });
  writeFileSync(resolve(initRepository, "api", "main.ts"), "export {};\n");
  writeFileSync(resolve(initRepository, "worker", "job.py"), "pass\n");
  const first = io();
  assert.equal(
    await runCli(
      [
        "init",
        initRepository,
        "--yes",
        "--source-root",
        "api",
        "--embedding",
        "hash",
        "--skip-skill-install",
      ],
      first.adapter,
      { TIELINE_CONFIG_HOME: configHome }
    ),
    0
  );
  assert.match(
    first.output.join(""),
    /Source scope: recognized code outside configured roots: worker\./
  );
  const workspace = findTielineWorkspace(initRepository);
  assert.ok(workspace);
  assert.deepEqual(workspace.config.repository.source_roots, ["api"]);
  const configBeforeRerun = readFileSync(workspace.configPath, "utf8");

  const second = io();
  assert.equal(
    await runCli(
      ["init", initRepository, "--yes", "--skip-skill-install"],
      second.adapter,
      { TIELINE_CONFIG_HOME: configHome }
    ),
    0
  );
  assert.match(second.output.join(""), /already initialized/i);
  assert.match(
    second.output.join(""),
    /Source scope: recognized code outside configured roots: worker\./
  );
  assert.equal(
    readFileSync(workspace.configPath, "utf8"),
    configBeforeRerun,
    "an existing-workspace advisory must not rewrite configuration"
  );

  const automaticRepository = resolve(root, "automatic-repository");
  mkdirSync(resolve(automaticRepository, "blue"), { recursive: true });
  mkdirSync(resolve(automaticRepository, "green"), { recursive: true });
  writeFileSync(resolve(automaticRepository, "blue", "main.ts"), "export {};\n");
  writeFileSync(resolve(automaticRepository, "green", "job.py"), "pass\n");
  const automatic = io();
  assert.equal(
    await runCli(
      [
        "init",
        automaticRepository,
        "--yes",
        "--embedding",
        "hash",
        "--skip-skill-install",
      ],
      automatic.adapter,
      { TIELINE_CONFIG_HOME: resolve(root, "automatic-config-home") }
    ),
    0
  );
  assert.doesNotMatch(automatic.output.join(""), /Source scope:/);
  assert.deepEqual(
    findTielineWorkspace(automaticRepository)?.config.repository.source_roots,
    ["blue", "green"]
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("source scope tests passed");
