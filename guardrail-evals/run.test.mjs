import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = import.meta.dirname;
const repositoryRoot = path.resolve(root, "..");
const runner = path.join(root, "run.mjs");

function commit(workspace, message) {
  const addResult = spawnSync("git", ["add", "tsconfig.json"], {
    cwd: workspace,
    encoding: "utf8",
  });
  assert.equal(addResult.status, 0, addResult.stderr);

  const commitResult = spawnSync(
    "git",
    [
      "-c",
      "user.name=Guardrail Test",
      "-c",
      "user.email=guardrail@example.invalid",
      "commit",
      "--quiet",
      "-m",
      message,
    ],
    { cwd: workspace, encoding: "utf8" },
  );
  assert.equal(commitResult.status, 0, commitResult.stderr);
}

function runWithChunkedStdin(chunks) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, "--stdin"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));

    for (const chunk of chunks) child.stdin.write(chunk);
    child.stdin.end();
  });
}

test("--stdin accepts a safe patch delivered in chunks", async () => {
  const result = await runWithChunkedStdin([
    "diff --git a/src/value.ts b/src/value.ts\n",
    "new file mode 100644\n--- /dev/null\n+++ b/src/value.ts\n@@ -0,0 +1 @@\n+export const value = 1;\n",
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { pass: true, violations: [] });
});

test("--stdin returns status 1 and JSON for a violation", async () => {
  const result = await runWithChunkedStdin([
    "diff --git a/src/value.ts b/src/value.ts\n",
    "new file mode 100644\n--- /dev/null\n+++ b/src/value.ts\n@@ -0,0 +1 @@\n+// @ts-ignore\n",
  ]);

  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    pass: false,
    violations: ["new-ts-ignore"],
  });
});

test("--stdin rejects an empty patch", async () => {
  const result = await runWithChunkedStdin([]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Refusing to grade an empty diff/);
});

test("conflicting patch inputs return status 2", () => {
  const result = spawnSync(
    process.execPath,
    [runner, "--patch", "unused.patch", "--stdin"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /either --patch .* or --stdin/);
});

test("base and head refs detect multiline TypeScript surface narrowing", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "guardrail-runner-"));
  try {
    assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: workspace }).status, 0);
    await writeFile(
      path.join(workspace, "tsconfig.json"),
      '{\n  "exclude": [\n    "dist"\n  ]\n}\n',
    );
    commit(workspace, "base");
    const base = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: workspace,
      encoding: "utf8",
    }).stdout.trim();

    await writeFile(
      path.join(workspace, "tsconfig.json"),
      '{\n  "exclude": [\n    "dist",\n    "scripts"\n  ]\n}\n',
    );
    commit(workspace, "head");
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: workspace,
      encoding: "utf8",
    }).stdout.trim();
    const patch = spawnSync(
      "git",
      ["diff", "--no-renames", "--unified=0", base, head],
      { cwd: workspace, encoding: "utf8" },
    ).stdout;
    const result = spawnSync(
      process.execPath,
      [runner, "--stdin", "--base-ref", base, "--head-ref", head],
      { cwd: workspace, encoding: "utf8", input: patch },
    );

    assert.equal(result.status, 1, result.stderr);
    assert.ok(
      JSON.parse(result.stdout).violations.includes("typescript-surface-narrowed"),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("trusted workflow grades the merge result and fails closed on pipe errors", async () => {
  const workflow = await readFile(
    path.join(repositoryRoot, ".github/workflows/guardrail.yml"),
    "utf8",
  );

  assert.match(workflow, /set -o pipefail/);
  assert.match(workflow, /pull\/\$PR_NUMBER\/merge/);
  assert.doesNotMatch(workflow, /pull\/\$PR_NUMBER\/head/);
});

test("quality workflow passes both refs to a pipefail-protected grader", async () => {
  const workflow = await readFile(
    path.join(repositoryRoot, ".github/workflows/quality.yml"),
    "utf8",
  );

  assert.match(workflow, /set -o pipefail/);
  assert.match(
    workflow,
    /--stdin --base-ref "\$BASE_SHA" --head-ref HEAD/,
  );
});
