import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Script } from "node:vm";
import { loadAcceptedContractWithSources } from "../../../src/contract/load.js";
import { renderContractReviewPage } from "../../../src/contract/review-page.js";
import { buildScreenReviewModel } from "../../../src/contract/screen-review-page.js";
import { writeWorkspaceReviewPage } from "../../../src/tieline/review.js";
import { report, test } from "../../support/harness.js";
import {
  createScreensWorkspace,
  NOTES_CATALOG_YAML,
  REPO_KEY,
  SHARING_CATALOG_YAML,
  type ScreensWorkspace,
} from "../../support/screen-fixtures.js";

interface EmbeddedScreen {
  key: string;
  title: string;
  image: { src: string; label: string } | null;
  shown_by: Array<{ story: string; criterion: string | null }>;
  capture_test: string | null;
}

const workspaces: ScreensWorkspace[] = [];
function workspace(options: Parameters<typeof createScreensWorkspace>[0]): ScreensWorkspace {
  const created = createScreensWorkspace(options);
  workspaces.push(created);
  return created;
}

const CATALOG = {
  ".tieline/screens/NOTES.yaml": NOTES_CATALOG_YAML,
  ".tieline/screens/SHARING.yaml": SHARING_CATALOG_YAML,
};

function embeddedData(page: string): { sections: Array<{ capability: string; groups: Array<{ name: string | null; screens: string[] }> }>; screens: EmbeddedScreen[] } {
  const match = /<script type="application\/json" id="screen-data">([\s\S]*?)<\/script>/.exec(page);
  assert.ok(match, "the page embeds its screen data");
  return JSON.parse(match[1]!);
}

function inlineScripts(page: string): string[] {
  return [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!);
}

console.log("screens review page");

await test("renders the Screens view, linked screens, and coverage from the catalog", () => {
  const ws = workspace({
    screens: { enabled: true },
    notes: { storyShows: ["notes-list"], criterionShows: ["notes-list", "notes-share-denied"] },
    catalog: CATALOG,
  });
  const result = writeWorkspaceReviewPage(ws.root, REPO_KEY, ".tieline/spec");
  assert.deepEqual(result.screens, { screens: 4, unlinked_screens: 2, stories_without_screens: 1 });
  const page = readFileSync(result.path, "utf8");
  const data = embeddedData(page);
  assert.deepEqual(
    data.sections.map((section) => [section.capability, section.groups.map((group) => [group.name, group.screens])]),
    [
      ["NOTES", [["Browsing", ["notes-list", "notes-list-empty"]], [null, ["note-saved-toast"]]]],
      ["SHARING", [["Invitations", ["notes-share-denied"]]]],
    ]
  );
  const byKey = new Map(data.screens.map((screen) => [screen.key, screen]));
  // The page sits in .tieline/, so a path locator resolves beside it.
  assert.deepEqual(byKey.get("notes-list")!.image, {
    src: "captures/notes/notes-list.png",
    label: "notes/notes-list.png",
  });
  assert.deepEqual(byKey.get("notes-share-denied")!.image, {
    src: "https://images.example.test/share-denied.png",
    label: "https://images.example.test/share-denied.png",
  });
  // No locator at all still renders: the card and detail fall back to a placeholder.
  assert.equal(byKey.get("note-saved-toast")!.image, null);
  assert.deepEqual(
    byKey.get("notes-list")!.shown_by.map((link) => [link.story, link.criterion]),
    [["NOTES-001", null], ["NOTES-001", "NOTES-001-AC1"]]
  );
  assert.deepEqual(byKey.get("notes-list-empty")!.shown_by, []);

  assert.match(page, /data-view-tab="screens" aria-selected="false">Screens <span>4<\/span>/);
  assert.match(page, /<b>4<\/b> screens<\/button>/);
  assert.match(page, /<b>2<\/b> shown by Stories/);
  assert.match(page, /<b>2<\/b> with no links/);
  assert.match(page, /<b>1<\/b> of 2 Stories show no screens<\/summary>[\s\S]*data-story-jump="SHARING-001"/);
  assert.match(page, /<input type="checkbox" value="inline-error" data-kind-filter>/);
  assert.match(page, /<select data-dimension-filter="role">[\s\S]*<option value="viewer">viewer<\/option>/);
  // Story and AC documents list their screens; the Story rolls up its ACs.
  const story = /<template id="story-NOTES-001">([\s\S]*?)<\/template>/.exec(page)![1]!;
  assert.match(story, /Screens in this Story <span>2<\/span>/);
  assert.match(story, /<dt>Screens<\/dt>\s*<dd>2<\/dd>/);
  assert.match(story, /id="NOTES-001-AC1"[\s\S]*Screens <span>2<\/span>[\s\S]*data-open-screen="notes-share-denied"/);
  assert.match(story, /<img data-src="captures\/notes\/notes-list.png" alt="">/);
  assert.doesNotMatch(story, / src="captures/, "thumbnails load only when scrolled into view");
  // A Story's thumbnail says whether it has an image to load; a criterion
  // lists its screens as one-line chips with no thumbnail at all.
  assert.match(story, /<span class="chip-shot" data-kind="page" data-state="loading"><img data-src="captures\/notes\/notes-list.png" alt=""><i aria-hidden="true">Page<\/i><\/span>/);
  const criterion = /id="NOTES-001-AC1"[\s\S]*?<\/section>/.exec(story)![0];
  assert.match(criterion, /<div class="shown-screens shown-screens-compact">/);
  assert.match(criterion, /<button type="button" class="screen-chip-text" data-open-screen="notes-share-denied"><b>Sharing not allowed<\/b><small>Inline error<\/small><\/button>/);
  assert.doesNotMatch(criterion, /<img|chip-shot/);
  // Lifecycle is drawn as a shape and named for assistive technology, and
  // no glyph depends on font coverage.
  assert.match(page, /<i class="lifecycle lifecycle-in_progress" role="img" aria-label="In progress" title="In progress"><\/i>/);
  assert.match(story, /<dt>Status<\/dt>\s*<dd><span class="status"><i class="lifecycle lifecycle-production" aria-hidden="true"><\/i>Production<\/span><\/dd>/);
  assert.doesNotMatch(page, /⌕/);
});

await test("offers a canvas layout, a screenshot filter, and the test that captures each screen", () => {
  const ws = workspace({
    screens: { enabled: true },
    catalog: {
      ".tieline/screens/NOTES.yaml": NOTES_CATALOG_YAML.replace(
        "    image:\n      path: notes/notes-list.png\n",
        `    image:\n      path: notes/notes-list.png\n      sha256: ${"a".repeat(64)}\n    capture:\n      fingerprint: ${"b".repeat(64)}\n      text_sha256: ${"c".repeat(64)}\n      test: e2e/notes.screens.ts\n`
      ),
      ".tieline/screens/SHARING.yaml": SHARING_CATALOG_YAML,
    },
  });
  const page = readFileSync(writeWorkspaceReviewPage(ws.root, REPO_KEY, ".tieline/spec").path, "utf8");
  const byKey = new Map(embeddedData(page).screens.map((screen) => [screen.key, screen]));
  assert.equal(byKey.get("notes-list")!.capture_test, "e2e/notes.screens.ts");
  assert.equal(byKey.get("notes-list-empty")!.capture_test, null);
  // The grid stays the default; the canvas is one switch away, and its
  // board and controls are rendered for the script to lay out.
  assert.match(
    page,
    /<button type="button" data-layout-choice="grid" aria-pressed="true">Grid<\/button>\s*<button type="button" data-layout-choice="canvas" aria-pressed="false">Canvas<\/button>/
  );
  assert.match(
    page,
    /<div class="screens-map" id="screens-map" data-layout="grid" aria-label="Screen map">\s*<div class="screens-board" id="screens-board"><\/div>\s*<div class="canvas-tools" id="canvas-tools" hidden>/
  );
  assert.match(page, /<select id="screen-capture-filter">[\s\S]*<option value="not-captured">Not captured, with a reason<\/option>/);
});

await test("embeds catalog text inertly", () => {
  const hostile = '</script><img src=x onerror=alert(1)> & "quotes"';
  const ws = workspace({
    screens: { enabled: true },
    notes: { storyShows: ["notes-list"] },
    catalog: {
      ".tieline/screens/NOTES.yaml": NOTES_CATALOG_YAML.replace(
        "title: Notes list\n",
        `title: ${JSON.stringify(hostile)}\n`
      ).replace("  - Your notes", `  - ${JSON.stringify("Line\u2028separator <!--")}`),
    },
  });
  const page = readFileSync(writeWorkspaceReviewPage(ws.root, REPO_KEY, ".tieline/spec").path, "utf8");
  assert.equal(page.split("</script>").length - 1, inlineScripts(page).length + 1, "no catalog text closes a script element");
  assert.doesNotMatch(page, /<img src=x/);
  assert.match(page, /&lt;\/script&gt;&lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;quotes&quot;/);
  assert.equal(embeddedData(page).screens.find((screen) => screen.key === "notes-list")!.title, hostile);
  assert.match(page, /\\u003c\/script>\\u003cimg/);
  assert.match(page, /\\u2028separator \\u003c!--/);
});

await test("ships syntactically valid scripts", () => {
  const ws = workspace({ screens: { enabled: true }, notes: { storyShows: ["notes-list"] }, catalog: CATALOG });
  const page = readFileSync(writeWorkspaceReviewPage(ws.root, REPO_KEY, ".tieline/spec").path, "utf8");
  const scripts = inlineScripts(page);
  assert.equal(scripts.length, 2);
  for (const script of scripts) assert.doesNotThrow(() => new Script(script));
  assert.doesNotMatch(scripts[1]!, /innerHTML|insertAdjacentHTML|document\.write/);
});

await test("routes the Screens view under a hash no Story key can take", () => {
  // Story keys cannot contain "/", so `#view/screens` cannot be a Story,
  // while a Story keyed `screens` (a valid key) keeps its own `#screens`.
  const ws = workspace({ screens: { enabled: true }, catalog: CATALOG });
  ws.write(".tieline/spec/notes.yaml", readFileSync(resolve(ws.root, ".tieline/spec/notes.yaml"), "utf8").replace("- key: NOTES-001\n", "- key: screens\n").replaceAll("NOTES-001-AC", "screens-AC"));
  const page = readFileSync(writeWorkspaceReviewPage(ws.root, REPO_KEY, ".tieline/spec").path, "utf8");
  assert.match(page, /data-story-key="screens"/);
  // The only links to `#screens` are the Story's own.
  const storyLinks = [...page.matchAll(/<a\b[^>]*href="#screens"[^>]*>/g)].map((match) => match[0]);
  assert.ok(storyLinks.length > 0);
  for (const link of storyLinks) assert.match(link, /data-story-(?:link|jump)/, link);
  assert.match(page, /<a href="#view\/screens" data-outline-section=/);
  const script = inlineScripts(page).find((source) => source.includes("function routeFromHash"))!;
  assert.match(script, /hash === "view\/screens"/);
  assert.match(script, /history\.pushState\(null, "", "#view\/screens"\)/);
  assert.equal(/hash === "screens"|"#screens"/.test(script), false);
});

await test("resolves capture paths relative to a page written elsewhere", () => {
  const ws = workspace({ screens: { enabled: true, captures_directory: "shots dir" }, catalog: CATALOG });
  const result = writeWorkspaceReviewPage(ws.root, REPO_KEY, ".tieline/spec", resolve(ws.root, "out/review.html"));
  const data = embeddedData(readFileSync(result.path, "utf8"));
  assert.equal(
    data.screens.find((screen) => screen.key === "notes-list")!.image!.src,
    "../.tieline/shots%20dir/notes/notes-list.png"
  );
});

await test("explains an enabled but empty catalog and still lists every Story", () => {
  const ws = workspace({ screens: { enabled: true } });
  const result = writeWorkspaceReviewPage(ws.root, REPO_KEY, ".tieline/spec");
  assert.deepEqual(result.screens, { screens: 0, unlinked_screens: 0, stories_without_screens: 2 });
  const page = readFileSync(result.path, "utf8");
  assert.match(page, /<h1>No screens yet<\/h1>/);
  assert.match(page, /tieline screens import &lt;file&gt;/);
  assert.doesNotMatch(page, /id="screens-map"/);
  assert.doesNotMatch(page, /<button type="button" data-layout-choice=/, "no layout to choose without screens");
  assert.match(page, /data-story-key="NOTES-001"/);
});

await test("keeps a large catalog compact and grouped", () => {
  const ws = workspace({ screens: { enabled: true }, catalog: CATALOG });
  const loaded = loadAcceptedContractWithSources(ws.root, ".tieline/spec");
  const notes = loaded.screens!.files.find((file) => file.document.capability === "NOTES")!;
  const entries = Array.from({ length: 1_100 }, (_, index) => ({
    key: `screen-${index}`,
    title: `Synthetic screen ${index}`,
    group: `Group ${index % 14}`,
    route: `/area/${index}`,
    kind: "page" as const,
    when: "A member reaches this synthetic state.",
    image: { path: `area/${index}.png` },
  }));
  const catalog = {
    ...loaded.screens!,
    files: [{ ...notes, document: { ...notes.document, screens: entries } }],
  };
  const page = renderContractReviewPage({
    repositoryKey: REPO_KEY,
    documents: loaded.documents.map((document, index) => ({ path: loaded.sources[index]!.path, document })),
    screens: { catalog, capturesUrl: "captures/" },
  });
  const data = embeddedData(page);
  assert.equal(data.screens.length, 1_100);
  assert.equal(data.sections[0]!.groups.length, 14);
  assert.ok(Buffer.byteLength(page) < 600_000, `page is ${Buffer.byteLength(page)} bytes`);
  assert.equal((page.match(/ src="captures\//g) ?? []).length, 0, "no image is requested before it is visible");
  const model = buildScreenReviewModel(loaded.documents, { catalog, capturesUrl: "captures/" });
  assert.deepEqual(
    { screens: model.coverage.screens, unlinked: model.coverage.unlinked_screens },
    { screens: 1_100, unlinked: 1_100 }
  );
});

for (const created of workspaces) created.cleanup();
report();
