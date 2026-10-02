import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runCli } from "../../../src/cli.js";
import { runCheckCommand } from "../../../src/commands/check.js";
import { readScreensConfig } from "../../../src/config.js";
import { loadAcceptedContractWithSources } from "../../../src/contract/load.js";
import {
  compileContractManifest,
  compileContractManifestWithSources,
  manifestWithoutScreens,
  parseContractManifestSnapshot,
  readContractManifest,
  serializeContractManifest,
  writeContractManifest,
} from "../../../src/contract/manifest.js";
import {
  readScreenCatalogSources,
  screenCatalogDocumentSchema,
  screenSettingsForRepository,
  SCREEN_LIMITS,
  validateScreenCatalogDocuments,
} from "../../../src/contract/screen-catalog.js";
import { ContractValidationError } from "../../../src/contract/validate.js";
import { workspaceFromConfig } from "../../../src/tieline/workspace.js";
import { report, test } from "../../support/harness.js";
import {
  captureIO,
  createScreensWorkspace,
  NOTES_CATALOG_YAML,
  notesSpecYaml,
  REPO_KEY,
  screensConfigJson,
  SHARING_CATALOG_YAML,
  type ScreensWorkspace,
} from "../../support/screen-fixtures.js";

const ENABLED = { enabled: true };
const CATALOG = {
  ".tieline/screens/NOTES.yaml": NOTES_CATALOG_YAML,
  ".tieline/screens/SHARING.yaml": SHARING_CATALOG_YAML,
};

function compile(workspace: ScreensWorkspace) {
  return compileContractManifestWithSources({
    repositoryRoot: workspace.root,
    repositoryKey: REPO_KEY,
    specDirectory: ".tieline/spec",
  });
}

function validationIssues(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    if (error instanceof ContractValidationError) return error.issues;
    throw error;
  }
  assert.fail("expected contract validation to fail");
}

function catalogIssues(document: unknown, capabilities?: string[]): string[] {
  const issues: string[] = [];
  validateScreenCatalogDocuments(
    [{ path: "catalog.yaml", document }],
    capabilities ? new Set(capabilities) : undefined,
    issues
  );
  return issues;
}

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "notes-list",
    title: "Notes list",
    route: "/notes",
    kind: "page",
    when: "A member opens Notes.",
    ...overrides,
  };
}

const workspaces: ScreensWorkspace[] = [];
function workspace(options: Parameters<typeof createScreensWorkspace>[0]): ScreensWorkspace {
  const created = createScreensWorkspace(options);
  workspaces.push(created);
  return created;
}

console.log("screens: opt-in configuration");

await test("treats an absent or disabled screens block as off and applies defaults when on", () => {
  assert.equal(readScreensConfig({}), null);
  assert.equal(readScreensConfig({ screens: { enabled: false } }), null);
  assert.deepEqual(readScreensConfig({ screens: { enabled: true } }), {
    catalog_directory: "screens",
    captures_directory: "captures",
  });
  assert.throws(
    () => readScreensConfig({ screens: { enabled: "yes" } }),
    /Invalid 'screens' block.*screens\.enabled/
  );
  assert.throws(
    () => readScreensConfig({ screens: { enabled: true, colour: "blue" } }),
    /Unrecognized key/
  );
  assert.throws(
    () => readScreensConfig({ screens: { enabled: true, catalog_directory: "/etc" } }),
    /relative POSIX path/
  );
});

await test("keeps the catalog inside .tieline and captures inside the repository", () => {
  const escaped = workspace({ screens: { enabled: true, catalog_directory: "../catalog" } });
  assert.throws(
    () => screenSettingsForRepository(escaped.root),
    /catalog must be a directory inside '\.tieline'/
  );
  const outside = workspace({ screens: { enabled: true, captures_directory: "../../elsewhere" } });
  assert.throws(
    () => screenSettingsForRepository(outside.root),
    /captures directory must stay inside the repository/
  );
  const custom = workspace({
    screens: { enabled: true, catalog_directory: "ui/screens", captures_directory: "../artifacts/shots" },
  });
  const settings = screenSettingsForRepository(custom.root);
  assert.equal(settings?.catalogPath, ".tieline/ui/screens");
  assert.equal(settings?.capturesPath, "artifacts/shots");
  // The workspace loader accepts the block and never writes defaults back.
  const loaded = workspaceFromConfig(resolve(custom.root, ".tieline/config.json"));
  assert.deepEqual(loaded.config.screens, {
    enabled: true,
    catalog_directory: "ui/screens",
    captures_directory: "../artifacts/shots",
  });
});

await test("judges configured directories by where symbolic links really lead", () => {
  const outside = mkdtempSync(resolve(tmpdir(), "tieline-screens-outside-"));
  try {
    const catalogLink = workspace({ screens: ENABLED });
    symlinkSync(outside, resolve(catalogLink.root, ".tieline/screens"));
    assert.throws(
      () => screenSettingsForRepository(catalogLink.root),
      /Invalid 'screens\.catalog_directory' 'screens': it resolves to '.*' through a symbolic link, outside '\.tieline'/
    );

    const capturesLink = workspace({ screens: ENABLED });
    symlinkSync(outside, resolve(capturesLink.root, ".tieline/captures"));
    assert.throws(
      () => screenSettingsForRepository(capturesLink.root),
      /Invalid 'screens\.captures_directory' 'captures': it resolves to '.*' through a symbolic link, outside the repository/
    );

    const dangling = workspace({ screens: ENABLED });
    symlinkSync(resolve(outside, "not-created-yet"), resolve(dangling.root, ".tieline/screens"));
    assert.throws(() => screenSettingsForRepository(dangling.root), /cannot be resolved/);

    // A link that stays inside the repository is fine.
    const inside = workspace({ screens: ENABLED });
    inside.write("artifacts/shots/.keep", "");
    symlinkSync(resolve(inside.root, "artifacts/shots"), resolve(inside.root, ".tieline/captures"));
    assert.equal(screenSettingsForRepository(inside.root)?.capturesPath, ".tieline/captures");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

await test("refuses a catalog the captures .gitignore would hide", () => {
  for (const screens of [
    { enabled: true, catalog_directory: "shots", captures_directory: "shots" },
    { enabled: true, catalog_directory: "shots/catalog", captures_directory: "shots" },
  ]) {
    const ws = workspace({ screens });
    assert.throws(
      () => screenSettingsForRepository(ws.root),
      /the catalog directory '.*' is inside the captures directory 'shots', which is git-ignored/
    );
  }
  // The reverse is fine: screenshots may live under the catalog directory.
  const nested = workspace({ screens: { enabled: true, captures_directory: "screens/shots" } });
  assert.equal(screenSettingsForRepository(nested.root)?.capturesPath, ".tieline/screens/shots");
});

console.log("screens: catalog schema");

await test("accepts a complete catalog entry and an empty catalog", () => {
  assert.deepEqual(
    catalogIssues({
      version: 1,
      capability: "NOTES",
      screens: [
        entry({
          group: "Browsing",
          applies_to: { role: ["member"], plan: ["team"] },
          copy: ["Your notes"],
          image: { path: "notes/list.png" },
        }),
        entry({ key: "share", kind: "dialog", image: { url: "https://cdn.example.test/a.webp" } }),
      ],
    }),
    []
  );
  assert.deepEqual(catalogIssues({ version: 1, capability: "NOTES", screens: [] }), []);
});

await test("rejects unknown kinds, unknown fields, and reserved phase-two fields", () => {
  const kind = catalogIssues({ version: 1, capability: "NOTES", screens: [entry({ kind: "modal" })] });
  assert.equal(kind.length, 1);
  assert.match(kind[0]!, /screens\.0\.kind: Invalid enum value\. Expected 'page' \| 'state'.*received 'modal'/);
  assert.match(
    catalogIssues({ version: 1, capability: "NOTES", screens: [entry({ colour: "red" })] })[0]!,
    /Unrecognized key/
  );
  const reserved = catalogIssues({
    version: 1,
    capability: "NOTES",
    screens: [entry({ scene: "scenes/notes.ts", capture: { fingerprint: "abc" } })],
  });
  assert.deepEqual(reserved, [
    "catalog.yaml at screens.0.scene: 'scene' is reserved for the script that reaches a screen in a later Tieline release and must be omitted",
    "catalog.yaml at screens.0.capture: 'capture' is reserved for capture fingerprints in a later Tieline release and must be omitted",
  ]);
});

await test("rejects oversize fields at every bound", () => {
  const long = (length: number) => "x".repeat(length);
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ title: long(SCREEN_LIMITS.titleChars + 1) }, /screens\.0\.title: String must contain at most 200/],
    [{ group: long(SCREEN_LIMITS.groupChars + 1) }, /screens\.0\.group: String must contain at most 120/],
    [{ route: long(SCREEN_LIMITS.routeChars + 1) }, /screens\.0\.route: String must contain at most 500/],
    [{ when: long(SCREEN_LIMITS.whenChars + 1) }, /screens\.0\.when: String must contain at most 500/],
    [{ copy: [long(SCREEN_LIMITS.copyChars + 1)] }, /screens\.0\.copy\.0: String must contain at most 500/],
    [{ copy: Array.from({ length: SCREEN_LIMITS.copyItems + 1 }, () => "a") }, /screens\.0\.copy: Array must contain at most 50/],
    [{ image: { path: `${long(SCREEN_LIMITS.imagePathChars)}.png` } }, /screens\.0\.image\.path: String must contain at most 500/],
    [{ image: { url: `https://example.test/${long(SCREEN_LIMITS.imageUrlChars)}` } }, /screens\.0\.image\.url: String must contain at most 2048/],
    [{ applies_to: { role: Array.from({ length: 33 }, (_, index) => `r${index}`) } }, /screens\.0\.applies_to\.role: must contain at most 32 values/],
    [{ applies_to: { role: [long(121)] } }, /screens\.0\.applies_to\.role\.0: values must contain at most 120/],
    [{ key: long(161) }, /screens\.0\.key: String must contain at most 160/],
    [{ title: "Two\nlines" }, /screens\.0\.title: must be a single line/],
  ];
  for (const [overrides, expected] of cases) {
    const issues = catalogIssues({ version: 1, capability: "NOTES", screens: [entry(overrides)] });
    assert.equal(issues.length, 1, `${JSON.stringify(Object.keys(overrides))}: ${issues.join("; ")}`);
    assert.match(issues[0]!, expected);
  }
  // Exactly at the bound is accepted.
  assert.deepEqual(
    catalogIssues({
      version: 1,
      capability: "NOTES",
      screens: [entry({ title: long(SCREEN_LIMITS.titleChars), copy: Array.from({ length: 50 }, () => "a") })],
    }),
    []
  );
});

await test("refuses image locators that escape the captures directory or are not http(s)", () => {
  for (const path of ["../secrets.png", "/etc/x.png", "C:/x.png", "a//b.png", "notes/./x.png", "notes\\x.png", "notes/x.html", "javascript:alert(1).png"]) {
    const issues = catalogIssues({ version: 1, capability: "NOTES", screens: [entry({ image: { path } })] });
    assert.equal(issues.length, 1, path);
    assert.match(issues[0]!, /screens\.0\.image\.path/, path);
  }
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:image/png;base64,AAAA", "not a url"]) {
    const issues = catalogIssues({ version: 1, capability: "NOTES", screens: [entry({ image: { url } })] });
    assert.deepEqual(issues, ["catalog.yaml at screens.0.image.url: must be an absolute http or https URL"], url);
  }
  assert.match(
    catalogIssues({ version: 1, capability: "NOTES", screens: [entry({ image: { path: "a.png", url: "https://x.test/a.png" } })] })[0]!,
    /Unrecognized key/
  );
});

await test("rejects duplicate keys across files, two catalogs for one capability, and unknown capabilities", () => {
  const issues: string[] = [];
  validateScreenCatalogDocuments(
    [
      { path: "a.yaml", document: { version: 1, capability: "NOTES", screens: [entry(), entry({ key: "other" })] } },
      { path: "b.yaml", document: { version: 1, capability: "SHARING", screens: [entry()] } },
      { path: "c.yaml", document: { version: 1, capability: "NOTES", screens: [] } },
      { path: "d.yaml", document: { version: 1, capability: "BILLING", screens: [] } },
    ],
    new Set(["NOTES", "SHARING"]),
    issues
  );
  assert.deepEqual(issues, [
    "b.yaml: duplicate screen key 'notes-list' already used in a.yaml",
    "c.yaml: capability 'NOTES' already has a screen catalog in a.yaml; keep one catalog file per capability",
    "d.yaml: screen catalog names unknown capability 'BILLING'",
  ]);
  const within = catalogIssues({ version: 1, capability: "NOTES", screens: [entry(), entry()] });
  assert.deepEqual(within, ["catalog.yaml: duplicate screen key 'notes-list' already used in catalog.yaml"]);
});

await test("bounds catalog file size before reading and treats a missing catalog as empty", () => {
  const empty = workspace({ screens: ENABLED });
  const settings = screenSettingsForRepository(empty.root)!;
  assert.deepEqual(readScreenCatalogSources(empty.root, settings), {
    sources: [],
    issues: [],
    complete: true,
  });
  empty.write(".tieline/screens/BIG.yaml", `# ${"x".repeat(SCREEN_LIMITS.catalogFileBytes)}\n`);
  const read = readScreenCatalogSources(empty.root, settings);
  assert.equal(read.sources.length, 0);
  assert.match(read.issues[0]!, /\.tieline\/screens\/BIG\.yaml: screen catalog file is \d+ bytes; the limit is 4194304/);
  assert.ok(screenCatalogDocumentSchema.safeParse({ version: 1, capability: "N", screens: [] }).success);
});

await test("bounds the catalog walk by depth, entries, files, and total bytes", () => {
  const ws = workspace({ screens: ENABLED, notes: { storyShows: ["notes-list"] }, catalog: CATALOG });
  const settings = screenSettingsForRepository(ws.root)!;
  const limits = { depth: 2, entries: 50, files: 3, fileBytes: 4096, totalBytes: 2048 };
  assert.equal(readScreenCatalogSources(ws.root, settings, limits).complete, true);

  ws.write(".tieline/screens/a/b/c/deep.yaml", "version: 1\ncapability: NOTES\nscreens: []\n");
  const deep = readScreenCatalogSources(ws.root, settings, limits);
  assert.equal(deep.complete, false);
  assert.match(deep.issues[0]!, /\.tieline\/screens\/a\/b\/c: the screen catalog is nested deeper than 2 directories/);
  ws.remove(".tieline/screens/a");

  for (const name of ["x", "y"]) ws.write(`.tieline/screens/${name}.yaml`, "{}\n");
  assert.deepEqual(readScreenCatalogSources(ws.root, settings, limits).issues, [
    "the screen catalog holds more than 3 YAML files",
  ]);
  ws.remove(".tieline/screens/x.yaml");
  ws.remove(".tieline/screens/y.yaml");

  ws.write(".tieline/screens/padding.yaml", `# ${"p".repeat(1500)}\n`);
  assert.deepEqual(readScreenCatalogSources(ws.root, settings, limits).issues, [
    "the screen catalog holds more than 2048 bytes of YAML",
  ]);
  ws.remove(".tieline/screens/padding.yaml");

  for (let index = 0; index < 60; index += 1) ws.write(`.tieline/screens/notes-${index}.txt`, "");
  assert.deepEqual(readScreenCatalogSources(ws.root, settings, limits).issues, [
    "the screen catalog holds more than 50 directory entries",
  ]);

  // With the default bounds, a catalog nested too deep stops loading with
  // that one issue, rather than reporting every shows link as unknown.
  ws.write(".tieline/screens/1/2/3/4/5/6/7/8/9/deep.yaml", "version: 1\ncapability: NOTES\nscreens: []\n");
  assert.deepEqual(validationIssues(() => loadAcceptedContractWithSources(ws.root, ".tieline/spec")), [
    ".tieline/screens/1/2/3/4/5/6/7/8/9: the screen catalog is nested deeper than 8 directories",
  ]);
});

console.log("screens: shows links");

await test("resolves shows links on Stories and ACs and compiles them deterministically", () => {
  const ws = workspace({
    screens: ENABLED,
    notes: { storyShows: ["notes-list"], criterionShows: ["notes-share-denied", "notes-list-empty"] },
    catalog: CATALOG,
  });
  const loaded = loadAcceptedContractWithSources(ws.root, ".tieline/spec");
  assert.equal(loaded.screens?.screens.size, 4);
  const story = loaded.documents.find((document) => document.capability.key === "NOTES")!.capability.stories[0]!;
  // Evidence links keep exactly their pre-screens shape; shows links move out.
  assert.deepEqual(story.links.map((link) => link.relation), ["implements"]);
  assert.deepEqual(story.shows?.map((link) => link.target.key), ["notes-list"]);
  assert.equal(story.acceptance_criteria[1]!.shows, undefined);

  const first = compile(ws);
  const second = compile(ws);
  assert.equal(serializeContractManifest(first.manifest), serializeContractManifest(second.manifest));
  const notes = first.manifest.capabilities.find((capability) => capability.stable_id === "NOTES")!;
  assert.deepEqual(notes.stories[0]!.shows, [
    { relation: "shows", provenance: "authored", target: { kind: "screen", key: "notes-list" } },
  ]);
  // Sorted by target regardless of authored order.
  assert.deepEqual(
    notes.stories[0]!.acceptance_criteria[0]!.shows?.map((link) => link.target.key),
    ["notes-list-empty", "notes-share-denied"]
  );
  assert.equal("shows" in notes.stories[0]!.acceptance_criteria[1]!, false);
  assert.deepEqual(
    first.manifest.screen_catalogs?.map((catalog) => [catalog.capability, catalog.input.path, catalog.screens.map((screen) => screen.stable_id)]),
    [
      ["NOTES", ".tieline/screens/NOTES.yaml", ["note-saved-toast", "notes-list", "notes-list-empty"]],
      ["SHARING", ".tieline/screens/SHARING.yaml", ["notes-share-denied"]],
    ]
  );
  const list = first.manifest.screen_catalogs![0]!.screens[1]!;
  assert.deepEqual(
    { ...list, contract_hash: "<hash>" },
    {
      stable_id: "notes-list",
      title: "Notes list",
      group: "Browsing",
      route: "/notes",
      kind: "page",
      when: "A member opens Notes.",
      applies_to: { role: ["member", "admin"] },
      copy: ["Your notes"],
      image: { path: "notes/notes-list.png" },
      contract_hash: "<hash>",
    }
  );
  assert.match(list.contract_hash, /^[a-f0-9]{64}$/);
});

await test("fails validation for unknown, duplicate, and disabled-feature shows links", () => {
  const unknown = workspace({ screens: ENABLED, notes: { criterionShows: ["missing-screen"] }, catalog: CATALOG });
  assert.deepEqual(validationIssues(() => loadAcceptedContractWithSources(unknown.root, ".tieline/spec")), [
    ".tieline/spec/notes.yaml: 'NOTES-001-AC1' shows unknown screen 'missing-screen'",
  ]);
  assert.throws(() => compile(unknown), /shows unknown screen 'missing-screen'/);

  const duplicate = workspace({ screens: ENABLED, notes: { storyShows: ["notes-list", "notes-list"] }, catalog: CATALOG });
  assert.deepEqual(validationIssues(() => loadAcceptedContractWithSources(duplicate.root, ".tieline/spec")), [
    ".tieline/spec/notes.yaml: 'NOTES-001' declares the same 'shows' link target with provenance 'authored' more than once",
  ]);

  // With the feature off a shows link stays an error, as it was before
  // screens existed, but now says how to opt in.
  const disabled = workspace({ notes: { storyShows: ["notes-list"] }, catalog: CATALOG });
  assert.deepEqual(validationIssues(() => loadAcceptedContractWithSources(disabled.root, ".tieline/spec")), [
    `.tieline/spec/notes.yaml: 'NOTES-001' shows screen 'notes-list', but screens are not enabled for this repository; add "screens": { "enabled": true } to .tieline/config.json`,
  ]);
});

await test("reports an invalid catalog file once instead of once per link into it", () => {
  const ws = workspace({
    screens: ENABLED,
    notes: { storyShows: ["notes-list"], criterionShows: ["notes-list-empty"] },
    catalog: { ".tieline/screens/NOTES.yaml": NOTES_CATALOG_YAML.replace("kind: toast", "kind: snackbar") },
  });
  const issues = validationIssues(() => loadAcceptedContractWithSources(ws.root, ".tieline/spec"));
  assert.equal(issues.length, 1);
  assert.match(issues[0]!, /^\.tieline\/screens\/NOTES\.yaml at screens\.2\.kind: Invalid enum value/);
});

await test("reports catalog read failures beside contract issues", () => {
  const ws = workspace({ screens: ENABLED, notes: { storyShows: ["nope"] } });
  ws.write(".tieline/screens/NOTES.yaml", "version: 1\ncapability: [unclosed\n");
  const issues = validationIssues(() => loadAcceptedContractWithSources(ws.root, ".tieline/spec"));
  assert.match(issues[0]!, /^\.tieline\/screens\/NOTES\.yaml: invalid YAML/);
  assert.match(issues[1]!, /'NOTES-001' shows unknown screen 'nope'/);
});

console.log("screens: manifest");

await test("round-trips screens through the manifest directory and git snapshots", () => {
  const ws = workspace({ screens: ENABLED, notes: { storyShows: ["notes-list"] }, catalog: CATALOG });
  const compiled = compile(ws);
  const directory = resolve(ws.root, ".tieline/manifest");
  const written = writeContractManifest(directory, compiled);
  assert.deepEqual(written.files, ["index.json", "NOTES.json", "SHARING.json"]);
  const shard = JSON.parse(readFileSync(resolve(directory, "NOTES.json"), "utf8"));
  assert.deepEqual(Object.keys(shard), ["capability", "input", "screen_catalog"]);
  const reread = readContractManifest(directory);
  assert.equal(serializeContractManifest(reread), serializeContractManifest(compiled.manifest));
  const snapshot = parseContractManifestSnapshot(
    readdirSync(directory).map((name) => ({ name, content: readFileSync(resolve(directory, name), "utf8") })),
    "ref 'main'"
  );
  assert.equal(serializeContractManifest(snapshot), serializeContractManifest(compiled.manifest));

  // One canonical form: an empty shows list is never written, so reading one is refused.
  const notes = JSON.parse(readFileSync(resolve(directory, "NOTES.json"), "utf8"));
  notes.capability.stories[0].acceptance_criteria[0].shows = [];
  writeFileSync(resolve(directory, "NOTES.json"), `${JSON.stringify(notes)}\n`);
  assert.throws(() => readContractManifest(directory), /shows: Array must contain at least 1/);

  // A screen key claimed by two capability files is refused.
  writeContractManifest(directory, compiled);
  const sharing = JSON.parse(readFileSync(resolve(directory, "SHARING.json"), "utf8"));
  sharing.screen_catalog.screens.push(JSON.parse(readFileSync(resolve(directory, "NOTES.json"), "utf8")).screen_catalog.screens[1]);
  writeFileSync(resolve(directory, "SHARING.json"), `${JSON.stringify(sharing)}\n`);
  assert.throws(() => readContractManifest(directory), /duplicate screen key 'notes-list'/);
});

await test("keeps contract hashes independent of shows links", () => {
  const withLinks = workspace({ screens: ENABLED, notes: { storyShows: ["notes-list"], criterionShows: ["notes-list"] }, catalog: CATALOG });
  const without = workspace({});
  const hashes = (manifest: ReturnType<typeof compileContractManifest>) =>
    manifest.capabilities.flatMap((capability) => [
      capability.contract_hash,
      ...capability.stories.flatMap((story) => [
        story.contract_hash,
        ...story.acceptance_criteria.map((criterion) => criterion.contract_hash),
      ]),
    ]);
  assert.deepEqual(hashes(compile(withLinks).manifest), hashes(compile(without).manifest));
});

console.log("screens: sync");

await test("strips screens for sync down to exactly the pre-screens manifest", () => {
  const enabled = workspace({
    screens: ENABLED,
    notes: { storyShows: ["notes-list"], criterionShows: ["notes-list-empty", "notes-share-denied"] },
    catalog: CATALOG,
  });
  const disabled = workspace({});
  const { manifest, skipped } = manifestWithoutScreens(compile(enabled).manifest);
  const expected = compile(disabled).manifest;
  assert.deepEqual(skipped, { screens: 4, shows_links: 3 });
  // The spec files differ only by their shows links, so their source hashes
  // differ; every synced record is otherwise identical.
  const paths = (inputs: typeof expected.inputs) => inputs.map((input) => input.path);
  assert.deepEqual(paths(manifest.inputs), paths(expected.inputs));
  assert.deepEqual({ ...manifest, inputs: [] }, { ...expected, inputs: [] });
  assert.equal("screen_catalogs" in manifest, false);
  const unchanged = manifestWithoutScreens(compile(disabled).manifest);
  assert.deepEqual(unchanged.skipped, { screens: 0, shows_links: 0 });
});

console.log("screens: disabled feature changes nothing");

await test("ignores a catalog directory entirely while the feature is off", async () => {
  const plain = workspace({ git: true });
  // Even an invalid catalog is never read while screens are off.
  const withCatalog = workspace({
    git: true,
    catalog: { ...CATALOG, ".tieline/screens/BROKEN.yaml": "version: 2\nscreens: nope\n" },
  });
  const capture = captureIO();
  const outputs: Record<string, string[]> = { plain: [], withCatalog: [] };
  for (const [name, ws] of [["plain", plain], ["withCatalog", withCatalog]] as const) {
    for (const args of [
      ["contract", "validate", ws.root, "--json"],
      ["contract", "compile", ws.root, "--json"],
      ["contract", "review", ws.root, "--json"],
    ]) {
      capture.reset();
      assert.equal(await runCli(args, capture.io, {}), 0);
      outputs[name]!.push(capture.output().replaceAll(ws.root, "<root>"));
    }
    outputs[name]!.push(readFileSync(resolve(ws.root, ".tieline/review.html"), "utf8"));
    for (const file of readdirSync(resolve(ws.root, ".tieline/manifest")).sort()) {
      outputs[name]!.push(file, readFileSync(resolve(ws.root, ".tieline/manifest", file), "utf8"));
    }
    ws.commit("baseline");
    ws.write("src/notes.ts", "export const notes: string[] = ['changed'];\n");
    capture.reset();
    const exit = await runCheckCommand({ base: "HEAD", repository: ws.root, json: true }, capture.io);
    const check = JSON.parse(capture.output().replaceAll(ws.root, "<root>"));
    assert.equal("screens" in check, false);
    // Each workspace is its own repository, so the commit compared from
    // legitimately differs; everything else must match.
    assert.match(check.base_commit, /^[a-f0-9]{40}$/);
    delete check.base_commit;
    outputs[name]!.push(String(exit), JSON.stringify(check));
  }
  assert.deepEqual(outputs.withCatalog, outputs.plain);
  const [validate, compiled, review, page] = outputs.plain;
  assert.equal("screens" in JSON.parse(validate!), false);
  assert.equal("screens" in JSON.parse(compiled!), false);
  assert.equal("screens" in JSON.parse(review!), false);
  for (const marker of ["screen-data", "view-tabs", "data-open-screen", "screens-view", "Screens"]) {
    assert.equal(page!.includes(marker), false, marker);
  }
  assert.equal(compiled!.includes("screen_catalog"), false);
});

console.log("screens: check");

await test("fails check on committed shows links whose screen left the catalog", async () => {
  const ws = workspace({ git: true, screens: ENABLED, notes: { storyShows: ["notes-list"], criterionShows: ["note-saved-toast"] }, catalog: CATALOG });
  const capture = captureIO();
  assert.equal(await runCli(["contract", "compile", ws.root], capture.io, {}), 0);
  ws.commit("baseline");

  capture.reset();
  assert.equal(await runCheckCommand({ base: "HEAD", repository: ws.root, json: true }, capture.io), 0);
  const healthy = JSON.parse(capture.output());
  assert.deepEqual(healthy.screens, {
    status: "evaluated",
    catalog_path: ".tieline/screens",
    catalog_screens: 4,
    shows_links: 2,
    broken_links: [],
    catalog_issues: [],
  });
  assert.equal(healthy.exit_reason, "ok");

  ws.write(".tieline/screens/NOTES.yaml", NOTES_CATALOG_YAML.slice(0, NOTES_CATALOG_YAML.indexOf("  - key: note-saved-toast")));
  capture.reset();
  assert.equal(await runCheckCommand({ base: "HEAD", repository: ws.root, json: true }, capture.io), 1);
  const broken = JSON.parse(capture.output());
  assert.equal(broken.exit_reason, "broken_links");
  assert.deepEqual(broken.screens.broken_links, [
    {
      owner_kind: "acceptance_criterion",
      owner_stable_id: "NOTES-001-AC1",
      story_stable_id: "NOTES-001",
      screen_key: "note-saved-toast",
      provenance: "authored",
    },
  ]);
  assert.ok(broken.errors.includes("NOTES-001-AC1 shows screen 'note-saved-toast', but the screen catalog does not contain it."));

  capture.reset();
  assert.equal(
    await runCheckCommand({ base: "HEAD", repository: ws.root, json: true, failOnBroken: false }, capture.io),
    0
  );
  assert.equal(JSON.parse(capture.output()).exit_reason, "broken_links_warn_only");

  capture.reset();
  await runCheckCommand({ base: "HEAD", repository: ws.root }, capture.io);
  assert.match(capture.output(), /broken link\(s\)=0; broken screen link\(s\)=1;/);
});

await test("fails check on working-tree shows links the catalog does not contain", async () => {
  const ws = workspace({ git: true, screens: ENABLED, notes: { storyShows: ["notes-list"] }, catalog: CATALOG });
  const capture = captureIO();
  assert.equal(await runCli(["contract", "compile", ws.root], capture.io, {}), 0);
  ws.commit("baseline");

  // Added: the spec no longer compiles, so the committed manifest never sees the link.
  ws.write(".tieline/spec/notes.yaml", notesSpecYaml({ storyShows: ["notes-list"], criterionShows: ["no-such-screen"] }));
  capture.reset();
  assert.equal(await runCheckCommand({ base: "HEAD", repository: ws.root, json: true }, capture.io), 1);
  const added = JSON.parse(capture.output());
  assert.match(added.manifest_compile_error, /'NOTES-001-AC1' shows unknown screen 'no-such-screen'/);
  assert.equal(added.exit_reason, "broken_links");
  assert.equal(added.screens.status, "evaluated");
  assert.equal(added.screens.shows_links, 2);
  assert.deepEqual(added.screens.broken_links, [
    {
      owner_kind: "acceptance_criterion",
      owner_stable_id: "NOTES-001-AC1",
      story_stable_id: "NOTES-001",
      screen_key: "no-such-screen",
      provenance: "authored",
    },
  ]);
  assert.ok(added.errors.includes("NOTES-001-AC1 shows screen 'no-such-screen', but the screen catalog does not contain it."));

  // Retargeted: the committed link still resolves, the working-tree one does not.
  ws.write(".tieline/spec/notes.yaml", notesSpecYaml({ storyShows: ["notes-lists"] }));
  capture.reset();
  assert.equal(await runCheckCommand({ base: "HEAD", repository: ws.root, json: true }, capture.io), 1);
  const retargeted = JSON.parse(capture.output());
  assert.equal(retargeted.exit_reason, "broken_links");
  assert.deepEqual(
    retargeted.screens.broken_links.map((link: { owner_stable_id: string; screen_key: string }) => [link.owner_stable_id, link.screen_key]),
    [["NOTES-001", "notes-lists"]]
  );

  // A working-tree link to a screen that exists is not broken; the manifest is only stale.
  ws.write(".tieline/spec/notes.yaml", notesSpecYaml({ storyShows: ["notes-list"], criterionShows: ["note-saved-toast"] }));
  capture.reset();
  assert.equal(
    await runCheckCommand({ base: "HEAD", repository: ws.root, json: true, failOnStaleManifest: false }, capture.io),
    0
  );
  const valid = JSON.parse(capture.output());
  assert.equal(valid.exit_reason, "stale_manifest_warn_only");
  assert.equal(valid.screens.shows_links, 2);
  assert.deepEqual(valid.screens.broken_links, []);
});

await test("matches working-tree shows keys the way the schema normalizes them", async () => {
  // The schema trims authored keys, so this is the manifest's 'notes-list' link.
  const ws = workspace({ git: true, screens: ENABLED, notes: { storyShows: ['" notes-list "'] }, catalog: CATALOG });
  const capture = captureIO();
  assert.equal(await runCli(["contract", "compile", ws.root], capture.io, {}), 0);
  ws.commit("baseline");
  capture.reset();
  assert.equal(await runCheckCommand({ base: "HEAD", repository: ws.root, json: true }, capture.io), 0);
  const result = JSON.parse(capture.output());
  assert.equal(result.manifest_current, true);
  assert.equal(result.exit_reason, "ok");
  assert.equal(result.screens.shows_links, 1);
  assert.deepEqual(result.screens.broken_links, []);
});

await test("fails check when the working-tree catalog does not validate", async () => {
  const ws = workspace({ git: true, screens: ENABLED, notes: { storyShows: ["notes-list"] }, catalog: CATALOG });
  const capture = captureIO();
  assert.equal(await runCli(["contract", "compile", ws.root], capture.io, {}), 0);
  ws.commit("baseline");
  ws.write(".tieline/screens/SHARING.yaml", SHARING_CATALOG_YAML.replace("kind: inline-error", "kind: banner"));
  capture.reset();
  assert.equal(
    await runCheckCommand({ base: "HEAD", repository: ws.root, json: true, failOnBroken: false }, capture.io),
    1
  );
  const result = JSON.parse(capture.output());
  assert.equal(result.exit_reason, "invalid_screen_catalog");
  assert.equal(result.screens.status, "catalog_invalid");
  assert.deepEqual(result.screens.broken_links, []);
  assert.match(result.errors.find((error: string) => error.startsWith("Screen catalog:")), /SHARING\.yaml at screens\.0\.kind/);
  capture.reset();
  await runCheckCommand({ base: "HEAD", repository: ws.root }, capture.io);
  assert.match(capture.output(), /screen catalog=invalid/);
  assert.match(capture.output(), /An invalid screen catalog fails this check/);
});

await test("fails check when a catalog names a capability the spec does not declare", async () => {
  const ws = workspace({ git: true, screens: ENABLED, catalog: CATALOG });
  const capture = captureIO();
  assert.equal(await runCli(["contract", "compile", ws.root], capture.io, {}), 0);
  ws.commit("baseline");
  ws.write(".tieline/screens/BILLING.yaml", "version: 1\ncapability: BILLING\nscreens: []\n");
  capture.reset();
  assert.equal(await runCheckCommand({ base: "HEAD", repository: ws.root, json: true }, capture.io), 1);
  const result = JSON.parse(capture.output());
  assert.equal(result.exit_reason, "invalid_screen_catalog");
  assert.deepEqual(result.screens.catalog_issues, [
    ".tieline/screens/BILLING.yaml: screen catalog names unknown capability 'BILLING'",
  ]);
});

await test("fails check when an unparseable spec leaves catalog capabilities unconfirmed", async () => {
  const ws = workspace({ git: true, screens: ENABLED, catalog: CATALOG });
  const capture = captureIO();
  assert.equal(await runCli(["contract", "compile", ws.root], capture.io, {}), 0);
  ws.commit("baseline");
  ws.write(".tieline/spec/sharing.yaml", "version: 1\ncapability: [unclosed\n");
  ws.write(".tieline/screens/BILLING.yaml", "version: 1\ncapability: BILLING\nscreens: []\n");
  capture.reset();
  assert.equal(await runCheckCommand({ base: "HEAD", repository: ws.root, json: true }, capture.io), 1);
  const result = JSON.parse(capture.output());
  assert.equal(result.exit_reason, "invalid_screen_catalog");
  assert.match(
    result.screens.catalog_issues[0],
    /^cannot confirm screen catalog capabilities because the spec does not parse: \.tieline\/spec\/sharing\.yaml: invalid YAML/
  );
});

await test("fails check when screens are disabled but the manifest still records them", async () => {
  const ws = workspace({ git: true, screens: ENABLED, notes: { storyShows: ["notes-list"] }, catalog: CATALOG });
  const capture = captureIO();
  assert.equal(await runCli(["contract", "compile", ws.root], capture.io, {}), 0);
  ws.commit("baseline");
  ws.write(".tieline/config.json", screensConfigJson({ enabled: false }));
  capture.reset();
  assert.equal(await runCheckCommand({ base: "HEAD", repository: ws.root, json: true }, capture.io), 1);
  const result = JSON.parse(capture.output());
  assert.equal(result.exit_reason, "invalid_screen_catalog");
  assert.equal(result.screens.status, "disabled_with_screen_data");
  assert.equal(result.screens.catalog_path, null);
  assert.match(
    result.screens.catalog_issues[0],
    /records 4 screen\(s\) and 1 shows link\(s\), but screens are not enabled/
  );
});

await test("reports screen counts from validate and compile when enabled", async () => {
  const ws = workspace({ screens: ENABLED, catalog: CATALOG });
  const capture = captureIO();
  assert.equal(await runCli(["contract", "validate", ws.root, "--json"], capture.io, {}), 0);
  assert.equal(JSON.parse(capture.output()).screens, 4);
  capture.reset();
  assert.equal(await runCli(["contract", "validate", ws.root], capture.io, {}), 0);
  assert.match(capture.output(), /Contract valid: 2 Stories, 3 acceptance criteria, 4 screens, 0 warning\(s\)\./);
  capture.reset();
  assert.equal(await runCli(["contract", "compile", ws.root, "--json"], capture.io, {}), 0);
  assert.equal(JSON.parse(capture.output()).screens, 4);
});

console.log("screens: exact context reads");

await test("answers AC and asset context the same from a manifest that carries screens", async () => {
  const enabled = workspace({ screens: ENABLED, notes: { storyShows: ["notes-list"], criterionShows: ["notes-list"] }, catalog: CATALOG });
  const disabled = workspace({});
  const answers: unknown[] = [];
  for (const ws of [enabled, disabled]) {
    const capture = captureIO();
    assert.equal(await runCli(["contract", "compile", ws.root], capture.io, {}), 0);
    const read = async (args: string[]) => {
      capture.reset();
      assert.equal(await runCli([...args, "--repository", ws.root, "--json"], capture.io, {}), 0);
      const result = JSON.parse(capture.output()) as Record<string, unknown>;
      // The digest identifies the reviewed manifest, which legitimately
      // differs once it carries screens; the answer itself must not.
      delete result.manifest_digest;
      return result;
    };
    answers.push([
      await read(["contract", "context", "--ac", "NOTES-001-AC1"]),
      await read(["contract", "context", "--path", "src/notes.ts", "--kind", "code"]),
      await read(["contract", "criteria", "src/notes.ts"]),
    ]);
  }
  assert.deepEqual(answers[0], answers[1]);
});

for (const created of workspaces) created.cleanup();
report();
