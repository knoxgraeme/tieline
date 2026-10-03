import { URL } from "node:url";
import type {
  AcceptedContractDocument,
  AcceptedStory,
  Applicability,
  ContractLink,
  ContractScenario,
} from "./schema.js";
import { renderUserStory } from "./schema.js";
import { escapeHtml, SEARCH_ICON } from "./html.js";
import {
  indexReviewChanges,
  renderChangeBadge,
  renderChangesPanel,
  renderChangesUnavailable,
  renderStoryChangeAttribute,
  REVIEW_CHANGE_SCRIPT,
  REVIEW_CHANGE_STYLES,
  type ReviewChangeIndex,
} from "./review-changes-page.js";
import type { ItemHistory } from "./history.js";
import type { ReviewComparison } from "./review-changes.js";
import {
  buildScreenReviewModel,
  renderScreenSidebar,
  renderScreensView,
  renderScreenTabs,
  renderShownScreens,
  SCREEN_REVIEW_SCRIPT,
  SCREEN_REVIEW_STYLES,
  serializeScreenReviewData,
  type ContractReviewScreens,
  type ScreenReviewModel,
} from "./screen-review-page.js";

export interface ContractReviewDocument {
  path: string;
  document: AcceptedContractDocument;
}

export interface ContractReviewPageOptions {
  repositoryKey: string;
  documents: ContractReviewDocument[];
  warnings?: string[];
  /**
   * Rendered in the empty state so a page generated before onboarding tells
   * the reader how to author the first capabilities.
   */
  onboardingInstruction?: string;
  /**
   * The screen catalog, supplied only when the repository enabled screens.
   * Without it the page is exactly the Stories review it always was.
   */
  screens?: ContractReviewScreens;
  /**
   * What the branch changed against a base ref, or why that could not be
   * computed. Supplied only when the page is built with `--base`; without it
   * the page is unchanged.
   */
  comparison?: ReviewComparison;
  /**
   * When each Story, criterion, and screen last changed, from git history.
   * Without it the page shows no history.
   */
  history?: ReviewHistory;
}

/** Each item's last change, keyed `<kind>:<stable id>`, and whether older history was read. */
export interface ReviewHistory {
  items: ReadonlyMap<string, ItemHistory>;
  /** True when older commits were not read, so change counts may be low. */
  truncated: boolean;
}

const LIFECYCLE_LABELS: Record<AcceptedStory["lifecycle"], string> = {
  production: "Production",
  in_progress: "In progress",
  retired: "Retired",
};

/**
 * "#71 · 2026-09-30 · 4 changes", linked when the host is known, after
 * "Last changed in " unless a label already says so.
 */
function renderLastChanged(history: ReviewHistory | undefined, key: string, prefix = true): string {
  const item = history?.items.get(key);
  if (!history || !item) return "";
  const label = item.url
    ? `<a href="${escapeHtml(item.url)}" rel="noreferrer">${escapeHtml(item.label)}</a>`
    : escapeHtml(item.label);
  const count = `${item.changes}${history.truncated ? "+" : ""} change${item.changes === 1 && !history.truncated ? "" : "s"}`;
  return `${prefix ? "Last changed in " : ""}${label} · ${escapeHtml(item.date)} · ${count}`;
}

/** "role: member, viewer · plan: pro", or "" when the item applies to everyone. */
function applicabilityText(applicability: Applicability | undefined): string {
  if (!applicability) return "";
  return Object.entries(applicability)
    .map(
      ([dimension, values]) =>
        `<b>${escapeHtml(dimension)}</b> ${values.map(escapeHtml).join(", ")}`
    )
    .join(" · ");
}

function renderLifecycle(lifecycle: AcceptedStory["lifecycle"]): string {
  return `<span class="status"><i class="lifecycle lifecycle-${lifecycle}" aria-hidden="true"></i>${LIFECYCLE_LABELS[lifecycle]}</span>`;
}

function targetLabel(link: ContractLink): string {
  if (link.target.kind === "help") {
    return `${link.target.source}:${link.target.external_id}`;
  }
  return `${link.target.repository}/${link.target.path}${
    link.target.selector ? ` · ${link.target.selector}` : ""
  }`;
}

function safeExternalUrl(value: string | undefined): string | null {
  if (!value) return null;
  const protocol = new URL(value).protocol;
  return protocol === "https:" || protocol === "http:" ? value : null;
}

function renderLinks(links: ContractLink[]): string {
  if (links.length === 0) return "";
  return `<details class="references disclosure">
    <summary>References <span>${links.length}</span></summary>
    <ul>
      ${links
        .map((link) => {
          const label = escapeHtml(targetLabel(link));
          const externalUrl =
            link.target.kind === "help"
              ? safeExternalUrl(link.target.url)
              : null;
          const target = externalUrl
            ? `<a href="${escapeHtml(externalUrl)}" target="_blank" rel="noreferrer">${label}</a>`
            : `<span>${label}</span>`;
          return `<li><small>${escapeHtml(link.relation)} · ${escapeHtml(link.provenance)}</small>${target}</li>`;
        })
        .join("")}
    </ul>
  </details>`;
}

function renderScenarios(scenarios: ContractScenario[], open: boolean): string {
  if (scenarios.length === 0) return "";
  return `<details class="scenarios disclosure"${open ? " open" : ""}>
    <summary>Scenarios <span>${scenarios.length}</span></summary>
    <div class="scenario-list">
    ${scenarios
      .map(
        (scenario, index) => `<section class="scenario">
          <header>
            <span>Scenario ${index + 1}</span>
            ${scenario.name ? `<strong>${escapeHtml(scenario.name)}</strong>` : ""}
          </header>
          <dl>
            <div><dt>Given</dt><dd>${escapeHtml(scenario.given)}</dd></div>
            <div><dt>When</dt><dd>${escapeHtml(scenario.when)}</dd></div>
            <div><dt>Then</dt><dd>${escapeHtml(scenario.then)}</dd></div>
          </dl>
        </section>`
      )
      .join("")}
    </div>
  </details>`;
}

function storySearchText(
  capabilityKey: string,
  capabilityName: string,
  capabilityDescription: string,
  story: AcceptedStory
): string {
  return [
    capabilityKey,
    capabilityName,
    capabilityDescription,
    story.key,
    story.title,
    story.actor,
    story.goal,
    story.benefit,
    ...story.aliases,
    ...story.acceptance_criteria.flatMap((criterion) => [
      criterion.key,
      criterion.criterion,
      criterion.rationale ?? "",
      ...criterion.scenarios.flatMap((scenario) => [
        scenario.name ?? "",
        scenario.given,
        scenario.when,
        scenario.then,
      ]),
    ]),
  ]
    .join(" ")
    .toLocaleLowerCase("en");
}

/**
 * The criteria a branch removed from this Story, shown struck through at the
 * end of its list so a removal is visible where it happened.
 */
function renderRemovedCriteria(story: AcceptedStory, changes: ReviewChangeIndex | undefined): string[] {
  if (!changes) return [];
  return changes.changes.records
    .filter(
      (record) =>
        record.kind === "acceptance_criterion" &&
        record.status === "removed" &&
        record.story_stable_id === story.key
    )
    .map(
      (record) => `<section class="criterion criterion-removed" data-change="removed">
        <span class="criterion-number" aria-hidden="true">–</span>
        <div>
          <header class="criterion-head"><code>${escapeHtml(record.stable_id)}</code>${renderChangeBadge(record)}</header>
          <p class="criterion-text">${escapeHtml(record.title)}</p>
        </div>
      </section>`
    );
}

function renderStoryDocument(
  capabilityName: string,
  capabilityDescription: string,
  story: AcceptedStory,
  screens?: ScreenReviewModel,
  changes?: ReviewChangeIndex,
  history?: ReviewHistory
): string {
  const criteria = story.acceptance_criteria
    .map((criterion, index) => {
      const change = changes?.records.get(criterion.key);
      const applies = applicabilityText(criterion.applies_to);
      return `<section class="criterion" id="${escapeHtml(criterion.key)}"${
        change ? ` data-change="${change.status}"` : ""
      }>
        <span class="criterion-number">${index + 1}</span>
        <div>
          <header class="criterion-head"><code>${escapeHtml(criterion.key)}</code>${
            changes ? renderChangeBadge(change) : ""
          }${
            history?.items.has(`acceptance_criterion:${criterion.key}`)
              ? `<span class="last-changed">${renderLastChanged(history, `acceptance_criterion:${criterion.key}`)}</span>`
              : ""
          }</header>
          <p class="criterion-text">${escapeHtml(criterion.criterion)}</p>
          ${
            criterion.rationale
              ? `<p class="rationale"><b>Why</b> ${escapeHtml(criterion.rationale)}</p>`
              : ""
          }${applies ? `<p class="applies">Applies to ${applies}</p>` : ""}${
            screens ? renderShownScreens(screens, criterion.key, "Screens", false) : ""
          }${
            criterion.scenarios.length > 0 || criterion.links.length > 0
              ? `<div class="criterion-more">
          ${renderScenarios(criterion.scenarios, change?.status === "added" || change?.status === "changed")}
          ${renderLinks(criterion.links)}
          </div>`
              : ""
          }
        </div>
      </section>`;
    })
    .join("");
  const removed = renderRemovedCriteria(story, changes);
  const changedCriteria =
    (changes
      ? story.acceptance_criteria.filter((criterion) => changes.records.has(criterion.key)).length
      : 0) + removed.length;
  const storyChange =
    changes?.records.get(story.key) ??
    (changes?.stories.has(story.key)
      ? { status: "changed" as const, aspects: ["acceptance criteria"] }
      : undefined);
  const expandable =
    story.links.length > 0 ||
    story.acceptance_criteria.some(
      (criterion) => criterion.scenarios.length > 0 || criterion.links.length > 0
    );
  const storyApplies = applicabilityText(story.applies_to);

  return `<article class="story-document">
    <header class="issue-header">
      <p class="breadcrumbs"><span>${escapeHtml(capabilityName)}</span><b aria-hidden="true">·</b><code>${escapeHtml(story.key)}</code>${
        changes ? renderChangeBadge(storyChange) : ""
      }</p>
      <h1>${escapeHtml(story.title)}</h1>
    </header>
    <div class="issue-layout">
      <aside class="issue-details" aria-label="Story details">
        <h2>Details</h2>
        <dl>
          <div>
            <dt>Status</dt>
            <dd>${renderLifecycle(story.lifecycle)}</dd>
          </div>${
            history?.items.has(`story:${story.key}`)
              ? `
          <div>
            <dt>Last changed</dt>
            <dd class="last-changed">${renderLastChanged(history, `story:${story.key}`, false)}</dd>
          </div>`
              : ""
          }${
            screens
              ? `
          <div>
            <dt>Screens</dt>
            <dd>${screens.shownByOwner.get(story.key)?.length ?? 0}</dd>
          </div>`
              : ""
          }${
            story.aliases.length > 0
              ? `
          <div>
            <dt>Aliases</dt>
            <dd class="aliases">${story.aliases.map(escapeHtml).join("<br>")}</dd>
          </div>`
              : ""
          }${
            storyApplies
              ? `
          <div>
            <dt>Applies to</dt>
            <dd class="applies">${storyApplies}</dd>
          </div>`
              : ""
          }
        </dl>
      </aside>
      <div class="issue-main">
        <section class="issue-section description">
          <p class="story-lead">${escapeHtml(renderUserStory(story))}</p>
          <p class="capability-description">${escapeHtml(capabilityDescription)}</p>${
            screens
              ? renderShownScreens(screens, story.key, "Screens in this Story")
              : ""
          }
        </section>
        <section class="criteria issue-section">
          <div class="criteria-head">
            <h2><span>Acceptance criteria</span><small>${story.acceptance_criteria.length}</small>${
              changedCriteria > 0
                ? `<small class="changed-count">· ${changedCriteria} changed</small>`
                : ""
            }</h2>${
              expandable
                ? `
            <button type="button" class="expand-all" data-expand-all>Expand all</button>`
                : ""
            }
          </div>
          ${criteria}${removed.join("")}
        </section>
        ${renderLinks(story.links)}
      </div>
    </div>
  </article>`;
}

function renderEmptyState(options: ContractReviewPageOptions): string {
  if (options.warnings && options.warnings.length > 0) {
    return `<div class="empty-state">
        <h1>The contract does not validate</h1>
        <p>Fix the review notes above, then run
        <code>tieline contract compile .</code> to refresh this page.</p>
      </div>`;
  }
  return `<div class="empty-state">
        <h1>No capabilities yet</h1>
        <p>This page lists the product's capabilities, user stories, and
        acceptance criteria once semantic onboarding authors them under
        <code>.tieline/spec/</code>.</p>
        ${
          options.onboardingInstruction
            ? `<p>Invoke the installed skill in your coding agent to begin:</p>
              <pre class="prompt">${escapeHtml(options.onboardingInstruction)}</pre>`
            : ""
        }
        <p><code>tieline contract compile .</code> refreshes this page
        whenever the contract changes.</p>
      </div>`;
}

export function renderContractReviewPage(
  options: ContractReviewPageOptions
): string {
  const comparison = options.comparison;
  const changes = comparison?.changes ? indexReviewChanges(comparison.changes) : undefined;
  const screens = options.screens
    ? buildScreenReviewModel(
        options.documents.map(({ document }) => document),
        options.history ? { ...options.screens, history: options.history } : options.screens,
        changes
      )
    : undefined;
  const storyEntries = options.documents.flatMap(({ document }) =>
    document.capability.stories.map((story) => ({
      capability: document.capability,
      story,
    }))
  );
  const firstEntry = storyEntries[0];

  const navigation = options.documents
    .map(
      ({ document }) => `<section class="nav-group" data-nav-group>
        <h2>${escapeHtml(document.capability.name)}</h2>
        <ul>
          ${document.capability.stories
            .map(
              (story) => `<li data-nav-item data-search="${escapeHtml(
                storySearchText(
                  document.capability.key,
                  document.capability.name,
                  document.capability.description,
                  story
                )
              )}">
                <a
                  href="#${escapeHtml(story.key)}"
                  data-story-link
                  data-template-id="story-${escapeHtml(story.key)}"
                  data-story-key="${escapeHtml(story.key)}"
                  data-lifecycle="${story.lifecycle}"${
                    changes ? renderStoryChangeAttribute(changes, story.key) : ""
                  }
                >
                  <i class="lifecycle lifecycle-${story.lifecycle}" role="img" aria-label="${LIFECYCLE_LABELS[story.lifecycle]}" title="${LIFECYCLE_LABELS[story.lifecycle]}"></i>
                  <span>${escapeHtml(story.title)}</span>
                  <code>${escapeHtml(story.key)}</code>
                </a>
              </li>`
            )
            .join("")}
        </ul>
      </section>`
    )
    .join("");

  const templates = storyEntries
    .map(
      ({ capability, story }) =>
        `<template id="story-${escapeHtml(story.key)}">${renderStoryDocument(
          capability.name,
          capability.description,
          story,
          screens,
          changes,
          options.history
        )}</template>`
    )
    .join("");

  const initialContent = firstEntry
    ? renderStoryDocument(
        firstEntry.capability.name,
        firstEntry.capability.description,
        firstEntry.story,
        screens,
        changes,
        options.history
      )
    : renderEmptyState(options);

  const warnings =
    options.warnings && options.warnings.length > 0
      ? `<aside class="warnings" aria-label="Contract warnings">
          <strong>Review notes <span>· ${options.warnings.length}</span></strong>
          <ul>${options.warnings
            .map((warning) => `<li>${escapeHtml(warning)}</li>`)
            .join("")}</ul>
        </aside>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${escapeHtml(options.repositoryKey)} · Tieline spec review</title>
  <style>
    :root {
      --bg: #ffffff;
      --bg-1: #fafafa;
      --bg-2: #f4f4f5;
      --bg-3: #e9e9eb;
      --line: #e4e4e7;
      --line-strong: #d4d4d8;
      --fg-1: #18181b;
      --fg-2: #3f3f46;
      --fg-3: #62626b;
      --fg-4: #85858e;
      --inverse: #ffffff;
      --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Helvetica Neue", Arial, sans-serif;
      --font-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      --text-2xl: 1.5rem;
      --text-xl: 1.25rem;
      --text-lg: .9375rem;
      --text-base: .875rem;
      --text-md: .8125rem;
      --text-sm: .75rem;
      --text-xs: .6875rem;
      --r-sm: 4px;
      --r-md: 6px;
      --shadow-overlay: -1px 0 0 var(--line), -16px 0 32px rgba(0, 0, 0, .08);
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      color: var(--fg-2);
      background: var(--bg);
      font: 400 var(--text-base)/1.5714 var(--font-sans);
      -webkit-font-smoothing: antialiased;
    }
    a { color: var(--fg-1); }
    button, input, select { color: inherit; font: inherit; }
    :where(a, button, input, select, summary, [tabindex]):focus-visible {
      outline: 2px solid var(--fg-1);
      outline-offset: 2px;
    }
    code { font: var(--text-sm)/1rem var(--font-mono); overflow-wrap: anywhere; }
    kbd {
      display: inline-grid;
      min-width: 18px;
      height: 18px;
      padding: 0 4px;
      place-items: center;
      color: var(--fg-3);
      background: var(--bg);
      border: 1px solid var(--line-strong);
      border-radius: var(--r-sm);
      font: 500 var(--text-xs)/1 var(--font-mono);
    }
    .wiki-content a { text-decoration-color: var(--line-strong); text-underline-offset: 2px; }
    .wiki-content a:hover { text-decoration-color: var(--fg-1); }
    .wiki-shell {
      display: grid;
      grid-template-columns: 264px minmax(0, 1fr);
      min-height: 100vh;
    }
    .wiki-nav {
      position: sticky;
      top: 0;
      align-self: start;
      display: flex;
      flex-direction: column;
      height: 100vh;
      padding: 16px 12px 0;
      background: var(--bg-1);
      border-right: 1px solid var(--line);
      overflow-y: auto;
    }
    .wiki-nav > * { flex-shrink: 0; }
    .wiki-brand { padding: 0 8px 12px; }
    .wiki-brand b {
      display: block;
      color: var(--fg-1);
      font-size: var(--text-md);
      font-weight: 600;
      line-height: 1.25rem;
      overflow-wrap: anywhere;
    }
    .wiki-brand p { margin: 0; color: var(--fg-3); font-size: var(--text-sm); line-height: 1rem; }
    .nav-open { display: none; }
    .nav-search { display: flex; gap: 4px; margin: 4px 0 8px; }
    .search { position: relative; display: block; flex: 1; min-width: 0; }
    .search svg {
      position: absolute;
      left: 9px;
      top: 50%;
      color: var(--fg-4);
      transform: translateY(-50%);
      pointer-events: none;
    }
    .search input {
      width: 100%;
      height: 32px;
      padding: 0 32px 0 30px;
      color: var(--fg-1);
      background: var(--bg-2);
      border: 1px solid transparent;
      border-radius: var(--r-sm);
      font-size: var(--text-md);
    }
    .search input::placeholder { color: var(--fg-3); }
    .search input:hover, .search input:focus { border-color: var(--line-strong); }
    .search input:focus { background: var(--bg); }
    .search kbd {
      position: absolute;
      right: 8px;
      top: 50%;
      transform: translateY(-50%);
      pointer-events: none;
    }
    .search input:not(:placeholder-shown) ~ kbd, .search input:focus ~ kbd { display: none; }
    .toggle {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 32px;
      padding: 0 10px;
      color: var(--fg-2);
      background: var(--bg);
      border: 1px solid var(--line-strong);
      border-radius: var(--r-sm);
      cursor: pointer;
      font-size: var(--text-md);
      white-space: nowrap;
    }
    .toggle span { color: var(--fg-3); font: var(--text-sm) var(--font-mono); font-variant-numeric: tabular-nums; }
    .toggle:hover { background: var(--bg-2); }
    .toggle[aria-pressed="true"] { color: var(--fg-1); background: var(--bg-3); border-color: var(--fg-1); font-weight: 500; }
    .toggle[aria-pressed="true"] span { color: var(--fg-1); }
    .nav-group { margin-top: 16px; }
    .nav-group[hidden], .nav-group li[hidden] { display: none; }
    .nav-group h2 {
      margin: 0 8px 4px;
      color: var(--fg-3);
      font-size: var(--text-xs);
      font-weight: 600;
      letter-spacing: .04em;
      line-height: 1rem;
      text-transform: uppercase;
    }
    .nav-group ul { margin: 0; padding: 0; list-style: none; }
    .nav-group a {
      display: grid;
      grid-template-columns: 10px minmax(0, 1fr);
      gap: 2px 10px;
      padding: 6px 8px;
      color: var(--fg-2);
      border-radius: var(--r-sm);
      font-size: var(--text-md);
      line-height: 1.125rem;
      text-decoration: none;
    }
    .nav-group a:hover { background: var(--bg-2); }
    .nav-group a[aria-current="page"] {
      color: var(--fg-1);
      background: var(--bg-3);
      box-shadow: inset 2px 0 var(--fg-1);
      font-weight: 500;
    }
    .nav-group a > .lifecycle { margin-top: 4px; color: var(--fg-3); }
    .nav-group a[aria-current="page"] > .lifecycle { color: var(--fg-1); }
    .nav-group a[data-lifecycle="retired"] span { color: var(--fg-3); }
    .nav-group a span { min-width: 0; }
    .nav-group a code {
      grid-column: 2;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      color: var(--fg-3);
      font-size: var(--text-xs);
      font-weight: 400;
    }
    .lifecycle {
      display: inline-block;
      flex: none;
      width: 10px;
      height: 10px;
      color: var(--fg-1);
      border-radius: 50%;
    }
    .lifecycle-production { background: currentColor; }
    .lifecycle-in_progress {
      border: 1.5px solid currentColor;
      background: linear-gradient(90deg, currentColor 50%, transparent 50%);
    }
    .lifecycle-retired {
      border: 1.5px solid var(--fg-4);
      background: linear-gradient(135deg, transparent calc(50% - .75px), var(--fg-4) 0 calc(50% + .75px), transparent 0);
    }
    .nav-empty {
      display: none;
      margin: 16px 8px;
      color: var(--fg-3);
      font-size: var(--text-md);
    }
    .nav-empty.show { display: block; }
    .wiki-foot {
      position: sticky;
      bottom: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin: auto -12px 0;
      padding: 8px 20px;
      color: var(--fg-3);
      background: var(--bg-1);
      border-top: 1px solid var(--line);
      font-size: var(--text-sm);
    }
    .keys { display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 0; }
    .keys > span { display: inline-flex; align-items: center; gap: 3px; }
    .print {
      height: 28px;
      padding: 0 10px;
      color: var(--fg-2);
      background: var(--bg);
      border: 1px solid var(--line-strong);
      border-radius: var(--r-sm);
      cursor: pointer;
      font-size: var(--text-sm);
    }
    .print:hover { background: var(--bg-2); }
    .wiki-main { min-width: 0; }
    .wiki-content {
      max-width: 1088px;
      padding: 32px 48px 96px;
    }
    .warnings {
      margin-bottom: 24px;
      padding: 12px 16px;
      background: var(--bg);
      border: 1px solid var(--line-strong);
      border-left: 3px solid var(--fg-1);
      border-radius: var(--r-md);
      font-size: var(--text-md);
    }
    .warnings strong { display: flex; align-items: center; gap: 8px; color: var(--fg-1); font-weight: 600; }
    .warnings strong::before {
      display: inline-grid;
      width: 16px;
      height: 16px;
      place-items: center;
      color: var(--inverse);
      background: var(--fg-1);
      border-radius: 50%;
      content: "!";
      font: 700 11px/1 var(--font-sans);
    }
    .warnings strong span { margin-left: -4px; color: var(--fg-3); font-weight: 400; }
    .warnings ul { margin: 8px 0 0; padding-left: 24px; }
    .warnings li + li { margin-top: 4px; }
    .issue-header { padding-bottom: 16px; }
    .breadcrumbs {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      margin: 0 0 8px;
      color: var(--fg-3);
      font-size: var(--text-sm);
      line-height: 1.125rem;
    }
    .breadcrumbs b { color: var(--fg-4); font-weight: 400; }
    .issue-header h1 {
      max-width: 40ch;
      margin: 0;
      color: var(--fg-1);
      font-size: var(--text-2xl);
      font-weight: 600;
      line-height: 2rem;
      letter-spacing: -.01em;
    }
    .issue-layout {
      display: grid;
      grid-template-columns: minmax(0, 720px) 224px;
      grid-template-areas: "main props";
      gap: 48px;
      align-items: start;
      margin-top: 8px;
    }
    .issue-main { grid-area: main; min-width: 0; }
    .issue-details {
      grid-area: props;
      position: sticky;
      top: 32px;
      padding: 0 0 0 16px;
      border-left: 1px solid var(--line);
    }
    .issue-details > h2 {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
    }
    .issue-details dl { margin: 0; }
    .issue-details dl > div {
      display: grid;
      grid-template-columns: 88px minmax(0, 1fr);
      gap: 8px;
      padding: 6px 0;
    }
    .issue-details dt { color: var(--fg-3); font-size: var(--text-sm); line-height: 1.25rem; }
    .issue-details dd {
      min-width: 0;
      margin: 0;
      color: var(--fg-1);
      font-size: var(--text-md);
      line-height: 1.25rem;
      overflow-wrap: anywhere;
    }
    .issue-details .last-changed, .issue-details .aliases, .issue-details .applies { color: var(--fg-2); font-size: var(--text-md); }
    .status { display: inline-flex; align-items: center; gap: 8px; }
    .issue-section + .issue-section { margin-top: 32px; }
    .story-lead {
      max-width: 66ch;
      margin: 0;
      color: var(--fg-2);
      font-size: var(--text-lg);
      line-height: 1.5rem;
    }
    .capability-description {
      max-width: 66ch;
      margin: 8px 0 0;
      color: var(--fg-3);
      font-size: var(--text-md);
      line-height: 1.25rem;
    }
    .criteria-head { display: flex; align-items: center; gap: 12px; margin-bottom: 4px; }
    .criteria-head h2 {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin: 0;
      color: var(--fg-1);
      font-size: var(--text-md);
      font-weight: 600;
      line-height: 1.25rem;
    }
    .criteria-head h2 small {
      color: var(--fg-3);
      font: 400 var(--text-sm) var(--font-mono);
      font-variant-numeric: tabular-nums;
    }
    .criteria-head h2 .changed-count { margin-left: -4px; color: var(--fg-1); font-family: var(--font-sans); }
    .expand-all {
      height: 24px;
      margin-left: auto;
      padding: 0 8px;
      color: var(--fg-3);
      background: none;
      border: 0;
      border-radius: var(--r-sm);
      cursor: pointer;
      font-size: var(--text-sm);
    }
    .expand-all:hover { color: var(--fg-1); background: var(--bg-2); }
    .criterion {
      display: grid;
      grid-template-columns: 24px minmax(0, 1fr);
      gap: 12px;
      padding: 16px 0;
      border-top: 1px solid var(--line);
      scroll-margin-top: 16px;
    }
    .criterion > div { min-width: 0; }
    .criterion-number {
      display: grid;
      width: 20px;
      height: 20px;
      place-items: center;
      color: var(--fg-3);
      border-radius: var(--r-sm);
      font: 500 var(--text-sm)/1 var(--font-mono);
      font-variant-numeric: tabular-nums;
    }
    .criterion-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px 8px;
      min-height: 20px;
      color: var(--fg-3);
    }
    .criterion-head .last-changed { margin-left: auto; }
    .criterion-text {
      margin: 4px 0 0;
      color: var(--fg-1);
      font-size: var(--text-base);
      font-weight: 500;
      line-height: 1.375rem;
    }
    .last-changed { color: var(--fg-3); font-size: var(--text-sm); }
    .rationale {
      max-width: 72ch;
      margin: 6px 0 0;
      color: var(--fg-3);
      font-size: var(--text-md);
      line-height: 1.25rem;
    }
    .rationale b { margin-right: 4px; color: var(--fg-2); font-weight: 600; }
    .applies { margin: 6px 0 0; color: var(--fg-3); font-size: var(--text-sm); }
    .applies b { color: var(--fg-2); font-weight: 500; }
    .criterion-more { display: flex; flex-wrap: wrap; gap: 0 16px; margin-top: 8px; }
    .criterion-more > details[open] { flex-basis: 100%; }
    .disclosure > summary {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--fg-3);
      border-radius: var(--r-sm);
      cursor: pointer;
      font-size: var(--text-sm);
      font-weight: 500;
      line-height: 1.5rem;
      list-style: none;
    }
    .disclosure > summary::-webkit-details-marker { display: none; }
    .disclosure > summary::before {
      width: 0;
      height: 0;
      border-top: 4px solid transparent;
      border-bottom: 4px solid transparent;
      border-left: 5px solid currentColor;
      content: "";
      transition: transform .12s ease;
    }
    .disclosure[open] > summary::before { transform: rotate(90deg); }
    .disclosure > summary:hover { color: var(--fg-1); }
    .disclosure > summary span { font-family: var(--font-mono); font-weight: 400; font-variant-numeric: tabular-nums; }
    .scenario-list, .references ul {
      margin: 4px 0 4px 2px;
      padding-left: 14px;
      border-left: 1px solid var(--line);
    }
    .scenario { padding: 8px 0; }
    .scenario + .scenario { border-top: 1px solid var(--line); }
    .scenario header {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 8px;
      margin-bottom: 4px;
      color: var(--fg-3);
      font-size: var(--text-sm);
    }
    .scenario header strong { color: var(--fg-1); font-weight: 500; }
    .scenario dl { display: grid; gap: 2px; margin: 0; }
    .scenario dl div { display: grid; grid-template-columns: 48px minmax(0, 1fr); gap: 8px; }
    .scenario dt {
      color: var(--fg-3);
      font-size: var(--text-xs);
      font-weight: 600;
      letter-spacing: .04em;
      line-height: 1.25rem;
      text-transform: uppercase;
    }
    .scenario dd { margin: 0; color: var(--fg-2); font-size: var(--text-md); line-height: 1.25rem; }
    .references ul { display: grid; list-style: none; }
    .references li {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      padding: 4px 0;
      font: var(--text-sm)/1rem var(--font-mono);
    }
    .references li > :not(small) { color: var(--fg-2); overflow-wrap: anywhere; }
    .references small { order: 2; color: var(--fg-3); font-family: var(--font-sans); white-space: nowrap; }
    .issue-main > .references { margin-top: 32px; padding-top: 12px; border-top: 1px solid var(--line); }
    .empty-state { max-width: 58ch; margin: 48px 0 0; }
    .empty-state h1 {
      margin: 0 0 8px;
      color: var(--fg-1);
      font-size: var(--text-xl);
      font-weight: 600;
      line-height: 1.75rem;
    }
    .empty-state p { color: var(--fg-2); }
    .empty-state .prompt {
      padding: 12px 16px;
      color: var(--fg-1);
      background: var(--bg-2);
      border-radius: var(--r-md);
      font: var(--text-md)/1.25rem var(--font-mono);
      white-space: pre-wrap;
      user-select: all;
    }
    @media (prefers-reduced-motion: reduce) {
      html { scroll-behavior: auto; }
      .disclosure > summary::before { transition: none; }
    }
    @media (max-width: 1199px) {
      .issue-layout {
        grid-template-columns: minmax(0, 1fr);
        grid-template-areas: "props" "main";
        gap: 24px;
      }
      .issue-details { position: static; padding: 0 0 12px; border-left: 0; border-bottom: 1px solid var(--line); }
      .issue-details dl { display: flex; flex-wrap: wrap; gap: 4px 24px; }
      .issue-details dl > div { display: flex; align-items: baseline; gap: 8px; padding: 0; }
    }
    @media (max-width: 760px) {
      .wiki-shell { display: block; }
      .wiki-nav {
        z-index: 20;
        flex-direction: row;
        align-items: center;
        gap: 8px;
        height: auto;
        min-height: 48px;
        padding: 8px 12px;
        border-right: 0;
        border-bottom: 1px solid var(--line);
        overflow: visible;
      }
      .wiki-brand { flex: 1 1 auto; min-width: 0; padding: 0; }
      .wiki-brand p { display: none; }
      .nav-open {
        display: inline-flex;
        align-items: center;
        height: 32px;
        padding: 0 12px;
        color: var(--fg-1);
        background: var(--bg);
        border: 1px solid var(--line-strong);
        border-radius: var(--r-sm);
        cursor: pointer;
        font-size: var(--text-md);
      }
      .wiki-shell:not([data-nav-open]) .nav-search,
      .wiki-shell:not([data-nav-open]) .wiki-nav > nav,
      .wiki-shell:not([data-nav-open]) .nav-empty,
      .wiki-shell:not([data-nav-open]) .wiki-foot { display: none; }
      .wiki-shell[data-nav-open] .wiki-nav {
        position: fixed;
        inset: 0;
        flex-direction: column;
        align-items: stretch;
        padding-top: 12px;
        overflow-y: auto;
      }
      .wiki-shell[data-nav-open] .wiki-brand { padding: 4px 80px 8px 8px; }
      .wiki-shell[data-nav-open] .nav-open { position: absolute; top: 12px; right: 12px; }
      .wiki-shell[data-nav-open] .nav-group a { min-height: 44px; align-content: center; }
      .wiki-content { padding: 24px 16px 64px; }
    }
    @media (max-width: 520px) {
      .scenario dl div { grid-template-columns: 1fr; gap: 0; }
      .criterion-head .last-changed { flex-basis: 100%; margin-left: 0; }
    }
    @media print {
      .wiki-shell { display: block; }
      .wiki-nav { display: none; }
      .wiki-content { max-width: none; padding: 0; }
      .warnings { display: none; }
      .issue-layout { display: block; }
      .issue-details { position: static; margin-bottom: 16px; padding: 0 0 8px; border: 0; border-bottom: 1px solid var(--line); }
      .issue-details dl { display: flex; flex-wrap: wrap; gap: 4px 24px; }
      .issue-details dl > div { display: flex; gap: 8px; padding: 0; }
      .references:not([open]) > ul { display: grid !important; }
      .scenarios:not([open]) > .scenario-list { display: block !important; }
      .scenarios::details-content, .references::details-content { content-visibility: visible; }
      .expand-all { display: none; }
      .criterion, .scenario { break-inside: avoid; }
    }
${screens ? SCREEN_REVIEW_STYLES : ""}${comparison ? REVIEW_CHANGE_STYLES : ""}  </style>
</head>
<body>
  <div class="wiki-shell">
    <aside class="wiki-nav">
      <header class="wiki-brand">
        <b>${escapeHtml(options.repositoryKey)}</b>
        <p>Specification</p>
      </header>
${screens ? renderScreenTabs(screens) : ""}      <button type="button" class="nav-open" id="nav-open" aria-expanded="false">Browse</button>
      <div class="nav-search">
        <label class="search">
          ${SEARCH_ICON}
          <input id="search" type="search" placeholder="Search" aria-label="Search stories" autocomplete="off">
          <kbd aria-hidden="true">/</kbd>
        </label>${
          changes && changes.stories.size > 0
            ? `
        <button type="button" class="toggle" id="story-change-toggle" aria-pressed="false" title="Show only Stories changed on this branch">Changed <span>${changes.stories.size}</span></button>`
            : ""
        }
      </div>
      <nav aria-label="Stories">${navigation}</nav>
      <p class="nav-empty" id="nav-empty">No matching stories.</p>
${screens ? renderScreenSidebar(screens) : ""}      <footer class="wiki-foot">
        <p class="keys"><span><kbd>/</kbd> Search</span><span><kbd>j</kbd><kbd>k</kbd> Next, previous</span>${
          screens ? `<span class="zoom-keys"><kbd>+</kbd><kbd>−</kbd> Zoom</span>` : ""
        }</p>
        <button class="print" type="button" onclick="window.print()">Print</button>
      </footer>
    </aside>
    <main class="wiki-main">
      <div class="wiki-content">
        ${warnings}${
          changes
            ? renderChangesPanel(changes, screens !== undefined)
            : comparison?.unavailable !== undefined
              ? renderChangesUnavailable(comparison.base, comparison.unavailable)
              : ""
        }
        <div id="story-content">${initialContent}</div>${
          screens ? `\n        ${renderScreensView(screens)}` : ""
        }
      </div>
    </main>
  </div>
  ${templates}
  <script>
    (() => {
      const shell = document.querySelector(".wiki-shell");
      const nav = document.querySelector(".wiki-nav");
      const search = document.querySelector("#search");
      const changeToggle = document.querySelector("#story-change-toggle");
      const sheetToggle = document.querySelector("#nav-open");
      const links = [...document.querySelectorAll("[data-story-link]")];
      const groups = [...document.querySelectorAll("[data-nav-group]")];
      const content = document.querySelector("#story-content");
      const empty = document.querySelector("#nav-empty");

      // Below 760px the navigation is a sheet opened from the top bar.
      function setSheet(open) {
        if (open) shell.setAttribute("data-nav-open", "");
        else shell.removeAttribute("data-nav-open");
        sheetToggle.setAttribute("aria-expanded", String(open));
        sheetToggle.textContent = open ? "Close" : "Browse";
      }

      function showStory(link, updateHash = true) {
        const template = document.getElementById(link.dataset.templateId);
        if (!template) return;
        content.replaceChildren(template.content.cloneNode(true));
        for (const item of links) {
          if (item === link) item.setAttribute("aria-current", "page");
          else item.removeAttribute("aria-current");
        }
        if (updateHash) {
          history.pushState(null, "", "#" + link.dataset.storyKey);
          window.scrollTo({ top: 0, behavior: "instant" });
        }
        document.title =
          link.querySelector("span").textContent + " · Tieline spec review";
      }

      function updateSearch() {
        const query = search.value.trim().toLocaleLowerCase("en");
        const changedOnly =
          changeToggle !== null && changeToggle.getAttribute("aria-pressed") === "true";
        let visible = 0;
        for (const item of document.querySelectorAll("[data-nav-item]")) {
          const link = item.querySelector("[data-story-link]");
          item.hidden =
            (query.length > 0 && !item.dataset.search.includes(query)) ||
            (changedOnly && !link.hasAttribute("data-change"));
          if (!item.hidden) visible += 1;
        }
        for (const group of groups) {
          group.hidden = !group.querySelector("[data-nav-item]:not([hidden])");
        }
        empty.classList.toggle("show", visible === 0);
      }

      // The next or previous Story still listed, from the one shown.
      function stepStory(offset) {
        const listed = links.filter((link) => !link.closest("[data-nav-item]").hidden);
        if (listed.length === 0) return;
        const index = listed.findIndex((link) => link.getAttribute("aria-current") === "page");
        const next = index === -1
          ? (offset > 0 ? 0 : listed.length - 1)
          : Math.min(listed.length - 1, Math.max(0, index + offset));
        if (next === index) return;
        showStory(listed[next]);
        listed[next].scrollIntoView({ block: "nearest" });
      }

      for (const link of links) {
        link.addEventListener("click", (event) => {
          event.preventDefault();
          showStory(link);
        });
      }
      search.addEventListener("input", updateSearch);
      if (changeToggle) {
        changeToggle.addEventListener("click", () => {
          changeToggle.setAttribute(
            "aria-pressed",
            String(changeToggle.getAttribute("aria-pressed") !== "true")
          );
          updateSearch();
        });
      }
      sheetToggle.addEventListener("click", () => setSheet(!shell.hasAttribute("data-nav-open")));
      nav.addEventListener("click", (event) => {
        if (!shell.hasAttribute("data-nav-open")) return;
        const target = event.target instanceof Element
          ? event.target.closest("a[href], button[data-key]")
          : null;
        if (target) setSheet(false);
      });
      content.addEventListener("click", (event) => {
        const button = event.target instanceof Element
          ? event.target.closest("[data-expand-all]")
          : null;
        if (!button) return;
        const sections = [...content.querySelectorAll("details")];
        const open = sections.some((section) => !section.open);
        for (const section of sections) section.open = open;
        button.textContent = open ? "Collapse all" : "Expand all";
      });
      window.addEventListener("popstate", route);
      document.addEventListener("keydown", (event) => {
        if (event.key === "/" && document.activeElement !== search) {
          event.preventDefault();
          search.focus();
        }
        if (event.key === "Escape" && document.activeElement === search) {
          search.value = "";
          search.blur();
          updateSearch();
        }
        const typing = event.target instanceof HTMLElement &&
          (event.target.matches("input, select, textarea") || event.target.isContentEditable);
        if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.key === "j" || event.key === "k") {
          event.preventDefault();
          stepStory(event.key === "j" ? 1 : -1);
        }
      });

      // A Story key selects that Story; a criterion key selects its Story
      // and scrolls to the criterion.
      function storyFromHash() {
        let requested = "";
        try {
          requested = decodeURIComponent(location.hash.slice(1));
        } catch {
          return {};
        }
        const story = links.find((link) => link.dataset.storyKey === requested);
        if (story || !requested) return { link: story };
        for (const link of links) {
          const template = document.getElementById(link.dataset.templateId);
          if (template && template.content.getElementById(requested)) {
            return { link, target: requested };
          }
        }
        return {};
      }

      function route() {
        const found = storyFromHash();
        const link = found.link || links[0];
        if (!link) return;
        showStory(link, false);
        const target = found.target && document.getElementById(found.target);
        if (target) target.scrollIntoView({ block: "start" });
      }

      route();
    })();
  </script>
${changes ? `  <script>${REVIEW_CHANGE_SCRIPT}  </script>\n` : ""}${
  screens
    ? `  <script type="application/json" id="screen-data">${serializeScreenReviewData(
        screens
      )}</script>
  <script>${SCREEN_REVIEW_SCRIPT}  </script>
`
    : ""
}</body>
</html>
`;
}
