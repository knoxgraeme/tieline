import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { Script } from "node:vm";
import { runCli } from "../../../src/cli.js";
import { compileContractManifest } from "../../../src/contract/manifest.js";
import { diffReviewManifests } from "../../../src/contract/review-changes.js";
import { REVIEW_CHANGE_SCRIPT } from "../../../src/contract/review-changes-page.js";
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

await test("reports a Story or acceptance criterion moved to another parent", () => {
  const ws = branchWorkspace(false);
  const base = compile(ws);
  const capability = (manifest: typeof base, key: string) =>
    manifest.capabilities.find((candidate) => candidate.stable_id === key)!;

  // Unchanged criterion, new Story: its content hash is the same.
  const criterionMoved = structuredClone(base);
  const from = capability(criterionMoved, "NOTES").stories[0]!;
  const index = from.acceptance_criteria.findIndex((criterion) => criterion.stable_id === "NOTES-001-AC2");
  capability(criterionMoved, "SHARING").stories[0]!.acceptance_criteria.push(...from.acceptance_criteria.splice(index, 1));
  assert.deepEqual(
    diffReviewManifests(base, criterionMoved, "origin/main").records.map((record) => [
      record.kind,
      record.stable_id,
      record.story_stable_id,
      record.status,
      record.aspects,
    ]),
    [["acceptance_criterion", "NOTES-001-AC2", "SHARING-001", "changed", ["moved"]]]
  );

  // Unchanged Story, new capability: its criteria stay under it, so only it moved.
  const storyMoved = structuredClone(base);
  capability(storyMoved, "NOTES").stories.push(...capability(storyMoved, "SHARING").stories.splice(0, 1));
  assert.deepEqual(
    diffReviewManifests(base, storyMoved, "origin/main").records.map((record) => [record.kind, record.stable_id, record.status, record.aspects]),
    [["story", "SHARING-001", "changed", ["moved"]]]
  );

  assert.deepEqual(diffReviewManifests(base, structuredClone(base), "origin/main").records, []);
});

await test("reports acceptance criteria reordered within their Story, not ones shifted by an insertion", () => {
  const ws = branchWorkspace(false);
  const base = compile(ws);
  const story = (manifest: typeof base) =>
    manifest.capabilities.find((capability) => capability.stable_id === "NOTES")!.stories[0]!;
  const renumber = (manifest: typeof base) =>
    story(manifest).acceptance_criteria.forEach((criterion, position) => {
      criterion.position = position;
    });
  assert.deepEqual(story(base).acceptance_criteria.map((criterion) => criterion.stable_id), ["NOTES-001-AC1", "NOTES-001-AC2"]);

  // Unchanged criteria, swapped: their content hashes are the same.
  const swapped = structuredClone(base);
  story(swapped).acceptance_criteria.reverse();
  renumber(swapped);
  assert.deepEqual(
    diffReviewManifests(base, swapped, "origin/main").records.map((record) => [record.stable_id, record.status, record.aspects]),
    [
      ["NOTES-001-AC1", "changed", ["reordered"]],
      ["NOTES-001-AC2", "changed", ["reordered"]],
    ]
  );

  // A new first criterion shifts every position after it, but reorders nothing.
  const inserted = structuredClone(base);
  story(inserted).acceptance_criteria.unshift({ ...structuredClone(story(base).acceptance_criteria[0]!), stable_id: "NOTES-001-AC0" });
  renumber(inserted);
  assert.deepEqual(
    diffReviewManifests(base, inserted, "origin/main").records.map((record) => [record.stable_id, record.status, record.aspects]),
    [["NOTES-001-AC0", "added", []]]
  );
});

await test("badges changes across both views while keeping the whole contract navigable", () => {
  const ws = branchWorkspace(true);
  const base = compile(ws);
  changeBranch(ws, true);
  const changes = diffReviewManifests(base, compile(ws), "origin/main");
  const page = readFileSync(writeWorkspaceReviewPage(ws.root, REPO_KEY, ".tieline/spec", undefined, { changes }).path, "utf8");
  assert.match(page, /Changes against <code>origin\/main<\/code><\/strong><span>1 Stories, 1 acceptance criteria, and 4 screens changed\.<\/span>/);
  assert.match(page, /<a href="#screen\/notes-share-dialog" data-change-link><code>notes-share-dialog<\/code><\/a>/);
  assert.match(page, /<a href="#NOTES-001" data-change-link><code>NOTES-001-AC2<\/code><\/a>/);
  assert.ok(page.includes(REVIEW_CHANGE_SCRIPT), "summary links are routed");
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
    "data-change-link",
  ]) {
    assert.equal(plain.includes(marker), false, marker);
  }
  assert.equal(plain.includes(REVIEW_CHANGE_SCRIPT), false);
});

await test("routes a summary link through history so every router on the page hears it", () => {
  class FakeElement {
    /** The summary link this element sits in, if any. */
    link: FakeElement | null = null;
    constructor(private readonly href?: string) {}
    closest(selector: string): FakeElement | null {
      assert.equal(selector, "a[data-change-link]");
      return this.link;
    }
    getAttribute(name: string): string | null {
      return name === "href" ? (this.href ?? null) : null;
    }
  }
  class FakePopStateEvent {
    constructor(readonly type: string, readonly init: unknown) {}
  }
  let onClick: ((event: unknown) => void) | undefined;
  const pushed: string[] = [];
  const dispatched: string[] = [];
  new Script(REVIEW_CHANGE_SCRIPT).runInNewContext({
    Element: FakeElement,
    PopStateEvent: FakePopStateEvent,
    document: {
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        assert.equal(type, "click");
        onClick = listener;
      },
    },
    history: { pushState: (_state: unknown, _title: string, url: string) => pushed.push(url) },
    window: { dispatchEvent: (event: FakePopStateEvent) => dispatched.push(event.type) },
  });
  const click = (target: unknown, init: Record<string, unknown> = {}) => {
    const event = { target, button: 0, defaultPrevented: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...init, prevented: false, preventDefault() { this.prevented = true; } };
    onClick!(event);
    return event.prevented;
  };
  const link = new FakeElement("#NOTES-001");
  link.link = link;
  const inside = new FakeElement();
  inside.link = link;

  // A click inside a summary link: one history entry, one popstate.
  assert.equal(click(inside), true);
  assert.deepEqual(pushed, ["#NOTES-001"]);
  assert.deepEqual(dispatched, ["popstate"]);

  // New-tab clicks, other buttons, handled clicks, and other targets are left alone.
  for (const init of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }]) {
    assert.equal(click(inside, init), false, JSON.stringify(init));
  }
  assert.equal(click(new FakeElement()), false);
  assert.equal(click({}), false, "a non-element target");
  assert.deepEqual(pushed, ["#NOTES-001"]);
  assert.deepEqual(dispatched, ["popstate"]);
});

await test("summarizes Story and AC changes for repositories without screens", () => {
  const ws = branchWorkspace(false);
  const base = compile(ws);
  changeBranch(ws, false);
  const changes = diffReviewManifests(base, compile(ws), "origin/main");
  assert.deepEqual(changes.screens, []);
  const page = readFileSync(writeWorkspaceReviewPage(ws.root, REPO_KEY, ".tieline/spec", undefined, { changes }).path, "utf8");
  assert.match(page, /0 Stories, 1 acceptance criteria, and 0 screens changed\./);
  assert.match(page, /data-story-key="NOTES-001"\s+data-lifecycle="production" data-change="changed"/);
  assert.equal(page.includes("screen-data"), false);
  assert.equal(page.includes("view-tabs"), false);
});

await test("reads the base manifest where the base kept it, and only its own files", async () => {
  const ws = branchWorkspace(false);
  const capture = captureIO();
  assert.equal(await runCli(["contract", "compile", ws.root], captureIO().io, {}), 0);
  // A tracked file below the manifest directory is not part of the manifest,
  // just as the working-tree reader ignores it.
  ws.write(".tieline/manifest/archive/old.json", "{}\n");
  ws.commit("compiled base");
  const unchanged = { added: 0, changed: 0, removed: 0 };
  const sameContract = {
    base: "HEAD",
    base_has_manifest: true,
    stories: unchanged,
    acceptance_criteria: unchanged,
    screens: unchanged,
  };
  assert.equal(await runCli(["contract", "review", ws.root, "--base", "HEAD", "--json"], capture.io, {}), 0);
  assert.deepEqual(JSON.parse(capture.output()).changes, sameContract);

  // The branch moves the manifest: the base's is still found where the base
  // configured it, so an unchanged contract is not reported as all new.
  const configPath = resolve(ws.root, ".tieline/config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.files.manifest = "compiled";
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  rmSync(resolve(ws.root, ".tieline/manifest"), { recursive: true, force: true });
  assert.equal(await runCli(["contract", "compile", ws.root], captureIO().io, {}), 0);
  capture.reset();
  assert.equal(await runCli(["contract", "review", ws.root, "--base", "HEAD", "--json"], capture.io, {}), 0);
  assert.deepEqual(JSON.parse(capture.output()).changes, sameContract);
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
  // The page itself says the comparison was not made, not only the terminal.
  const page = readFileSync(resolve(ws.root, ".tieline/review.html"), "utf8");
  assert.match(
    page,
    /<aside class="changes changes-unavailable"[^>]*>\s*<header><strong>Changes against <code>HEAD<\/code> are not shown<\/strong><\/header>\s*<p class="changes-note">the working-tree contract does not compile \(Contract validation failed:/
  );
  assert.match(page, /\.changes-unavailable \{/);

  await assert.rejects(
    () => runCli(["contract", "review", ws.root, "--base", "no-such-ref", "--json"], captureIO().io, {}),
    /no-such-ref/
  );
});

await test("compares from where the branch left the base, not the base's latest commit", async () => {
  const ws = branchWorkspace(true);
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: ws.root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  assert.equal(await runCli(["contract", "compile", ws.root], captureIO().io, {}), 0);
  ws.commit("branch point");
  git("branch", "-M", "main");
  git("checkout", "-q", "-b", "feature");
  changeBranch(ws, true);
  assert.equal(await runCli(["contract", "compile", ws.root], captureIO().io, {}), 0);
  ws.commit("feature work");
  // main moves on afterwards: a new screen the feature branch never saw.
  git("checkout", "-q", "main");
  ws.write(
    ".tieline/screens/SHARING.yaml",
    `${sharingCatalog({ url: "https://cdn.example.test/v1/denied.png", withDialog: false })}  - key: shared-with-me
    title: Shared with me
    route: /shared
    kind: page
    when: A member opens shared notes.
`
  );
  assert.equal(await runCli(["contract", "compile", ws.root], captureIO().io, {}), 0);
  ws.commit("main adds a screen");
  git("checkout", "-q", "feature");

  const capture = captureIO();
  assert.equal(await runCli(["contract", "review", ws.root, "--base", "main", "--json"], capture.io, {}), 0);
  assert.deepEqual(JSON.parse(capture.output()).changes.screens, { added: 1, changed: 2, removed: 1 });
});

await test("reads the default manifest in a repository without workspace configuration", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "tieline-review-configless-"));
  try {
    const write = (path: string, content: string): void => {
      mkdirSync(dirname(resolve(root, path)), { recursive: true });
      writeFileSync(resolve(root, path), content);
    };
    write("src/notes.ts", "export const notes: string[] = [];\n");
    write(".tieline/spec/notes.yaml", notesSpecYaml().replaceAll(REPO_KEY, root.split("/").pop()!));
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
    };
    git("init", "-q");
    git("config", "user.email", "test@example.test");
    git("config", "user.name", "Tieline Test");
    assert.equal(await runCli(["contract", "compile", root], captureIO().io, {}), 0);
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const capture = captureIO();
    assert.equal(await runCli(["contract", "review", root, "--base", "HEAD", "--json"], capture.io, {}), 0);
    const changes = JSON.parse(capture.output()).changes;
    assert.equal(changes.base_has_manifest, true);
    assert.deepEqual(changes.acceptance_criteria, { added: 0, changed: 0, removed: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const created of workspaces) created.cleanup();
report();
