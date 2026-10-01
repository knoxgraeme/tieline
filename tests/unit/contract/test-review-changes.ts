import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { runCli } from "../../../src/cli.js";
import { compileContractManifest } from "../../../src/contract/manifest.js";
import { diffReviewManifests } from "../../../src/contract/review-changes.js";
import { writeWorkspaceReviewPage } from "../../../src/tieline/review.js";
import { report, test } from "../../support/harness.js";
import {
  captureIO,
  createScreensWorkspace,
  notesSpecYaml,
  REPO_KEY,
  type ScreensWorkspace,
} from "../../support/screen-fixtures.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);

function notesCatalog(options: { toastTitle: string; listDigest: string; withEmpty: boolean }): string {
  return `version: 1
capability: NOTES
screens:
  - key: notes-list
    title: Notes list
    route: /notes
    kind: page
    when: A member opens Notes.
    image:
      path: notes/list.png
      sha256: ${options.listDigest}
${
  options.withEmpty
    ? `  - key: notes-list-empty
    title: Notes list, no notes yet
    route: /notes
    kind: state
    when: A member without notes opens Notes.
`
    : ""
}  - key: note-saved-toast
    title: ${options.toastTitle}
    route: /notes/:noteId
    kind: toast
    when: A member saves a note.
`;
}

function sharingCatalog(options: { url: string; withDialog: boolean }): string {
  return `version: 1
capability: SHARING
screens:
  - key: notes-share-denied
    title: Sharing not allowed
    route: /notes/:noteId
    kind: inline-error
    when: A viewer presses Share.
    image:
      url: ${options.url}
      sha256: ${DIGEST_C}
${
  options.withDialog
    ? `  - key: notes-share-dialog
    title: Share note dialog
    route: /notes/:noteId
    kind: dialog
    when: The owner presses Share.
`
    : ""
}`;
}

const workspaces: ScreensWorkspace[] = [];

/** A base state, committed with its manifest, and a branch that changes it. */
function branchWorkspace(screens: boolean): ScreensWorkspace {
  const ws = createScreensWorkspace({
    git: true,
    ...(screens ? { screens: { enabled: true } } : {}),
    notes: screens ? { criterionShows: ["notes-list"] } : {},
    catalog: screens
      ? {
          ".tieline/screens/NOTES.yaml": notesCatalog({ toastTitle: "Note saved", listDigest: DIGEST_A, withEmpty: true }),
          ".tieline/screens/SHARING.yaml": sharingCatalog({ url: "https://cdn.example.test/v1/denied.png", withDialog: false }),
        }
      : {},
  });
  workspaces.push(ws);
  return ws;
}

function changeBranch(ws: ScreensWorkspace, screens: boolean): void {
  ws.write(
    ".tieline/spec/notes.yaml",
    notesSpecYaml(screens ? { storyShows: ["note-saved-toast"], criterionShows: ["notes-list"] } : {}).replace(
      "must invite a member without notes to write one.",
      "must invite a member without notes to write their first one."
    )
  );
  if (!screens) return;
  ws.write(".tieline/screens/NOTES.yaml", notesCatalog({ toastTitle: "Note saved confirmation", listDigest: DIGEST_B, withEmpty: false }));
  // Same picture under a new URL: not a visual change.
  ws.write(".tieline/screens/SHARING.yaml", sharingCatalog({ url: "https://cdn.example.test/v2/denied.png", withDialog: true }));
}

function compile(ws: ScreensWorkspace) {
  return compileContractManifest({ repositoryRoot: ws.root, repositoryKey: REPO_KEY, specDirectory: ".tieline/spec" });
}

console.log("review changes against a base ref");

await test("reports added, changed, and removed records and screens with what changed", () => {
  const ws = branchWorkspace(true);
  const base = compile(ws);
  changeBranch(ws, true);
  const changes = diffReviewManifests(base, compile(ws), "origin/main");
  assert.equal(changes.base_has_manifest, true);
  assert.deepEqual(
    changes.records.map((record) => [record.kind, record.stable_id, record.status, record.aspects]),
    [
      ["story", "NOTES-001", "changed", ["screens"]],
      ["acceptance_criterion", "NOTES-001-AC2", "changed", ["content"]],
    ]
  );
  assert.deepEqual(
    changes.screens.map((screen) => [screen.capability, screen.stable_id, screen.status, screen.aspects]),
    [
      ["NOTES", "note-saved-toast", "changed", ["details"]],
      ["NOTES", "notes-list", "changed", ["image"]],
      ["NOTES", "notes-list-empty", "removed", []],
      ["SHARING", "notes-share-dialog", "added", []],
    ]
  );
  assert.equal(changes.screens.find((screen) => screen.status === "removed")!.title, "Notes list, no notes yet");

  const fresh = diffReviewManifests(null, compile(ws), "origin/main");
  assert.equal(fresh.base_has_manifest, false);
  assert.ok(fresh.records.every((record) => record.status === "added"));
  assert.equal(fresh.screens.length, 4);
  assert.deepEqual(diffReviewManifests(compile(ws), compile(ws), "HEAD"), {
    base: "HEAD",
    base_has_manifest: true,
    records: [],
    screens: [],
  });
});

await test("badges changes across both views while keeping the whole contract navigable", () => {
  const ws = branchWorkspace(true);
  const base = compile(ws);
  changeBranch(ws, true);
  const changes = diffReviewManifests(base, compile(ws), "origin/main");
  const page = readFileSync(writeWorkspaceReviewPage(ws.root, REPO_KEY, ".tieline/spec", undefined, changes).path, "utf8");
  assert.match(page, /Changes against <code>origin\/main<\/code><\/strong><span>1 Stories, 1 acceptance criteria, and 4 screens changed\.<\/span>/);
  assert.match(page, /<a href="#screen\/notes-share-dialog"><code>notes-share-dialog<\/code><\/a>/);
  assert.match(page, /<li class="changed-removed"> <span class="change-badge change-removed"[^>]*>Removed<\/span> <code>notes-list-empty<\/code>/);
  assert.match(page, /data-story-key="NOTES-001"\s+data-lifecycle="production" data-change="changed"/);
  assert.match(page, /data-story-key="SHARING-001"\s+data-lifecycle="in_progress"\s*>/, "unchanged Stories carry no badge");
  assert.match(page, /<code>NOTES-001-AC2<\/code> <span class="change-badge change-changed"/);
  assert.match(page, /<select id="screen-change-filter">/);
  const data = JSON.parse(/<script type="application\/json" id="screen-data">([\s\S]*?)<\/script>/.exec(page)![1]!);
  const byKey = new Map<string, { change?: unknown }>(data.screens.map((screen: { key: string }) => [screen.key, screen]));
  assert.deepEqual(byKey.get("notes-list")!.change, { status: "changed", aspects: ["image"] });
  assert.deepEqual(byKey.get("notes-share-dialog")!.change, { status: "added", aspects: [] });
  assert.equal("change" in byKey.get("notes-share-denied")!, false);
  for (const script of [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!)) {
    assert.doesNotThrow(() => new Script(script));
  }

  // Without a base the same contract renders no change layer at all.
  const plain = readFileSync(writeWorkspaceReviewPage(ws.root, REPO_KEY, ".tieline/spec").path, "utf8");
  // The shared screens script names the change classes, so look for rendered
  // markup, styles, and data rather than bare strings.
  for (const marker of [
    '<aside class="changes"',
    'data-change="',
    '<select id="screen-change-filter">',
    ".change-badge {",
    '"change":',
  ]) {
    assert.equal(plain.includes(marker), false, marker);
  }
});

await test("summarizes Story and AC changes for repositories without screens", () => {
  const ws = branchWorkspace(false);
  const base = compile(ws);
  changeBranch(ws, false);
  const changes = diffReviewManifests(base, compile(ws), "origin/main");
  assert.deepEqual(changes.screens, []);
  const page = readFileSync(writeWorkspaceReviewPage(ws.root, REPO_KEY, ".tieline/spec", undefined, changes).path, "utf8");
  assert.match(page, /0 Stories, 1 acceptance criteria, and 0 screens changed\./);
  assert.match(page, /data-story-key="NOTES-001"\s+data-lifecycle="production" data-change="changed"/);
  assert.equal(page.includes("screen-data"), false);
  assert.equal(page.includes("view-tabs"), false);
});

await test("compares against a git ref from the CLI and explains when it cannot", async () => {
  const ws = branchWorkspace(true);
  const capture = captureIO();
  // Committed before any manifest exists: everything on the branch is new.
  ws.commit("spec without manifest");
  assert.equal(await runCli(["contract", "review", ws.root, "--base", "HEAD", "--json"], capture.io, {}), 0);
  const fresh = JSON.parse(capture.output());
  assert.equal(fresh.changes.base_has_manifest, false);
  assert.deepEqual(fresh.changes.screens, { added: 4, changed: 0, removed: 0 });

  assert.equal(await runCli(["contract", "compile", ws.root], captureIO().io, {}), 0);
  ws.commit("compiled base");
  changeBranch(ws, true);
  capture.reset();
  assert.equal(await runCli(["contract", "review", ws.root, "--base", "HEAD", "--json"], capture.io, {}), 0);
  assert.deepEqual(JSON.parse(capture.output()).changes, {
    base: "HEAD",
    base_has_manifest: true,
    stories: { added: 0, changed: 1, removed: 0 },
    acceptance_criteria: { added: 0, changed: 1, removed: 0 },
    screens: { added: 1, changed: 2, removed: 1 },
  });
  capture.reset();
  assert.equal(await runCli(["contract", "review", ws.root, "--base", "HEAD"], capture.io, {}), 0);
  assert.match(capture.output(), /Changes against HEAD: 1 Stories, 1 acceptance criteria, 4 screens\./);

  capture.reset();
  assert.equal(await runCli(["contract", "review", ws.root, "--json"], capture.io, {}), 0);
  assert.equal("changes" in JSON.parse(capture.output()), false);

  ws.write(".tieline/spec/notes.yaml", notesSpecYaml({ storyShows: ["no-such-screen"] }));
  capture.reset();
  assert.equal(await runCli(["contract", "review", ws.root, "--base", "HEAD", "--json"], capture.io, {}), 0);
  const unavailable = JSON.parse(capture.output()).changes;
  assert.equal(unavailable.base, "HEAD");
  assert.match(unavailable.unavailable, /^the working-tree contract does not compile \(Contract validation failed:/);

  await assert.rejects(
    () => runCli(["contract", "review", ws.root, "--base", "no-such-ref", "--json"], captureIO().io, {}),
    /no-such-ref/
  );
});

for (const created of workspaces) created.cleanup();
report();
