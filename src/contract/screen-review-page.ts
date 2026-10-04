import { escapeHtml, SEARCH_ICON } from "./html.js";
import { renderChangeBadge, type ReviewChangeIndex } from "./review-changes-page.js";
import type { ItemHistory } from "./history.js";
import type { ScreenRecordChange } from "./review-changes.js";
import type { AcceptedContractDocument, Applicability } from "./schema.js";
import type {
  ScreenKind,
  ValidatedScreenCatalog,
} from "./screen-catalog.js";

/**
 * The Screens part of the contract review page.
 *
 * Kept apart from `review-page.ts` so a repository that has not enabled screens
 * renders exactly the page it always did: every fragment here is only called
 * when screens are enabled. The screens view is rendered in the browser from
 * one embedded JSON document, built with `textContent` and attribute setters
 * only, so catalog text can never become markup. It is designed for catalogs of
 * about a thousand screens: cards are grouped by capability and group under
 * labels that stay readable at every zoom level, only images scrolled into view
 * are requested, and search results are listed beside the map.
 */

export interface ContractReviewScreens {
  catalog: ValidatedScreenCatalog;
  /**
   * URL of the captures directory relative to the page, ending in `/`. Image
   * `path` locators are resolved against it.
   */
  capturesUrl: string;
  /** Present on a hosted page, which serves images by digest. */
  hosted?: HostedReviewImages;
  /** When each screen last changed, keyed `screen:<key>`. */
  history?: { items: ReadonlyMap<string, ItemHistory>; truncated: boolean };
}

/**
 * How a hosted page finds images: by digest at `images/<digest>`, relative to
 * the page, instead of in a captures directory. A changed screen also shows
 * the image it had on the base the page is compared with.
 */
export interface HostedReviewImages {
  /** The digests the site serves. A screen whose digest is not here has no image. */
  served: ReadonlySet<string>;
  /** Each screen's image digest on the base, by screen key. */
  base: ReadonlyMap<string, string>;
  /** What the base is called in captions, for example `main`. */
  baseLabel: string;
}

export interface ScreenShownBy {
  story: string;
  story_title: string;
  /** Null for a Story-level link. */
  criterion: string | null;
  criterion_text: string | null;
}

export interface ScreenReviewEntry {
  key: string;
  title: string;
  capability: string;
  capability_name: string;
  group: string | null;
  route: string;
  kind: ScreenKind;
  when: string;
  applies_to: Applicability | null;
  copy: string[];
  image: { src: string; label: string } | null;
  /** On a hosted page, the image a changed screen had on the base. */
  before_image?: { src: string; label: string };
  /** Why the screen is deliberately not captured, or null. */
  not_captured: { reason: string; detail: string } | null;
  /** The test that captures the screen, from its capture record, or null. */
  capture_test: string | null;
  /** When the screen last changed, from git history. */
  last_changed?: ItemHistory & { truncated: boolean };
  shown_by: ScreenShownBy[];
  /** Present only on a page built against a base ref, for changed screens. */
  change?: Pick<ScreenRecordChange, "status" | "aspects">;
}

export interface ScreenReviewSection {
  capability: string;
  name: string;
  groups: Array<{ name: string | null; screens: string[] }>;
}

export interface ScreenCoverage {
  screens: number;
  linked_screens: number;
  unlinked_screens: number;
  stories: number;
  stories_without_screens: Array<{ key: string; title: string }>;
}

export interface ScreenReviewModel {
  sections: ScreenReviewSection[];
  /** In section, then group, then catalog order. */
  screens: ScreenReviewEntry[];
  coverage: ScreenCoverage;
  /** Screens shown by each Story (including its ACs) and each AC. */
  shownByOwner: ReadonlyMap<string, string[]>;
  kinds: Array<{ kind: ScreenKind; count: number }>;
  dimensions: Array<{ name: string; values: string[] }>;
  /** True when the page was built against a base ref. */
  hasChanges: boolean;
}

const KIND_LABELS: Record<ScreenKind, string> = {
  page: "Page",
  state: "State",
  dialog: "Dialog",
  drawer: "Drawer",
  toast: "Toast",
  "inline-error": "Inline error",
  "error-page": "Error page",
  redirect: "Redirect",
  loading: "Loading",
};

function changeOf(
  changes: ReviewChangeIndex | undefined,
  key: string
): Pick<ScreenReviewEntry, "change"> {
  const change = changes?.screens.get(key);
  return change ? { change: { status: change.status, aspects: change.aspects } } : {};
}

/**
 * Where the browser should look for a screen's image. A `path` is resolved
 * against the captures directory one encoded segment at a time; a `url` was
 * already restricted to http(s) when the catalog was validated.
 */
function imageSource(
  locator: { path: string; sha256?: string | undefined } | { url: string } | undefined,
  screens: ContractReviewScreens
): ScreenReviewEntry["image"] {
  if (!locator) return null;
  if ("url" in locator) return { src: locator.url, label: locator.url };
  if (screens.hosted) {
    return locator.sha256 !== undefined && screens.hosted.served.has(locator.sha256)
      ? { src: hostedImageSource(locator.sha256), label: locator.path }
      : null;
  }
  return {
    src: `${screens.capturesUrl}${locator.path.split("/").map(encodeURIComponent).join("/")}`,
    label: locator.path,
  };
}

/** Where a hosted site serves the image with `digest`, relative to the page. */
export function hostedImageSource(digest: string): string {
  return `images/${digest}`;
}

/**
 * The image a changed screen replaced, on a hosted page whose base had a
 * different image for it.
 */
function beforeImage(
  key: string,
  current: string | undefined,
  screens: ContractReviewScreens,
  change: Pick<ScreenReviewEntry, "change">
): Pick<ScreenReviewEntry, "before_image"> {
  const before = screens.hosted?.base.get(key);
  if (!screens.hosted || !before || before === current || !change.change?.aspects.includes("image")) {
    return {};
  }
  return { before_image: { src: hostedImageSource(before), label: screens.hosted.baseLabel } };
}

export function buildScreenReviewModel(
  documents: AcceptedContractDocument[],
  screens: ContractReviewScreens,
  changes?: ReviewChangeIndex
): ScreenReviewModel {
  const shownBy = new Map<string, ScreenShownBy[]>();
  const shownByOwner = new Map<string, string[]>();
  const record = (owner: string, key: string): void => {
    const keys = shownByOwner.get(owner) ?? [];
    if (!keys.includes(key)) keys.push(key);
    shownByOwner.set(owner, keys);
  };
  let stories = 0;
  const storiesWithoutScreens: ScreenCoverage["stories_without_screens"] = [];
  for (const { capability } of documents) {
    for (const story of capability.stories) {
      stories += 1;
      for (const link of story.shows ?? []) {
        const entries = shownBy.get(link.target.key) ?? [];
        entries.push({
          story: story.key,
          story_title: story.title,
          criterion: null,
          criterion_text: null,
        });
        shownBy.set(link.target.key, entries);
        record(story.key, link.target.key);
      }
      for (const criterion of story.acceptance_criteria) {
        for (const link of criterion.shows ?? []) {
          const entries = shownBy.get(link.target.key) ?? [];
          entries.push({
            story: story.key,
            story_title: story.title,
            criterion: criterion.key,
            criterion_text: criterion.criterion,
          });
          shownBy.set(link.target.key, entries);
          record(criterion.key, link.target.key);
          record(story.key, link.target.key);
        }
      }
      if (!shownByOwner.has(story.key)) {
        storiesWithoutScreens.push({ key: story.key, title: story.title });
      }
    }
  }

  const catalogs = new Map(
    screens.catalog.files.map((file) => [file.document.capability, file.document])
  );
  const sections: ScreenReviewSection[] = [];
  const entries: ScreenReviewEntry[] = [];
  const kinds = new Map<ScreenKind, number>();
  const dimensions = new Map<string, Set<string>>();
  for (const { capability } of documents) {
    const catalog = catalogs.get(capability.key);
    if (!catalog || catalog.screens.length === 0) continue;
    const groups = new Map<string | null, string[]>();
    for (const entry of catalog.screens) {
      const group = entry.group ?? null;
      const keys = groups.get(group) ?? [];
      keys.push(entry.key);
      groups.set(group, keys);
    }
    const byKey = new Map(catalog.screens.map((entry) => [entry.key, entry]));
    for (const keys of groups.values()) {
      for (const key of keys) {
        const entry = byKey.get(key)!;
        const change = changeOf(changes, entry.key);
        kinds.set(entry.kind, (kinds.get(entry.kind) ?? 0) + 1);
        for (const [dimension, values] of Object.entries(entry.applies_to ?? {})) {
          const known = dimensions.get(dimension) ?? new Set<string>();
          for (const value of values) known.add(value);
          dimensions.set(dimension, known);
        }
        entries.push({
          key: entry.key,
          title: entry.title,
          capability: capability.key,
          capability_name: capability.name,
          group: entry.group ?? null,
          route: entry.route,
          kind: entry.kind,
          when: entry.when,
          applies_to: entry.applies_to ?? null,
          copy: entry.copy ?? [],
          image: imageSource(entry.image, screens),
          ...beforeImage(entry.key, entry.image?.sha256, screens, change),
          not_captured: entry.not_captured ?? null,
          capture_test: entry.capture?.test ?? null,
          ...(screens.history?.items.has(`screen:${entry.key}`)
            ? { last_changed: { ...screens.history.items.get(`screen:${entry.key}`)!, truncated: screens.history.truncated } }
            : {}),
          shown_by: shownBy.get(entry.key) ?? [],
          ...change,
        });
      }
    }
    sections.push({
      capability: capability.key,
      name: capability.name,
      groups: [...groups].map(([name, keys]) => ({ name, screens: keys })),
    });
  }
  const linked = entries.filter((entry) => entry.shown_by.length > 0).length;
  return {
    sections,
    screens: entries,
    coverage: {
      screens: entries.length,
      linked_screens: linked,
      unlinked_screens: entries.length - linked,
      stories,
      stories_without_screens: storiesWithoutScreens,
    },
    shownByOwner,
    hasChanges: changes !== undefined,
    kinds: (Object.keys(KIND_LABELS) as ScreenKind[])
      .filter((kind) => kinds.has(kind))
      .map((kind) => ({ kind, count: kinds.get(kind)! })),
    dimensions: [...dimensions]
      .map(([name, values]) => ({
        name,
        values: [...values].sort((left, right) => left.localeCompare(right)),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

/** Whether a thumbnail has an image to load, or why it shows none. */
function shotState(entry: ScreenReviewEntry): "loading" | "not-captured" | "none" {
  return entry.image ? "loading" : entry.not_captured ? "not-captured" : "none";
}

/**
 * The screens linked to one Story or AC, each opening the screen in the
 * Screens view. A Story shows thumbnails, which load only when scrolled into
 * view; an AC lists its screens as one-line chips.
 */
export function renderShownScreens(
  model: ScreenReviewModel,
  owner: string,
  label: string,
  thumbnails = true
): string {
  const keys = model.shownByOwner.get(owner);
  if (!keys || keys.length === 0) return "";
  const byKey = new Map(model.screens.map((entry) => [entry.key, entry]));
  const entries = keys
    .map((key) => byKey.get(key))
    .filter((entry): entry is ScreenReviewEntry => entry !== undefined);
  if (!thumbnails) {
    return `<div class="shown-screens shown-screens-compact">
    <h3>${escapeHtml(label)} <span>${keys.length}</span></h3>
    ${entries
      .map(
        (entry) => `<button type="button" class="screen-chip-text" data-open-screen="${escapeHtml(entry.key)}"><b>${escapeHtml(entry.title)}</b><small>${escapeHtml(KIND_LABELS[entry.kind])}</small>${renderChangeBadge(entry.change)}</button>`
      )
      .join("")}
  </div>`;
  }
  return `<div class="shown-screens">
    <h3>${escapeHtml(label)} <span>${keys.length}</span></h3>
    <div class="shown-screen-list">${entries
      .map((entry) => {
        const state = shotState(entry);
        return `<button type="button" class="screen-chip" data-open-screen="${escapeHtml(entry.key)}">
        <span class="chip-shot" data-kind="${entry.kind}" data-state="${state}">${
          entry.image
            ? `<img data-src="${escapeHtml(entry.image.src)}" alt=""><i aria-hidden="true">${escapeHtml(KIND_LABELS[entry.kind])}</i>`
            : `<i>${state === "not-captured" ? "Not captured" : "No capture"}</i>`
        }${renderChangeBadge(entry.change)}</span>
        <span class="chip-text"><b>${escapeHtml(entry.title)}</b><small>${escapeHtml(KIND_LABELS[entry.kind])} · ${escapeHtml(entry.route)}</small></span>
      </button>`;
      })
      .join("")}</div>
  </div>`;
}

export function renderScreenTabs(model: ScreenReviewModel): string {
  return `      <div class="view-tabs" role="tablist" aria-label="Review views">
        <button type="button" role="tab" data-view-tab="stories" aria-selected="true">Stories</button>
        <button type="button" role="tab" data-view-tab="screens" aria-selected="false">Screens <span>${model.coverage.screens}</span></button>
      </div>
`;
}

export function renderScreenSidebar(model: ScreenReviewModel): string {
  const kindFilters = model.kinds
    .map(
      ({ kind, count }) => `<label class="kind-filter">
          <input type="checkbox" value="${kind}" data-kind-filter>
          <span>${escapeHtml(KIND_LABELS[kind])}</span><small>${count}</small>
        </label>`
    )
    .join("");
  const dimensionFilters = model.dimensions
    .map(
      ({ name, values }) => `<label class="filter-select">
          <span>${escapeHtml(name)}</span>
          <select data-dimension-filter="${escapeHtml(name)}">
            <option value="">Any</option>
            ${values
              .map(
                (value) =>
                  `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`
              )
              .join("")}
          </select>
        </label>`
    )
    .join("");
  const outline = model.sections
    .map(
      (section) => `<li>
          <a href="#view/screens" data-outline-section="${escapeHtml(section.capability)}">${escapeHtml(section.name)}<small>${section.groups.reduce((total, group) => total + group.screens.length, 0)}</small></a>
          ${
            section.groups.some((group) => group.name !== null)
              ? `<ul>${section.groups
                  .map(
                    (group, index) =>
                      `<li><a href="#view/screens" data-outline-section="${escapeHtml(section.capability)}" data-outline-group="${index}">${escapeHtml(group.name ?? "Ungrouped")}<small>${group.screens.length}</small></a></li>`
                  )
                  .join("")}</ul>`
              : ""
          }
        </li>`
    )
    .join("");
  return `      <div class="screen-panel">
        <label class="search">
          ${SEARCH_ICON}
          <input id="screen-search" type="search" placeholder="Search" aria-label="Search screens" autocomplete="off" aria-controls="screen-results">
          <kbd aria-hidden="true">/</kbd>
        </label>
        <details class="screen-filters">
          <summary>Filters <span id="screen-filter-count"></span></summary>
          <div class="filter-body">
          <fieldset>
            <legend>Kind</legend>
            ${kindFilters}
          </fieldset>
          <label class="filter-select">
            <span>Stories</span>
            <select id="screen-linked-filter">
              <option value="">All screens</option>
              <option value="linked">Shown by a Story or AC</option>
              <option value="unlinked">Not linked to any Story</option>
            </select>
          </label>
          <label class="filter-select">
            <span>Screenshot</span>
            <select id="screen-capture-filter">
              <option value="">All screens</option>
              <option value="captured">With a screenshot</option>
              <option value="not-captured">Not captured, with a reason</option>
              <option value="none">No screenshot yet</option>
            </select>
          </label>${
            model.hasChanges
              ? `
          <label class="filter-select">
            <span>Branch</span>
            <select id="screen-change-filter">
              <option value="">All screens</option>
              <option value="changed">New or changed on this branch</option>
            </select>
          </label>`
              : ""
          }
          ${dimensionFilters}
          <button type="button" class="clear-filters" id="screen-clear-filters" hidden>Clear filters</button>
          </div>
        </details>
        <p class="screen-result-count" id="screen-result-count" aria-live="polite"></p>
        <ol class="screen-results" id="screen-results" hidden></ol>
        <nav class="screen-outline" id="screen-outline" aria-label="Screen sections"><ul>${outline}</ul></nav>
      </div>
`;
}

export function renderScreensView(model: ScreenReviewModel): string {
  const { coverage } = model;
  const storiesWithout =
    coverage.stories_without_screens.length > 0
      ? `<details class="coverage-stories">
          <summary><b>${coverage.stories_without_screens.length}</b> of ${coverage.stories} Stories show no screens</summary>
          <ul>${coverage.stories_without_screens
            .map(
              (story) =>
                `<li><a href="#${escapeHtml(story.key)}" data-story-jump="${escapeHtml(story.key)}">${escapeHtml(story.title)}</a> <code>${escapeHtml(story.key)}</code></li>`
            )
            .join("")}</ul>
        </details>`
      : `<p class="coverage-stories">Every Story shows at least one screen.</p>`;
  const body =
    coverage.screens === 0
      ? `<div class="empty-state">
          <h1>No screens yet</h1>
          <p>Screens are enabled for this repository, but the catalog is empty.
          Import screens with <code>tieline screens import &lt;file&gt;</code> or
          author them in the screen catalog, then run
          <code>tieline contract compile .</code>.</p>
        </div>`
      : `<div class="screens-map" id="screens-map" data-layout="grid" aria-label="Screen map">
          <div class="screens-board" id="screens-board"></div>
          <div class="canvas-tools" id="canvas-tools" hidden>
            <button type="button" id="canvas-zoom-out" aria-label="Zoom out" title="Zoom out (−)">−</button>
            <span id="canvas-scale">100%</span>
            <button type="button" id="canvas-zoom-in" aria-label="Zoom in" title="Zoom in (+)">+</button>
            <button type="button" id="canvas-fit" title="Fit every screen (0)">Fit</button>
          </div>
        </div>`;
  return `<section class="screens-view" id="screens-view" aria-label="Screens">
          <header class="screens-header">
            <h1>Screens</h1>
            <div class="screen-toolbar">
              <div class="coverage" role="group" aria-label="Screen coverage">
                <button type="button" data-coverage-filter=""><b>${coverage.screens}</b> screens</button>
                <button type="button" data-coverage-filter="linked"><b>${coverage.linked_screens}</b> shown by Stories</button>
                <button type="button" data-coverage-filter="unlinked"><b>${coverage.unlinked_screens}</b> with no links</button>
              </div>${
                model.screens.some((entry) => entry.change)
                  ? `
              <button type="button" class="toggle" id="screen-change-toggle" aria-pressed="false" title="Show only screens new or changed on this branch">Changed <span>${model.screens.filter((entry) => entry.change).length}</span></button>`
                  : ""
              }
            </div>
            <div class="map-tools">
              <span id="screen-visible-count" aria-live="polite"></span>${
                coverage.screens > 0
                  ? `
              <div class="layout-switch" role="group" aria-label="Layout">
                <button type="button" data-layout-choice="grid" aria-pressed="true">Grid</button>
                <button type="button" data-layout-choice="canvas" aria-pressed="false">Canvas</button>
              </div>`
                  : ""
              }
              <label class="zoom">
                <span>Zoom</span>
                <input id="screen-zoom" type="range" min="1" max="4" step="1" value="2" aria-label="Thumbnail size">
              </label>
            </div>
            ${storiesWithout}
          </header>
          ${body}
        </section>
        <aside class="screen-detail" id="screen-detail" hidden aria-labelledby="screen-detail-title">
          <div class="detail-bar">
            <button type="button" id="screen-detail-prev" aria-label="Previous screen">←</button>
            <span id="screen-detail-position"></span>
            <button type="button" id="screen-detail-next" aria-label="Next screen">→</button>
            <button type="button" id="screen-detail-close" aria-label="Close screen details">×</button>
          </div>
          <div class="detail-body">
            <p class="breadcrumbs" id="screen-detail-crumbs"></p>
            <h1 id="screen-detail-title"></h1>
            <p class="detail-sub" id="screen-detail-sub"></p>
            <p class="detail-when" id="screen-detail-when"></p>
            <div class="detail-compare">
              <figure class="detail-shot" id="screen-detail-shot"></figure>
              <figure class="detail-shot detail-before" id="screen-detail-before" hidden></figure>
            </div>
            <section class="detail-section" id="screen-detail-links"></section>
            <section class="detail-section" id="screen-detail-copy"></section>
            <dl class="detail-meta" id="screen-detail-meta"></dl>
          </div>
        </aside>`;
}

/**
 * JSON for a `<script type="application/json">` element. Escaping `<` keeps
 * catalog text from closing the element; the line separators are escaped for
 * older parsers that treat them as line terminators.
 */
export function serializeScreenReviewData(model: ScreenReviewModel): string {
  return JSON.stringify({
    kinds: KIND_LABELS,
    sections: model.sections,
    screens: model.screens,
  })
    .replaceAll("<", "\\u003c")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");
}

export const SCREEN_REVIEW_STYLES = `    .view-tabs {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 2px;
      margin: 0 0 8px;
      padding: 2px;
      background: var(--bg-2);
      border: 1px solid var(--line);
      border-radius: var(--r-md);
    }
    .view-tabs button {
      height: 28px;
      padding: 0 8px;
      color: var(--fg-2);
      background: transparent;
      border: 0;
      border-radius: var(--r-sm);
      cursor: pointer;
      font-size: var(--text-md);
      font-weight: 500;
    }
    .view-tabs button:hover { color: var(--fg-1); }
    .view-tabs button[aria-selected="true"] {
      color: var(--fg-1);
      background: var(--bg);
      box-shadow: 0 0 0 1px var(--line-strong);
    }
    .view-tabs span { margin-left: 4px; color: var(--fg-3); font: 400 var(--text-sm) var(--font-mono); }
    .screen-panel, .screens-view, .zoom-keys { display: none; }
    .wiki-shell[data-view="screens"] .screen-panel,
    .wiki-shell[data-view="screens"] .screens-view { display: block; }
    .wiki-shell[data-view="screens"] .zoom-keys { display: inline-flex; }
    .wiki-shell[data-view="screens"] .wiki-nav > .nav-search,
    .wiki-shell[data-view="screens"] .wiki-nav > nav,
    .wiki-shell[data-view="screens"] .wiki-nav > .nav-empty,
    .wiki-shell[data-view="screens"] #story-content { display: none; }
    .wiki-shell[data-view="screens"] .wiki-content { max-width: none; }
    .screen-panel .search { margin: 4px 0 8px; }
    .screen-filters { font-size: var(--text-md); }
    .screen-filters summary {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      color: var(--fg-2);
      border-radius: var(--r-sm);
      cursor: pointer;
      font-weight: 500;
      list-style: none;
    }
    .screen-filters summary::-webkit-details-marker { display: none; }
    .screen-filters summary::before {
      width: 0;
      height: 0;
      border-top: 4px solid transparent;
      border-bottom: 4px solid transparent;
      border-left: 5px solid var(--fg-4);
      content: "";
    }
    .screen-filters[open] summary::before { transform: rotate(90deg); }
    .screen-filters summary:hover { background: var(--bg-2); }
    #screen-filter-count { color: var(--fg-3); font-weight: 400; }
    .filter-body { display: grid; gap: 12px; padding: 8px 8px 4px; }
    .screen-filters fieldset { display: flex; flex-wrap: wrap; gap: 4px; margin: 0; padding: 0; border: 0; }
    .screen-filters legend, .filter-select > span {
      margin-bottom: 4px;
      padding: 0;
      color: var(--fg-3);
      font-size: var(--text-xs);
      font-weight: 600;
      letter-spacing: .04em;
      line-height: 1rem;
      overflow-wrap: anywhere;
      text-transform: uppercase;
    }
    .kind-filter {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 24px;
      padding: 0 8px;
      color: var(--fg-2);
      background: var(--bg);
      border: 1px solid var(--line-strong);
      border-radius: var(--r-sm);
      cursor: pointer;
      font-size: var(--text-sm);
    }
    .kind-filter input { margin: 0; accent-color: var(--fg-1); }
    .kind-filter small { color: var(--fg-3); font-family: var(--font-mono); }
    .kind-filter:has(input:checked) { color: var(--fg-1); background: var(--bg-3); border-color: var(--fg-1); }
    .filter-select { display: grid; }
    .filter-select select {
      width: 100%;
      min-width: 0;
      height: 28px;
      padding: 0 6px;
      color: var(--fg-1);
      background: var(--bg-2);
      border: 1px solid var(--line-strong);
      border-radius: var(--r-sm);
      font-size: var(--text-md);
    }
    .clear-filters {
      justify-self: start;
      height: 24px;
      padding: 0 8px;
      color: var(--fg-2);
      background: var(--bg);
      border: 1px solid var(--line-strong);
      border-radius: var(--r-sm);
      cursor: pointer;
      font-size: var(--text-sm);
    }
    .clear-filters[hidden] { display: none; }
    .screen-result-count { margin: 12px 8px 4px; color: var(--fg-3); font-size: var(--text-sm); }
    .screen-result-count:empty { display: none; }
    .screen-results, .screen-outline ul {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .screen-results button {
      display: grid;
      width: 100%;
      gap: 2px;
      padding: 6px 8px;
      color: var(--fg-2);
      background: transparent;
      border: 0;
      border-radius: var(--r-sm);
      cursor: pointer;
      text-align: left;
    }
    .screen-results button:hover { background: var(--bg-2); }
    .screen-results button[aria-current="true"] {
      color: var(--fg-1);
      background: var(--bg-3);
      box-shadow: inset 2px 0 var(--fg-1);
    }
    .screen-results b { font-size: var(--text-md); font-weight: 500; line-height: 1.125rem; }
    .screen-results code, .screen-results small { color: var(--fg-3); font-size: var(--text-xs); }
    .screen-results .more { padding: 6px 8px; color: var(--fg-3); font-size: var(--text-sm); }
    .screen-outline { margin-top: 8px; }
    .screen-outline > ul > li { margin-top: 8px; }
    .screen-outline a {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      padding: 6px 8px;
      color: var(--fg-2);
      border-radius: var(--r-sm);
      font-size: var(--text-md);
      line-height: 1.125rem;
      text-decoration: none;
    }
    .screen-outline > ul > li > a { color: var(--fg-1); font-weight: 500; }
    .screen-outline ul ul a { padding-left: 20px; }
    .screen-outline a:hover { background: var(--bg-2); }
    .screen-outline small { color: var(--fg-3); font: 400 var(--text-sm) var(--font-mono); }
    .screens-header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-areas: "title title" "toolbar tools" "stories stories";
      align-items: center;
      gap: 12px 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--line);
    }
    .screens-header h1 {
      grid-area: title;
      margin: 0;
      color: var(--fg-1);
      font-size: var(--text-2xl);
      font-weight: 600;
      line-height: 2rem;
      letter-spacing: -.01em;
    }
    .screen-toolbar { grid-area: toolbar; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .coverage {
      display: inline-flex;
      flex-wrap: wrap;
      gap: 2px;
      padding: 2px;
      background: var(--bg-2);
      border: 1px solid var(--line);
      border-radius: var(--r-md);
    }
    .coverage button {
      height: 26px;
      padding: 0 10px;
      color: var(--fg-2);
      background: none;
      border: 0;
      border-radius: var(--r-sm);
      cursor: pointer;
      font-size: var(--text-md);
    }
    .coverage button:hover { color: var(--fg-1); }
    .coverage button[aria-pressed="true"] {
      color: var(--fg-1);
      background: var(--bg);
      box-shadow: 0 0 0 1px var(--line-strong);
      font-weight: 500;
    }
    .coverage b { margin-right: 2px; color: var(--fg-1); font: 500 var(--text-sm) var(--font-mono); font-variant-numeric: tabular-nums; }
    .map-tools { grid-area: tools; display: flex; align-items: center; gap: 16px; color: var(--fg-3); font-size: var(--text-sm); }
    .zoom { display: inline-flex; align-items: center; gap: 8px; }
    #screen-zoom { width: 96px; accent-color: var(--fg-1); }
    .coverage-stories { grid-area: stories; margin: 0; color: var(--fg-3); font-size: var(--text-md); }
    .coverage-stories summary { width: max-content; max-width: 100%; cursor: pointer; }
    .coverage-stories b { color: var(--fg-1); font-weight: 500; }
    .coverage-stories ul { margin: 8px 0 0; padding-left: 20px; columns: 2 280px; }
    .coverage-stories li { margin-bottom: 4px; }
    .coverage-stories code { color: var(--fg-3); font-size: var(--text-xs); }
    .screens-map { --screen-card: 168px; }
    .screen-section { margin-top: 24px; }
    .screen-section[hidden], .screen-group[hidden], .screen-card[hidden] { display: none; }
    .screen-section > h2 {
      position: sticky;
      top: 0;
      z-index: 2;
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin: 0;
      padding: 10px 0 8px;
      color: var(--fg-1);
      background: var(--bg);
      border-bottom: 1px solid var(--line);
      font-size: var(--text-md);
      font-weight: 600;
      line-height: 1.25rem;
    }
    .screen-section > h2 small, .screen-group > h3 small {
      color: var(--fg-3);
      font: 400 var(--text-sm) var(--font-mono);
      letter-spacing: 0;
    }
    .screen-group { margin-top: 12px; }
    .screen-group > h3 {
      position: sticky;
      top: 39px;
      z-index: 1;
      margin: 0 0 8px;
      padding: 4px 0;
      color: var(--fg-3);
      background: var(--bg);
      font-size: var(--text-xs);
      font-weight: 600;
      letter-spacing: .04em;
      line-height: 1rem;
      text-transform: uppercase;
    }
    .screen-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(var(--screen-card), 1fr));
      gap: 20px 16px;
    }
    .screens-map[data-zoom="1"] .screen-grid { gap: 8px; }
    .screens-map[data-zoom="4"] .screen-grid { gap: 24px; }
    .screen-card {
      display: grid;
      align-content: start;
      gap: 8px;
      min-width: 0;
      padding: 0;
      color: inherit;
      background: none;
      border: 0;
      border-radius: var(--r-md);
      cursor: pointer;
      text-align: left;
    }
    .screen-card .shot { border: 1px solid var(--line-strong); border-radius: var(--r-md); }
    .screen-card:hover .shot { border-color: var(--fg-4); }
    .screen-card:hover .card-body b { text-decoration: underline; text-decoration-color: var(--line-strong); text-underline-offset: 2px; }
    .screen-card[aria-current="true"] .shot { outline: 2px solid var(--fg-1); outline-offset: 2px; }
    .shot, .chip-shot, .detail-shot {
      position: relative;
      display: grid;
      place-items: center;
      overflow: hidden;
      background: repeating-linear-gradient(135deg, var(--bg-2) 0 6px, var(--bg) 6px 12px);
    }
    .shot { aspect-ratio: 16 / 10; }
    .shot[data-state="loading"], .chip-shot[data-state="loading"] { background: var(--bg-2); }
    .shot img, .chip-shot img {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      object-position: top;
      background: var(--bg);
      opacity: 0;
    }
    .shot.loaded img, .chip-shot.loaded img { opacity: 1; }
    .shot i, .chip-shot i {
      display: inline-grid;
      justify-items: center;
      max-width: calc(100% - 16px);
      padding: 2px 8px;
      color: var(--fg-2);
      background: var(--bg);
      border: 1px dashed var(--fg-3);
      border-radius: var(--r-sm);
      font: 600 var(--text-xs)/1rem var(--font-sans);
      font-style: normal;
      text-align: center;
    }
    .shot[data-state="loading"] i, .chip-shot[data-state="loading"] i {
      color: var(--fg-3);
      background: none;
      border-color: transparent;
      font-weight: 500;
    }
    .shot i small { color: var(--fg-3); font: 400 var(--text-xs)/1rem var(--font-mono); }
    .shot.loaded i, .chip-shot.loaded i { display: none; }
    .card-body { display: grid; gap: 2px; min-width: 0; }
    .card-body b {
      overflow: hidden;
      color: var(--fg-1);
      font-size: var(--text-md);
      font-weight: 500;
      line-height: 1.125rem;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .card-meta {
      overflow: hidden;
      color: var(--fg-3);
      font-size: var(--text-sm);
      line-height: 1rem;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .card-meta code { font-size: var(--text-xs); }
    .unlinked-tag {
      display: inline-flex;
      justify-self: start;
      align-items: center;
      height: 18px;
      margin-top: 2px;
      padding: 0 6px;
      color: var(--fg-2);
      border: 1px dashed var(--fg-3);
      border-radius: var(--r-sm);
      font: 600 var(--text-xs)/1 var(--font-sans);
    }
    .screens-map[data-zoom="1"] .card-meta,
    .screens-map[data-zoom="1"] .unlinked-tag,
    .screens-map[data-zoom="1"] .shot i small { display: none; }
    .screens-map[data-zoom="1"] .card-body b { font-size: var(--text-xs); }
    .screens-map[data-zoom="1"] .shot i { padding: 0 4px; }
    .screen-detail {
      position: fixed;
      top: 0;
      right: 0;
      z-index: 30;
      width: min(720px, 100vw);
      height: 100vh;
      background: var(--bg);
      box-shadow: var(--shadow-overlay);
      overflow-y: auto;
    }
    .screen-detail:has(#screen-detail-before:not([hidden])) { width: min(1120px, 96vw); }
    .screen-detail[hidden] { display: none; }
    .detail-bar {
      position: sticky;
      top: 0;
      z-index: 2;
      display: flex;
      align-items: center;
      gap: 4px;
      height: 48px;
      padding: 0 16px;
      background: var(--bg-1);
      border-bottom: 1px solid var(--line);
      font-size: var(--text-sm);
    }
    .detail-bar span { flex: 1; color: var(--fg-3); font-variant-numeric: tabular-nums; }
    .detail-bar button {
      min-width: 32px;
      height: 32px;
      padding: 0 8px;
      color: var(--fg-2);
      background: var(--bg);
      border: 1px solid var(--line-strong);
      border-radius: var(--r-sm);
      cursor: pointer;
      font-size: var(--text-base);
    }
    .detail-bar button:hover { background: var(--bg-2); }
    .detail-body { padding: 20px 24px 48px; }
    .detail-body > .breadcrumbs { margin-bottom: 4px; }
    .detail-body h1 {
      margin: 0;
      color: var(--fg-1);
      font-size: var(--text-xl);
      font-weight: 600;
      line-height: 1.75rem;
    }
    .detail-sub { margin: 4px 0 0; color: var(--fg-3); font-size: var(--text-sm); }
    .detail-sub code { color: var(--fg-2); }
    .detail-when { max-width: 72ch; margin: 16px 0; color: var(--fg-2); }
    .detail-when b {
      display: block;
      color: var(--fg-3);
      font-size: var(--text-xs);
      font-weight: 600;
      letter-spacing: .04em;
      line-height: 1rem;
      text-transform: uppercase;
    }
    .detail-compare { display: grid; gap: 12px; }
    .detail-compare:has(.detail-before:not([hidden])) { grid-template-columns: 1fr 1fr; align-items: start; }
    .detail-compare .detail-before { order: -1; }
    .detail-shot {
      min-height: 180px;
      margin: 0;
      border: 1px solid var(--line-strong);
      border-radius: var(--r-md);
    }
    .detail-shot img { display: block; width: 100%; height: auto; }
    .detail-shot figcaption {
      display: grid;
      gap: 8px;
      justify-items: center;
      padding: 24px;
      color: var(--fg-3);
      font-size: var(--text-md);
      text-align: center;
    }
    .detail-shot figcaption i {
      color: var(--fg-3);
      font-size: var(--text-xs);
      font-style: normal;
      font-weight: 600;
      letter-spacing: .04em;
      text-transform: uppercase;
    }
    .detail-shot.loaded { background: var(--bg); }
    .detail-before[hidden] { display: none; }
    .shot-label {
      justify-self: stretch;
      align-self: start;
      padding: 6px 12px;
      color: var(--fg-1);
      background: var(--bg-1);
      border-bottom: 1px solid var(--line);
      font: 600 var(--text-xs)/1rem var(--font-sans);
    }
    .detail-shot:has(.shot-label) { place-items: start stretch; }
    .detail-meta { margin: 24px 0 0; }
    .detail-meta > div {
      display: grid;
      grid-template-columns: 112px minmax(0, 1fr);
      gap: 12px;
      padding: 6px 0;
      border-top: 1px solid var(--line);
    }
    .detail-meta dt { color: var(--fg-3); font-size: var(--text-sm); line-height: 1.25rem; }
    .detail-meta dd {
      min-width: 0;
      margin: 0;
      color: var(--fg-2);
      font-size: var(--text-md);
      line-height: 1.25rem;
      overflow-wrap: anywhere;
    }
    .detail-section h2 { margin: 24px 0 8px; color: var(--fg-1); font-size: var(--text-md); font-weight: 600; }
    .detail-section ul { display: grid; margin: 0; padding: 0; list-style: none; }
    .detail-section li { font-size: var(--text-md); }
    .copy-list { gap: 6px; }
    .copy-list li { padding: 2px 0 2px 12px; color: var(--fg-2); border-left: 2px solid var(--line-strong); }
    .detail-link {
      display: grid;
      width: 100%;
      gap: 2px;
      padding: 8px;
      color: inherit;
      background: none;
      border: 0;
      border-top: 1px solid var(--line);
      cursor: pointer;
      text-align: left;
    }
    .detail-section li:first-child .detail-link { border-top: 0; }
    .detail-link:hover { background: var(--bg-2); }
    .detail-link code { color: var(--fg-3); font-size: var(--text-xs); }
    .detail-link b { color: var(--fg-1); font-weight: 500; }
    .detail-link small { color: var(--fg-3); font-size: var(--text-sm); }
    .detail-empty { color: var(--fg-3); font-size: var(--text-md); }
    .shown-screens { margin-top: 24px; }
    .shown-screens h3 {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin: 0 0 8px;
      color: var(--fg-1);
      font-size: var(--text-md);
      font-weight: 600;
    }
    .shown-screens h3 span { color: var(--fg-3); font: 400 var(--text-sm) var(--font-mono); }
    .shown-screen-list { display: flex; flex-wrap: wrap; gap: 16px 12px; }
    .screen-chip {
      display: grid;
      gap: 6px;
      width: 160px;
      padding: 0;
      color: inherit;
      background: none;
      border: 0;
      border-radius: var(--r-md);
      cursor: pointer;
      text-align: left;
    }
    .chip-shot { width: 100%; aspect-ratio: 16 / 10; border: 1px solid var(--line-strong); border-radius: var(--r-md); }
    .screen-chip:hover .chip-shot { border-color: var(--fg-4); }
    .chip-text { display: grid; min-width: 0; }
    .chip-text b {
      overflow: hidden;
      color: var(--fg-1);
      font-size: var(--text-md);
      font-weight: 500;
      line-height: 1.125rem;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .chip-text small { overflow: hidden; color: var(--fg-3); font-size: var(--text-sm); text-overflow: ellipsis; white-space: nowrap; }
    .shown-screens-compact { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 8px; }
    .shown-screens-compact h3 { margin: 0 2px 0 0; color: var(--fg-3); font-size: var(--text-sm); font-weight: 500; }
    .screen-chip-text {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 100%;
      height: 24px;
      padding: 0 8px;
      color: var(--fg-2);
      background: var(--bg);
      border: 1px solid var(--line-strong);
      border-radius: var(--r-sm);
      cursor: pointer;
      font-size: var(--text-sm);
    }
    .screen-chip-text::before {
      flex: none;
      width: 10px;
      height: 8px;
      border: 1px solid var(--fg-4);
      border-radius: 2px;
      content: "";
    }
    .screen-chip-text:hover { background: var(--bg-2); }
    .screen-chip-text b { overflow: hidden; color: var(--fg-1); font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
    .screen-chip-text small { color: var(--fg-3); font-size: var(--text-sm); }
    .layout-switch {
      display: inline-flex;
      gap: 2px;
      padding: 2px;
      background: var(--bg-2);
      border: 1px solid var(--line);
      border-radius: var(--r-md);
    }
    .layout-switch button {
      height: 24px;
      padding: 0 10px;
      color: var(--fg-2);
      background: none;
      border: 0;
      border-radius: var(--r-sm);
      cursor: pointer;
      font-size: var(--text-sm);
    }
    .layout-switch button:hover { color: var(--fg-1); }
    .layout-switch button[aria-pressed="true"] {
      color: var(--fg-1);
      background: var(--bg);
      box-shadow: 0 0 0 1px var(--line-strong);
      font-weight: 500;
    }
    .zoom[hidden], .canvas-tools[hidden] { display: none; }
    .screens-map[data-layout="canvas"] {
      position: relative;
      margin-top: 16px;
      overflow: hidden;
      background: var(--bg-1);
      border: 1px solid var(--line);
      border-radius: var(--r-md);
      cursor: grab;
      touch-action: none;
      user-select: none;
      -webkit-user-select: none;
    }
    .screens-map[data-layout="canvas"].panning { cursor: grabbing; }
    .screens-map[data-layout="canvas"] .screens-board { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
    .screens-map[data-layout="canvas"] .screen-section { position: absolute; margin: 0; }
    /* Labels are sized against the canvas scale, so they read at every zoom. */
    .screens-map[data-layout="canvas"] .screen-section > h2 {
      position: absolute;
      top: auto;
      bottom: 100%;
      left: 0;
      display: block;
      margin: 0;
      padding: 0 0 calc(6px / var(--canvas-scale));
      overflow: hidden;
      background: none;
      border: 0;
      font-size: calc(13px / var(--canvas-scale));
      line-height: 1.3;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .screens-map[data-layout="canvas"] .screen-section > h2 small,
    .screens-map[data-layout="canvas"] .screen-group > h3 small { margin-left: .4em; font-size: .85em; }
    .screens-map[data-layout="canvas"] .screen-group { position: absolute; width: max-content; margin: 0; }
    .screens-map[data-layout="canvas"] .screen-group > h3 {
      position: absolute;
      top: auto;
      bottom: 100%;
      left: 0;
      max-width: 100%;
      margin: 0;
      padding: 0 0 6px;
      overflow: hidden;
      background: none;
      font-size: min(72px, calc(11px / var(--canvas-scale)));
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .screens-map[data-layout="canvas"] .screen-grid { grid-template-columns: repeat(var(--cols, 4), 240px); gap: 24px 16px; }
    .screens-map[data-layout="canvas"] .screen-card[aria-current="true"] { position: relative; z-index: 1; }
    .screens-map[data-layout="canvas"] .screen-card[aria-current="true"] .shot {
      outline-width: calc(2px / var(--canvas-scale));
      outline-offset: calc(2px / var(--canvas-scale));
    }
    /* Hidden, not removed, so a card's size never depends on the zoom. */
    .screens-map[data-band="far"] .screen-group > h3,
    .screens-map[data-band="far"] .shot i,
    .screens-map[data-band="far"] .card-body,
    .screens-map[data-band="mid"] .card-body { visibility: hidden; }
    .canvas-tools {
      position: absolute;
      right: 12px;
      bottom: 12px;
      z-index: 3;
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 2px;
      background: var(--bg);
      border: 1px solid var(--line-strong);
      border-radius: var(--r-md);
      cursor: default;
    }
    .canvas-tools button {
      min-width: 28px;
      height: 28px;
      padding: 0 8px;
      color: var(--fg-2);
      background: none;
      border: 0;
      border-radius: var(--r-sm);
      cursor: pointer;
      font-size: var(--text-md);
    }
    .canvas-tools button:hover { color: var(--fg-1); background: var(--bg-2); }
    .canvas-tools span {
      min-width: 44px;
      color: var(--fg-3);
      font: var(--text-sm) var(--font-mono);
      font-variant-numeric: tabular-nums;
      text-align: center;
    }
    @media (max-width: 760px) {
      .wiki-shell:not([data-nav-open]) .screen-panel { display: none; }
      .layout-switch { display: none; }
      .view-tabs { flex: none; margin: 0; }
      .screens-header { grid-template-columns: minmax(0, 1fr); grid-template-areas: "title" "toolbar" "tools" "stories"; }
      .screen-detail, .screen-detail:has(#screen-detail-before:not([hidden])) { width: 100vw; }
      .detail-bar { height: 56px; }
      .detail-bar button { min-width: 44px; height: 44px; }
      .detail-body { padding: 16px 16px 48px; }
      .detail-compare:has(.detail-before:not([hidden])) { grid-template-columns: minmax(0, 1fr); }
      .detail-compare .detail-before { order: 0; }
    }
    @media print {
      .view-tabs, .screen-panel, .screen-detail, .shown-screens { display: none; }
    }
`;

/**
 * The browser side of the Screens view. Written without template literals so
 * it can sit inside this module's string, and without `innerHTML` so catalog
 * text is only ever assigned as text.
 */
export const SCREEN_REVIEW_SCRIPT = `
    (() => {
      const shell = document.querySelector(".wiki-shell");
      const dataElement = document.getElementById("screen-data");
      if (!shell || !dataElement) return;
      const data = JSON.parse(dataElement.textContent || "{}");
      const screens = data.screens || [];
      const byKey = new Map(screens.map((screen) => [screen.key, screen]));
      const map = document.getElementById("screens-map");
      const search = document.getElementById("screen-search");
      const linkedFilter = document.getElementById("screen-linked-filter");
      const changeFilter = document.getElementById("screen-change-filter");
      const kindFilters = [...document.querySelectorAll("[data-kind-filter]")];
      const dimensionFilters = [...document.querySelectorAll("[data-dimension-filter]")];
      const coverageButtons = [...document.querySelectorAll("[data-coverage-filter]")];
      const changeToggle = document.getElementById("screen-change-toggle");
      const filterCount = document.getElementById("screen-filter-count");
      const clear = document.getElementById("screen-clear-filters");
      const results = document.getElementById("screen-results");
      const outline = document.getElementById("screen-outline");
      const resultCount = document.getElementById("screen-result-count");
      const visibleCount = document.getElementById("screen-visible-count");
      const zoom = document.getElementById("screen-zoom");
      const detail = document.getElementById("screen-detail");
      const tabs = [...document.querySelectorAll("[data-view-tab]")];
      const board = document.getElementById("screens-board");
      const captureFilter = document.getElementById("screen-capture-filter");
      const layoutButtons = [...document.querySelectorAll("[data-layout-choice]")];
      const zoomControl = zoom ? zoom.closest(".zoom") : null;
      const canvasTools = document.getElementById("canvas-tools");
      const canvasScale = document.getElementById("canvas-scale");
      const RESULT_LIMIT = 200;
      const ZOOM_WIDTHS = ["80px", "168px", "240px", "360px"];
      const LAYOUT_KEY = "tieline:screens-layout";
      // Below this scale a card is too small on screen to be worth its image,
      // so a catalog zoomed out to fit requests none.
      const IMAGE_SCALE = 0.15;
      // Room above each row of groups for their labels, in board units.
      const GROUP_GAP = 96;
      const canvas = { active: false, laidOut: false, scale: 1, x: 0, y: 0, width: 0, height: 0 };
      const cards = new Map();
      const sectionElements = [];
      let visible = screens.slice();
      let current = null;
      let returnFocus = null;

      function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
      }

      function kindLabel(kind) {
        return (data.kinds && data.kinds[kind]) || kind;
      }

      const imageObserver = "IntersectionObserver" in window
        ? new IntersectionObserver((entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              if (canvas.active && canvas.scale < IMAGE_SCALE) continue;
              imageObserver.unobserve(entry.target);
              loadImage(entry.target);
            }
          }, { rootMargin: "300px 0px" })
        : null;

      function loadImage(image) {
        const source = image.getAttribute("data-src");
        if (!source) return;
        image.removeAttribute("data-src");
        image.addEventListener("load", () => {
          image.parentElement && image.parentElement.classList.add("loaded");
        });
        image.addEventListener("error", () => {
          const holder = image.parentElement;
          image.remove();
          if (!holder) return;
          holder.dataset.state = "failed";
          const label = holder.querySelector("i");
          if (label) label.textContent = "Image unavailable";
        });
        image.src = source;
      }

      function observeImages(root) {
        for (const image of root.querySelectorAll("img[data-src]")) {
          if (imageObserver) imageObserver.observe(image);
          else loadImage(image);
        }
      }

      function changeLabel(change) {
        const status = change.status === "added" ? "New" : change.status === "removed" ? "Removed" : "Changed";
        return change.aspects.length > 0 ? status + " · " + change.aspects.join(", ") : status;
      }

      function changeTag(change) {
        return element("span", "change-badge change-" + change.status, changeLabel(change));
      }

      // The short tag a thumbnail carries; the full label is its tooltip.
      function shotChangeTag(change) {
        const tag = changeTag(change);
        tag.textContent = changeLabel({ status: change.status, aspects: [] });
        tag.title = changeLabel(change);
        return tag;
      }

      function searchText(screen) {
        return [
          screen.key, screen.title, screen.route, screen.when, screen.group || "",
          screen.capability, screen.capability_name, kindLabel(screen.kind),
          ...(screen.copy || []),
          ...Object.entries(screen.applies_to || {}).flat(2),
        ].join(" ").toLocaleLowerCase("en");
      }

      // What a thumbnail shows until, or instead of, its image.
      function placeholder(shot, screen) {
        if (screen.image) {
          shot.dataset.state = "loading";
          shot.append(element("i", "", kindLabel(screen.kind)));
        } else if (screen.not_captured) {
          shot.dataset.state = "not-captured";
          const label = element("i", "", "Not captured");
          label.append(element("small", "", screen.not_captured.reason));
          shot.append(label);
        } else {
          shot.dataset.state = "none";
          shot.append(element("i", "", "No capture"));
        }
      }

      function renderCard(screen) {
        const card = element("button", "screen-card");
        card.type = "button";
        card.dataset.key = screen.key;
        card.setAttribute("aria-label", screen.title + ", " + kindLabel(screen.kind) +
          (screen.change ? ", " + changeLabel(screen.change) : ""));
        const shot = element("span", "shot");
        shot.dataset.kind = screen.kind;
        if (screen.image) {
          const image = element("img");
          image.alt = "";
          image.setAttribute("data-src", screen.image.src);
          shot.append(image);
        }
        placeholder(shot, screen);
        if (screen.change) shot.append(shotChangeTag(screen.change));
        const body = element("span", "card-body");
        const meta = element("span", "card-meta", kindLabel(screen.kind) + " · ");
        meta.append(element("code", "", screen.route));
        for (const [dimension, values] of Object.entries(screen.applies_to || {})) {
          meta.append(" · " + dimension + ": " + values.join(", "));
        }
        body.append(element("b", "", screen.title), meta);
        if (screen.shown_by.length === 0) body.append(element("span", "unlinked-tag", "No links"));
        card.append(shot, body);
        card.addEventListener("click", () => openDetail(screen.key, true));
        screen.search = searchText(screen);
        cards.set(screen.key, card);
        return card;
      }

      if (map) {
        for (const section of data.sections || []) {
          const sectionElement = element("section", "screen-section");
          sectionElement.dataset.section = section.capability;
          const heading = element("h2", "", section.name);
          const total = section.groups.reduce((sum, group) => sum + group.screens.length, 0);
          heading.append(element("small", "", String(total)));
          sectionElement.append(heading);
          const groups = [];
          section.groups.forEach((group, index) => {
            const groupElement = element("div", "screen-group");
            groupElement.dataset.group = String(index);
            if (group.name !== null || section.groups.length > 1) {
              const label = element("h3", "", group.name === null ? "Ungrouped" : group.name);
              label.append(element("small", "", " " + group.screens.length));
              groupElement.append(label);
            }
            const grid = element("div", "screen-grid");
            for (const key of group.screens) {
              const screen = byKey.get(key);
              if (screen) grid.append(renderCard(screen));
            }
            groupElement.append(grid);
            sectionElement.append(groupElement);
            groups.push(groupElement);
          });
          board.append(sectionElement);
          sectionElements.push({ element: sectionElement, groups });
        }
        observeImages(map);
      }

      function activeFilters() {
        const kinds = new Set(kindFilters.filter((input) => input.checked).map((input) => input.value));
        const dimensions = dimensionFilters
          .filter((select) => select.value)
          .map((select) => [select.getAttribute("data-dimension-filter"), select.value]);
        return {
          query: (search ? search.value : "").trim().toLocaleLowerCase("en"),
          kinds,
          dimensions,
          linked: linkedFilter ? linkedFilter.value : "",
          changed: changeFilter ? changeFilter.value : "",
          capture: captureFilter ? captureFilter.value : "",
        };
      }

      function matches(screen, filters) {
        if (filters.kinds.size > 0 && !filters.kinds.has(screen.kind)) return false;
        if (filters.linked === "linked" && screen.shown_by.length === 0) return false;
        if (filters.linked === "unlinked" && screen.shown_by.length > 0) return false;
        if (filters.changed === "changed" && !screen.change) return false;
        if (filters.capture === "captured" && !screen.image) return false;
        if (filters.capture === "not-captured" && (screen.image || !screen.not_captured)) return false;
        if (filters.capture === "none" && (screen.image || screen.not_captured)) return false;
        for (const [dimension, value] of filters.dimensions) {
          const values = screen.applies_to && screen.applies_to[dimension];
          // A screen without this dimension applies to every value of it.
          if (values && !values.includes(value)) return false;
        }
        if (!filters.query) return true;
        return filters.query.split(/\\s+/).every((term) => screen.search.includes(term));
      }

      function renderResults(filters, active) {
        results.replaceChildren();
        results.hidden = !active;
        outline.hidden = active;
        if (!active) {
          resultCount.textContent = "";
          return;
        }
        resultCount.textContent = visible.length === 1 ? "1 match" : visible.length + " matches";
        for (const screen of visible.slice(0, RESULT_LIMIT)) {
          const item = element("li");
          const button = element("button");
          button.type = "button";
          button.dataset.key = screen.key;
          button.append(
            element("b", "", screen.title),
            element("small", "", kindLabel(screen.kind) + " · " + screen.capability_name + (screen.group ? " / " + screen.group : "")),
            element("code", "", screen.route)
          );
          button.addEventListener("click", () => openDetail(screen.key, true));
          item.append(button);
          results.append(item);
        }
        if (visible.length > RESULT_LIMIT) {
          results.append(element("li", "more", (visible.length - RESULT_LIMIT) + " more — refine the search to see them"));
        }
      }

      function applyFilters() {
        const filters = activeFilters();
        const active = Boolean(filters.query) || filters.kinds.size > 0 ||
          filters.dimensions.length > 0 || Boolean(filters.linked) || Boolean(filters.changed) ||
          Boolean(filters.capture);
        visible = screens.filter((screen) => matches(screen, filters));
        const shown = new Set(visible.map((screen) => screen.key));
        for (const [key, card] of cards) card.hidden = !shown.has(key);
        for (const section of sectionElements) {
          let any = false;
          for (const group of section.groups) {
            group.hidden = !group.querySelector(".screen-card:not([hidden])");
            any = any || !group.hidden;
          }
          section.element.hidden = !any;
        }
        for (const button of coverageButtons) {
          button.setAttribute("aria-pressed", String(button.getAttribute("data-coverage-filter") === filters.linked));
        }
        if (changeToggle) changeToggle.setAttribute("aria-pressed", String(filters.changed === "changed"));
        // The query is shown in the search box, so it is not counted here.
        const chosen = filters.kinds.size + filters.dimensions.length +
          (filters.linked ? 1 : 0) + (filters.changed ? 1 : 0) + (filters.capture ? 1 : 0);
        if (filterCount) filterCount.textContent = chosen > 0 ? "· " + chosen + " active" : "";
        if (clear) clear.hidden = !active;
        if (visibleCount) {
          visibleCount.textContent = active ? "Showing " + visible.length + " of " + screens.length + " screens" : "";
        }
        if (results) renderResults(filters, active);
        refreshCanvas();
      }

      function applyZoom() {
        map.dataset.zoom = zoom.value;
        map.style.setProperty("--screen-card", ZOOM_WIDTHS[Number(zoom.value) - 1] || ZOOM_WIDTHS[1]);
      }

      function narrowScreen() {
        return window.matchMedia("(max-width: 760px)").matches;
      }

      function savedLayout() {
        if (narrowScreen()) return "grid";
        try {
          return window.localStorage.getItem(LAYOUT_KEY) === "canvas" ? "canvas" : "grid";
        } catch {
          return "grid";
        }
      }

      // The grid scrolls with the page; the canvas lays every section out on
      // one board that pans and zooms inside a fixed frame.
      function setLayout(layout, remember) {
        if (!map || !board) return;
        const isCanvas = layout === "canvas";
        canvas.active = isCanvas;
        map.dataset.layout = isCanvas ? "canvas" : "grid";
        for (const button of layoutButtons) {
          button.setAttribute("aria-pressed", String(button.getAttribute("data-layout-choice") === map.dataset.layout));
        }
        if (zoomControl) zoomControl.hidden = isCanvas;
        if (canvasTools) canvasTools.hidden = !isCanvas;
        if (isCanvas) {
          delete map.dataset.zoom;
          refreshCanvas();
        } else {
          board.removeAttribute("style");
          map.style.removeProperty("height");
          map.style.removeProperty("--canvas-scale");
          delete map.dataset.band;
          for (const section of sectionElements) {
            for (const property of ["left", "top", "width", "height"]) section.element.style.removeProperty(property);
            const label = section.element.querySelector(":scope > h2");
            if (label) label.style.removeProperty("max-width");
            for (const group of section.groups) {
              for (const property of ["--cols", "left", "top"]) group.style.removeProperty(property);
            }
          }
          if (zoom) applyZoom();
        }
        if (remember) {
          try {
            window.localStorage.setItem(LAYOUT_KEY, map.dataset.layout);
          } catch {
            // Storage may be unavailable, for example for a file page in a
            // private window; the choice then lasts until the page reloads.
          }
        }
      }

      function canvasVisible() {
        return canvas.active && shell.dataset.view === "screens" && map.offsetParent !== null;
      }

      function applyTransform() {
        board.style.transform = "translate(" + canvas.x + "px, " + canvas.y + "px) scale(" + canvas.scale + ")";
        map.style.setProperty("--canvas-scale", String(canvas.scale));
        map.dataset.band = canvas.scale < 0.15 ? "far" : canvas.scale < 0.5 ? "mid" : "near";
        if (canvasScale) canvasScale.textContent = Math.round(canvas.scale * 100) + "%";
        scheduleImageScan();
      }

      // The frame fills the window below the view's header, so the page
      // itself does not scroll while the canvas is in use.
      function sizeCanvas() {
        const top = map.getBoundingClientRect().top + window.scrollY;
        map.style.height = Math.max(360, Math.round(window.innerHeight - top - 24)) + "px";
      }

      // Where a node sits on the board, in board units.
      function boardBox(node) {
        let left = 0;
        let top = 0;
        let current = node;
        while (current && current !== board) {
          left += current.offsetLeft;
          top += current.offsetTop;
          current = current.offsetParent;
        }
        return { left, top, width: node.offsetWidth, height: node.offsetHeight };
      }

      // Places boxes left to right in rows no wider than the target width.
      function packRows(boxes, target, gap) {
        let x = 0;
        let y = gap;
        let row = 0;
        let width = 0;
        const positions = [];
        for (const box of boxes) {
          if (x > 0 && x + box.width > target) {
            y += row + gap;
            x = 0;
            row = 0;
          }
          positions.push({ left: x, top: y });
          x += box.width + gap;
          row = Math.max(row, box.height);
          width = Math.max(width, x - gap);
        }
        return { positions, width, height: y + row };
      }

      // The row width that lets boxes packed with the gap fit the frame at the
      // largest scale, among a range from one long row to one column.
      function packToFit(boxes, gap, frameWidth, frameHeight) {
        const widest = Math.max(...boxes.map((box) => box.width));
        const total = boxes.reduce((sum, box) => sum + box.width + gap, 0);
        let pick = null;
        for (let step = 1; step <= 24; step += 1) {
          const packed = packRows(boxes, Math.max(widest, (total * step) / 24), gap);
          const scale = Math.min(frameWidth / packed.width, frameHeight / packed.height);
          if (!pick || scale > pick.scale) pick = { packed, scale };
        }
        return pick;
      }

      // Lays the canvas out in two levels: each section's groups in rows
      // shaped like the frame, so zooming to a section fills it, then the
      // sections the same way. A group is about half again as wide as it is
      // tall, and the gap between sections leaves room for a label at the
      // scale the whole map fits at.
      function layoutCanvas() {
        const frameWidth = Math.max(1, map.clientWidth);
        const frameHeight = Math.max(1, map.clientHeight);
        const boxes = [];
        for (const section of sectionElements) {
          if (section.element.hidden) continue;
          const groups = section.groups.filter((group) => !group.hidden);
          for (const group of groups) {
            const count = group.querySelectorAll(".screen-card:not([hidden])").length;
            group.style.setProperty("--cols", String(Math.max(1, Math.min(count, Math.ceil(Math.sqrt(count * 1.6))))));
          }
          const groupBoxes = groups.map((group) => ({ element: group, width: group.offsetWidth, height: group.offsetHeight }));
          if (groupBoxes.length === 0) continue;
          const inner = packToFit(groupBoxes, GROUP_GAP, frameWidth, frameHeight).packed;
          inner.positions.forEach((position, index) => {
            groupBoxes[index].element.style.left = position.left + "px";
            groupBoxes[index].element.style.top = position.top + "px";
          });
          section.element.style.width = inner.width + "px";
          section.element.style.height = inner.height + "px";
          boxes.push({ element: section.element, width: inner.width, height: inner.height });
        }
        let best = null;
        let gap = 160;
        if (boxes.length > 0) {
          for (let pass = 0; pass < 3; pass += 1) {
            best = Object.assign(packToFit(boxes, gap, frameWidth, frameHeight), { gap });
            gap = Math.max(GROUP_GAP, 48 / best.scale);
          }
          best.packed.positions.forEach((position, index) => {
            const box = boxes[index];
            box.element.style.left = position.left + "px";
            box.element.style.top = position.top + "px";
            const label = box.element.querySelector(":scope > h2");
            if (label) label.style.maxWidth = Math.round(box.width + best.gap * 0.8) + "px";
          });
        }
        canvas.width = best ? best.packed.width : 0;
        canvas.height = best ? best.packed.height : 0;
        board.style.width = canvas.width + "px";
        board.style.height = canvas.height + "px";
        canvas.laidOut = true;
      }

      function clampScale(value, max) {
        return Math.min(max === undefined ? 2 : max, Math.max(0.02, value));
      }

      function fitBox(box, padding, maxScale) {
        const frameWidth = map.clientWidth;
        const frameHeight = map.clientHeight;
        if (box.width <= 0 || box.height <= 0 || frameWidth <= 0 || frameHeight <= 0) return;
        const scale = clampScale(Math.min(
          (frameWidth - padding * 2) / box.width,
          (frameHeight - padding * 2) / box.height
        ), maxScale);
        canvas.scale = scale;
        canvas.x = (frameWidth - box.width * scale) / 2 - box.left * scale;
        canvas.y = (frameHeight - box.height * scale) / 2 - box.top * scale;
        applyTransform();
      }

      function fitAll() {
        fitBox({ left: 0, top: 0, width: canvas.width, height: canvas.height }, 24, 1);
      }

      function zoomAt(factor, clientX, clientY) {
        const frame = map.getBoundingClientRect();
        const x = clientX - frame.left;
        const y = clientY - frame.top;
        const next = clampScale(canvas.scale * factor);
        canvas.x = x - (x - canvas.x) * (next / canvas.scale);
        canvas.y = y - (y - canvas.y) * (next / canvas.scale);
        canvas.scale = next;
        applyTransform();
      }

      function zoomCenter(factor) {
        const frame = map.getBoundingClientRect();
        zoomAt(factor, frame.left + frame.width / 2, frame.top + frame.height / 2);
      }

      // Lays the canvas out again and fits it when it is on screen; otherwise
      // the next time it is.
      function refreshCanvas() {
        if (!canvas.active) return;
        canvas.laidOut = false;
        if (!canvasVisible()) return;
        sizeCanvas();
        layoutCanvas();
        fitAll();
      }

      // Brings a card into view, close enough to read, beside the detail
      // panel when it is open.
      function revealCard(card) {
        if (!canvasVisible() || card.hidden) return;
        const box = boardBox(card);
        const frame = map.getBoundingClientRect();
        const covered = detail && !detail.hidden
          ? Math.max(0, frame.right - detail.getBoundingClientRect().left)
          : 0;
        const usable = Math.max(1, frame.width - covered);
        const left = canvas.x + box.left * canvas.scale;
        const top = canvas.y + box.top * canvas.scale;
        const inView = left >= 0 && top >= 0 &&
          left + box.width * canvas.scale <= usable &&
          top + box.height * canvas.scale <= frame.height;
        if (inView && canvas.scale >= IMAGE_SCALE) return;
        canvas.scale = clampScale(Math.max(canvas.scale, 0.6));
        canvas.x = usable / 2 - (box.left + box.width / 2) * canvas.scale;
        canvas.y = frame.height / 2 - (box.top + box.height / 2) * canvas.scale;
        applyTransform();
      }

      // Loads the images of cards on screen once they are large enough to
      // see; an IntersectionObserver does not report cards that stay in view
      // while the canvas zooms.
      let imageScan = 0;
      function scheduleImageScan() {
        if (imageScan) return;
        imageScan = window.setTimeout(() => {
          imageScan = 0;
          if (!canvasVisible() || canvas.scale < IMAGE_SCALE) return;
          const frame = map.getBoundingClientRect();
          for (const image of board.querySelectorAll("img[data-src]")) {
            const box = image.parentElement.getBoundingClientRect();
            if (box.width === 0) continue;
            if (box.right > frame.left - 200 && box.left < frame.right + 200 &&
                box.bottom > frame.top - 200 && box.top < frame.bottom + 200) {
              if (imageObserver) imageObserver.unobserve(image);
              loadImage(image);
            }
          }
        }, 120);
      }

      function setView(view, updateHash) {
        shell.dataset.view = view;
        if (view === "screens") document.title = "Screens · Tieline spec review";
        for (const tab of tabs) {
          tab.setAttribute("aria-selected", String(tab.getAttribute("data-view-tab") === view));
        }
        if (view !== "screens") closeDetail(false);
        else if (canvas.active && !canvas.laidOut) refreshCanvas();
        if (updateHash && view === "screens") history.pushState(null, "", "#view/screens");
      }

      function definition(list, term, value) {
        if (value === null || value === undefined || value === "") return;
        const row = element("div");
        const dd = element("dd");
        if (value instanceof Node) dd.append(value);
        else dd.textContent = value;
        row.append(element("dt", "", term), dd);
        list.append(row);
      }

      function renderShot(screen) {
        const figure = document.getElementById("screen-detail-shot");
        figure.replaceChildren();
        figure.classList.remove("loaded");
        if (screen.before_image) figure.append(element("span", "shot-label", "After · this branch"));
        const caption = element("figcaption");
        caption.append(element("i", "", kindLabel(screen.kind)));
        if (screen.image) {
          caption.append(element("span", "", "Loading capture…"));
          const image = element("img");
          image.alt = "Screenshot of " + screen.title;
          image.addEventListener("load", () => {
            figure.classList.add("loaded");
            caption.remove();
          });
          image.addEventListener("error", () => {
            image.remove();
            caption.lastChild.textContent = "Capture not available: " + screen.image.label;
          });
          image.src = screen.image.src;
          figure.append(image, caption);
        } else if (screen.not_captured) {
          caption.append(element("span", "", "Not captured (" + screen.not_captured.reason + "): " + screen.not_captured.detail));
          figure.append(caption);
        } else {
          caption.append(element("span", "", "No capture recorded for this screen."));
          figure.append(caption);
        }
      }

      // "#71 · 2026-09-30 · 4 changes", beside a "Last changed" label.
      function lastChangedNode(history) {
        const node = element("span");
        if (history.url) {
          const link = element("a", "", history.label);
          link.href = history.url;
          link.rel = "noreferrer";
          node.append(link);
        } else {
          node.append(history.label);
        }
        const count = history.changes + (history.truncated ? "+" : "") + (history.changes === 1 && !history.truncated ? " change" : " changes");
        node.append(" · " + history.date + " · " + count);
        return node;
      }

      function renderBefore(screen) {
        const figure = document.getElementById("screen-detail-before");
        figure.replaceChildren();
        figure.classList.remove("loaded");
        figure.hidden = !screen.before_image;
        if (!screen.before_image) return;
        const label = screen.before_image.label;
        figure.append(element("span", "shot-label", "Before · " + label));
        const caption = element("figcaption");
        caption.append(element("span", "", "Loading the image on " + label + "…"));
        const image = element("img");
        image.alt = "Screenshot of " + screen.title + " on " + label;
        image.addEventListener("load", () => {
          figure.classList.add("loaded");
          caption.remove();
        });
        image.addEventListener("error", () => {
          image.remove();
          caption.lastChild.textContent = "The image on " + label + " is not available.";
        });
        image.src = screen.before_image.src;
        figure.append(image, caption);
      }

      function renderLinks(screen) {
        const section = document.getElementById("screen-detail-links");
        section.replaceChildren(element("h2", "", "Shown by Stories and acceptance criteria"));
        if (screen.shown_by.length === 0) {
          section.append(element("p", "detail-empty", "No Story or acceptance criterion links to this screen."));
          return;
        }
        const list = element("ul");
        for (const link of screen.shown_by) {
          const button = element("button", "detail-link");
          button.type = "button";
          button.append(
            element("code", "", link.criterion || link.story),
            element("b", "", link.criterion_text || link.story_title),
            element("small", "", link.criterion ? "Story: " + link.story_title : "Story-level link")
          );
          button.addEventListener("click", () => showStory(link.story, link.criterion));
          const item = element("li");
          item.append(button);
          list.append(item);
        }
        section.append(list);
      }

      function openDetail(key, updateHash) {
        const screen = byKey.get(key);
        if (!screen || !detail) return;
        if (shell.dataset.view !== "screens") setView("screens", false);
        if (detail.hidden) returnFocus = document.activeElement;
        current = key;
        for (const [cardKey, card] of cards) {
          if (cardKey === key) card.setAttribute("aria-current", "true");
          else card.removeAttribute("aria-current");
        }
        for (const button of results.querySelectorAll("button[data-key]")) {
          button.setAttribute("aria-current", String(button.dataset.key === key));
        }
        document.getElementById("screen-detail-crumbs").textContent =
          screen.capability_name + (screen.group ? " / " + screen.group : "");
        document.getElementById("screen-detail-title").textContent = screen.title;
        const sub = document.getElementById("screen-detail-sub");
        sub.replaceChildren(kindLabel(screen.kind) + " · ", element("code", "", screen.route));
        if (screen.change) sub.append(" ", changeTag(screen.change));
        document.getElementById("screen-detail-when").replaceChildren(
          element("b", "", "Appears when"),
          screen.when
        );
        document.title = screen.title + " · Tieline spec review";
        renderShot(screen);
        renderBefore(screen);
        // The caption already says why a screen has no image.
        const meta = document.getElementById("screen-detail-meta");
        meta.replaceChildren();
        const applies = Object.entries(screen.applies_to || {});
        definition(meta, "Applies to", applies.length > 0
          ? applies.map(([dimension, values]) => dimension + ": " + values.join(", ")).join("; ")
          : "Everyone");
        if (screen.last_changed) definition(meta, "Last changed", lastChangedNode(screen.last_changed));
        definition(meta, "Capability", screen.capability_name + " (" + screen.capability + ")");
        if (screen.image) definition(meta, "Image", screen.image.label);
        if (screen.capture_test) definition(meta, "Captured by", element("code", "", screen.capture_test));
        definition(meta, "Key", screen.key);
        const copy = document.getElementById("screen-detail-copy");
        copy.replaceChildren();
        if (screen.copy.length > 0) {
          copy.append(element("h2", "", "Key copy"));
          const list = element("ul", "copy-list");
          for (const text of screen.copy) list.append(element("li", "", text));
          copy.append(list);
        }
        renderLinks(screen);
        const order = visible.some((entry) => entry.key === key) ? visible : screens;
        const index = order.findIndex((entry) => entry.key === key);
        document.getElementById("screen-detail-position").textContent =
          (index + 1) + " of " + order.length;
        detail.hidden = false;
        document.getElementById("screen-detail-close").focus({ preventScroll: true });
        const card = cards.get(key);
        if (card && !card.hidden) {
          if (canvas.active) revealCard(card);
          else card.scrollIntoView({ block: "nearest" });
        }
        if (updateHash) history.pushState(null, "", "#screen/" + encodeURIComponent(key));
      }

      function closeDetail(updateHash) {
        if (!detail || detail.hidden) return;
        detail.hidden = true;
        current = null;
        for (const card of cards.values()) card.removeAttribute("aria-current");
        if (returnFocus && document.contains(returnFocus)) returnFocus.focus({ preventScroll: true });
        returnFocus = null;
        if (updateHash) history.pushState(null, "", "#view/screens");
      }

      function step(offset) {
        if (current === null) {
          // Nothing open yet: start from the first or the last screen shown.
          if (visible.length > 0) openDetail(visible[offset > 0 ? 0 : visible.length - 1].key, true);
          return;
        }
        const order = visible.some((entry) => entry.key === current) ? visible : screens;
        if (order.length === 0) return;
        const index = order.findIndex((entry) => entry.key === current);
        const next = order[(index + offset + order.length) % order.length];
        openDetail(next.key, true);
      }

      function showStory(storyKey, criterionKey) {
        const link = document.querySelector('[data-story-link][data-story-key="' + CSS.escape(storyKey) + '"]');
        setView("stories", false);
        if (link) link.click();
        if (criterionKey) {
          const target = document.getElementById(criterionKey);
          if (target) target.scrollIntoView({ block: "start" });
        }
      }

      function routeFromHash() {
        let hash = "";
        try {
          hash = decodeURIComponent(location.hash.slice(1));
        } catch {
          return;
        }
        // Story keys cannot contain "/", so view routes never collide with one.
        if (hash === "view/screens") {
          setView("screens", false);
          closeDetail(false);
        } else if (hash.startsWith("screen/")) {
          openDetail(hash.slice("screen/".length), false);
        } else {
          setView("stories", false);
        }
      }

      for (const tab of tabs) {
        tab.addEventListener("click", () => {
          const view = tab.getAttribute("data-view-tab");
          setView(view, true);
          if (view === "stories") {
            const selected = document.querySelector('[data-story-link][aria-current="page"]');
            if (selected) history.pushState(null, "", "#" + selected.dataset.storyKey);
          }
        });
      }
      for (const input of [search, linkedFilter, changeFilter, captureFilter, ...kindFilters, ...dimensionFilters]) {
        if (input) input.addEventListener(input === search ? "input" : "change", applyFilters);
      }
      for (const button of coverageButtons) {
        button.addEventListener("click", () => {
          if (linkedFilter) linkedFilter.value = button.getAttribute("data-coverage-filter") || "";
          applyFilters();
        });
      }
      if (changeToggle && changeFilter) {
        changeToggle.addEventListener("click", () => {
          changeFilter.value = changeFilter.value === "changed" ? "" : "changed";
          applyFilters();
        });
      }
      if (clear) {
        clear.addEventListener("click", () => {
          for (const input of kindFilters) input.checked = false;
          for (const select of dimensionFilters) select.value = "";
          if (linkedFilter) linkedFilter.value = "";
          if (changeFilter) changeFilter.value = "";
          if (captureFilter) captureFilter.value = "";
          if (search) search.value = "";
          applyFilters();
        });
      }
      if (outline) {
        outline.addEventListener("click", (event) => {
          const link = event.target.closest("[data-outline-section]");
          if (!link) return;
          event.preventDefault();
          const section = map && map.querySelector('[data-section="' + CSS.escape(link.getAttribute("data-outline-section")) + '"]');
          const group = link.hasAttribute("data-outline-group") && section
            ? section.querySelector('[data-group="' + link.getAttribute("data-outline-group") + '"]')
            : section;
          if (!group) return;
          if (canvas.active) {
            const box = boardBox(group);
            fitBox({ left: box.left, top: box.top - 48 / canvas.scale, width: box.width, height: box.height + 48 / canvas.scale }, 32, 1);
          } else {
            group.scrollIntoView({ block: "start" });
          }
        });
      }
      if (zoom && map) {
        zoom.addEventListener("input", applyZoom);
        applyZoom();
      }
      for (const button of layoutButtons) {
        button.addEventListener("click", () => setLayout(button.getAttribute("data-layout-choice"), true));
      }
      if (map && board && canvasTools) {
        document.getElementById("canvas-zoom-in").addEventListener("click", () => zoomCenter(1.25));
        document.getElementById("canvas-zoom-out").addEventListener("click", () => zoomCenter(0.8));
        document.getElementById("canvas-fit").addEventListener("click", fitAll);
        // A plain wheel or two-finger scroll pans; with Ctrl or Cmd, or a
        // pinch, it zooms around the pointer.
        map.addEventListener("wheel", (event) => {
          if (!canvas.active) return;
          event.preventDefault();
          if (event.ctrlKey || event.metaKey) {
            zoomAt(Math.exp(-event.deltaY * 0.01), event.clientX, event.clientY);
          } else {
            canvas.x -= event.deltaX;
            canvas.y -= event.deltaY;
            applyTransform();
          }
        }, { passive: false });
        // Dragging pans. A press that moves less than a few pixels stays a
        // click, so a card still opens.
        let drag = null;
        let suppressClick = false;
        map.addEventListener("pointerdown", (event) => {
          if (!canvas.active || event.button !== 0 || event.target.closest(".canvas-tools")) return;
          drag = { id: event.pointerId, x: event.clientX, y: event.clientY, originX: canvas.x, originY: canvas.y, moved: false };
        });
        map.addEventListener("pointermove", (event) => {
          if (!drag || event.pointerId !== drag.id) return;
          const dx = event.clientX - drag.x;
          const dy = event.clientY - drag.y;
          if (!drag.moved) {
            if (Math.hypot(dx, dy) < 4) return;
            drag.moved = true;
            map.setPointerCapture(drag.id);
            map.classList.add("panning");
          }
          canvas.x = drag.originX + dx;
          canvas.y = drag.originY + dy;
          applyTransform();
        });
        const endDrag = (event) => {
          if (!drag || event.pointerId !== drag.id) return;
          suppressClick = drag.moved;
          map.classList.remove("panning");
          drag = null;
        };
        map.addEventListener("pointerup", endDrag);
        map.addEventListener("pointercancel", endDrag);
        map.addEventListener("click", (event) => {
          if (!suppressClick) return;
          suppressClick = false;
          event.preventDefault();
          event.stopPropagation();
        }, true);
        // The canvas moves by transform only; undo any scroll the browser
        // makes to show a focused card, and show it by panning instead.
        map.addEventListener("scroll", () => {
          if (!canvas.active) return;
          map.scrollTop = 0;
          map.scrollLeft = 0;
        });
        map.addEventListener("focusin", (event) => {
          const card = event.target.closest(".screen-card");
          if (canvas.active && card) revealCard(card);
        });
        let resizeTimer = 0;
        window.addEventListener("resize", () => {
          if (!canvas.active) return;
          window.clearTimeout(resizeTimer);
          resizeTimer = window.setTimeout(() => {
            if (narrowScreen()) setLayout("grid", false);
            else refreshCanvas();
          }, 150);
        });
        // Opening or closing a list above the map moves it; fit it again.
        document.addEventListener("toggle", (event) => {
          if (canvas.active && event.target.closest && event.target.closest(".wiki-content")) refreshCanvas();
        }, true);
      }
      document.getElementById("screen-detail-prev").addEventListener("click", () => step(-1));
      document.getElementById("screen-detail-next").addEventListener("click", () => step(1));
      document.getElementById("screen-detail-close").addEventListener("click", () => closeDetail(true));
      document.addEventListener("click", (event) => {
        const chip = event.target.closest("[data-open-screen]");
        if (chip) {
          event.preventDefault();
          openDetail(chip.getAttribute("data-open-screen"), true);
          return;
        }
        const jump = event.target.closest("[data-story-jump]");
        if (jump) {
          event.preventDefault();
          showStory(jump.getAttribute("data-story-jump"), null);
        }
      });
      // Registered in the capture phase so that, while the Screens view is
      // open, the Stories view's own shortcuts never see a key press: its "/"
      // shortcut would otherwise swallow a slash typed into the screen search.
      window.addEventListener("keydown", (event) => {
        if (shell.dataset.view !== "screens") return;
        event.stopPropagation();
        const typing = event.target instanceof HTMLElement &&
          (event.target.matches("input, select, textarea") || event.target.isContentEditable);
        if (typing) {
          if (event.key === "Escape" && event.target === search) {
            search.value = "";
            search.blur();
            applyFilters();
          }
          return;
        }
        if (event.key === "/") {
          event.preventDefault();
          if (search) search.focus();
        } else if (event.key === "Escape") closeDetail(true);
        else if (event.key === "ArrowRight" || event.key === "j") step(1);
        else if (event.key === "ArrowLeft" || event.key === "k") step(-1);
        else if ((event.key === "+" || event.key === "=") && canvas.active) zoomCenter(1.25);
        else if (event.key === "-" && canvas.active) zoomCenter(0.8);
        else if (event.key === "0" && canvas.active) fitAll();
        else if ((event.key === "+" || event.key === "=") && zoom) {
          zoom.value = String(Math.min(4, Number(zoom.value) + 1));
          zoom.dispatchEvent(new Event("input"));
        } else if (event.key === "-" && zoom) {
          zoom.value = String(Math.max(1, Number(zoom.value) - 1));
          zoom.dispatchEvent(new Event("input"));
        }
      }, true);
      const storyContent = document.getElementById("story-content");
      if (storyContent) {
        observeImages(storyContent);
        new MutationObserver(() => observeImages(storyContent))
          .observe(storyContent, { childList: true, subtree: true });
      }
      window.addEventListener("popstate", routeFromHash);
      setLayout(savedLayout(), false);
      applyFilters();
      routeFromHash();
    })();
`;
