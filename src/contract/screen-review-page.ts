import { escapeHtml } from "./html.js";
import type { ReviewChangeIndex } from "./review-changes-page.js";
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
  locator: { path: string } | { url: string } | undefined,
  capturesUrl: string
): ScreenReviewEntry["image"] {
  if (!locator) return null;
  if ("url" in locator) return { src: locator.url, label: locator.url };
  return {
    src: `${capturesUrl}${locator.path.split("/").map(encodeURIComponent).join("/")}`,
    label: locator.path,
  };
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
          image: imageSource(entry.image, screens.capturesUrl),
          shown_by: shownBy.get(entry.key) ?? [],
          ...changeOf(changes, entry.key),
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

/**
 * The screens linked to one Story or AC, as compact chips that open the screen
 * in the Screens view. Thumbnails load only when scrolled into view.
 */
export function renderShownScreens(
  model: ScreenReviewModel,
  owner: string,
  label: string
): string {
  const keys = model.shownByOwner.get(owner);
  if (!keys || keys.length === 0) return "";
  const byKey = new Map(model.screens.map((entry) => [entry.key, entry]));
  return `<div class="shown-screens">
    <h3>${escapeHtml(label)} <span>${keys.length}</span></h3>
    <div class="shown-screen-list">${keys
      .map((key) => byKey.get(key))
      .filter((entry): entry is ScreenReviewEntry => entry !== undefined)
      .map(
        (entry) => `<button type="button" class="screen-chip" data-open-screen="${escapeHtml(entry.key)}">
        <span class="chip-shot" data-kind="${entry.kind}">${
          entry.image
            ? `<img data-src="${escapeHtml(entry.image.src)}" alt="">`
            : ""
        }<i aria-hidden="true">${escapeHtml(KIND_LABELS[entry.kind])}</i></span>
        <span class="chip-text"><b>${escapeHtml(entry.title)}</b><small>${escapeHtml(KIND_LABELS[entry.kind])} · ${escapeHtml(entry.route)}</small></span>
      </button>`
      )
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
          <a href="#screens" data-outline-section="${escapeHtml(section.capability)}">${escapeHtml(section.name)}<small>${section.groups.reduce((total, group) => total + group.screens.length, 0)}</small></a>
          ${
            section.groups.some((group) => group.name !== null)
              ? `<ul>${section.groups
                  .map(
                    (group, index) =>
                      `<li><a href="#screens" data-outline-section="${escapeHtml(section.capability)}" data-outline-group="${index}">${escapeHtml(group.name ?? "Ungrouped")}<small>${group.screens.length}</small></a></li>`
                  )
                  .join("")}</ul>`
              : ""
          }
        </li>`
    )
    .join("");
  return `      <div class="screen-panel">
        <label class="search">
          <input id="screen-search" type="search" placeholder="Search screens…" autocomplete="off" aria-controls="screen-results">
          <span aria-hidden="true">⌕</span>
        </label>
        <details class="screen-filters" open>
          <summary>Filters</summary>
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
          <button type="button" class="clear-filters" id="screen-clear-filters">Clear filters</button>
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
      : `<div class="screens-map" id="screens-map" aria-label="Screen map"></div>`;
  return `<section class="screens-view" id="screens-view" aria-label="Screens">
          <header class="screens-header">
            <p class="breadcrumbs"><span>Screens</span><b>/</b>All capabilities</p>
            <h1>Screens</h1>
            <div class="coverage" aria-label="Screen coverage">
              <button type="button" data-coverage-filter=""><b>${coverage.screens}</b> screens</button>
              <button type="button" data-coverage-filter="linked"><b>${coverage.linked_screens}</b> shown by Stories</button>
              <button type="button" data-coverage-filter="unlinked"><b>${coverage.unlinked_screens}</b> with no links</button>
            </div>
            ${storiesWithout}
            <div class="map-tools">
              <span id="screen-visible-count"></span>
              <label class="zoom">
                <span>Zoom</span>
                <input id="screen-zoom" type="range" min="1" max="4" step="1" value="2" aria-label="Thumbnail size">
              </label>
            </div>
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
            <code id="screen-detail-key"></code>
            <h1 id="screen-detail-title"></h1>
            <figure class="detail-shot" id="screen-detail-shot"></figure>
            <dl class="detail-meta" id="screen-detail-meta"></dl>
            <section class="detail-section" id="screen-detail-copy"></section>
            <section class="detail-section" id="screen-detail-links"></section>
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
      gap: .25rem;
      margin: 1rem .15rem 0;
      padding: .2rem;
      background: #e9ebee;
      border-radius: 6px;
    }
    .view-tabs button {
      padding: .35rem .5rem;
      color: var(--muted);
      background: transparent;
      border: 0;
      border-radius: 4px;
      cursor: pointer;
      font-size: .74rem;
      font-weight: 700;
    }
    .view-tabs button[aria-selected="true"] {
      color: var(--ink);
      background: white;
      box-shadow: 0 1px 2px rgba(9, 30, 66, .15);
    }
    .view-tabs span {
      margin-left: .25rem;
      color: #858d98;
      font: .62rem var(--mono);
    }
    .screen-panel, .screens-view { display: none; }
    .wiki-shell[data-view="screens"] .screen-panel,
    .wiki-shell[data-view="screens"] .screens-view { display: block; }
    .wiki-shell[data-view="screens"] .wiki-nav > .search,
    .wiki-shell[data-view="screens"] .wiki-nav > nav,
    .wiki-shell[data-view="screens"] .wiki-nav > .nav-empty,
    .wiki-shell[data-view="screens"] #story-content { display: none; }
    .wiki-shell[data-view="screens"] .wiki-content { max-width: none; }
    .screen-filters { margin: 0 .15rem; font-size: .72rem; }
    .screen-filters summary {
      color: var(--muted);
      cursor: pointer;
      font-size: .66rem;
      font-weight: 800;
      letter-spacing: .055em;
      text-transform: uppercase;
    }
    .screen-filters fieldset {
      display: flex;
      flex-wrap: wrap;
      gap: .25rem;
      margin: .5rem 0 0;
      padding: 0;
      border: 0;
    }
    .screen-filters legend {
      margin-bottom: .25rem;
      color: var(--muted);
      font-size: .66rem;
      font-weight: 700;
    }
    .kind-filter {
      display: inline-flex;
      align-items: center;
      gap: .25rem;
      padding: .12rem .4rem;
      background: white;
      border: 1px solid #cfd2d7;
      border-radius: 12px;
      cursor: pointer;
    }
    .kind-filter input { margin: 0; }
    .kind-filter small { color: #858d98; font-family: var(--mono); }
    .filter-select {
      display: grid;
      grid-template-columns: 64px minmax(0, 1fr);
      align-items: center;
      gap: .4rem;
      margin-top: .45rem;
    }
    .filter-select span {
      color: var(--muted);
      font-weight: 700;
      overflow-wrap: anywhere;
      text-transform: capitalize;
    }
    .filter-select select {
      min-width: 0;
      padding: .2rem;
      background: white;
      border: 1px solid #cfd2d7;
      border-radius: 4px;
      font: inherit;
    }
    .clear-filters {
      margin-top: .55rem;
      padding: .2rem .5rem;
      color: var(--muted);
      background: white;
      border: 1px solid #cfd2d7;
      border-radius: 4px;
      cursor: pointer;
      font-size: .68rem;
    }
    .screen-result-count {
      margin: 1rem .45rem .35rem;
      color: var(--muted);
      font-size: .7rem;
    }
    .screen-results, .screen-outline ul {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .screen-results button {
      display: grid;
      width: 100%;
      gap: .05rem;
      padding: .38rem .45rem;
      color: #424852;
      background: transparent;
      border: 0;
      border-radius: 4px;
      cursor: pointer;
      text-align: left;
    }
    .screen-results button:hover { background: #e9ebee; }
    .screen-results button[aria-current="true"] {
      color: var(--accent);
      background: #e9f2ff;
      box-shadow: inset 3px 0 var(--accent);
    }
    .screen-results b { font-size: .75rem; font-weight: 600; line-height: 1.35; }
    .screen-results code, .screen-results small { color: #8a919c; font-size: .59rem; }
    .screen-results .more { padding: .4rem .45rem; color: var(--muted); font-size: .68rem; }
    .screen-outline > ul > li { margin-top: .55rem; }
    .screen-outline a {
      display: flex;
      justify-content: space-between;
      gap: .5rem;
      padding: .25rem .45rem;
      color: #424852;
      border-radius: 4px;
      font-size: .75rem;
      text-decoration: none;
    }
    .screen-outline > ul > li > a { font-weight: 700; }
    .screen-outline ul ul a { padding-left: 1.1rem; color: var(--muted); font-size: .71rem; }
    .screen-outline a:hover { background: #e9ebee; }
    .screen-outline small { color: #8a919c; font-family: var(--mono); }
    .screens-header {
      padding-bottom: 1rem;
      border-bottom: 1px solid var(--line);
    }
    .screens-header h1 {
      margin: .35rem 0 .75rem;
      font-size: clamp(1.45rem, 2.5vw, 1.85rem);
      line-height: 1.2;
      letter-spacing: -.015em;
    }
    .coverage { display: flex; flex-wrap: wrap; gap: .4rem; }
    .coverage button {
      padding: .3rem .6rem;
      color: var(--muted);
      background: #f7f8fa;
      border: 1px solid var(--line);
      border-radius: 4px;
      cursor: pointer;
      font-size: .74rem;
    }
    .coverage button[aria-pressed="true"] {
      color: var(--accent);
      background: #e9f2ff;
      border-color: #a9c8f5;
    }
    .coverage b { color: var(--ink); font-family: var(--mono); }
    .coverage-stories { margin: .65rem 0 0; color: var(--muted); font-size: .76rem; }
    .coverage-stories summary { cursor: pointer; }
    .coverage-stories ul { margin: .4rem 0 0; padding-left: 1.2rem; columns: 2 280px; }
    .coverage-stories li { margin-bottom: .2rem; }
    .map-tools {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: .75rem;
      margin-top: .85rem;
      color: var(--muted);
      font-size: .74rem;
    }
    .zoom { display: inline-flex; align-items: center; gap: .45rem; }
    .screens-map { --screen-card: 168px; }
    .screen-section { margin-top: 1.25rem; }
    .screen-section[hidden], .screen-group[hidden], .screen-card[hidden] { display: none; }
    .screen-section > h2 {
      position: sticky;
      top: 0;
      z-index: 2;
      display: flex;
      align-items: baseline;
      gap: .5rem;
      margin: 0;
      padding: .6rem 0 .45rem;
      background: rgba(255, 255, 255, .96);
      border-bottom: 1px solid var(--line);
      font-size: .95rem;
    }
    .screen-section > h2 small, .screen-group > h3 small {
      color: #858d98;
      font: .64rem var(--mono);
    }
    .screen-group { margin-top: .75rem; }
    .screen-group > h3 {
      position: sticky;
      top: 2.35rem;
      z-index: 1;
      margin: 0 0 .45rem;
      padding: .2rem 0;
      color: var(--muted);
      background: rgba(255, 255, 255, .92);
      font-size: .68rem;
      font-weight: 800;
      letter-spacing: .055em;
      text-transform: uppercase;
    }
    .screen-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(var(--screen-card), 1fr));
      gap: .65rem;
    }
    .screen-card {
      display: grid;
      align-content: start;
      min-width: 0;
      padding: 0;
      color: inherit;
      background: white;
      border: 1px solid var(--line);
      border-radius: 6px;
      cursor: pointer;
      overflow: hidden;
      text-align: left;
    }
    .screen-card:hover { border-color: #a9c8f5; box-shadow: 0 1px 3px rgba(9, 30, 66, .12); }
    .screen-card[aria-current="true"] { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(12, 102, 228, .25); }
    .shot, .chip-shot, .detail-shot {
      position: relative;
      display: grid;
      place-items: center;
      overflow: hidden;
      background:
        repeating-linear-gradient(135deg, #f4f5f7 0 8px, #eceef1 8px 16px);
    }
    .shot { aspect-ratio: 16 / 10; border-bottom: 1px solid var(--line); }
    .shot img, .chip-shot img {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      object-position: top;
      background: white;
      opacity: 0;
    }
    .shot.loaded img, .chip-shot.loaded img { opacity: 1; }
    .shot i, .chip-shot i, .detail-shot i {
      padding: .1rem .4rem;
      color: var(--muted);
      background: rgba(255, 255, 255, .85);
      border-radius: 3px;
      font: 700 .6rem var(--mono);
      font-style: normal;
      text-transform: uppercase;
    }
    .shot.loaded i, .chip-shot.loaded i { display: none; }
    .card-body { display: grid; gap: .2rem; padding: .5rem .55rem .6rem; min-width: 0; }
    .card-body b { font-size: .76rem; line-height: 1.3; }
    .card-body code { color: #6b7380; font-size: .6rem; }
    .card-meta { display: flex; flex-wrap: wrap; gap: .25rem; }
    .kind-tag, .applies-tag {
      padding: .05rem .35rem;
      color: var(--muted);
      background: #f0f1f3;
      border-radius: 3px;
      font-size: .6rem;
    }
    .kind-tag { font-weight: 700; }
    .links-tag { color: var(--green); background: #e7f3ed; }
    .unlinked-tag { color: #8a5a00; background: #fff6e2; }
    .screens-map[data-zoom="1"] .card-body { padding: .3rem .35rem .35rem; }
    .screens-map[data-zoom="1"] .card-body code,
    .screens-map[data-zoom="1"] .card-meta { display: none; }
    .screens-map[data-zoom="1"] .card-body b {
      overflow: hidden;
      font-size: .6rem;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .screens-map[data-zoom="1"] .screen-grid { gap: .4rem; }
    .screens-map[data-zoom="1"] .shot i { font-size: .45rem; }
    .screen-detail {
      position: fixed;
      top: 0;
      right: 0;
      z-index: 10;
      width: min(760px, 94vw);
      height: 100vh;
      background: white;
      border-left: 1px solid var(--line);
      box-shadow: -8px 0 24px rgba(9, 30, 66, .15);
      overflow-y: auto;
    }
    .screen-detail[hidden] { display: none; }
    .detail-bar {
      position: sticky;
      top: 0;
      z-index: 1;
      display: flex;
      align-items: center;
      gap: .4rem;
      padding: .55rem .9rem;
      background: #fafbfc;
      border-bottom: 1px solid var(--line);
      font-size: .74rem;
    }
    .detail-bar span { flex: 1; color: var(--muted); }
    .detail-bar button {
      min-width: 30px;
      padding: .2rem .45rem;
      background: white;
      border: 1px solid #cfd2d7;
      border-radius: 4px;
      cursor: pointer;
    }
    .detail-body { padding: 1.1rem 1.25rem 3rem; }
    .detail-body h1 { margin: .3rem 0 .9rem; font-size: 1.3rem; line-height: 1.25; }
    .detail-shot {
      min-height: 180px;
      margin: 0;
      border: 1px solid var(--line);
      border-radius: 6px;
    }
    .detail-shot img { display: block; width: 100%; height: auto; }
    .detail-shot figcaption {
      display: grid;
      gap: .35rem;
      justify-items: center;
      padding: 1.5rem;
      color: var(--muted);
      font-size: .74rem;
      text-align: center;
    }
    .detail-shot.loaded { background: white; }
    .detail-meta { margin: 1rem 0 0; }
    .detail-meta > div {
      display: grid;
      grid-template-columns: 96px minmax(0, 1fr);
      gap: .65rem;
      padding: .5rem 0;
      border-top: 1px solid var(--line);
    }
    .detail-meta dt { color: var(--muted); font-size: .68rem; font-weight: 700; }
    .detail-meta dd { min-width: 0; margin: 0; font-size: .76rem; overflow-wrap: anywhere; }
    .detail-section h2 { margin: 1.25rem 0 .5rem; font-size: .86rem; }
    .detail-section ul { display: grid; gap: .35rem; margin: 0; padding: 0; list-style: none; }
    .detail-section li { font-size: .76rem; }
    .copy-list li {
      padding: .4rem .55rem;
      background: #f7f8fa;
      border-left: 2px solid #c9983c;
    }
    .detail-link {
      display: grid;
      width: 100%;
      gap: .1rem;
      padding: .45rem .55rem;
      color: inherit;
      background: white;
      border: 1px solid var(--line);
      border-radius: 4px;
      cursor: pointer;
      text-align: left;
    }
    .detail-link:hover { border-color: #a9c8f5; }
    .detail-link code { color: var(--muted); }
    .detail-empty { color: var(--muted); font-size: .76rem; }
    .shown-screens { margin-top: .8rem; }
    .shown-screens h3 {
      display: flex;
      align-items: center;
      gap: .45rem;
      margin: 0 0 .45rem;
      color: var(--muted);
      font-size: .72rem;
    }
    .shown-screens h3 span {
      min-width: 19px;
      padding: 0 .3rem;
      color: #858d98;
      background: #f0f1f3;
      border-radius: 9px;
      font: .6rem/18px var(--mono);
      text-align: center;
    }
    .shown-screen-list { display: flex; flex-wrap: wrap; gap: .45rem; }
    .screen-chip {
      display: grid;
      grid-template-columns: 64px minmax(0, 1fr);
      align-items: center;
      gap: .5rem;
      width: 250px;
      max-width: 100%;
      padding: .3rem;
      color: inherit;
      background: white;
      border: 1px solid var(--line);
      border-radius: 5px;
      cursor: pointer;
      text-align: left;
    }
    .screen-chip:hover { border-color: #a9c8f5; }
    .chip-shot { width: 64px; aspect-ratio: 16 / 10; border-radius: 3px; }
    .chip-shot i { font-size: .45rem; }
    .chip-text { display: grid; min-width: 0; }
    .chip-text b { overflow: hidden; font-size: .72rem; text-overflow: ellipsis; white-space: nowrap; }
    .chip-text small { overflow: hidden; color: var(--muted); font-size: .62rem; text-overflow: ellipsis; white-space: nowrap; }
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
      const results = document.getElementById("screen-results");
      const outline = document.getElementById("screen-outline");
      const resultCount = document.getElementById("screen-result-count");
      const visibleCount = document.getElementById("screen-visible-count");
      const zoom = document.getElementById("screen-zoom");
      const detail = document.getElementById("screen-detail");
      const tabs = [...document.querySelectorAll("[data-view-tab]")];
      const RESULT_LIMIT = 200;
      const ZOOM_WIDTHS = ["80px", "168px", "240px", "360px"];
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
        image.addEventListener("error", () => image.remove());
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
        return change.aspects.length > 0 ? status + ": " + change.aspects.join(", ") : status;
      }

      function changeTag(change) {
        return element("span", "change-badge change-" + change.status, changeLabel(change));
      }

      function searchText(screen) {
        return [
          screen.key, screen.title, screen.route, screen.when, screen.group || "",
          screen.capability, screen.capability_name, kindLabel(screen.kind),
          ...(screen.copy || []),
          ...Object.entries(screen.applies_to || {}).flat(2),
        ].join(" ").toLocaleLowerCase("en");
      }

      function renderCard(screen) {
        const card = element("button", "screen-card");
        card.type = "button";
        card.dataset.key = screen.key;
        card.setAttribute("aria-label", screen.title + ", " + kindLabel(screen.kind));
        const shot = element("span", "shot");
        shot.dataset.kind = screen.kind;
        if (screen.image) {
          const image = element("img");
          image.alt = "";
          image.setAttribute("data-src", screen.image.src);
          shot.append(image);
        }
        shot.append(element("i", "", kindLabel(screen.kind)));
        const body = element("span", "card-body");
        body.append(element("b", "", screen.title), element("code", "", screen.route));
        const meta = element("span", "card-meta");
        if (screen.change) meta.append(changeTag(screen.change));
        meta.append(element("span", "kind-tag", kindLabel(screen.kind)));
        for (const [dimension, values] of Object.entries(screen.applies_to || {})) {
          meta.append(element("span", "applies-tag", dimension + ": " + values.join(", ")));
        }
        meta.append(screen.shown_by.length > 0
          ? element("span", "applies-tag links-tag", screen.shown_by.length + " linked")
          : element("span", "applies-tag unlinked-tag", "no links"));
        body.append(meta);
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
          map.append(sectionElement);
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
        };
      }

      function matches(screen, filters) {
        if (filters.kinds.size > 0 && !filters.kinds.has(screen.kind)) return false;
        if (filters.linked === "linked" && screen.shown_by.length === 0) return false;
        if (filters.linked === "unlinked" && screen.shown_by.length > 0) return false;
        if (filters.changed === "changed" && !screen.change) return false;
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
          resultCount.textContent = screens.length + " screens";
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
          filters.dimensions.length > 0 || Boolean(filters.linked) || Boolean(filters.changed);
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
        if (visibleCount) {
          visibleCount.textContent = "Showing " + visible.length + " of " + screens.length + " screens";
        }
        if (results) renderResults(filters, active);
      }

      function setView(view, updateHash) {
        shell.dataset.view = view;
        if (view === "screens") document.title = "Screens · Tieline spec review";
        for (const tab of tabs) {
          tab.setAttribute("aria-selected", String(tab.getAttribute("data-view-tab") === view));
        }
        if (view !== "screens") closeDetail(false);
        if (updateHash && view === "screens") history.pushState(null, "", "#screens");
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
        } else {
          caption.append(element("span", "", "No capture recorded for this screen."));
          figure.append(caption);
        }
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
        document.getElementById("screen-detail-key").textContent = screen.key;
        document.getElementById("screen-detail-title").textContent = screen.title;
        document.title = screen.title + " · Tieline spec review";
        renderShot(screen);
        const meta = document.getElementById("screen-detail-meta");
        meta.replaceChildren();
        if (screen.change) definition(meta, "On this branch", changeTag(screen.change));
        definition(meta, "Kind", kindLabel(screen.kind));
        definition(meta, "Route", screen.route);
        definition(meta, "Appears when", screen.when);
        const applies = Object.entries(screen.applies_to || {});
        definition(meta, "Applies to", applies.length > 0
          ? applies.map(([dimension, values]) => dimension + ": " + values.join(", ")).join("; ")
          : "Everyone");
        definition(meta, "Capability", screen.capability_name + " (" + screen.capability + ")");
        definition(meta, "Image", screen.image ? screen.image.label : "None");
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
        if (card && !card.hidden) card.scrollIntoView({ block: "nearest" });
        if (updateHash) history.pushState(null, "", "#screen/" + encodeURIComponent(key));
      }

      function closeDetail(updateHash) {
        if (!detail || detail.hidden) return;
        detail.hidden = true;
        current = null;
        for (const card of cards.values()) card.removeAttribute("aria-current");
        if (returnFocus && document.contains(returnFocus)) returnFocus.focus({ preventScroll: true });
        returnFocus = null;
        if (updateHash) history.pushState(null, "", "#screens");
      }

      function step(offset) {
        if (current === null) return;
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
        if (hash === "screens") {
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
      for (const input of [search, linkedFilter, changeFilter, ...kindFilters, ...dimensionFilters]) {
        if (input) input.addEventListener(input === search ? "input" : "change", applyFilters);
      }
      for (const button of coverageButtons) {
        button.addEventListener("click", () => {
          if (linkedFilter) linkedFilter.value = button.getAttribute("data-coverage-filter") || "";
          applyFilters();
        });
      }
      const clear = document.getElementById("screen-clear-filters");
      if (clear) {
        clear.addEventListener("click", () => {
          for (const input of kindFilters) input.checked = false;
          for (const select of dimensionFilters) select.value = "";
          if (linkedFilter) linkedFilter.value = "";
          if (changeFilter) changeFilter.value = "";
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
          if (group) group.scrollIntoView({ block: "start" });
        });
      }
      if (zoom && map) {
        const applyZoom = () => {
          map.dataset.zoom = zoom.value;
          map.style.setProperty("--screen-card", ZOOM_WIDTHS[Number(zoom.value) - 1] || ZOOM_WIDTHS[1]);
        };
        zoom.addEventListener("input", applyZoom);
        applyZoom();
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
      applyFilters();
      routeFromHash();
    })();
`;
