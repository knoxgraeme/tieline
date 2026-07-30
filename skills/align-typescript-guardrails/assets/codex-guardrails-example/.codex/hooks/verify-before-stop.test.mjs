import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const hook = path.join(path.dirname(fileURLToPath(import.meta.url)), "verify-before-stop.mjs");

function runHook(cwd, stopHookActive = false) {
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({
      hook_event_name: "Stop",
      cwd,
      stop_hook_active: stopHookActive,
    }),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("passes a successful fast check and blocks a failing one only once", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "guardrail-stop-hook-"));

  try {
    const git = spawnSync("git", ["init", "--quiet"], { cwd: workspace, encoding: "utf8" });
    assert.equal(git.status, 0, git.stderr);
    await writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({
        scripts: {
          "check:fast":
            "node -e \"const fs=require('node:fs');process.exit(Number(fs.readFileSync('.check-result','utf8')))\"",
        },
      }),
    );
    await writeFile(path.join(workspace, ".check-result"), "0");

    const add = spawnSync("git", ["add", "package.json", ".check-result"], {
      cwd: workspace,
      encoding: "utf8",
    });
    assert.equal(add.status, 0, add.stderr);
    const commit = spawnSync(
      "git",
      [
        "-c",
        "user.name=Guardrail Test",
        "-c",
        "user.email=guardrail@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "baseline",
      ],
      { cwd: workspace, encoding: "utf8" },
    );
    assert.equal(commit.status, 0, commit.stderr);

    await mkdir(path.join(workspace, "new", "source"), { recursive: true });
    await writeFile(
      path.join(workspace, "new", "source", "changed.ts"),
      "export const changed = true;\n",
    );
    assert.deepEqual(runHook(workspace), {});

    await writeFile(path.join(workspace, ".check-result"), "1");
    const failure = runHook(workspace);
    assert.equal(failure.decision, "block");
    assert.match(failure.reason, /check:fast/);

    assert.deepEqual(runHook(workspace, true), {});
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
