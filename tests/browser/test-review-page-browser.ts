/**
 * Opt-in browser test for the review page: `npm run test:review:browser`.
 *
 * It renders review pages from source and drives them in Chromium with every
 * http(s) request refused, so it needs a browser (`npx playwright install
 * chromium`) but no app or server, and like the capture browser test it is
 * not part of `npm run check`. It proves what string assertions cannot: that
 * a change tag stays visible at every zoom, that a thumbnail says why it shows
 * no image, that the Changed toggles, j/k, criterion links, and Expand all
 * work, that the narrow-screen navigation opens and closes as a sheet, and
 * that printing shows every scenario.
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { loadAcceptedContractWithSources } from "../../src/contract/load.js";
import { compileContractManifest } from "../../src/contract/manifest.js";
import { renderContractReviewPage } from "../../src/contract/review-page.js";
import { diffReviewManifests } from "../../src/contract/review-changes.js";
import { writeWorkspaceReviewPage } from "../../src/tieline/review.js";
import { report, test } from "../support/harness.js";
import {
  createScreensWorkspace,
  NOTES_CATALOG_YAML,
  REPO_KEY,
  SHARING_CATALOG_YAML,
  showsLink,
} from "../support/screen-fixtures.js";

/** NOTES with scenarios, and a third criterion the branch removes. */
function notesSpec(secondCriterion: string, withThird: boolean): string {
  return `version: 1
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
${showsLink("notes-list", "        ")}
      acceptance_criteria:
        - key: NOTES-001-AC1
          criterion: The notes list must show the member's notes, newest first.
          scenarios:
            - given: a member with two notes
              when: they open Notes
              then: the newer note must be listed first
          links:
${showsLink("notes-list", "            ")}
        - key: NOTES-001-AC2
          criterion: ${secondCriterion}
          scenarios:
            - given: a member without notes
              when: they open Notes
              then: an invitation to write a note must be shown
${
  withThird
    ? `        - key: NOTES-001-AC3
          criterion: The notes list must show how many notes a member has.
`
    : ""
}`;
}

/** The toast is deliberately not captured; the list records the test that captures it. */
const NOTES_CATALOG = NOTES_CATALOG_YAML.replace(
  "    kind: toast\n",
  "    kind: toast\n    not_captured:\n      reason: flag-off\n      detail: Behind the saved-toast flag.\n"
).replace(
  "    image:\n      path: notes/notes-list.png\n",
  `    image:\n      path: notes/notes-list.png\n      sha256: ${"a".repeat(64)}\n    capture:\n      fingerprint: ${"b".repeat(64)}\n      text_sha256: ${"c".repeat(64)}\n      test: e2e/notes.screens.ts\n`
);
const ws = createScreensWorkspace({
  screens: { enabled: true },
  catalog: {
    ".tieline/screens/NOTES.yaml": NOTES_CATALOG,
    ".tieline/screens/SHARING.yaml": SHARING_CATALOG_YAML,
  },
});
ws.write(".tieline/spec/notes.yaml", notesSpec("The notes list must invite a member without notes to write one.", true));
const compile = () =>
  compileContractManifest({ repositoryRoot: ws.root, repositoryKey: REPO_KEY, specDirectory: ".tieline/spec" });
const base = compile();
ws.write(
  ".tieline/spec/notes.yaml",
  notesSpec("The notes list must invite a member without notes to write their first one.", false)
);
ws.write(".tieline/screens/NOTES.yaml", NOTES_CATALOG.replace("title: Notes list\n", "title: All notes\n"));
const pagePath = resolve(ws.root, ".tieline/review.html");
writeWorkspaceReviewPage(ws.root, REPO_KEY, ".tieline/spec", pagePath, {
  changes: diffReviewManifests(base, compile(), "origin/main"),
});
const pageUrl = pathToFileURL(pagePath).href;

/** A catalog at contact-sheet scale, in 14 groups, none of whose images exist. */
const LARGE_SCREENS = 1_100;
const loaded = loadAcceptedContractWithSources(ws.root, ".tieline/spec");
const notesFile = loaded.screens!.files.find((file) => file.document.capability === "NOTES")!;
const largeCatalog = {
  ...loaded.screens!,
  files: [{
    ...notesFile,
    document: {
      ...notesFile.document,
      screens: Array.from({ length: LARGE_SCREENS }, (_, index) => ({
        key: `screen-${index}`,
        title: `Synthetic screen ${index}`,
        group: `Group ${index % 14}`,
        route: `/area/${index}`,
        kind: "page" as const,
        when: "A member reaches this synthetic state.",
        image: { path: `area/${index}.png` },
      })),
    },
  }],
};
const largePagePath = resolve(ws.root, ".tieline/large.html");
writeFileSync(
  largePagePath,
  renderContractReviewPage({
    repositoryKey: REPO_KEY,
    documents: loaded.documents.map((document, index) => ({ path: loaded.sources[index]!.path, document })),
    screens: { catalog: largeCatalog, capturesUrl: "captures/" },
  })
);
const largePageUrl = pathToFileURL(largePagePath).href;

const browser: Browser = await chromium.launch();

async function open(
  hash = "",
  viewport = { width: 1280, height: 800 },
  options: { url?: string; layout?: "canvas" } = {}
): Promise<Page> {
  const context = await browser.newContext({ viewport });
  // Images given by URL are refused; images by path are missing from disk.
  await context.route(/^https?:/, (route) => route.abort());
  if (options.layout) {
    await context.addInitScript({ content: `localStorage.setItem("tieline:screens-layout", "${options.layout}")` });
  }
  const page = await context.newPage();
  await page.goto((options.url ?? pageUrl) + hash);
  return page;
}

type Box = { x: number; y: number; width: number; height: number };

function inside(box: Box, frame: Box): boolean {
  return box.x >= frame.x - 0.5 && box.y >= frame.y - 0.5 &&
    box.x + box.width <= frame.x + frame.width + 0.5 && box.y + box.height <= frame.y + frame.height + 0.5;
}

function overlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function currentStory(page: Page): Promise<string | null> {
  return page.getAttribute('[data-story-link][aria-current="page"]', "data-story-key");
}

console.log("review page in a real browser");

try {
  await test("marks what a branch changed on the Story and filters the navigation to it", async () => {
    const page = await open();
    assert.equal(await currentStory(page), "NOTES-001");
    assert.equal(await page.textContent(".issue-header .change-badge"), "Changed");
    assert.equal(await page.textContent(".changed-count"), "· 2 changed");
    // Scenarios open only where the criterion changed.
    assert.equal(await page.locator("#NOTES-001-AC2[data-change='changed'] details.scenarios").getAttribute("open"), "");
    assert.equal(await page.locator("#NOTES-001-AC1 details.scenarios").getAttribute("open"), null);
    // The removed criterion stays on its Story, struck through.
    const removed = page.locator(".criterion-removed");
    assert.match((await removed.textContent()) ?? "", /NOTES-001-AC3[\s\S]*Removed[\s\S]*how many notes/);
    // Evaluated as source: this project type-checks without the DOM library.
    const decoration = await page.evaluate(
      "getComputedStyle(document.querySelector('.criterion-removed .criterion-text')).textDecorationLine"
    );
    assert.match(String(decoration), /line-through/);

    const toggle = page.locator("#story-change-toggle");
    assert.equal((await toggle.textContent())?.replace(/\s+/g, " "), "Changed 1");
    const sharing = page.locator('[data-nav-item]:has([data-story-key="SHARING-001"])');
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-pressed"), "true");
    assert.equal(await sharing.isHidden(), true);
    await toggle.click();
    assert.equal(await sharing.isVisible(), true);
    await page.context().close();
  });

  await test("moves between Stories with j and k, opens a criterion's Story from its link, and expands everything", async () => {
    const page = await open();
    await page.keyboard.press("j");
    assert.equal(await currentStory(page), "SHARING-001");
    assert.equal(new URL(page.url()).hash, "#SHARING-001");
    await page.keyboard.press("j");
    assert.equal(await currentStory(page), "SHARING-001", "j stops at the last Story");
    await page.keyboard.press("k");
    assert.equal(await currentStory(page), "NOTES-001");
    // Typing in search never moves between Stories.
    await page.focus("#search");
    await page.keyboard.type("j");
    assert.equal(await currentStory(page), "NOTES-001");
    await page.context().close();

    const linked = await open("#SHARING-001-AC1");
    assert.equal(await currentStory(linked), "SHARING-001");
    assert.equal(await linked.locator("#story-content #SHARING-001-AC1").count(), 1);
    await linked.context().close();

    const short = await open("#NOTES-001-AC2", { width: 1280, height: 360 });
    assert.equal(await currentStory(short), "NOTES-001");
    assert.ok(Number(await short.evaluate("window.scrollY")) > 0, "the criterion is scrolled to");
    const expand = short.locator("[data-expand-all]");
    await expand.click();
    assert.equal(await short.locator("#story-content details:not([open])").count(), 0);
    assert.equal(await short.locator("#story-content details[open]").count(), 2);
    assert.equal(await expand.textContent(), "Collapse all");
    await expand.click();
    assert.equal(await short.locator("#story-content details[open]").count(), 0);
    await short.context().close();
  });

  await test("keeps change tags visible at every zoom and says why a thumbnail has no image", async () => {
    const page = await open("#view/screens");
    const list = page.locator('.screen-card[data-key="notes-list"]');
    for (const key of ["-", "+", "+", "+"]) {
      await page.keyboard.press(key);
      assert.equal(await list.locator(".shot > .change-badge").isVisible(), true, `zoom ${await page.inputValue("#screen-zoom")}`);
    }
    assert.equal(await list.locator(".shot > .change-badge").textContent(), "Changed");
    // An image that fails to load says so instead of showing an empty frame.
    await list.locator('.shot[data-state="failed"]').waitFor();
    assert.equal(await list.locator(".shot i").textContent(), "Image unavailable");
    const toast = page.locator('.screen-card[data-key="note-saved-toast"] .shot');
    assert.equal(await toast.getAttribute("data-state"), "not-captured");
    assert.equal(await toast.locator("i").textContent(), "Not capturedflag-off");
    const empty = page.locator('.screen-card[data-key="notes-list-empty"] .shot');
    assert.equal(await empty.getAttribute("data-state"), "none");
    assert.equal(await empty.locator("i").textContent(), "No capture");
    await page.context().close();
  });

  await test("filters the Screens view to what changed and opens the first screen from the keyboard", async () => {
    const page = await open("#view/screens");
    assert.equal(await page.textContent("#screen-visible-count"), "");
    assert.equal(await page.locator("#screen-clear-filters").isHidden(), true);
    const toggle = page.locator("#screen-change-toggle");
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator(".screen-card:visible").count(), 1);
    assert.equal(await page.textContent("#screen-visible-count"), "Showing 1 of 4 screens");
    assert.equal(await page.textContent("#screen-filter-count"), "· 1 active");
    await page.click(".screen-filters summary");
    await page.click("#screen-clear-filters");
    assert.equal(await toggle.getAttribute("aria-pressed"), "false");
    assert.equal(await page.locator(".screen-card:visible").count(), 4);

    await page.keyboard.press("j");
    assert.equal(await page.locator("#screen-detail").isVisible(), true);
    assert.equal(await page.textContent("#screen-detail-title"), "All notes");
    assert.equal(await page.textContent("#screen-detail-position"), "1 of 4");
    await page.context().close();
  });

  await test("lays every screen out on a canvas that fits, zooms, pans, and is remembered", async () => {
    const page = await open("#view/screens");
    await page.click('[data-layout-choice="canvas"]');
    assert.equal(await page.getAttribute("#screens-map", "data-layout"), "canvas");
    assert.equal(await page.locator("#canvas-tools").isVisible(), true);
    assert.equal(await page.locator("#screen-zoom").isHidden(), true);
    // Fitted: every card is inside the frame, and no two sections overlap.
    const frame = (await page.locator("#screens-map").boundingBox())!;
    for (const card of await page.locator(".screen-card").all()) {
      assert.ok(inside((await card.boundingBox())!, frame), await card.getAttribute("data-key") ?? "");
    }
    const sections = await Promise.all((await page.locator(".screen-section").all()).map(async (section) => (await section.boundingBox())!));
    assert.equal(sections.length, 2);
    assert.equal(overlap(sections[0]!, sections[1]!), false);
    const fitted = await page.textContent("#canvas-scale");
    await page.keyboard.press("-");
    assert.notEqual(await page.textContent("#canvas-scale"), fitted);
    await page.keyboard.press("0");
    assert.equal(await page.textContent("#canvas-scale"), fitted);

    // Dragging the empty canvas pans and opens nothing; a click still opens a card.
    const before = await page.getAttribute("#screens-board", "style");
    await page.mouse.move(frame.x + 6, frame.y + 6);
    await page.mouse.down();
    await page.mouse.move(frame.x + 106, frame.y + 56, { steps: 5 });
    await page.mouse.up();
    assert.notEqual(await page.getAttribute("#screens-board", "style"), before);
    assert.equal(await page.locator("#screen-detail").isHidden(), true);
    await page.keyboard.press("0");
    await page.click('.screen-card[data-key="notes-list"]');
    assert.equal(await page.textContent("#screen-detail-title"), "All notes");
    assert.match((await page.textContent("#screen-detail-meta")) ?? "", /Captured bye2e\/notes\.screens\.ts/);
    await page.keyboard.press("Escape");

    // A filter lays the canvas out again around what matches.
    await page.click(".screen-filters summary");
    await page.selectOption("#screen-capture-filter", "not-captured");
    const matches = page.locator(".screen-card:visible");
    assert.equal(await matches.count(), 1);
    assert.equal(await matches.getAttribute("data-key"), "note-saved-toast");
    assert.ok(inside((await matches.boundingBox())!, frame));

    // The choice outlasts a reload, and the grid comes back as it was.
    await page.reload();
    assert.equal(await page.getAttribute("#screens-map", "data-layout"), "canvas");
    await page.click('[data-layout-choice="grid"]');
    assert.equal(await page.getAttribute("#screens-map", "data-layout"), "grid");
    assert.equal(await page.getAttribute("#screens-board", "style"), null);
    assert.equal(await page.locator("#screen-zoom").isVisible(), true);
    await page.context().close();

    // A narrow screen always gets the grid.
    const narrow = await open("#view/screens", { width: 390, height: 844 }, { layout: "canvas" });
    assert.equal(await narrow.getAttribute("#screens-map", "data-layout"), "grid");
    assert.equal(await narrow.locator(".layout-switch").isHidden(), true);
    await narrow.context().close();
  });

  await test("requests no image while the canvas is zoomed out too far to see one", async () => {
    const page = await open("#view/screens", { width: 1280, height: 800 }, { url: largePageUrl, layout: "canvas" });
    const pending = page.locator("#screens-board img[data-src]");
    assert.ok(Number.parseInt((await page.textContent("#canvas-scale")) ?? "", 10) < 15);
    assert.equal(await pending.count(), LARGE_SCREENS);
    // Zooming to one group brings its images in, and only those near it.
    await page.click('[data-outline-section="NOTES"][data-outline-group="3"]');
    await page.waitForFunction(
      `document.querySelectorAll("#screens-board img[data-src]").length < ${LARGE_SCREENS}`
    );
    assert.ok((await pending.count()) > LARGE_SCREENS / 2, "images far from view stay deferred");
    await page.context().close();
  });

  await test("opens the navigation as a sheet on a narrow screen and closes it on choosing a Story", async () => {
    const page = await open("", { width: 390, height: 844 });
    const search = page.locator("#search");
    const browse = page.locator("#nav-open");
    assert.equal(await search.isHidden(), true);
    await browse.click();
    assert.equal(await browse.getAttribute("aria-expanded"), "true");
    assert.equal(await browse.textContent(), "Close");
    assert.equal(await search.isVisible(), true);
    await page.click('[data-story-key="SHARING-001"]');
    assert.equal(await page.getAttribute(".wiki-shell", "data-nav-open"), null);
    assert.equal(await browse.getAttribute("aria-expanded"), "false");
    assert.equal(await search.isHidden(), true);
    assert.equal(await page.textContent("#story-content h1"), "Share a note");
    await page.context().close();
  });

  await test("prints every scenario, open or not", async () => {
    const page = await open();
    await page.emulateMedia({ media: "print" });
    const scenarios = page.locator("#story-content .scenario");
    assert.equal(await scenarios.count(), 2);
    for (const scenario of await scenarios.all()) assert.equal(await scenario.isVisible(), true);
    // On screen, the unchanged criterion's scenarios stay folded.
    await page.emulateMedia({ media: "screen" });
    assert.equal(await page.locator("#NOTES-001-AC1 .scenario").isHidden(), true);
    await page.context().close();
  });
} finally {
  await browser.close();
  ws.cleanup();
}
report();
