import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { stringify } from "yaml";
import { runCli } from "../../../src/cli.js";
import {
  runScreensCaptureCommand,
  topologyDependents,
  type ScreensCaptureDependencies,
} from "../../../src/commands/screens-capture.js";
import { compileContractManifest } from "../../../src/contract/manifest.js";
import type { RepositoryPathChange } from "../../../src/contract/impact.js";
import {
  changedSceneTagReader,
  readBaseScreenCatalog,
  screenOwnerLinks,
  selectChangedScreens,
  selectRequestedScreens,
  SCREEN_SELECTION_LIMITS,
  type ChangedScreenInputs,
  type ScreenDependents,
} from "../../../src/contract/screen-capture-selection.js";
import {
  loadScreenCatalog,
  screenSettingsForRepository,
  type ScreenEntry,
} from "../../../src/contract/screen-catalog.js";
import { report, test } from "../../support/harness.js";
import {
  captureIO,
  createScreensWorkspace,
  REPO_KEY,
  type ScreensWorkspace,
} from "../../support/screen-fixtures.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);

const workspaces: ScreensWorkspace[] = [];
function workspace(options: Parameters<typeof createScreensWorkspace>[0]): ScreensWorkspace {
  const created = createScreensWorkspace(options);
  workspaces.push(created);
  return created;
}

function screen(key: string, overrides: Partial<ScreenEntry> = {}): ScreenEntry {
  return {
    key,
    title: `Screen ${key}`,
    route: "/notes",
    kind: "page",
    when: "A member opens Notes.",
    ...overrides,
  };
}

function catalogYaml(capability: string, screens: ScreenEntry[]): string {
  return stringify({ version: 1, capability, screens });
}

const NOTES_SCREENS: ScreenEntry[] = [
  screen("notes-list", { paths: ["src/pages/notes-list.tsx"] }),
  screen("notes-list-empty", { paths: ["src/pages/notes-list.tsx", "src/empty/**"] }),
  screen("note-saved-toast"),
];
const SHARING_SCREENS: ScreenEntry[] = [screen("notes-share-denied", { kind: "inline-error" })];

/** Acme Notes with screens enabled, a catalog, and shows links. */
function notesWorkspace(screens: unknown = { enabled: true }): ScreensWorkspace {
  return workspace({
    git: true,
    screens,
    notes: { storyShows: ["note-saved-toast"], criterionShows: ["notes-list"] },
    catalog: {
      ".tieline/screens/NOTES.yaml": catalogYaml("NOTES", NOTES_SCREENS),
      ".tieline/screens/SHARING.yaml": catalogYaml("SHARING", SHARING_SCREENS),
    },
  });
}

/** Inputs for the pure rules, against a workspace's current catalog. */
function inputs(ws: ScreensWorkspace, overrides: Partial<ChangedScreenInputs> = {}): ChangedScreenInputs {
  const settings = screenSettingsForRepository(ws.root)!;
  const { catalog, issues } = loadScreenCatalog(ws.root, settings);
  assert.deepEqual(issues, []);
  return {
    settings,
    current: catalog,
    base: new Map([...catalog.screens].map(([key, entry]) => [key, entry.entry])),
    changes: [],
    globalPaths: [],
    owners: new Map(),
    dependents: { status: "complete", files: [], truncated: false },
    sceneTags: () => [],
    ...overrides,
  };
}

function gitHead(ws: ScreensWorkspace): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ws.root, encoding: "utf8" }).trim();
}

function picks(result: ReturnType<typeof selectChangedScreens>): Record<string, unknown[]> {
  return Object.fromEntries(result.screens.map((selected) => [selected.key, selected.reasons]));
}

function modified(path: string): RepositoryPathChange {
  return { status: "modified", path };
}

console.log("screens selection: rules");

await test("selects nothing when nothing relevant changed", () => {
  const ws = notesWorkspace();
  const result = selectChangedScreens(inputs(ws, { changes: [modified("README.md")] }));
  assert.deepEqual(result, { screens: [], unavailable: [] });
});

await test("selects added screens and screens whose authored fields changed, not their selection paths", () => {
  const ws = notesWorkspace();
  const base = new Map<string, ScreenEntry>([
    ["notes-list", screen("notes-list", { title: "Old title", paths: ["src/pages/notes-list.tsx"] })],
    ["notes-list-empty", screen("notes-list-empty", { paths: ["src/other.tsx"] })],
    ["note-saved-toast", screen("note-saved-toast")],
    ["retired", screen("retired")],
  ]);
  assert.deepEqual(picks(selectChangedScreens(inputs(ws, { base }))), {
    "notes-list": [{ rule: "catalog", change: "changed" }],
    "notes-share-denied": [{ rule: "catalog", change: "added" }],
  });
});

await test("selects screens whose committed outputs changed, in the catalog or the text directory", () => {
  const ws = notesWorkspace();
  ws.write(
    ".tieline/screens/NOTES.yaml",
    catalogYaml("NOTES", [
      screen("notes-list", {
        paths: ["src/pages/notes-list.tsx"],
        image: { path: "notes-list.png", sha256: DIGEST_A },
        capture: { fingerprint: DIGEST_B, text_sha256: DIGEST_C, test: "e2e/notes.screens.ts" },
      }),
      ...NOTES_SCREENS.slice(1),
    ])
  );
  const current = inputs(ws);
  const base = new Map(current.base);
  base.set("notes-list", screen("notes-list", { paths: ["src/pages/notes-list.tsx"], image: { path: "notes-list.png", sha256: DIGEST_A } }));
  const result = selectChangedScreens({
    ...current,
    base,
    changes: [
      modified(".tieline/screen-text/note-saved-toast.yml"),
      { status: "deleted", path: ".tieline/screen-text/notes-share-denied.yml" },
      { status: "renamed", old_path: ".tieline/screen-text/notes-list-empty.yml", path: ".tieline/screen-text/elsewhere/x.yml" },
      modified(".tieline/screen-text/retired.yml"),
      modified(".tieline/screen-text/notes-list.txt"),
    ],
  });
  assert.deepEqual(picks(result), {
    "note-saved-toast": [{ rule: "outputs", path: ".tieline/screen-text/note-saved-toast.yml" }],
    "notes-list": [{ rule: "outputs", path: ".tieline/screens/NOTES.yaml" }],
    "notes-list-empty": [{ rule: "outputs", path: ".tieline/screen-text/notes-list-empty.yml" }],
    "notes-share-denied": [{ rule: "outputs", path: ".tieline/screen-text/notes-share-denied.yml" }],
  });
});

await test("selects screens tagged by changed scene tests and reports unreadable ones", () => {
  const ws = notesWorkspace();
  const read: string[] = [];
  const result = selectChangedScreens(
    inputs(ws, {
      changes: [
        modified("e2e/notes.screens.ts"),
        { status: "deleted", path: "e2e/sharing.spec.ts" },
        modified("e2e/huge.spec.ts"),
        modified("src/notes.ts"),
      ],
      sceneTags: (change) => {
        read.push(change.path);
        if (change.path === "e2e/huge.spec.ts") return null;
        return change.path === "e2e/notes.screens.ts" ? ["notes-list", "unknown-key"] : ["notes-share-denied"];
      },
    })
  );
  // Only test files are read; tags of uncatalogued keys select nothing.
  assert.deepEqual(read, ["e2e/notes.screens.ts", "e2e/sharing.spec.ts", "e2e/huge.spec.ts"]);
  assert.deepEqual(picks(result), {
    "notes-list": [{ rule: "scene", path: "e2e/notes.screens.ts" }],
    "notes-share-denied": [{ rule: "scene", path: "e2e/sharing.spec.ts" }],
  });
  assert.deepEqual(result.unavailable, [
    { rule: "scene", detail: "1 changed test file(s) could not be read for @screen tags (e2e/huge.spec.ts)" },
  ]);
});

await test("selects screens through the links of the Stories and ACs that show them", () => {
  const ws = notesWorkspace();
  const manifest = compileContractManifest({ repositoryRoot: ws.root, repositoryKey: REPO_KEY, specDirectory: ".tieline/spec" });
  const owners = screenOwnerLinks(manifest);
  // The Story-level link falls back to the Story's links and every AC's.
  assert.deepEqual(Object.fromEntries(owners), {
    "note-saved-toast": [{ owner: "NOTES-001", path: "src/notes.ts" }],
    "notes-list": [],
  });
  const result = selectChangedScreens(
    inputs(ws, { owners, changes: [{ status: "renamed", old_path: "src/notes.ts", path: "src/notes/index.ts" }] })
  );
  assert.deepEqual(picks(result), {
    "note-saved-toast": [{ rule: "contract", owner: "NOTES-001", path: "src/notes.ts" }],
  });
  assert.deepEqual(
    selectChangedScreens(inputs(ws, { owners: null })).unavailable,
    [{ rule: "contract", detail: "the working-tree contract does not compile, so the Stories and ACs that show each screen are unknown" }]
  );
});

await test("selects screens whose paths match a changed file or a file that depends on it", () => {
  const ws = notesWorkspace();
  const dependents: ScreenDependents = {
    status: "complete",
    files: [
      { path: "src/pages/notes-list.tsx", from: "src/components/button.tsx" },
      { path: "src/notes.ts", from: "src/storage.ts" },
      { path: "src/unrelated.ts", from: "src/storage.ts" },
    ],
    truncated: false,
  };
  const result = selectChangedScreens(
    inputs(ws, {
      owners: new Map([["note-saved-toast", [{ owner: "NOTES-001", path: "src/notes.ts" }]]]),
      changes: [modified("src/empty/illustration.tsx"), modified("src/components/button.tsx"), modified("src/storage.ts")],
      dependents,
    })
  );
  assert.deepEqual(picks(result), {
    "note-saved-toast": [{ rule: "dependency", path: "src/notes.ts", from: "src/storage.ts", owner: "NOTES-001" }],
    "notes-list": [{ rule: "dependency", path: "src/pages/notes-list.tsx", from: "src/components/button.tsx", pattern: "src/pages/notes-list.tsx" }],
    "notes-list-empty": [
      { rule: "path", pattern: "src/empty/**", path: "src/empty/illustration.tsx" },
      { rule: "dependency", path: "src/pages/notes-list.tsx", from: "src/components/button.tsx", pattern: "src/pages/notes-list.tsx" },
    ],
  });
  assert.deepEqual(result.unavailable, []);
});

await test("reports a truncated or unavailable blast radius instead of treating it as no dependents", () => {
  const ws = notesWorkspace();
  assert.deepEqual(
    selectChangedScreens(inputs(ws, { dependents: { status: "complete", files: [], truncated: true } })).unavailable,
    [{ rule: "dependency", detail: "the code-topology blast radius reached its traversal bound, so some dependents were not followed" }]
  );
  assert.deepEqual(
    selectChangedScreens(inputs(ws, { dependents: { status: "unavailable", detail: "topology_stale" } })).unavailable,
    [{ rule: "dependency", detail: "topology_stale" }]
  );
});

await test("selects every screen when a global path changed, naming the first match", () => {
  const ws = notesWorkspace();
  const result = selectChangedScreens(
    inputs(ws, {
      globalPaths: ["src/styles/**", "src/i18n/*.json"],
      changes: [modified("src/notes.ts"), modified("src/i18n/en.json"), modified("src/styles/theme.css")],
    })
  );
  assert.equal(result.screens.length, 4);
  for (const selected of result.screens) {
    assert.deepEqual(selected.reasons, [{ rule: "global", pattern: "src/i18n/*.json", path: "src/i18n/en.json" }]);
  }
});

await test("orders reasons by rule and bounds how many each screen keeps", () => {
  const ws = notesWorkspace();
  const changes = Array.from({ length: SCREEN_SELECTION_LIMITS.reasonsPerScreen + 5 }, (_, index) =>
    modified(`src/empty/file-${String(index).padStart(2, "0")}.tsx`)
  );
  const result = selectChangedScreens(
    inputs(ws, { changes: [...changes, modified("e2e/empty.spec.ts")], sceneTags: () => ["notes-list-empty"] })
  );
  const [selected] = result.screens;
  assert.equal(selected!.key, "notes-list-empty");
  assert.equal(selected!.reasons.length, SCREEN_SELECTION_LIMITS.reasonsPerScreen);
  assert.deepEqual(selected!.reasons[0], { rule: "scene", path: "e2e/empty.spec.ts" });
  assert.deepEqual(selected!.reasons[1], { rule: "path", pattern: "src/empty/**", path: "src/empty/file-00.tsx" });
  assert.equal(selected!.omitted_reasons, 6);
});

await test("selects every screen, or exactly the requested ones", () => {
  const ws = notesWorkspace();
  const { current } = inputs(ws);
  assert.deepEqual(
    selectRequestedScreens(current, { kind: "all" }).map((selected) => [selected.key, selected.capability, selected.reasons]),
    [
      ["note-saved-toast", "NOTES", [{ rule: "all" }]],
      ["notes-list", "NOTES", [{ rule: "all" }]],
      ["notes-list-empty", "NOTES", [{ rule: "all" }]],
      ["notes-share-denied", "SHARING", [{ rule: "all" }]],
    ]
  );
  assert.deepEqual(
    selectRequestedScreens(current, { kind: "screens", keys: ["notes-share-denied"] }).map((selected) => selected.key),
    ["notes-share-denied"]
  );
  assert.throws(
    () => selectRequestedScreens(current, { kind: "screens", keys: ["notes-list", "nope", "gone"] }),
    /The screen catalog has no screen 'nope', 'gone'\./
  );
});

console.log("screens selection: the branch point");

await test("reads the catalog committed at the branch point and widens on what it cannot read", () => {
  const ws = notesWorkspace();
  ws.commit("baseline");
  const commit = gitHead(ws);
  ws.write(".tieline/screens/NOTES.yaml", catalogYaml("NOTES", [screen("brand-new")]));
  const settings = screenSettingsForRepository(ws.root)!;
  const read = readBaseScreenCatalog(ws.root, settings, commit);
  assert.deepEqual([...read.entries.keys()].sort(), ["note-saved-toast", "notes-list", "notes-list-empty", "notes-share-denied"]);
  assert.deepEqual(read.issues, []);

  ws.write(".tieline/screens/SHARING.yaml", "version: 1\ncapability: SHARING\nscreens:\n  - key: broken\n");
  ws.commit("an invalid catalog file");
  const invalid = readBaseScreenCatalog(ws.root, settings, gitHead(ws));
  assert.deepEqual([...invalid.entries.keys()], ["brand-new"]);
  assert.match(invalid.issues[0]!, /^\.tieline\/screens\/SHARING\.yaml at screens\.0\.title: Required/);

  const missing = readBaseScreenCatalog(ws.root, settings, "0".repeat(40));
  assert.equal(missing.entries.size, 0);
  assert.match(missing.issues[0]!, /could not be listed/);

  // Bounded like the working-tree catalog walk; past a bound nothing is read.
  const head = gitHead(ws);
  const files = readBaseScreenCatalog(ws.root, settings, head, { files: 1, fileBytes: 4096, totalBytes: 4096 });
  assert.equal(files.entries.size, 0);
  assert.match(files.issues[0]!, /holds more than 1 YAML files/);
  const total = readBaseScreenCatalog(ws.root, settings, head, { files: 10, fileBytes: 4096, totalBytes: 64 });
  assert.equal(total.entries.size, 0);
  assert.match(total.issues[0]!, /holds more than 64 bytes of YAML/);
  const oversize = readBaseScreenCatalog(ws.root, settings, head, { files: 10, fileBytes: 32, totalBytes: 4096 });
  assert.equal(oversize.entries.size, 0);
  assert.match(oversize.issues[0]!, /\.tieline\/screens\/NOTES\.yaml at [a-f0-9]{12} could not be read/);
});

await test("reads a deleted scene test's tags from the branch point", () => {
  const ws = notesWorkspace();
  ws.write("e2e/gone.spec.ts", 'test("x", { tag: "@screen:notes-list" }, () => {});\n');
  ws.write("e2e/kept.spec.ts", 'test("y", { tag: "@screen:note-saved-toast" }, () => {});\n');
  ws.commit("baseline");
  const reader = changedSceneTagReader(ws.root, gitHead(ws));
  ws.remove("e2e/gone.spec.ts");
  assert.deepEqual(reader({ status: "deleted", path: "e2e/gone.spec.ts" }), ["notes-list"]);
  assert.deepEqual(reader(modified("e2e/kept.spec.ts")), ["note-saved-toast"]);
  assert.equal(reader(modified("e2e/never-existed.spec.ts")), null);
});

console.log("screens selection: capture --dry-run");

const NO_TOPOLOGY: ScreensCaptureDependencies = {
  async dependents() {
    return { status: "unavailable", detail: "no topology in this test" };
  },
};

async function dryRun(
  ws: ScreensWorkspace,
  args: string[],
  dependencies: ScreensCaptureDependencies = NO_TOPOLOGY
): Promise<Record<string, unknown>> {
  const capture = captureIO();
  const options = parseArgs(args);
  assert.equal(
    await runScreensCaptureCommand({ ...options, repository: ws.root, dryRun: true, json: true }, capture.io, dependencies),
    0
  );
  return JSON.parse(capture.output()) as Record<string, unknown>;
}

function parseArgs(args: string[]): { all?: boolean; changed?: boolean; base?: string; screens?: string[] } {
  const options: { all?: boolean; changed?: boolean; base?: string; screens?: string[] } = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--all") options.all = true;
    else if (arg === "--changed") options.changed = true;
    else if (arg === "--base") options.base = args[++index];
    else if (arg === "--screen") options.screens = [...(options.screens ?? []), args[++index]!];
  }
  return options;
}

await test("reports the selection for a branch with each reason, from where it left its base", async () => {
  const ws = notesWorkspace({ enabled: true, capture: { global_paths: ["src/styles/**"] } });
  ws.write("e2e/notes.screens.ts", 'test("list", { tag: "@screen:notes-list" }, () => {});\n');
  ws.commit("baseline");
  const baseCommit = gitHead(ws);
  ws.write("e2e/notes.screens.ts", 'test("list", { tag: "@screen:notes-list" }, async () => {});\n');
  ws.write("src/notes.ts", "export const notes: string[] = ['changed'];\n");
  const seen: unknown[] = [];
  const result = await dryRun(ws, ["--changed", "--base", "HEAD"], {
    async dependents(input) {
      seen.push(input);
      return { status: "complete", files: [{ path: "src/pages/notes-list.tsx", from: "src/notes.ts" }], truncated: false };
    },
  });
  assert.deepEqual(seen, [{ repositoryRoot: ws.root, repositoryKey: REPO_KEY, base: baseCommit }]);
  const selection = result.selection as { base: unknown; changed_files: number; screens: Array<{ key: string; reasons: unknown[] }>; unavailable: unknown[] };
  assert.deepEqual(selection.base, { ref: "HEAD", commit: baseCommit });
  assert.equal(selection.changed_files, 2);
  assert.deepEqual(
    Object.fromEntries(selection.screens.map((selected) => [selected.key, selected.reasons])),
    {
      "note-saved-toast": [{ rule: "contract", owner: "NOTES-001", path: "src/notes.ts" }],
      "notes-list": [
        { rule: "scene", path: "e2e/notes.screens.ts" },
        { rule: "dependency", path: "src/pages/notes-list.tsx", from: "src/notes.ts", pattern: "src/pages/notes-list.tsx" },
      ],
      "notes-list-empty": [
        { rule: "dependency", path: "src/pages/notes-list.tsx", from: "src/notes.ts", pattern: "src/pages/notes-list.tsx" },
      ],
    }
  );
  assert.deepEqual(selection.unavailable, []);
  assert.equal(result.catalog_screens, 4);

  // A global path selects everything.
  ws.write("src/styles/theme.css", "body { color: black; }\n");
  const global = await dryRun(ws, ["--changed", "--base", "HEAD"]);
  assert.equal((global.selection as { screens: unknown[] }).screens.length, 4);

  // Text output names each screen and why, and notes unavailable rules.
  const capture = captureIO();
  await runScreensCaptureCommand({ repository: ws.root, changed: true, base: "HEAD", dryRun: true }, capture.io, NO_TOPOLOGY);
  const text = capture.output();
  assert.match(text, /^Would capture 4 of 4 screen\(s\) changed since HEAD \(branch point [a-f0-9]{12}, 3 changed file\(s\)\)\.\n/);
  assert.match(text, /  notes-list \(NOTES\)\n    scene      scene test e2e\/notes\.screens\.ts changed\n/);
  assert.match(text, /    contract   NOTES-001 shows it and links src\/notes\.ts, which changed\n/);
  assert.match(text, /    global     global path src\/styles\/theme\.css changed \(src\/styles\/\*\*\)\n/);
  assert.match(text, /  note  dependency rule incomplete: no topology in this test\n/);
});

await test("reports --all and --screen selections and validates the scope", async () => {
  const ws = notesWorkspace();
  const all = await dryRun(ws, ["--all"]);
  assert.equal((all.selection as { screens: unknown[] }).screens.length, 4);
  assert.equal((all.selection as { base: unknown }).base, null);
  const one = await dryRun(ws, ["--screen", "notes-list", "--screen", "notes-list"]);
  assert.deepEqual(
    (one.selection as { screens: Array<{ key: string; reasons: unknown[] }> }).screens,
    [{ key: "notes-list", capability: "NOTES", reasons: [{ rule: "requested" }], omitted_reasons: 0 }]
  );
  const capture = captureIO();
  for (const [options, expected] of [
    [{}, /Choose exactly one of --all, --changed --base <ref>, or --screen <key>\./],
    [{ all: true, changed: true, base: "HEAD" }, /Choose exactly one/],
    [{ changed: true }, /--changed needs --base <ref>/],
    [{ all: true, base: "HEAD" }, /--base applies only to --changed\./],
    [{ screens: ["nope"] }, /The screen catalog has no screen 'nope'\./],
  ] as const) {
    await assert.rejects(
      () => runScreensCaptureCommand({ ...options, repository: ws.root, dryRun: true }, capture.io, NO_TOPOLOGY),
      expected,
      JSON.stringify(options)
    );
  }
  await assert.rejects(
    () => runScreensCaptureCommand({ all: true, repository: ws.root }, capture.io, NO_TOPOLOGY),
    /not available in this build yet; pass --dry-run/
  );
});

await test("refuses a repository that has not opted in or whose catalog is invalid", async () => {
  const capture = captureIO();
  const disabled = workspace({ git: true });
  await assert.rejects(
    () => runCli(["screens", "capture", "--all", "--dry-run", "--repository", disabled.root], capture.io, {}),
    /Screens are not enabled for this repository/
  );
  const invalid = workspace({
    git: true,
    screens: { enabled: true },
    catalog: { ".tieline/screens/BILLING.yaml": catalogYaml("BILLING", [screen("invoice")]) },
  });
  await assert.rejects(
    () => runCli(["screens", "capture", "--all", "--dry-run", "--repository", invalid.root], capture.io, {}),
    /The screen catalog is invalid; fix it before capturing\.\n- \.tieline\/screens\/BILLING\.yaml: screen catalog names unknown capability 'BILLING'/
  );
});

console.log("screens selection: code topology");

await test("follows a changed shared component through the real code topology to the pages that use it", async () => {
  const ws = notesWorkspace();
  ws.write("src/components/button.ts", "export function button(label: string): string {\n  return `<button>${label}</button>`;\n}\n");
  ws.write(
    "src/pages/notes-list.tsx",
    'import { button } from "../components/button";\n\nexport function notesList(): string {\n  return button("New note");\n}\n'
  );
  const capture = captureIO();
  assert.equal(await runCli(["contract", "compile", ws.root], capture.io, {}), 0);
  assert.equal(await runCli(["code", "compile", ws.root], capture.io, {}), 0);
  ws.commit("baseline");
  ws.write("src/components/button.ts", "export function button(label: string): string {\n  return `<button class=\"primary\">${label}</button>`;\n}\n");
  // A stale topology is reported, not mistaken for "nothing depends on it".
  const stale = await dryRun(ws, ["--changed", "--base", "HEAD"], { dependents: topologyDependents });
  const staleSelection = stale.selection as { screens: unknown[]; unavailable: Array<{ rule: string; detail: string }> };
  assert.deepEqual(staleSelection.screens, []);
  assert.equal(staleSelection.unavailable[0]!.rule, "dependency");
  assert.match(staleSelection.unavailable[0]!.detail, /blast radius is unavailable \(topology_stale\)/);

  capture.reset();
  assert.equal(await runCli(["code", "compile", ws.root], capture.io, {}), 0);
  capture.reset();
  assert.equal(
    await runCli(["screens", "capture", "--changed", "--base", "HEAD", "--dry-run", "--json", "--repository", ws.root], capture.io, {}),
    0
  );
  const selection = (JSON.parse(capture.output()) as { selection: { screens: Array<{ key: string; reasons: unknown[] }>; unavailable: unknown[] } }).selection;
  assert.deepEqual(selection.unavailable, []);
  assert.deepEqual(
    Object.fromEntries(selection.screens.map((selected) => [selected.key, selected.reasons])),
    {
      "notes-list": [{ rule: "dependency", path: "src/pages/notes-list.tsx", from: "src/components/button.ts", pattern: "src/pages/notes-list.tsx" }],
      "notes-list-empty": [{ rule: "dependency", path: "src/pages/notes-list.tsx", from: "src/components/button.ts", pattern: "src/pages/notes-list.tsx" }],
    }
  );
});

for (const created of workspaces) created.cleanup();
report();
