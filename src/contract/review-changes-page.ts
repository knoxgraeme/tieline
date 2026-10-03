import { escapeHtml } from "./html.js";
import type {
  ContractRecordChange,
  ReviewChanges,
  ReviewChangeStatus,
  ScreenRecordChange,
} from "./review-changes.js";

/**
 * The branch-changes layer of the review page, rendered only when the page is
 * built against a base ref. The whole contract stays navigable; changed
 * records are badged and summarized rather than shown in isolation.
 */

export interface ReviewChangeIndex {
  changes: ReviewChanges;
  records: ReadonlyMap<string, ContractRecordChange>;
  screens: ReadonlyMap<string, ScreenRecordChange>;
  /** Stories whose own record or any of whose criteria changed. */
  stories: ReadonlyMap<string, ReviewChangeStatus>;
}

const STATUS_LABELS: Record<ReviewChangeStatus, string> = {
  added: "New",
  changed: "Changed",
  removed: "Removed",
};

/** Lists open by default only while they are short enough to scan. */
const OPEN_LIST_LIMIT = 8;

export function indexReviewChanges(changes: ReviewChanges): ReviewChangeIndex {
  const records = new Map(changes.records.map((record) => [record.stable_id, record]));
  const stories = new Map<string, ReviewChangeStatus>();
  for (const record of changes.records) {
    if (record.kind === "story") {
      if (record.status !== "removed") stories.set(record.stable_id, record.status);
    } else if (!stories.has(record.story_stable_id)) {
      stories.set(record.story_stable_id, "changed");
    }
  }
  return {
    changes,
    records,
    screens: new Map(changes.screens.map((screen) => [screen.stable_id, screen])),
    stories,
  };
}

function aspectText(aspects: readonly string[]): string {
  return aspects.length > 0 ? ` (${aspects.join(", ")})` : "";
}

export function renderChangeBadge(
  change: { status: ReviewChangeStatus; aspects: readonly string[] } | undefined
): string {
  if (!change) return "";
  return ` <span class="change-badge change-${change.status}" title="${escapeHtml(
    `${STATUS_LABELS[change.status]} on this branch${aspectText(change.aspects)}`
  )}">${STATUS_LABELS[change.status]}</span>`;
}

/** The attribute that badges a Story in the navigation. */
export function renderStoryChangeAttribute(index: ReviewChangeIndex, storyKey: string): string {
  const status = index.stories.get(storyKey);
  return status ? ` data-change="${status}"` : "";
}

function recordItem(record: ContractRecordChange): string {
  const label = escapeHtml(record.stable_id);
  const target =
    record.status === "removed"
      ? `<code>${label}</code>`
      : `<a href="#${escapeHtml(record.story_stable_id)}" data-change-link><code>${label}</code></a>`;
  const title = escapeHtml(`${record.title}${aspectText(record.aspects)}`);
  return `<li class="changed-${record.status}">${renderChangeBadge(record)} ${target} <span title="${title}">${title}</span></li>`;
}

function screenItem(screen: ScreenRecordChange, linkable: boolean): string {
  const label = `<code>${escapeHtml(screen.stable_id)}</code>`;
  const target =
    linkable && screen.status !== "removed"
      ? `<a href="#screen/${encodeURIComponent(screen.stable_id)}" data-change-link>${label}</a>`
      : label;
  const title = escapeHtml(`${screen.title}${aspectText(screen.aspects)}`);
  return `<li class="changed-${screen.status}">${renderChangeBadge(screen)} ${target} <span title="${title}">${title}</span></li>`;
}

function changeList(title: string, items: string[]): string {
  if (items.length === 0) return "";
  return `<details class="changes-list"${items.length <= OPEN_LIST_LIMIT ? " open" : ""}>
          <summary>${escapeHtml(title)} <span>${items.length}</span></summary>
          <ul>${items.join("")}</ul>
        </details>`;
}

/**
 * The summary shown above the content in both the Stories and the Screens
 * view. Screen entries link into the Screens view only when it is rendered.
 */
export function renderChangesPanel(index: ReviewChangeIndex, screensLinkable: boolean): string {
  const { changes } = index;
  const stories = changes.records.filter((record) => record.kind === "story").length;
  const criteria = changes.records.length - stories;
  const total = changes.records.length + changes.screens.length;
  const summary =
    total === 0
      ? "No Stories, acceptance criteria, or screens changed."
      : `${stories} Stories, ${criteria} acceptance criteria, and ${changes.screens.length} screens changed.`;
  return `<aside class="changes" aria-label="Changes on this branch">
        <header><strong>Changes against <code>${escapeHtml(changes.base)}</code></strong><span>${summary}</span></header>
        ${
          changes.base_has_manifest
            ? ""
            : `<p class="changes-note">The base has no compiled manifest, so every record is new.</p>`
        }
        ${changeList("Stories and acceptance criteria", changes.records.map(recordItem))}
        ${changeList(
          "Screens",
          changes.screens.map((screen) => screenItem(screen, screensLinkable))
        )}
      </aside>`;
}

/**
 * Shown instead of the summary when the page was asked for a comparison it
 * could not make, so a reader can tell an un-compared page from one with no
 * changes.
 */
export function renderChangesUnavailable(base: string, reason: string): string {
  return `<aside class="changes changes-unavailable" aria-label="Changes on this branch">
        <header><strong>Changes against <code>${escapeHtml(base)}</code> are not shown</strong></header>
        <p class="changes-note">${escapeHtml(reason)}</p>
      </aside>`;
}

/**
 * Routes the summary's links the way the page's own navigation does: the URL
 * changes through history, then every router on the page hears one
 * `popstate`. A plain fragment link would leave routing to whether the
 * browser fires `popstate` for fragment navigation. Clicks that open a new
 * tab or window are left to the browser.
 */
export const REVIEW_CHANGE_SCRIPT = `
    (() => {
      document.addEventListener("click", (event) => {
        const link = event.target instanceof Element ? event.target.closest("a[data-change-link]") : null;
        if (!link || event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        history.pushState(null, "", link.getAttribute("href"));
        window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
      });
    })();
`;

/**
 * Every change mark is drawn without hue: New is a solid fill, Changed an
 * outline, Removed a dashed outline with the item struck through. All of them
 * live here, so a page built without a base carries none of these rules.
 */
export const REVIEW_CHANGE_STYLES = `    .changes {
      margin-bottom: 24px;
      padding: 10px 16px;
      background: var(--bg-1);
      border: 1px solid var(--line);
      border-radius: var(--r-md);
      font-size: var(--text-md);
    }
    .changes header { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; }
    .changes header strong { color: var(--fg-1); font-weight: 600; }
    .changes header span { color: var(--fg-3); }
    .changes-note { margin: 4px 0 0; color: var(--fg-3); }
    .changes-unavailable { background: var(--bg); border: 1px dashed var(--fg-4); }
    .changes-list { margin-top: 6px; }
    .changes-list summary {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--fg-2);
      border-radius: var(--r-sm);
      cursor: pointer;
      font-weight: 500;
      list-style: none;
    }
    .changes-list summary::-webkit-details-marker { display: none; }
    .changes-list summary::before {
      width: 0;
      height: 0;
      border-top: 4px solid transparent;
      border-bottom: 4px solid transparent;
      border-left: 5px solid currentColor;
      content: "";
    }
    .changes-list[open] summary::before { transform: rotate(90deg); }
    .changes-list summary span { color: var(--fg-3); font: var(--text-sm) var(--font-mono); }
    .changes-list ul {
      display: grid;
      max-height: 40vh;
      margin: 4px 0 0 2px;
      padding: 0 0 0 14px;
      border-left: 1px solid var(--line);
      list-style: none;
      overflow: auto;
    }
    .changes-list li {
      display: grid;
      grid-template-columns: auto auto minmax(0, 1fr);
      gap: 8px;
      align-items: center;
      min-height: 28px;
    }
    .changes-list li > span:last-child { overflow: hidden; color: var(--fg-3); text-overflow: ellipsis; white-space: nowrap; }
    .changes-list .changed-removed code, .changes-list .changed-removed > span:last-child { color: var(--fg-3); text-decoration: line-through; }
    .change-badge {
      display: inline-flex;
      align-items: center;
      height: 18px;
      padding: 0 6px;
      color: var(--fg-1);
      background: var(--bg);
      border: 1px solid var(--fg-1);
      border-radius: var(--r-sm);
      font: 600 var(--text-xs)/1 var(--font-sans);
      letter-spacing: .02em;
      white-space: nowrap;
      vertical-align: middle;
    }
    .change-added { color: var(--inverse); background: var(--fg-1); }
    .change-removed { color: var(--fg-3); border-color: var(--fg-3); border-style: dashed; }
    .nav-group a[data-change] code::after {
      display: inline-flex;
      align-items: center;
      height: 16px;
      padding: 0 5px;
      border: 1px solid var(--fg-1);
      border-radius: var(--r-sm);
      font: 600 var(--text-xs)/1 var(--font-sans);
      letter-spacing: .02em;
    }
    .nav-group a[data-change="added"] code::after { content: "New"; color: var(--inverse); background: var(--fg-1); }
    .nav-group a[data-change="changed"] code::after { content: "Changed"; color: var(--fg-1); background: var(--bg); }
    .criterion[data-change="changed"] .criterion-number { color: var(--fg-1); border: 1px solid var(--fg-1); }
    .criterion[data-change="added"] .criterion-number { color: var(--inverse); background: var(--fg-1); }
    .criterion[data-change="removed"] .criterion-number { border: 1px dashed var(--fg-3); }
    .criterion-removed .criterion-head code, .criterion-removed .criterion-text { color: var(--fg-3); text-decoration: line-through; }
    .criterion-removed .criterion-text { font-weight: 400; }
    .shot > .change-badge, .chip-shot > .change-badge { position: absolute; top: 6px; right: 6px; z-index: 1; }
    .screen-chip-text > .change-badge { height: 16px; }
    @media print {
      .change-added, .criterion[data-change="added"] .criterion-number { color: #000; background: none; border: 2px solid #000; }
    }
`;
