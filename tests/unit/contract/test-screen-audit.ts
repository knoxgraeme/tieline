import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { stringify } from "yaml";
import { runCli } from "../../../src/cli.js";
import { runCheckCommand } from "../../../src/commands/check.js";
import {
  auditScreenCaptures,
  screenAuditStrictFailures,
  screenAuditWarnings,
  summarizeScreenAudit,
} from "../../../src/contract/screen-audit.js";
import { compileContractManifest } from "../../../src/contract/manifest.js";
import { loadScreenCatalog, screenSettingsForRepository } from "../../../src/contract/screen-catalog.js";
import {
  acceptanceCriterionTagsIn,
  interceptsRequests,
  isSceneTestCandidate,
  scanPageFiles,
  scanScreenScenes,
  screenTagsIn,
  SCREEN_SCENE_LIMITS,
} from "../../../src/contract/screen-scenes.js";
import {
  readScreenTextDirectory,
  screenTextDigest,
  screenTextFile,
  SCREEN_TEXT_LIMITS,
} from "../../../src/contract/screen-text.js";
import { screenPathPattern, wildcardPattern } from "../../../src/contract/paths.js";
import { report, test } from "../../support/harness.js";
import {
  captureIO,
  createScreensWorkspace,
  notesSpecYaml,
  REPO_KEY,
  type ScreensWorkspace,
} from "../../support/screen-fixtures.js";

const ENABLED = { enabled: true };
const DIGEST_A = "a".repeat(64);
const FINGERPRINT_1 = "1".repeat(64);
const FINGERPRINT_2 = "2".repeat(64);

const workspaces: ScreensWorkspace[] = [];
function workspace(options: Parameters<typeof createScreensWorkspace>[0]): ScreensWorkspace {
  const created = createScreensWorkspace(options);
  workspaces.push(created);
  return created;
}

const LIST_TEXT = '- heading "Your notes" [level=1]\n- list\n';
const EMPTY_TEXT = '- heading "Your notes" [level=1]\n- text: Write your first note\n';

interface ScreenSpec {
  key: string;
  image?: Record<string, string>;
  capture?: { fingerprint: string; text_sha256: string; test: string };
}

function captured(key: string, text: string, fingerprint = FINGERPRINT_1): ScreenSpec {
  return {
    key,
    image: { path: `${key}.png`, sha256: DIGEST_A },
    capture: { fingerprint, text_sha256: screenTextDigest(text), test: "e2e/notes.screens.ts" },
  };
}

function catalogYaml(capability: string, screens: ScreenSpec[]): string {
  return stringify({
    version: 1,
    capability,
    screens: screens.map(({ key, image, capture }) => ({
      key,
      title: `Screen ${key}`,
      route: "/notes",
      kind: "page",
      when: "A member opens Notes.",
      ...(image ? { image } : {}),
      ...(capture ? { capture } : {}),
    })),
  });
}

/** Acme Notes with two captured screens, one never captured, and their scenes. */
function capturedWorkspace(): ScreensWorkspace {
  const ws = workspace({
    git: true,
    screens: ENABLED,
    catalog: {
      ".tieline/screens/NOTES.yaml": catalogYaml("NOTES", [
        captured("notes-list", LIST_TEXT),
        captured("notes-list-empty", EMPTY_TEXT),
        { key: "note-saved-toast" },
      ]),
    },
  });
  ws.write(".tieline/screen-text/notes-list.yml", LIST_TEXT);
  ws.write(".tieline/screen-text/notes-list-empty.yml", EMPTY_TEXT);
  ws.write(
    "e2e/notes.screens.ts",
    [
      'test("notes list", { tag: "@screen:notes-list" }, async () => {});',
      'test("empty list", { tag: ["@screen:notes-list-empty"] }, async () => {});',
      "",
    ].join("\n")
  );
  return ws;
}

function auditOf(ws: ScreensWorkspace) {
  const settings = screenSettingsForRepository(ws.root)!;
  const { catalog, issues } = loadScreenCatalog(ws.root, settings);
  assert.deepEqual(issues, []);
  return auditScreenCaptures({
    settings,
    catalog,
    text: readScreenTextDirectory(settings),
    scenes: scanScreenScenes(ws.root, settings.sceneTests),
    pages: scanPageFiles(ws.root, settings.capture.pages),
    contract: { manifest: compileContractManifest({ repositoryRoot: ws.root, repositoryKey: REPO_KEY, specDirectory: ".tieline/spec" }) },
  });
}

console.log("screens audit: scene tags");

await test("reads literal @screen tags and stops a key at a sentence's final period", () => {
  assert.deepEqual(
    screenTagsIn(
      [
        'test("a", { tag: "@screen:notes-list" }, () => {});',
        'test("b", { tag: ["@fast", "@screen:notes.list.v2", "@screen:notes-list"] }, () => {});',
        "// Captures @screen:note-saved-toast.",
        "// Not a tag: screen:other or @screen: spaced",
      ].join("\n")
    ),
    ["notes-list", "notes.list.v2", "note-saved-toast"]
  );
  assert.deepEqual(screenTagsIn("no tags here"), []);
});

await test("reads Playwright-named test files by default and configured patterns otherwise", () => {
  for (const path of ["e2e/notes.spec.ts", "tests/a.test.tsx", "e2e/screens/sharing.screens.ts", "x.spec.mjs", "y.test.cjs"]) {
    assert.equal(isSceneTestCandidate(path, null), true, path);
  }
  for (const path of ["src/notes.ts", "e2e/helpers.ts", "docs/notes.spec.md", "e2e/notes.spec.ts.snap"]) {
    assert.equal(isSceneTestCandidate(path, null), false, path);
  }
  const configured = ["e2e/**", "ui/*.ts", "specs/**/*.screens.ts"].map(screenPathPattern);
  assert.equal(isSceneTestCandidate("e2e/flows/login.ts", configured), true);
  assert.equal(isSceneTestCandidate("specs/top.screens.ts", configured), true, "a ** directory may be none");
  assert.equal(isSceneTestCandidate("ui/notes.ts", configured), true);
  assert.equal(isSceneTestCandidate("e2e/fixtures/data.json", configured), false);
  assert.equal(isSceneTestCandidate("tests/notes.spec.ts", configured), false);
});

await test("reads a ** directory in a screens pattern as none or more, as globs do", () => {
  const pages = screenPathPattern("app/**/page.tsx");
  for (const path of ["app/page.tsx", "app/notes/page.tsx", "app/a/b/page.tsx"]) assert.equal(pages.test(path), true, path);
  for (const path of ["apps/page.tsx", "app/page.tsx.bak", "app/notes/page.ts"]) assert.equal(pages.test(path), false, path);
  assert.equal(screenPathPattern("**/notes.screens.ts").test("notes.screens.ts"), true);
  assert.equal(screenPathPattern("a/**/b/**/c.ts").test("a/b/c.ts"), true);
  // The older pattern settings are unchanged.
  assert.equal(wildcardPattern("app/**/page.tsx").test("app/page.tsx"), false);

  // A scene and a page at the top of their folders are both found.
  const ws = workspace({ git: true, screens: ENABLED });
  ws.write("e2e/top.screens.ts", 'test("a", { tag: "@screen:notes-list" }, () => {});\n');
  ws.write("e2e/flows/nested.screens.ts", 'test("b", { tag: "@screen:notes-list-empty" }, () => {});\n');
  ws.write("app/page.tsx", "export default function Home() { return null; }\n");
  ws.write("app/notes/page.tsx", "export default function Notes() { return null; }\n");
  const scan = scanScreenScenes(ws.root, ["e2e/**/*.screens.ts"]);
  assert.deepEqual(Object.fromEntries([...scan.tags].map(([key, files]) => [key, [...files]])), {
    "notes-list": ["e2e/top.screens.ts"],
    "notes-list-empty": ["e2e/flows/nested.screens.ts"],
  });
  assert.deepEqual(scanPageFiles(ws.root, ["app/**/page.tsx"]).files, ["app/notes/page.tsx", "app/page.tsx"]);
});

await test("scans tracked and untracked test files, never ignored or linked ones", () => {
  const ws = workspace({ git: true, screens: ENABLED });
  ws.write("e2e/committed.spec.ts", 'test("a", { tag: "@screen:notes-list" }, () => {});\n');
  ws.write(".gitignore", "generated/\n");
  ws.commit("baseline");
  ws.write("e2e/new.screens.ts", 'test("b", { tag: "@screen:notes-list" }, () => {});\n');
  ws.write("generated/ignored.spec.ts", 'test("c", { tag: "@screen:ignored" }, () => {});\n');
  ws.write("outside.txt", 'test("d", { tag: "@screen:linked" }, () => {});\n');
  symlinkSync(resolve(ws.root, "outside.txt"), resolve(ws.root, "e2e/linked.spec.ts"));
  const scan = scanScreenScenes(ws.root, null);
  assert.equal(scan.status, "complete");
  assert.equal(scan.detail, null);
  assert.equal(scan.files, 2);
  assert.deepEqual(Object.fromEntries(scan.tags), {
    "notes-list": ["e2e/committed.spec.ts", "e2e/new.screens.ts"],
  });
});

await test("reports an incomplete scan at its bounds and an unavailable one without git", () => {
  const ws = workspace({ git: true, screens: ENABLED });
  ws.write("e2e/a.spec.ts", '"@screen:a"\n');
  ws.write("e2e/b.spec.ts", '"@screen:b"\n');
  ws.write("e2e/big.spec.ts", `"@screen:big"\n${"x".repeat(64)}\n`);
  const limits = { ...SCREEN_SCENE_LIMITS, fileBytes: 32 };
  const oversize = scanScreenScenes(ws.root, null, limits);
  assert.equal(oversize.status, "incomplete");
  assert.match(oversize.detail!, /1 test file\(s\) larger than 32 bytes or unreadable were not read \(e2e\/big\.spec\.ts\)/);
  assert.deepEqual([...oversize.tags.keys()].sort(), ["a", "b"]);

  const counted = scanScreenScenes(ws.root, null, { ...limits, files: 1 });
  assert.equal(counted.status, "incomplete");
  assert.match(counted.detail!, /the scan stopped at more than 1 candidate test files/);
  assert.equal(counted.files, 1);

  const total = scanScreenScenes(ws.root, null, { ...limits, totalBytes: 16 });
  assert.equal(total.status, "incomplete");
  assert.match(total.detail!, /the scan stopped at more than 16 bytes of candidate test files/);

  const listing = scanScreenScenes(ws.root, null, { ...limits, listedBytes: 8 });
  assert.equal(listing.status, "unavailable");

  const plain = workspace({ screens: ENABLED });
  const unavailable = scanScreenScenes(plain.root, null);
  assert.equal(unavailable.status, "unavailable");
  assert.match(unavailable.detail!, /could not be listed with git/);
  assert.equal(unavailable.tags.size, 0);
});

console.log("screens audit: committed ARIA snapshots");

await test("digests snapshots with normalized line endings and reports what it cannot read", () => {
  const ws = workspace({ screens: ENABLED });
  const settings = screenSettingsForRepository(ws.root)!;
  assert.deepEqual(readScreenTextDirectory(settings), { digests: new Map(), issues: [], complete: true });
  assert.deepEqual(screenTextFile(settings, "notes-list"), {
    absolutePath: resolve(ws.root, ".tieline/screen-text/notes-list.yml"),
    path: ".tieline/screen-text/notes-list.yml",
  });
  assert.equal(screenTextDigest("- a\r\n- b\r\n"), screenTextDigest("- a\n- b\n"));
  assert.notEqual(screenTextDigest("- a\n"), screenTextDigest("- b\n"));

  ws.write(".tieline/screen-text/notes-list.yml", LIST_TEXT.replaceAll("\n", "\r\n"));
  ws.write(".tieline/screen-text/README.md", "Generated by tieline screens capture.\n");
  ws.write(".tieline/screen-text/-bad-name.yml", "- x\n");
  ws.write(".tieline/screen-text/huge.yml", "x".repeat(64));
  writeFileSync(resolve(ws.root, ".tieline/screen-text/binary.yml"), Buffer.from([0xff, 0xfe, 0x00]));
  ws.write("elsewhere.yml", "- linked\n");
  symlinkSync(resolve(ws.root, "elsewhere.yml"), resolve(ws.root, ".tieline/screen-text/linked.yml"));
  const read = readScreenTextDirectory(settings, { ...SCREEN_TEXT_LIMITS, fileBytes: 48 });
  assert.deepEqual(Object.fromEntries(read.digests), { "notes-list": screenTextDigest(LIST_TEXT) });
  assert.deepEqual(read.issues, [
    ".tieline/screen-text/-bad-name.yml: the file name is not a screen key",
    ".tieline/screen-text/binary.yml: not valid UTF-8",
    `.tieline/screen-text/huge.yml: ARIA snapshot '${resolve(ws.root, ".tieline/screen-text/huge.yml")}' is larger than the 48-byte limit.`,
    ".tieline/screen-text/linked.yml: not a regular file",
  ]);
  assert.equal(read.complete, true);

  const capped = readScreenTextDirectory(settings, { fileBytes: 1024, files: 2, entries: 100 });
  assert.equal(capped.complete, false);
  assert.match(capped.issues[0]!, /holds more than 2 ARIA snapshot files; only the first 2 snapshot files were read/);
  const crowded = readScreenTextDirectory(settings, { fileBytes: 1024, files: 100, entries: 3 });
  assert.equal(crowded.complete, false);
  assert.match(crowded.issues[0]!, /holds more than 3 entries; only the first \d snapshot files were read/);
  assert.equal(SCREEN_TEXT_LIMITS.fileBytes, 1024 * 1024);
});

console.log("screens audit: findings");

await test("names each screen's missing outputs, mismatched and orphaned snapshots, and unknown tags", () => {
  const ws = capturedWorkspace();
  ws.write(".tieline/screen-text/notes-list-empty.yml", `${EMPTY_TEXT}- button "Edited by hand"\n`);
  ws.write(".tieline/screen-text/retired-screen.yml", "- text: gone\n");
  ws.write("e2e/old.spec.ts", 'test("x", { tag: "@screen:retired-screen" }, () => {});\n');
  const audit = auditOf(ws);
  assert.deepEqual(audit.incomplete, [
    { key: "note-saved-toast", capability: "NOTES", missing: ["screenshot", "capture", "text", "scene"] },
  ]);
  assert.deepEqual(audit.text_mismatch, ["notes-list-empty"]);
  assert.deepEqual(audit.orphaned_text, [".tieline/screen-text/retired-screen.yml"]);
  assert.deepEqual(audit.unknown_scene_tags, [{ key: "retired-screen", files: ["e2e/old.spec.ts"] }]);
  assert.deepEqual(audit.environments, [{ fingerprint: FINGERPRINT_1, screens: 2 }]);
  assert.deepEqual(audit.scene_scan, { status: "complete", files: 2, detail: null });
  assert.deepEqual(summarizeScreenAudit(audit), {
    screens: 3,
    incomplete: 1,
    missing_screenshot: 1,
    missing_capture: 1,
    missing_text: 1,
    missing_scene: 1,
    not_captured: 0,
    text_mismatch: 1,
    orphaned_text: 1,
    environments: 1,
    scene_scan: "complete",
    text_issues: 0,
    unclaimed_pages: null,
    untested_acceptance_criteria: 0,
    unlinked_acceptance_criteria: 0,
    unlinked_screens: 3,
    unknown_acceptance_criterion_tags: 0,
    intercepting_scene_files: 0,
  });
});

await test("reports a fully captured catalog as complete and mixed environments as a finding", () => {
  const ws = workspace({
    git: true,
    screens: ENABLED,
    catalog: {
      ".tieline/screens/NOTES.yaml": catalogYaml("NOTES", [
        captured("notes-list", LIST_TEXT, FINGERPRINT_2),
        captured("notes-list-empty", EMPTY_TEXT, FINGERPRINT_1),
        captured("note-saved-toast", LIST_TEXT, FINGERPRINT_1),
      ]),
    },
  });
  ws.write(".tieline/screen-text/notes-list.yml", LIST_TEXT);
  ws.write(".tieline/screen-text/notes-list-empty.yml", EMPTY_TEXT);
  ws.write(".tieline/screen-text/note-saved-toast.yml", LIST_TEXT);
  ws.write("e2e/notes.screens.ts", '"@screen:notes-list" "@screen:notes-list-empty" "@screen:note-saved-toast"\n');
  const audit = auditOf(ws);
  assert.deepEqual(audit.incomplete, []);
  assert.deepEqual(audit.environments, [
    { fingerprint: FINGERPRINT_1, screens: 2 },
    { fingerprint: FINGERPRINT_2, screens: 1 },
  ]);
  assert.deepEqual(screenAuditWarnings(audit), [
    "Screens were captured in 2 different environments, and digests from different environments are never compared; re-capture them in the pinned environment.",
  ]);
});

await test("does not count missing scenes when the scan could not finish", () => {
  const ws = capturedWorkspace();
  ws.write("e2e/huge.spec.ts", "x".repeat(SCREEN_SCENE_LIMITS.fileBytes + 1));
  const audit = auditOf(ws);
  assert.equal(audit.scene_scan.status, "incomplete");
  assert.deepEqual(audit.incomplete, [
    { key: "note-saved-toast", capability: "NOTES", missing: ["screenshot", "capture", "text"] },
  ]);
  const summary = summarizeScreenAudit(audit);
  assert.equal(summary.missing_scene, null);
  assert.deepEqual(screenAuditWarnings(audit), [
    "1 screen(s) are missing capture outputs (1 without a screenshot digest, 1 without a capture record, 1 without an ARIA snapshot); run `tieline screens audit` for the list.",
    `The test scan did not complete (${audit.scene_scan.detail}), so screens and acceptance criteria without a test are not counted.`,
  ]);
});

console.log("screens audit: coverage of pages and acceptance criteria");

/** Acme Notes where NOTES-001-AC1 is proven by a tagged test and AC2 is not. */
function alignedWorkspace(): ScreensWorkspace {
  const ws = workspace({
    git: true,
    screens: { enabled: true, capture: { pages: ["app/**/page.tsx", "!app/api/**"] } },
    catalog: {
      ".tieline/screens/NOTES.yaml": stringify({
        version: 1,
        capability: "NOTES",
        screens: [
          { key: "notes-list", title: "Notes list", route: "/notes", kind: "page", when: "A member opens Notes.", paths: ["app/notes/page.tsx"] },
          { key: "notes-list-empty", title: "No notes yet", route: "/notes", kind: "state", when: "A member has no notes.", paths: ["app/notes/page.tsx"] },
          {
            key: "payment-failed",
            title: "Payment failed",
            route: "/billing",
            kind: "toast",
            when: "A card is declined.",
            not_captured: { reason: "needs-real-trigger", detail: "The payment sandbox cannot decline a card yet." },
          },
        ],
      }),
    },
  });
  ws.write("app/notes/page.tsx", "export default function Notes() { return null; }\n");
  ws.write("app/settings/page.tsx", "export default function Settings() { return null; }\n");
  ws.write("app/api/notes/page.tsx", "export const route = true;\n");
  ws.write(
    "e2e/notes.screens.ts",
    [
      'test("list", { tag: ["@ac:NOTES-001-AC1", "@screen:notes-list"] }, async () => {});',
      'test("stray", { tag: "@ac:NOTES-404-AC9" }, async () => {});',
      "",
    ].join("\n")
  );
  ws.write("e2e/other.spec.ts", 'test("also", { tag: "@ac:NOTES-001-AC1" }, async () => {});\n');
  ws.write(
    ".tieline/spec/notes.yaml",
    `version: 1
capability:
  key: NOTES
  name: Notes
  description: Members write and organize notes.
  stories:
    - key: NOTES-001
      title: Browse my notes
      actor: member
      goal: see all of my notes in one list
      benefit: I can find what I wrote quickly
      lifecycle: production
      links:
        - relation: implements
          provenance: authored
          target: { kind: code, repository: ${REPO_KEY}, path: src/notes.ts }
      acceptance_criteria:
        - key: NOTES-001-AC1
          criterion: The notes list must show the member's notes, newest first.
          links:
            - relation: tests
              provenance: authored
              target: { kind: test, repository: ${REPO_KEY}, path: e2e/notes.screens.ts, framework_hint: playwright }
            - relation: shows
              provenance: authored
              target: { kind: screen, key: notes-list }
        - key: NOTES-001-AC2
          criterion: The notes list must invite a member without notes to write one.
          links:
            - relation: shows
              provenance: authored
              target: { kind: screen, key: notes-list-empty }
`
  );
  return ws;
}

await test("accounts for screens marked not captured, and finds page files no screen claims", () => {
  const ws = alignedWorkspace();
  const audit = auditOf(ws);
  assert.deepEqual(audit.not_captured, [
    { key: "payment-failed", capability: "NOTES", reason: "needs-real-trigger", detail: "The payment sandbox cannot decline a card yet." },
  ]);
  assert.deepEqual(audit.incomplete.map((gap) => gap.key), ["notes-list", "notes-list-empty"]);
  // app/api is excluded with `!`; app/notes is claimed by the screens' paths.
  assert.deepEqual(audit.pages, { status: "complete", detail: null, checked: 2, unclaimed: ["app/settings/page.tsx"] });
  const summary = summarizeScreenAudit(audit);
  assert.equal(summary.not_captured, 1);
  assert.equal(summary.unclaimed_pages, 1);
});

await test("checks that acceptance criteria showing screens are proven by tagged, linked tests", () => {
  const ws = alignedWorkspace();
  const audit = auditOf(ws);
  assert.deepEqual(audit.acceptance_criteria, {
    status: "evaluated",
    detail: null,
    untested: [{ key: "NOTES-001-AC2", story: "NOTES-001", shows: ["notes-list-empty"] }],
    unlinked: [{ key: "NOTES-001-AC1", files: ["e2e/other.spec.ts"] }],
    unknown_tags: [{ key: "NOTES-404-AC9", files: ["e2e/notes.screens.ts"] }],
  });
  const settings = screenSettingsForRepository(ws.root)!;
  const unavailable = auditScreenCaptures({
    settings,
    catalog: loadScreenCatalog(ws.root, settings).catalog,
    text: readScreenTextDirectory(settings),
    scenes: scanScreenScenes(ws.root, settings.sceneTests),
    pages: scanPageFiles(ws.root, settings.capture.pages),
    contract: { manifest: null, detail: "the working-tree contract does not compile: broken" },
  });
  assert.deepEqual(unavailable.acceptance_criteria, {
    status: "unavailable",
    detail: "the working-tree contract does not compile: broken",
    untested: [],
    unlinked: [],
    unknown_tags: [],
  });
});

await test("flags scene tests that intercept requests, for review", () => {
  assert.equal(interceptsRequests("await page.route('**/api/share', (route) => route.fulfill({ status: 500 }));"), true);
  assert.equal(interceptsRequests("await context.routeFromHAR('fixtures/notes.har');"), true);
  assert.equal(interceptsRequests("await page.goto('/notes'); // no routing here"), false);
  assert.deepEqual(acceptanceCriterionTagsIn('{ tag: ["@ac:NOTES-001-AC1", "@ac:NOTES-001-AC2."] }'), ["NOTES-001-AC1", "NOTES-001-AC2"]);
  const ws = alignedWorkspace();
  ws.write("e2e/blocked.spec.ts", 'test("x", { tag: "@screen:notes-list" }, async ({ page }) => { await page.route("**/analytics/**", (r) => r.abort()); });\n');
  ws.write("e2e/unrelated.spec.ts", 'test("y", async ({ page }) => { await page.route("**", (r) => r.continue()); });\n');
  assert.deepEqual(auditOf(ws).intercepting, [{ file: "e2e/blocked.spec.ts", keys: ["notes-list"] }]);
});

await test("names each unlinked screen with the criteria that implement its files, as a hint only", async () => {
  const screen = (key: string, paths?: string[]) => ({
    key,
    title: key,
    route: `/${key}`,
    kind: "state",
    when: "A member gets here.",
    ...(paths ? { paths } : {}),
  });
  const ws = workspace({
    git: true,
    screens: ENABLED,
    catalog: {
      ".tieline/screens/NOTES.yaml": stringify({
        version: 1,
        capability: "NOTES",
        screens: [
          screen("notes-list", ["app/notes/**"]),
          screen("notes-empty", ["app/notes/**"]),
          screen("search-empty", ["app/search/**"]),
          screen("about"),
        ],
      }),
    },
  });
  // AC1 shows the list; AC2 implements the notes page but shows nothing.
  ws.write(
    ".tieline/spec/notes.yaml",
    notesSpecYaml({ criterionShows: ["notes-list"] }).replace(
      "          criterion: The notes list must invite a member without notes to write one.\n",
      [
        "          criterion: The notes list must invite a member without notes to write one.",
        "          links:",
        "            - relation: implements",
        "              provenance: authored",
        `              target: { kind: code, repository: ${REPO_KEY}, path: app/notes/page.tsx }`,
        "",
      ].join("\n")
    )
  );
  ws.write("app/notes/page.tsx", "export default function Notes() { return null; }\n");
  const audit = auditOf(ws);
  assert.deepEqual(audit.unlinked_screens, [
    { key: "about", capability: "NOTES", candidates: [] },
    { key: "notes-empty", capability: "NOTES", candidates: ["NOTES-001-AC2"] },
    { key: "search-empty", capability: "NOTES", candidates: [] },
  ]);
  assert.equal(summarizeScreenAudit(audit).unlinked_screens, 3);
  // A hint only: an unlinked screen never fails a strict audit.
  assert.equal(screenAuditStrictFailures(audit).some((failure) => /unlinked screen|no links|not shown/.test(failure)), false);
  const capture = captureIO();
  assert.equal(await runCli(["screens", "audit", "--repository", ws.root], capture.io, {}), 0);
  assert.match(capture.output(), /  no links  notes-empty \(NOTES\): NOTES-001-AC2 implements its files; link it if one of them states it\n/);
  assert.match(capture.output(), /  no links  search-empty \(NOTES\): no acceptance criterion implements its files\n/);
  assert.doesNotMatch(capture.output(), /no links  notes-list /, "a shown screen is not listed");

  // Without a compiling contract, which screens are shown is unknown.
  const settings = screenSettingsForRepository(ws.root)!;
  const unknown = auditScreenCaptures({
    settings,
    catalog: loadScreenCatalog(ws.root, settings).catalog,
    text: readScreenTextDirectory(settings),
    scenes: scanScreenScenes(ws.root, settings.sceneTests),
    pages: scanPageFiles(ws.root, settings.capture.pages),
    contract: { manifest: null, detail: "the working-tree contract does not compile" },
  });
  assert.deepEqual(unknown.unlinked_screens, []);
  assert.equal(summarizeScreenAudit(unknown).unlinked_screens, null);
});

await test("fails a strict audit until every screen, page, and UI criterion is accounted for", async () => {
  const ws = alignedWorkspace();
  const capture = captureIO();
  assert.equal(await runCli(["screens", "audit", "--strict", "--repository", ws.root], capture.io, {}), 1);
  const text = capture.output();
  assert.match(text, /  not captured payment-failed \(NOTES\): needs-real-trigger: The payment sandbox cannot decline a card yet\.\n/);
  assert.match(text, /  page      app\/settings\/page\.tsx: no screen's paths claim this page file\n/);
  assert.match(text, /  untested  NOTES-001-AC2 shows notes-list-empty, but no test is tagged @ac:NOTES-001-AC2\n/);
  assert.match(text, /  unlinked  NOTES-001-AC1 is tagged in e2e\/other\.spec\.ts, which its tests links do not name\n/);
  assert.match(text, /  unknown   @ac:NOTES-404-AC9 in e2e\/notes\.screens\.ts: no acceptance criterion has this key\n/);
  assert.match(text, /Strict audit failed: 2 screen\(s\) are missing capture outputs or a test; 1 page file\(s\) are claimed by no screen; 1 acceptance criteria show screens but no test tags them; 1 acceptance criteria are tagged in tests their links do not name; 1 @ac: tag\(s\) name no acceptance criterion\.\n$/);
  // Without --strict the same findings are a report.
  capture.reset();
  assert.equal(await runCli(["screens", "audit", "--repository", ws.root], capture.io, {}), 0);
  capture.reset();
  assert.equal(await runCli(["screens", "audit", "--strict", "--json", "--repository", ws.root], capture.io, {}), 1);
  const json = JSON.parse(capture.output()) as { strict: { passed: boolean; failures: string[] } };
  assert.equal(json.strict.passed, false);
  assert.equal(json.strict.failures.length, 5);
  await assert.rejects(
    () => runCli(["screens", "audit", "--strict", "--capture", "--repository", ws.root], captureIO().io, {}),
    /--strict checks coverage without capturing; run it separately from --capture\./
  );
});

await test("passes a strict audit once everything is accounted for", async () => {
  const ws = workspace({
    git: true,
    screens: { enabled: true, capture: { pages: ["app/**/page.tsx"] } },
    catalog: {
      ".tieline/screens/NOTES.yaml": catalogYaml("NOTES", [captured("notes-list", LIST_TEXT)]).replace(
        "    kind: page\n",
        "    kind: page\n    paths:\n      - app/notes/page.tsx\n"
      ),
    },
  });
  ws.write("app/notes/page.tsx", "export default function Notes() { return null; }\n");
  ws.write(".tieline/screen-text/notes-list.yml", LIST_TEXT);
  ws.write("e2e/notes.screens.ts", 'test("list", { tag: "@screen:notes-list" }, async () => {});\n');
  const capture = captureIO();
  assert.equal(await runCli(["screens", "audit", "--strict", "--repository", ws.root], capture.io, {}), 0);
  assert.match(capture.output(), /Strict audit passed: every screen, page, and documented UI behavior is accounted for\.\n$/);
  assert.deepEqual(screenAuditStrictFailures(auditOf(ws)), []);
});

await test("names new page files without a screen, and unproven criteria, in check warnings", async () => {
  const ws = alignedWorkspace();
  const capture = captureIO();
  assert.equal(await runCli(["contract", "compile", ws.root], capture.io, {}), 0);
  ws.commit("baseline");
  ws.write("app/billing/page.tsx", "export default function Billing() { return null; }\n");
  capture.reset();
  assert.equal(await runCheckCommand({ base: "HEAD", repository: ws.root, json: true }, capture.io), 0);
  const result = JSON.parse(capture.output()) as { warnings: string[]; screens: { captures: Record<string, unknown> } };
  assert.ok(result.warnings.includes("1 page file(s) added on this branch are claimed by no screen (app/billing/page.tsx); add a screen whose paths name them."));
  assert.ok(result.warnings.includes("1 other page file(s) are claimed by no screen; run `tieline screens audit` for the list."));
  assert.ok(result.warnings.includes("1 acceptance criteria show screens but no test tagged @ac:<key> proves them (NOTES-001-AC2)."));
  assert.ok(result.warnings.includes("1 acceptance criteria are tagged in test files their tests links do not name (NOTES-001-AC1)."));
  assert.ok(result.warnings.includes("1 @ac: tag(s) name no acceptance criterion (NOTES-404-AC9)."));
  assert.equal(result.screens.captures.not_captured, 1);
  assert.equal(result.screens.captures.unclaimed_pages, 2);
});

console.log("screens audit: command");

await test("lists findings as text and JSON without changing anything", async () => {
  const ws = capturedWorkspace();
  ws.write(".tieline/screen-text/retired-screen.yml", "- text: gone\n");
  const capture = captureIO();
  assert.equal(await runCli(["screens", "audit", "--repository", ws.root, "--json"], capture.io, {}), 0);
  const json = JSON.parse(capture.output());
  assert.equal(json.catalog_path, ".tieline/screens");
  assert.equal(json.text_path, ".tieline/screen-text");
  assert.deepEqual(json.incomplete.map((gap: { key: string }) => gap.key), ["note-saved-toast"]);

  capture.reset();
  assert.equal(await runCli(["screens", "audit", "--repository", ws.root], capture.io, {}), 0);
  const text = capture.output();
  assert.match(text, /^Screen audit of \.tieline\/screens: 3 screen\(s\); 1 missing capture output\(s\); 0 not captured, with a reason; 0 ARIA snapshot mismatch\(es\); 1 orphaned ARIA snapshot\(s\)\.\n/);
  assert.match(text, /  note  page files are not checked; set screens\.capture\.pages to find pages no screen covers\.\n/);
  assert.match(text, /  missing   note-saved-toast \(NOTES\): screenshot digest, capture record, ARIA snapshot, @screen test\n/);
  assert.match(text, /  orphaned  \.tieline\/screen-text\/retired-screen\.yml: no catalogued screen has this key\n/);
});

await test("refuses to audit a repository that has not opted in or whose catalog is invalid", async () => {
  const disabled = workspace({ git: true });
  const capture = captureIO();
  await assert.rejects(
    () => runCli(["screens", "audit", "--repository", disabled.root], capture.io, {}),
    /Screens are not enabled for this repository/
  );
  const invalid = workspace({
    git: true,
    screens: ENABLED,
    catalog: { ".tieline/screens/NOTES.yaml": "version: 1\ncapability: NOTES\nscreens:\n  - key: x\n" },
  });
  await assert.rejects(
    () => runCli(["screens", "audit", "--repository", invalid.root], capture.io, {}),
    /The screen catalog is invalid; fix it before auditing\.\n- \.tieline\/screens\/NOTES\.yaml at screens\.0\.title/
  );
  const undeclared = workspace({
    git: true,
    screens: ENABLED,
    catalog: { ".tieline/screens/BILLING.yaml": catalogYaml("BILLING", [{ key: "invoice" }]) },
  });
  await assert.rejects(
    () => runCli(["screens", "audit", "--repository", undeclared.root], capture.io, {}),
    /- \.tieline\/screens\/BILLING\.yaml: screen catalog names unknown capability 'BILLING'/
  );
});

console.log("screens audit: check warning");

await test("warns about missing capture outputs in check without changing its exit code", async () => {
  const ws = capturedWorkspace();
  const capture = captureIO();
  assert.equal(await runCli(["contract", "compile", ws.root], capture.io, {}), 0);
  ws.commit("baseline");
  capture.reset();
  assert.equal(await runCheckCommand({ base: "HEAD", repository: ws.root, json: true }, capture.io), 0);
  const result = JSON.parse(capture.output());
  assert.equal(result.exit_reason, "ok");
  assert.equal(result.screens.captures.incomplete, 1);
  assert.deepEqual(
    result.warnings.filter((warning: string) => warning.includes("screen")),
    [
      "1 screen(s) are missing capture outputs (1 without a screenshot digest, 1 without a capture record, 1 without an ARIA snapshot, 1 without an @screen test); run `tieline screens audit` for the list.",
    ]
  );
  assert.deepEqual(result.errors, []);

  ws.write(".tieline/screen-text/notes-list.yml", "- text: hand edited\n");
  ws.write(".tieline/screen-text/retired-screen.yml", "- text: gone\n");
  capture.reset();
  assert.equal(await runCheckCommand({ base: "HEAD", repository: ws.root }, capture.io), 0);
  const text = capture.output();
  assert.match(text, /broken screen link\(s\)=0; screens missing capture output\(s\)=1;/);
  assert.match(text, /  warn  1 screen\(s\) have an ARIA snapshot that differs from the digest their capture recorded; re-capture them\.\n/);
  assert.match(text, /  warn  1 ARIA snapshot\(s\) belong to no catalogued screen; delete them or restore their screens\.\n/);
});

await test("adds no screen warnings once every screen is captured", async () => {
  const ws = capturedWorkspace();
  ws.write(
    ".tieline/screens/NOTES.yaml",
    catalogYaml("NOTES", [captured("notes-list", LIST_TEXT), captured("notes-list-empty", EMPTY_TEXT)])
  );
  const capture = captureIO();
  assert.equal(await runCli(["contract", "compile", ws.root], capture.io, {}), 0);
  ws.commit("baseline");
  capture.reset();
  assert.equal(await runCheckCommand({ base: "HEAD", repository: ws.root, json: true }, capture.io), 0);
  const result = JSON.parse(capture.output());
  assert.equal(result.screens.captures.incomplete, 0);
  assert.deepEqual(result.warnings.filter((warning: string) => /screen|ARIA/.test(warning)), []);
});

await test("leaves check's screen section out entirely when the catalog is invalid", async () => {
  const ws = capturedWorkspace();
  const capture = captureIO();
  assert.equal(await runCli(["contract", "compile", ws.root], capture.io, {}), 0);
  ws.commit("baseline");
  mkdirSync(resolve(ws.root, ".tieline/screens"), { recursive: true });
  ws.write(".tieline/screens/BROKEN.yaml", "version: 2\n");
  capture.reset();
  assert.equal(await runCheckCommand({ base: "HEAD", repository: ws.root, json: true }, capture.io), 1);
  const result = JSON.parse(capture.output());
  assert.equal(result.screens.status, "catalog_invalid");
  assert.equal(result.screens.captures, null);
});

for (const created of workspaces) created.cleanup();
report();
