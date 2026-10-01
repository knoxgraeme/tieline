import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { runCli, type TielineCliIO } from "../../../src/cli.js";
import { resolveComparisonBase } from "../../../src/contract/comparison-base.js";
import { tielineConfigJson } from "../../support/fixtures.js";
import { report, test } from "../../support/harness.js";

const REPO = "comparison-fixture";
const root = mkdtempSync(resolve(tmpdir(), "tieline-comparison-base-"));

function write(path: string, content: string): void {
  mkdirSync(dirname(resolve(root, path)), { recursive: true });
  writeFileSync(resolve(root, path), content);
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function link(path: string): string {
  return `            - relation: implements
              provenance: authored
              target: { kind: code, repository: ${REPO}, path: ${path} }`;
}

function spec(criteria: Array<[string, string, string]>): string {
  return `version: 1
capability:
  key: NOTES
  name: Notes
  description: Members keep notes.
  stories:
    - key: NOTES-001
      title: Keep notes
      actor: member
      goal: keep notes
      benefit: nothing is forgotten
      lifecycle: production
      acceptance_criteria:
${criteria
  .map(
    ([key, text, path]) => `        - key: ${key}
          criterion: ${text}
          links:
${link(path)}`
  )
  .join("\n")}
`;
}

let output = "";
const io: TielineCliIO = {
  write: (message) => {
    output += message;
  },
  error: (message) => {
    throw new Error(message);
  },
  question: async () => {
    throw new Error("must not prompt");
  },
};

async function json(args: string[]): Promise<Record<string, unknown>> {
  output = "";
  await runCli(args, io, {});
  return JSON.parse(output) as Record<string, unknown>;
}

function changedPaths(result: Record<string, unknown>): string[] {
  return (result.changes as Array<{ path: string }>).map((change) => change.path).sort();
}

// History: main and feature both start at `branchPoint`. The feature branch
// edits a.ts; afterwards main edits b.ts and adds a criterion linking c.ts.
git("init", "-q", "-b", "main");
git("config", "user.email", "test@example.test");
git("config", "user.name", "Tieline Test");
write(".tieline/config.json", tielineConfigJson({ name: "Comparison", repoName: REPO, specDirectory: "spec" }));
write("src/a.ts", "export const a = 1;\n");
write("src/b.ts", "export const b = 1;\n");
write(
  ".tieline/spec/notes.yaml",
  spec([
    ["NOTES-001-AC1", "Notes must save.", "src/a.ts"],
    ["NOTES-001-AC2", "Notes must list.", "src/b.ts"],
  ])
);
await runCli(["contract", "compile", root], io, {});
git("add", "-A");
git("commit", "-q", "-m", "branch point");
const branchPoint = git("rev-parse", "HEAD");

git("checkout", "-q", "-b", "feature");
write("src/a.ts", "export const a = 2;\n");
await runCli(["contract", "compile", root], io, {});
git("add", "-A");
git("commit", "-q", "-m", "feature edits a");

git("checkout", "-q", "main");
write("src/b.ts", "export const b = 2;\n");
write("src/c.ts", "export const c = 1;\n");
write(
  ".tieline/spec/notes.yaml",
  spec([
    ["NOTES-001-AC1", "Notes must save.", "src/a.ts"],
    ["NOTES-001-AC2", "Notes must list.", "src/b.ts"],
    ["NOTES-001-AC3", "Notes must search.", "src/c.ts"],
  ])
);
await runCli(["contract", "compile", root], io, {});
git("add", "-A");
git("commit", "-q", "-m", "main moves on");
const mainTip = git("rev-parse", "HEAD");
git("checkout", "-q", "feature");

console.log("comparison base");

await test("resolves the branch point rather than the base's tip", () => {
  assert.deepEqual(resolveComparisonBase(root, "main"), { ref: "main", commit: branchPoint });
  assert.deepEqual(resolveComparisonBase(root, branchPoint), { ref: branchPoint, commit: branchPoint });
  assert.equal(resolveComparisonBase(root, "HEAD").commit, git("rev-parse", "HEAD"));
});

await test("check reports only the branch's own changes when the base moved on", async () => {
  const result = await json(["check", root, "--base", "main", "--json"]);
  assert.equal(result.base, "main");
  assert.equal(result.base_commit, branchPoint);
  assert.deepEqual(changedPaths(result), [".tieline/manifest/NOTES.json", "src/a.ts"]);
  const criteria = new Set(
    (result.impacts as Array<{ acceptance_criterion_stable_id: string }>).map(
      (impact) => impact.acceptance_criterion_stable_id
    )
  );
  assert.deepEqual([...criteria], ["NOTES-001-AC1"]);
  assert.equal(result.exit_code, 0);
});

await test("reconcile and grade scope only the branch's own changes", async () => {
  const reconciled = await json(["contract", "reconcile", root, "--base", "main", "--json"]);
  assert.equal(reconciled.base_commit, branchPoint);
  assert.deepEqual(
    (reconciled.claimed_changes as Array<{ path: string }>).map((change) => change.path),
    ["src/a.ts"]
  );
  assert.deepEqual(reconciled.unclaimed_changes, []);

  const scope = await json(["contract", "grade", root, "--base", "main", "--emit-scope", "--json"]);
  const entries = scope.entries as Array<{ path: string; acceptance_criterion_stable_id: string; reason: string }>;
  assert.deepEqual(
    entries.map((entry) => [entry.acceptance_criterion_stable_id, entry.path, entry.reason]),
    [["NOTES-001-AC1", "src/a.ts", "modified"]]
  );
});

await test("a pull request checked out merged into the base keeps today's comparison", async () => {
  git("checkout", "-q", "-b", "ci-merge", "main");
  git("merge", "-q", "--no-ff", "--no-edit", "feature");
  try {
    const result = await json(["check", root, "--base", "main", "--json"]);
    assert.equal(result.base_commit, mainTip);
    assert.deepEqual(changedPaths(result), [".tieline/manifest/NOTES.json", "src/a.ts"]);
  } finally {
    git("checkout", "-q", "feature");
  }
});

await test("refuses refs that cannot name a branch point", async () => {
  assert.throws(() => resolveComparisonBase(root, "--output=/tmp/x"), /is not a Git revision/);
  assert.throws(() => resolveComparisonBase(root, " "), /is not a Git revision/);
  assert.throws(() => resolveComparisonBase(root, "no-such-ref"), /Cannot resolve base ref 'no-such-ref'/);
  git("checkout", "-q", "--orphan", "unrelated");
  git("commit", "-q", "-m", "unrelated history");
  try {
    assert.throws(
      () => resolveComparisonBase(root, "main"),
      /shares no commit with HEAD.*fetch-depth: 0/
    );
  } finally {
    git("checkout", "-q", "-f", "feature");
  }
  await assert.rejects(
    () => runCli(["check", root, "--base", "no-such-ref", "--json"], io, {}),
    /Cannot resolve base ref 'no-such-ref'/
  );
});

rmSync(root, { recursive: true, force: true });
report();
