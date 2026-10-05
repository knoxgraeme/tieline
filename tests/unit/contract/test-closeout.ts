import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { stringify } from "yaml";
import { buildCloseoutScope, verifyCloseoutReport, type CloseoutReport } from "../../../src/contract/closeout.js";
import { runCloseout } from "../../../src/commands/closeout.js";
import { runCli } from "../../../src/cli.js";
import { tielineConfigJson } from "../../support/fixtures.js";

const root = mkdtempSync(resolve(tmpdir(), "tieline-closeout-test-"));
const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 30_000, stdio: "pipe",
  env: { ...process.env, GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" } }).trim();
const commit = (message: string) => { git(["add", "."]); git(["commit", "-m", message]); return git(["rev-parse", "HEAD"]); };
const link = (path: string, repository = "fixture") => ({ relation: "implements", provenance: "authored", target: { kind: "code", repository, path } });
const definition = { version: 1, capability: { key: "EVAL", name: "Fixture", description: "Closeout fixture", stories: [{
  key: "EVAL-001", title: "Checkout", actor: "user", goal: "confirm checkout", benefit: "avoid unconfirmed charges", lifecycle: "production",
  links: [link("src/shared.ts")], acceptance_criteria: [
    { key: "AC-ONE", criterion: "Checkout must require confirmation.", links: [link("src/checkout.ts")] },
    { key: "AC-TWO", criterion: "Legacy checkout must require confirmation.", links: [link("src/old.ts")] },
    { key: "AC-THREE", criterion: "Shared policy must apply to checkout.", links: [] },
    { key: "AC-EXTERNAL", criterion: "External behavior must remain external.", links: [link("src/checkout.ts", "another-repo")] },
  ],
}] } };
const spec = resolve(root, ".tieline/spec/fixture.yaml");
try {
  git(["init", "-b", "main"]); git(["config", "user.name", "Test"]); git(["config", "user.email", "test@example.invalid"]);
  mkdirSync(resolve(root, ".tieline/spec"), { recursive: true }); mkdirSync(resolve(root, "src"));
  writeFileSync(resolve(root, ".tieline/config.json"), tielineConfigJson({ name: "Fixture", repoName: "fixture", specDirectory: "spec" }));
  for (const name of ["checkout", "old", "shared"]) writeFileSync(resolve(root, `src/${name}.ts`), "export const allowed = true;\n");
  writeFileSync(spec, stringify(definition));
  const base = commit("baseline");
  writeFileSync(resolve(root, "src/checkout.ts"), "export const allowed = false;\n");
  const head = commit("implementation only");
  const scope = buildCloseoutScope({ repositoryRoot: root, base, head });
  git(["checkout", "-b", "target", base]);
  writeFileSync(resolve(root, "TARGET.md"), "Unrelated target branch change\n");
  const movedTarget = commit("target branch advanced");
  git(["checkout", "main"]);
  const diverged = buildCloseoutScope({ repositoryRoot: root, base: movedTarget, head });
  assert.equal(diverged.binding.base_commit, movedTarget);
  assert.equal(diverged.binding.merge_base_commit, base);
  assert.deepEqual(diverged.criteria, scope.criteria);
  assert.ok(!diverged.changed_paths.includes("TARGET.md"));
  assert.deepEqual(buildCloseoutScope({ repositoryRoot: resolve(root, "src"), base, head }), scope);
  assert.deepEqual(scope.criteria.map((criterion) => criterion.id), ["AC-ONE"]);
  assert.deepEqual(scope.criteria[0]!.reasons, ["linked_file_changed"]);
  const report: CloseoutReport = { schema_version: 1, binding: scope.binding, dispositions: [
    { criteria: ["AC-ONE"], disposition: "still_valid", reason: "An independently reviewed implementation explanation belongs here.", changed_paths: [] },
  ] };
  assert.equal(verifyCloseoutReport(scope, report).ready, true);
  assert.equal(verifyCloseoutReport(scope, report).semantic_support, "not_assessed");
  assert.throws(() => verifyCloseoutReport(diverged, report), /base_commit/);
  assert.equal(verifyCloseoutReport(scope, { ...report, dispositions: [] }).complete, false);
  const unresolved = verifyCloseoutReport(scope, { ...report, dispositions: [{ ...report.dispositions[0], disposition: "unresolved" }] });
  assert.equal(unresolved.complete, true); assert.equal(unresolved.ready, false);
  assert.throws(() => verifyCloseoutReport(scope, { ...report, dispositions: [...report.dispositions, ...report.dispositions] }), /Duplicate/);
  assert.throws(() => verifyCloseoutReport(scope, { ...report, dispositions: [{ ...report.dispositions[0], criteria: ["AC-EXTERNAL"] }] }), /Out-of-scope/);
  assert.throws(() => verifyCloseoutReport(scope, { ...report, dispositions: [{ ...report.dispositions[0], reason: " " }] }));
  assert.throws(() => verifyCloseoutReport(scope, { ...report, dispositions: [{ ...report.dispositions[0], disposition: "updated" }] }), /cite at least one/);
  assert.throws(() => verifyCloseoutReport(scope, { ...report, dispositions: [{ ...report.dispositions[0], changed_paths: ["src/fabricated.ts"] }] }), /outside/);
  assert.equal(verifyCloseoutReport(scope, { ...report, dispositions: [{ ...report.dispositions[0], disposition: "updated", changed_paths: ["src/checkout.ts"] }] }).ready, true);
  for (const key of Object.keys(scope.binding)) {
    assert.throws(() => verifyCloseoutReport(scope, { ...report, binding: { ...scope.binding, [key]: key === "repository" ? "wrong" : "0".repeat(key === "scope_sha256" ? 64 : 40) } }), /mismatched/);
  }
  // Worktree edits cannot silently change the reviewed input: scope reads only commits.
  writeFileSync(resolve(root, "src/checkout.ts"), "uncommitted change");
  assert.deepEqual(buildCloseoutScope({ repositoryRoot: root, base, head }), scope);
  git(["restore", "src/checkout.ts"]);
  let output = "";
  const io = { write: (message: string) => { output += message; } };
  const configPath = resolve(root, ".tieline/config.json");
  const config = readFileSync(configPath, "utf8");
  writeFileSync(configPath, "invalid uncommitted config");
  assert.equal(await runCli(["contract", "closeout", resolve(root, "src"), "--base", base, "--head", head, "--emit-scope"],
    { ...io, error: (message) => { throw new Error(message); }, question: async () => { throw new Error("No prompts expected"); } }, {}), 0);
  assert.deepEqual(JSON.parse(output), scope);
  output = "";
  writeFileSync(configPath, config);
  const reportPath = resolve(root, ".git/closeout.json");
  writeFileSync(reportPath, JSON.stringify(report));
  assert.equal(runCloseout({ repository: root, base, verify: reportPath }, io), 0);
  assert.equal(JSON.parse(output).ready, true);
  assert.throws(() => runCloseout({ repository: root, base }, io), /exactly one/);
  writeFileSync(reportPath, JSON.stringify({ ...report, dispositions: [] }));
  assert.equal(runCloseout({ repository: root, base, verify: reportPath }, io), 1);
  writeFileSync(reportPath, " ".repeat(2 * 1024 * 1024 + 1));
  assert.throws(() => runCloseout({ repository: root, base, verify: reportPath }, io), /2 MiB/);
  writeFileSync(reportPath, "{");
  assert.throws(() => runCloseout({ repository: root, base, verify: reportPath }, io), SyntaxError);
  writeFileSync(reportPath, JSON.stringify(report));

  // New commit invalidates a report even if its required AC list is unchanged.
  writeFileSync(resolve(root, "README.md"), "Docs changed\n");
  const nextHead = commit("new revision");
  const next = buildCloseoutScope({ repositoryRoot: root, base, head: nextHead });
  assert.throws(() => verifyCloseoutReport(next, report), /head_commit/);
  assert.ok(next.unmapped_changed_paths.includes("README.md"));
  assert.equal(buildCloseoutScope({ repositoryRoot: root, base: nextHead, head: nextHead }).criteria.length, 0);
  assert.throws(() => runCloseout({ repository: root, base, verify: reportPath }, io), /head_commit/);

  // Removing a link cannot hide its former rule; removed rules also remain in scope.
  definition.capability.stories[0]!.acceptance_criteria[0]!.links = [];
  definition.capability.stories[0]!.acceptance_criteria = definition.capability.stories[0]!.acceptance_criteria.filter((criterion) => criterion.key !== "AC-TWO");
  definition.capability.stories[0]!.acceptance_criteria.push({ key: "AC-NEW", criterion: "New rules must require review.", links: [] });
  writeFileSync(spec, stringify(definition));
  renameSync(resolve(root, "src/old.ts"), resolve(root, "src/renamed.ts"));
  writeFileSync(resolve(root, "src/shared.ts"), "export const shared = false;\n");
  const removed = buildCloseoutScope({ repositoryRoot: root, base, head: commit("removed links and rules") });
  assert.ok(removed.criteria.find((criterion) => criterion.id === "AC-ONE")!.changed_linked_paths.includes("src/checkout.ts"));
  assert.ok(removed.criteria.find((criterion) => criterion.id === "AC-TWO")!.reasons.includes("removed"));
  assert.ok(removed.criteria.find((criterion) => criterion.id === "AC-TWO")!.changed_linked_paths.includes("src/old.ts"));
  assert.ok(removed.criteria.find((criterion) => criterion.id === "AC-THREE")!.changed_linked_paths.includes("src/shared.ts"));
  assert.ok(removed.criteria.find((criterion) => criterion.id === "AC-NEW")!.reasons.includes("added"));
  const grouped = { schema_version: 1, binding: removed.binding, dispositions: [{ criteria: removed.criteria.map((criterion) => criterion.id), disposition: "updated", reason: "Reviewed the policy change and its affected definitions together.", changed_paths: [".tieline/spec/fixture.yaml"] }] };
  assert.equal(verifyCloseoutReport(removed, grouped).ready, true);
  assert.throws(() => verifyCloseoutReport(removed, { ...grouped, dispositions: [{ ...grouped.dispositions[0], disposition: "still_valid" }] }), /Changed claim/);
  const priorConfig = git(["rev-parse", "HEAD"]);
  writeFileSync(configPath, JSON.stringify({ ...JSON.parse(config), manifest_mode: "post_merge" }));
  const configScope = buildCloseoutScope({ repositoryRoot: root, base: priorConfig, head: commit("configuration changed") });
  assert.equal(configScope.criteria.length, definition.capability.stories[0]!.acceptance_criteria.length);
  assert.ok(configScope.criteria.every((criterion) => criterion.reasons.includes("configuration_changed")));
  const priorApplicability = git(["rev-parse", "HEAD"]);
  writeFileSync(spec, stringify({ ...definition, capability: { ...definition.capability, applies_to: { plan: ["pro"] } } }));
  const applicabilityScope = buildCloseoutScope({ repositoryRoot: root, base: priorApplicability, head: commit("capability applicability changed") });
  assert.equal(applicabilityScope.criteria.length, definition.capability.stories[0]!.acceptance_criteria.length);
  assert.ok(applicabilityScope.criteria.every((criterion) => criterion.reasons.includes("claim_changed")));
  // No compiled manifest is needed, and a generated baseline cannot erase Git impacts.
  const beforePublication = buildCloseoutScope({ repositoryRoot: root, base, head: "HEAD" });
  mkdirSync(resolve(root, ".tieline/manifest"));
  writeFileSync(resolve(root, ".tieline/manifest/index.json"), "{}");
  const refreshed = buildCloseoutScope({ repositoryRoot: root, base, head: commit("generated publication") });
  assert.deepEqual(refreshed.criteria, beforePublication.criteria);
  assert.ok(refreshed.criteria.some((criterion) => criterion.id === "AC-TWO" && criterion.reasons.includes("removed")));
  // Missing config at head cannot hide all formerly accepted rules.
  rmSync(resolve(root, ".tieline"), { recursive: true });
  const deleted = buildCloseoutScope({ repositoryRoot: root, base, head: commit("remove contract") });
  assert.equal(deleted.criteria.length, 4);
  assert.ok(deleted.criteria.every((criterion) => criterion.reasons.includes("removed")));
  assert.throws(() => buildCloseoutScope({ repositoryRoot: root, base: "--all", head: "HEAD" }));
  assert.ok(readFileSync(reportPath, "utf8").includes(scope.binding.head_commit));
  console.log("commit-bound closeout tests passed");
} finally { rmSync(root, { recursive: true, force: true }); }
