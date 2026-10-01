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
