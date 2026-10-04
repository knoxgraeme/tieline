import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runContractHistoryCommand } from "../../../src/commands/contract-history.js";
import {
  CONTRACT_HISTORY_LIMITS,
  criterionHistory,
  githubRepositoryUrl,
  itemHistories,
  lastChanges,
  pullRequestNumber,
  readContractHistory,
  readReviewHistory,
} from "../../../src/contract/history.js";
import { compileContractManifestWithSources, writeContractManifest } from "../../../src/contract/manifest.js";
import { writeWorkspaceReviewPage } from "../../../src/tieline/review.js";
import { report, test } from "../../support/harness.js";
import {
  captureIO,
  createScreensWorkspace,
  notesSpecYaml,
  REPO_KEY,
  type ScreensWorkspace,
} from "../../support/screen-fixtures.js";

const workspaces: ScreensWorkspace[] = [];
const directories: string[] = [];
const MANIFEST = ".tieline/manifest";
const DIGEST = (character: string): string => character.repeat(64);

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function catalog(digest: string): string {
  return `version: 1
capability: NOTES
screens:
  - key: notes-list
    title: Notes list
    route: /notes
    kind: page
    when: A member opens Notes.
    image:
      path: notes-list.png
      sha256: ${digest}
`;
}

function compile(ws: ScreensWorkspace): void {
  writeContractManifest(
    resolve(ws.root, MANIFEST),
    compileContractManifestWithSources({ repositoryRoot: ws.root, repositoryKey: REPO_KEY, specDirectory: ".tieline/spec" })
  );
}

function commit(ws: ScreensWorkspace, subject: string): void {
  git(ws.root, "add", "-A");
  git(ws.root, "commit", "-q", "-m", subject);
}

/**
 * Acme Notes with four commits on main that change the contract and one that
 * does not, the third merged from a branch with a merge commit:
 *
 *   #1 adds everything; #2 rewords AC1; #3 (merge) rewords AC2;
 *   a README edit changes nothing; #4 recaptures the notes list.
 */
function historyWorkspace(): ScreensWorkspace {
  const ws = createScreensWorkspace({
    git: true,
    screens: { enabled: true },
    catalog: { ".tieline/screens/NOTES.yaml": catalog(DIGEST("a")) },
  });
  workspaces.push(ws);
  git(ws.root, "checkout", "-q", "-b", "main");
  compile(ws);
  commit(ws, "feat: notes (#1)");
  const spec = notesSpecYaml();
  ws.write(".tieline/spec/notes.yaml", spec.replace("newest first", "most recent first"));
  compile(ws);
  commit(ws, "docs: reword the notes list criterion (#2)");
  git(ws.root, "checkout", "-q", "-b", "empty-state");
  ws.write(
    ".tieline/spec/notes.yaml",
    spec.replace("newest first", "most recent first").replace("invite a member without notes", "invite a new member")
  );
  compile(ws);
  commit(ws, "Reword the empty state");
  git(ws.root, "checkout", "-q", "main");
  git(ws.root, "merge", "-q", "--no-ff", "empty-state", "-m", "Merge pull request #3 from acme/empty-state");
  ws.write("README.md", "Acme Notes\n");
  commit(ws, "docs: readme");
  ws.write(".tieline/screens/NOTES.yaml", catalog(DIGEST("b")));
  compile(ws);
  commit(ws, "feat: recapture the notes list (#4)");
  return ws;
}

console.log("contract history: pull requests and changes");

await test("reads the pull request from squash-merge and merge-commit subjects", () => {
  assert.equal(pullRequestNumber("feat: notes (#12)"), 12);
  assert.equal(pullRequestNumber("build: bumps (#58, #59) (#77)"), 77);
  assert.equal(pullRequestNumber("Merge pull request #3 from acme/empty-state"), 3);
  assert.equal(pullRequestNumber("fix: see #9 for details"), null);
  assert.equal(pullRequestNumber("feat: notes"), null);
});

await test("attributes each change to the first-parent commit that made it, newest first", () => {
  const ws = historyWorkspace();
  const history = readContractHistory(ws.root, MANIFEST);
  assert.equal(history.truncated, false);
  assert.deepEqual(history.unreadable, []);
  assert.deepEqual(
    history.commits.map((entry) => [entry.pull_request, entry.subject, entry.changes]),
    [
      [4, "feat: recapture the notes list (#4)", 1],
      [3, "Merge pull request #3 from acme/empty-state", 1],
      [2, "docs: reword the notes list criterion (#2)", 1],
      [1, "feat: notes (#1)", history.commits.at(-1)!.changes],
    ],
    "the README commit changed nothing, and the branch commit is folded into its merge"
  );
  const byPullRequest = (number: number) =>
    history.changes.filter((change) => change.commit.pull_request === number).map((change) => [change.kind, change.stable_id, change.status, change.aspects]);
  assert.deepEqual(byPullRequest(4), [["screen", "notes-list", "changed", ["image"]]]);
  assert.deepEqual(byPullRequest(3), [["acceptance_criterion", "NOTES-001-AC2", "changed", ["content"]]]);
  assert.deepEqual(byPullRequest(2), [["acceptance_criterion", "NOTES-001-AC1", "changed", ["content"]]]);
  assert.ok(byPullRequest(1).every(([, , status]) => status === "added"), "the first manifest adds everything");

  const last = lastChanges(history);
  assert.equal(last.get("acceptance_criterion:NOTES-001-AC1")!.changes, 2);
  assert.equal(last.get("acceptance_criterion:NOTES-001-AC1")!.last.commit.pull_request, 2);
  assert.equal(last.get("screen:notes-list")!.last.commit.pull_request, 4);
});

await test("stops at the limit without calling the oldest commit read the beginning", () => {
  const ws = historyWorkspace();
  const history = readContractHistory(ws.root, MANIFEST, { limit: 2 });
  assert.equal(history.truncated, true);
  assert.deepEqual(history.commits.map((entry) => entry.pull_request), [4, 3]);
  assert.ok(history.changes.every((change) => change.status !== "added"));
  assert.throws(() => readContractHistory(ws.root, MANIFEST, { limit: 0 }), /from 1 to 2000/);
  assert.throws(() => readContractHistory(ws.root, MANIFEST, { ref: "--output=x" }), /must not start with '-'/);
  assert.throws(() => readContractHistory(ws.root, MANIFEST, { until: "--output=x" }), /must not start with '-'/);
});

await test("bounds the manifest's file listings across the whole history, not per commit", () => {
  const ws = historyWorkspace();
  const listed = git(ws.root, "log", "--first-parent", "--format=%H", "--", MANIFEST).split("\n").filter(Boolean);
  const total = listed.reduce((sum, sha) => sum + Buffer.byteLength(git(ws.root, "ls-tree", "-r", sha, "--", MANIFEST)), 0);
  assert.ok(listed.length > 1 && total > 0);
  const whole = readContractHistory(ws.root, MANIFEST);
  assert.deepEqual(readContractHistory(ws.root, MANIFEST, { limits: { treeBytes: total } }), whole);
  // Each commit's listing fits by itself; together they do not.
  assert.throws(
    () => readContractHistory(ws.root, MANIFEST, { limits: { treeBytes: total - 1 } }),
    new RegExp(`file listings across ${listed.length} commits exceed the ${total - 1}-byte total`)
  );
  assert.equal(CONTRACT_HISTORY_LIMITS.treeBytes, 16 * 1024 * 1024);
});

await test("reads only the changes after a given commit, with its first parent as the base", () => {
  const ws = historyWorkspace();
  const second = git(ws.root, "log", "--first-parent", "--format=%H", "--grep", "(#2)").trim();
  const since = readContractHistory(ws.root, MANIFEST, { until: second });
  assert.equal(since.truncated, false);
  assert.deepEqual(since.commits.map((entry) => entry.pull_request), [4, 3]);
  assert.deepEqual(
    since.changes.map((change) => [change.commit.pull_request, change.stable_id, change.status]),
    [
      [4, "notes-list", "changed"],
      [3, "NOTES-001-AC2", "changed"],
    ]
  );
  assert.deepEqual(readContractHistory(ws.root, MANIFEST, { until: "HEAD" }).changes, []);
});

await test("treats a shallow clone's history as cut short", () => {
  const ws = historyWorkspace();
  const clone = mkdtempSync(join(tmpdir(), "tieline-history-shallow-"));
  directories.push(clone);
  execFileSync("git", ["clone", "-q", "--depth", "2", `file://${ws.root}`, clone], { stdio: "ignore" });
  const history = readContractHistory(clone, MANIFEST);
  assert.equal(history.truncated, true);
  assert.deepEqual(history.commits.map((entry) => entry.pull_request), [4]);
  assert.ok(history.changes.every((change) => change.status !== "added"), "nothing is claimed as added at the cut");
});

await test("reports commits a partial clone does not hold, without fetching them", () => {
  const ws = historyWorkspace();
  git(ws.root, "config", "uploadpack.allowFilter", "true");
  const clone = mkdtempSync(join(tmpdir(), "tieline-history-partial-"));
  directories.push(clone);
  execFileSync("git", ["clone", "-q", "--filter=blob:none", `file://${ws.root}`, clone], { stdio: "ignore" });
  // Make the source unreachable, so any attempt to fetch would fail loudly.
  git(clone, "remote", "set-url", "origin", "file:///nonexistent/tieline-history");
  const history = readContractHistory(clone, MANIFEST);
  assert.ok(history.unreadable.length > 0);
  assert.match(history.unreadable[0]!.detail, /partial clone/);
  // What #4 changed needs the manifest before it, which the clone lacks, so
  // nothing is attributed to it rather than a guess.
  assert.deepEqual(history.changes.filter((change) => change.commit.pull_request === 4), []);
});

await test("keeps what a recorder stores behind commits it cannot read", () => {
  const ws = historyWorkspace();
  git(ws.root, "config", "uploadpack.allowFilter", "true");
  const clone = mkdtempSync(join(tmpdir(), "tieline-history-gap-"));
  directories.push(clone);
  execFileSync("git", ["clone", "-q", "--filter=blob:none", `file://${ws.root}`, clone], { stdio: "ignore" });
  // Fetch the manifest before HEAD too, so HEAD's change is readable while
  // older commits are not; then make the source unreachable.
  git(clone, "checkout", "-q", "HEAD~1");
  git(clone, "checkout", "-q", "-");
  git(clone, "remote", "set-url", "origin", "file:///nonexistent/tieline-history");
  const history = readContractHistory(clone, MANIFEST);
  assert.ok(history.unreadable.length > 0);
  assert.ok(history.changes.some((change) => change.commit.pull_request === 4), "the newest commit's change is known");
  // But it is newer than a commit whose changes are unknown, so a recorder
  // resuming after its newest change must not store it yet.
  assert.deepEqual(history.beforeUnreadable.filter((change) => change.commit.pull_request === 4), []);
  assert.ok(history.beforeUnreadable.every((change) => history.changes.includes(change)));
  // With every commit readable, nothing is held back.
  const full = readContractHistory(ws.root, MANIFEST);
  assert.deepEqual(full.beforeUnreadable, full.changes);
});

await test("keeps what a recorder stores behind the oldest of several unreadable commits", () => {
  const ws = createScreensWorkspace({ git: true });
  workspaces.push(ws);
  git(ws.root, "checkout", "-q", "-b", "main");
  const spec = notesSpecYaml();
  const corrupt = (subject: string) => {
    ws.write(`${MANIFEST}/index.json`, "{ not json");
    commit(ws, subject);
  };
  compile(ws);
  commit(ws, "feat: notes (#1)");
  corrupt("chore: a broken manifest (#2)");
  compile(ws);
  commit(ws, "fix: the manifest again (#3)");
  ws.write(".tieline/spec/notes.yaml", spec.replace("newest first", "most recent first"));
  compile(ws);
  commit(ws, "docs: reword (#4)");
  corrupt("chore: another broken manifest (#5)");
  ws.write(".tieline/spec/notes.yaml", spec.replace("newest first", "latest first"));
  compile(ws);
  commit(ws, "docs: reword again (#6)");
  const history = readContractHistory(ws.root, MANIFEST);
  assert.equal(history.unreadable.length, 2);
  // #4 is known, but it lies between the two gaps: storing it would move a
  // recorder's resume point past #2, whose changes are unknown.
  assert.ok(history.changes.some((change) => change.commit.pull_request === 4));
  assert.deepEqual([...new Set(history.beforeUnreadable.map((change) => change.commit.pull_request))], [1]);
});

await test("links pull requests and commits for GitHub remotes only", () => {
  const ws = historyWorkspace();
  assert.equal(githubRepositoryUrl(ws.root), null);
  git(ws.root, "remote", "add", "origin", "https://github.com/acme/notes.git");
  for (const remote of ["https://github.com/acme/notes.git", "git@github.com:acme/notes.git", "ssh://git@github.com/acme/notes"]) {
    git(ws.root, "remote", "set-url", "origin", remote);
    assert.equal(githubRepositoryUrl(ws.root), "https://github.com/acme/notes", remote);
  }
  git(ws.root, "remote", "set-url", "origin", "https://gitlab.example.test/acme/notes.git");
  assert.equal(githubRepositoryUrl(ws.root), null);

  const items = itemHistories(readContractHistory(ws.root, MANIFEST), "https://github.com/acme/notes");
  assert.deepEqual(items.get("acceptance_criterion:NOTES-001-AC2"), {
    label: "#3",
    url: "https://github.com/acme/notes/pull/3",
    date: items.get("acceptance_criterion:NOTES-001-AC2")!.date,
    changes: 2,
  });
});

await test("gives one criterion's changes for exact context reads, or why there are none", () => {
  const ws = historyWorkspace();
  const history = criterionHistory(ws.root, resolve(ws.root, MANIFEST), "NOTES-001-AC2");
  assert.equal(history.unavailable, null);
  assert.equal(history.total, 2);
  assert.deepEqual(
    history.changes.map((change) => [change.status, change.pull_request, change.aspects]),
    [
      ["changed", 3, ["content"]],
      ["added", 1, []],
    ]
  );
  assert.equal(criterionHistory(ws.root, resolve(ws.root, MANIFEST), "NOTES-404").total, 0);
  const outside = mkdtempSync(join(tmpdir(), "tieline-history-none-"));
  directories.push(outside);
  assert.match(criterionHistory(outside, resolve(outside, MANIFEST), "NOTES-001-AC1").unavailable ?? "", /git history could not be read/);
});

console.log("contract history: command and review page");

await test("lists the contract's changes, or one item's, with their pull requests", () => {
  const ws = historyWorkspace();
  const all = captureIO();
  assert.equal(runContractHistoryCommand({ repository: ws.root }, all.io), 0);
  assert.match(all.output(), /^4 commit\(s\) changed the contract, newest first\.\n/);
  assert.match(all.output(), /#4\s+1 screen\s+feat: recapture the notes list \(#4\)/);
  assert.match(all.output(), /#3\s+1 criterion\s+Merge pull request #3/);

  const one = captureIO();
  assert.equal(runContractHistoryCommand({ repository: ws.root, key: "NOTES-001-AC1", json: true }, one.io), 0);
  const result = JSON.parse(one.output()) as { key: string; changes: Array<{ status: string; commit: { pull_request: number; url: string | null } }> };
  assert.equal(result.key, "NOTES-001-AC1");
  assert.deepEqual(result.changes.map((change) => [change.status, change.commit.pull_request, change.commit.url]), [
    ["changed", 2, null],
    ["added", 1, null],
  ]);

  const none = captureIO();
  runContractHistoryCommand({ repository: ws.root, key: "NOPE-1" }, none.io);
  assert.match(none.output(), /No change to NOPE-1 in the history read\./);
});

await test("shows when each Story, criterion, and screen last changed on the review page", () => {
  const ws = historyWorkspace();
  git(ws.root, "remote", "add", "origin", "https://github.com/acme/notes.git");
  const history = readReviewHistory(ws.root, resolve(ws.root, MANIFEST));
  assert.equal(history.status, "read");
  if (history.status !== "read") return;
  writeWorkspaceReviewPage(ws.root, REPO_KEY, ".tieline/spec", undefined, undefined, {
    items: history.items,
    truncated: history.truncated,
  });
  const page = readFileSync(resolve(ws.root, ".tieline/review.html"), "utf8");
  assert.match(
    page,
    /<span class="last-changed">Last changed in <a href="https:\/\/github\.com\/acme\/notes\/pull\/3" rel="noreferrer">#3<\/a> · \d{4}-\d{2}-\d{2} · 2 changes<\/span>/
  );
  // A criterion's rewording is not its Story's change: the Story last changed when it was added.
  assert.match(
    page,
    /<dt>Last changed<\/dt>\s*<dd class="last-changed"><a href="https:\/\/github\.com\/acme\/notes\/pull\/1" rel="noreferrer">#1<\/a> · \d{4}-\d{2}-\d{2} · 1 change<\/dd>/
  );
  const data = JSON.parse(/<script type="application\/json" id="screen-data">([\s\S]*?)<\/script>/.exec(page)![1]!) as {
    screens: Array<{ key: string; last_changed?: { label: string; changes: number } }>;
  };
  assert.deepEqual(
    data.screens.map((screen) => [screen.key, screen.last_changed?.label, screen.last_changed?.changes]),
    [["notes-list", "#4", 2]]
  );

  // Outside git there is no history, and the page is still written without it.
  const plain = mkdtempSync(join(tmpdir(), "tieline-history-none-"));
  directories.push(plain);
  const unavailable = readReviewHistory(plain, resolve(plain, MANIFEST));
  assert.equal(unavailable.status, "unavailable");
});

for (const ws of workspaces) ws.cleanup();
for (const directory of directories) rmSync(directory, { recursive: true, force: true });
report();
