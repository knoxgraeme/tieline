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
const OPEN_LIST_LIMIT = 20;

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
      : `<a href="#${escapeHtml(record.story_stable_id)}"><code>${label}</code></a>`;
  return `<li class="changed-${record.status}">${renderChangeBadge(record)} ${target} <span>${escapeHtml(
    record.title
  )}${escapeHtml(aspectText(record.aspects))}</span></li>`;
}

function screenItem(screen: ScreenRecordChange, linkable: boolean): string {
  const label = `<code>${escapeHtml(screen.stable_id)}</code>`;
  const target =
    linkable && screen.status !== "removed"
      ? `<a href="#screen/${encodeURIComponent(screen.stable_id)}">${label}</a>`
      : label;
  return `<li class="changed-${screen.status}">${renderChangeBadge(screen)} ${target} <span>${escapeHtml(
    screen.title
  )}${escapeHtml(aspectText(screen.aspects))}</span></li>`;
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

export const REVIEW_CHANGE_STYLES = `    .changes {
      margin-bottom: 1.5rem;
      padding: .75rem .9rem;
      background: #f3f7ff;
      border: 1px solid #c9dafb;
      border-radius: 4px;
      font-size: .78rem;
    }
    .changes header { display: flex; flex-wrap: wrap; gap: .35rem .75rem; align-items: baseline; }
    .changes header span { color: var(--muted); }
    .changes-note { margin: .4rem 0 0; color: var(--muted); }
    .changes-list { margin-top: .5rem; }
    .changes-list summary { cursor: pointer; font-weight: 700; }
    .changes-list summary span { color: #858d98; font: .64rem var(--mono); }
    .changes-list ul { display: grid; gap: .25rem; margin: .4rem 0 0; padding-left: .2rem; list-style: none; }
    .changes-list li { display: flex; flex-wrap: wrap; gap: .4rem; align-items: baseline; }
    .changes-list li span:last-child { color: var(--muted); }
    .changes-list .changed-removed code { text-decoration: line-through; }
    .change-badge {
      display: inline-block;
      padding: .02rem .35rem;
      border-radius: 3px;
      font: 700 .58rem/1.5 var(--body);
      letter-spacing: .03em;
      text-transform: uppercase;
      vertical-align: middle;
    }
    .change-added { color: #1f6f4a; background: #e3f4ea; }
    .change-changed { color: #8a5a00; background: #fff1d6; }
    .change-removed { color: #a1263a; background: #fdecee; }
    .nav-group a[data-change] span::after {
      margin-left: .35rem;
      padding: 0 .3rem;
      border-radius: 3px;
      font-size: .55rem;
      font-weight: 800;
      text-transform: uppercase;
    }
    .nav-group a[data-change="added"] span::after { content: "New"; color: #1f6f4a; background: #e3f4ea; }
    .nav-group a[data-change="changed"] span::after { content: "Changed"; color: #8a5a00; background: #fff1d6; }
`;
