import { URL } from "node:url";
import type {
  AcceptedContractDocument,
  AcceptedStory,
  Applicability,
  ContractLink,
  ContractScenario,
} from "./schema.js";
import { renderUserStory } from "./schema.js";

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
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderApplicability(applicability: Applicability | undefined): string {
  if (!applicability) return "";
  return `<div class="tags" aria-label="Applicability">
    ${Object.entries(applicability)
      .map(
        ([dimension, values]) =>
          `<span><b>${escapeHtml(dimension)}</b>${values
            .map(escapeHtml)
            .join(", ")}</span>`
      )
      .join("")}
  </div>`;
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
  return `<details class="references">
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

function renderScenarios(scenarios: ContractScenario[]): string {
  if (scenarios.length === 0) return "";
  return `<div class="scenarios">
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
  </div>`;
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

function renderStoryDocument(
  capabilityName: string,
  capabilityDescription: string,
  story: AcceptedStory
): string {
  const criteria = story.acceptance_criteria
    .map(
      (criterion, index) => `<section class="criterion" id="${escapeHtml(
        criterion.key
      )}">
        <span class="criterion-number">${index + 1}</span>
        <div>
          <code>${escapeHtml(criterion.key)}</code>
          <p class="criterion-text">${escapeHtml(criterion.criterion)}</p>
          ${
            criterion.rationale
              ? `<p class="rationale"><b>Why:</b> ${escapeHtml(criterion.rationale)}</p>`
              : ""
          }
          ${renderApplicability(criterion.applies_to)}
          ${renderScenarios(criterion.scenarios)}
          ${renderLinks(criterion.links)}
        </div>
      </section>`
    )
    .join("");

  return `<article class="story-document">
    <header class="issue-header">
      <p class="breadcrumbs"><span>Stories</span><b>/</b>${escapeHtml(capabilityName)}</p>
      <code>${escapeHtml(story.key)}</code>
      <h1>${escapeHtml(story.title)}</h1>
    </header>
    <div class="issue-layout">
      <div class="issue-main">
        <section class="issue-section description">
          <h2>Description</h2>
          <p class="capability-description">${escapeHtml(capabilityDescription)}</p>
          <blockquote>${escapeHtml(renderUserStory(story))}</blockquote>
          ${renderApplicability(story.applies_to)}
        </section>
        <section class="criteria issue-section">
          <h2><span>Acceptance criteria</span><small>${story.acceptance_criteria.length}</small></h2>
          ${criteria}
        </section>
        ${renderLinks(story.links)}
      </div>
      <aside class="issue-details">
        <h2>Details</h2>
        <dl>
          <div>
            <dt>Status</dt>
            <dd>
              <span class="status status-${story.lifecycle}">
                <i aria-hidden="true"></i>${escapeHtml(story.lifecycle.replace("_", " "))}
              </span>
            </dd>
          </div>
          <div>
            <dt>Capability</dt>
            <dd>${escapeHtml(capabilityName)}</dd>
          </div>
          <div>
            <dt>Criteria</dt>
            <dd>${story.acceptance_criteria.length}</dd>
          </div>
          ${
            story.aliases.length > 0
              ? `<div>
                  <dt>Aliases</dt>
                  <dd class="aliases">${story.aliases
                    .map(escapeHtml)
                    .join("<br>")}</dd>
                </div>`
              : ""
          }
        </dl>
      </aside>
    </div>
  </article>`;
}

export function renderContractReviewPage(
  options: ContractReviewPageOptions
): string {
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
                  data-lifecycle="${story.lifecycle}"
                >
                  <i aria-hidden="true"></i>
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
          story
        )}</template>`
    )
    .join("");

  const initialContent = firstEntry
    ? renderStoryDocument(
        firstEntry.capability.name,
        firstEntry.capability.description,
        firstEntry.story
      )
    : `<div class="empty-state">
        <h1>No capabilities yet</h1>
        <p>This page lists the product's capabilities, user stories, and
        acceptance criteria once semantic onboarding authors them under
        <code>.tieline/spec/</code>.</p>
        ${
          options.onboardingInstruction
            ? `<p>Run this command in your coding agent to begin:</p>
              <pre class="prompt">${escapeHtml(options.onboardingInstruction)}</pre>`
            : ""
        }
        <p><code>tieline contract compile .</code> refreshes this page
        whenever the contract changes.</p>
      </div>`;

  const warnings =
    options.warnings && options.warnings.length > 0
      ? `<aside class="warnings" aria-label="Contract warnings">
          <strong>Review notes</strong>
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
      --paper: #ffffff;
      --nav: #f4f5f7;
      --ink: #172b4d;
      --muted: #5e6c84;
      --line: #dfe1e6;
      --accent: #0c66e4;
      --green: #24775a;
      --body: "Avenir Next", Avenir, "Century Gothic", sans-serif;
      --mono: "SFMono-Regular", Menlo, Consolas, monospace;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      color: var(--ink);
      background: var(--paper);
      font: 14px/1.55 var(--body);
    }
    a { color: var(--accent); }
    button, input { font: inherit; }
    input:focus-visible, a:focus-visible, button:focus-visible {
      outline: 3px solid rgba(47, 88, 203, .25);
      outline-offset: 2px;
    }
    code { font: .7rem/1.5 var(--mono); overflow-wrap: anywhere; }
    .wiki-shell {
      display: grid;
      grid-template-columns: 280px minmax(0, 1fr);
      min-height: 100vh;
    }
    .wiki-nav {
      position: sticky;
      top: 0;
      align-self: start;
      height: 100vh;
      padding: 1.15rem .9rem 2rem;
      background: var(--nav);
      border-right: 1px solid var(--line);
      overflow-y: auto;
    }
    .wiki-brand {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: .65rem;
      padding: 0 .45rem 1rem;
      border-bottom: 1px solid var(--line);
    }
    .wiki-brand b { font-size: 1rem; }
    .wiki-brand p {
      margin: .2rem 0 0;
      color: var(--muted);
      font-size: .72rem;
      overflow-wrap: anywhere;
    }
    .print {
      padding: .25rem .5rem;
      color: var(--muted);
      background: white;
      border: 1px solid #cfd2d7;
      border-radius: 4px;
      cursor: pointer;
      font-size: .68rem;
    }
    .search {
      position: relative;
      display: block;
      margin: 1rem .15rem 1.15rem;
    }
    .search input {
      width: 100%;
      height: 36px;
      padding: .45rem 2rem .45rem .65rem;
      background: white;
      border: 1px solid #cfd2d7;
      border-radius: 4px;
    }
    .search span {
      position: absolute;
      right: .65rem;
      top: 50%;
      color: var(--muted);
      transform: translateY(-50%);
      pointer-events: none;
    }
    .nav-group { margin-top: 1.1rem; }
    .nav-group[hidden], .nav-group li[hidden] { display: none; }
    .nav-group h2 {
      margin: 0 .45rem .35rem;
      color: var(--muted);
      font-size: .66rem;
      font-weight: 800;
      letter-spacing: .055em;
      text-transform: uppercase;
    }
    .nav-group ul { margin: 0; padding: 0; list-style: none; }
    .nav-group a {
      display: grid;
      grid-template-columns: 8px minmax(0, 1fr);
      gap: .1rem .45rem;
      padding: .42rem .45rem;
      color: #424852;
      border-radius: 4px;
      text-decoration: none;
    }
    .nav-group a:hover { background: #e9ebee; }
    .nav-group a[aria-current="page"] {
      color: #0c66e4;
      background: #e9f2ff;
      box-shadow: inset 3px 0 #0c66e4;
    }
    .nav-group a > i {
      width: 6px;
      height: 6px;
      margin-top: .4rem;
      background: #9ca3ae;
      border-radius: 50%;
    }
    .nav-group a[data-lifecycle="production"] > i { background: var(--green); }
    .nav-group a[data-lifecycle="in_progress"] > i { background: var(--accent); }
    .nav-group a span { min-width: 0; font-size: .76rem; line-height: 1.35; }
    .nav-group a code {
      grid-column: 2;
      color: #8a919c;
      font-size: .59rem;
    }
    .nav-empty {
      display: none;
      margin: 1rem .45rem;
      color: var(--muted);
      font-size: .75rem;
    }
    .nav-empty.show { display: block; }
    .wiki-main { min-width: 0; }
    .wiki-content {
      max-width: 1180px;
      padding: clamp(1.75rem, 4vw, 3rem) clamp(1.25rem, 5vw, 4rem) 6rem;
    }
    .warnings {
      margin-bottom: 1.5rem;
      padding: .75rem .9rem;
      background: #fff6e2;
      border: 1px solid #e7cb99;
      border-radius: 4px;
    }
    .warnings ul { margin: .3rem 0 0; padding-left: 1.15rem; }
    .issue-header {
      padding-bottom: 1.25rem;
      border-bottom: 1px solid var(--line);
    }
    .breadcrumbs {
      display: flex;
      gap: .45rem;
      margin: 0 0 .65rem;
      color: var(--muted);
      font-size: .72rem;
    }
    .breadcrumbs span { color: var(--accent); }
    .breadcrumbs b { color: #a4acb8; font-weight: 400; }
    .issue-header > code { color: var(--muted); }
    .status {
      display: inline-flex;
      align-items: center;
      gap: .3rem;
      padding: .13rem .38rem;
      border-radius: 3px;
      font-size: .61rem;
      font-weight: 800;
      text-transform: uppercase;
    }
    .status i { width: 6px; height: 6px; border-radius: 50%; }
    .status-production { color: var(--green); background: #e7f3ed; }
    .status-production i { background: var(--green); }
    .status-in_progress { color: var(--accent); background: #e9edfa; }
    .status-in_progress i { background: var(--accent); }
    .status-retired { color: var(--muted); background: #eceef1; }
    .status-retired i { background: var(--muted); }
    .issue-header h1 {
      max-width: 32ch;
      margin: .35rem 0 0;
      font-size: clamp(1.45rem, 2.5vw, 1.85rem);
      line-height: 1.2;
      letter-spacing: -.015em;
    }
    .issue-layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 250px;
      gap: clamp(2rem, 5vw, 4rem);
      align-items: start;
      margin-top: 1.5rem;
    }
    .issue-main { min-width: 0; }
    .issue-section + .issue-section { margin-top: 2rem; }
    .issue-section > h2, .issue-details > h2 {
      margin: 0 0 .75rem;
      font-size: .92rem;
      line-height: 1.3;
    }
    .capability-description { max-width: 66ch; margin: 0; color: var(--muted); font-size: .82rem; }
    blockquote {
      margin: .85rem 0 0;
      padding: .8rem .95rem;
      color: #424a55;
      background: #f7f8fa;
      border: 1px solid #e3e5e9;
      border-left: 3px solid var(--accent);
      border-radius: 0 4px 4px 0;
      font-size: .86rem;
    }
    .aliases { color: var(--muted); font-size: .76rem; }
    .tags { display: flex; flex-wrap: wrap; gap: .3rem; margin-top: .75rem; }
    .tags span {
      display: inline-flex;
      gap: .3rem;
      padding: .16rem .4rem;
      color: var(--muted);
      background: #f0f1f3;
      border-radius: 3px;
      font-size: .67rem;
    }
    .tags b { color: var(--ink); text-transform: capitalize; }
    .criteria > h2 {
      display: flex;
      align-items: center;
      gap: .55rem;
      margin: 0 0 .75rem;
      font-size: .92rem;
      line-height: 1.3;
    }
    .criteria > h2 small {
      display: grid;
      min-width: 22px;
      height: 22px;
      padding: 0 .35rem;
      place-items: center;
      color: var(--muted);
      background: #f0f1f3;
      border-radius: 11px;
      font: 700 .64rem var(--mono);
    }
    .criterion {
      display: grid;
      grid-template-columns: 30px minmax(0, 1fr);
      gap: .75rem;
      margin-top: .65rem;
      padding: .9rem;
      background: #fff;
      border: 1px solid var(--line);
      border-radius: 6px;
    }
    .criterion > div {
      min-width: 0;
    }
    .criterion-number {
      display: grid;
      width: 25px;
      height: 25px;
      place-items: center;
      color: var(--accent);
      background: #edf0fa;
      border-radius: 4px;
      font: 700 .66rem var(--mono);
    }
    .criterion-text { margin: .3rem 0 0; font-size: .84rem; font-weight: 700; line-height: 1.45; }
    .rationale {
      margin: .65rem 0 0;
      padding: .5rem .65rem;
      color: var(--muted);
      background: #faf7ef;
      border-left: 2px solid #c9983c;
      font-size: .72rem;
    }
    .scenarios { display: grid; gap: .45rem; margin-top: .7rem; }
    .scenario {
      padding: .65rem .75rem;
      background: #f7f8fa;
      border: 1px solid #e5e7eb;
      border-radius: 4px;
    }
    .scenario header { display: flex; flex-wrap: wrap; gap: .35rem .65rem; margin-bottom: .4rem; font-size: .7rem; }
    .scenario header span { color: var(--accent); font-family: var(--mono); }
    .scenario dl { display: grid; gap: .25rem; margin: 0; }
    .scenario dl div { display: grid; grid-template-columns: 44px minmax(0, 1fr); }
    .scenario dt { color: var(--muted); font-size: .62rem; font-weight: 800; text-transform: uppercase; }
    .scenario dd { margin: 0; font-size: .74rem; }
    .references {
      margin-top: 1.2rem;
      padding-top: .75rem;
      border-top: 1px solid var(--line);
    }
    .criterion .references { margin-top: .75rem; }
    .references summary {
      display: flex;
      align-items: center;
      gap: .45rem;
      width: max-content;
      color: var(--muted);
      cursor: pointer;
      font-size: .72rem;
      font-weight: 700;
      list-style: none;
    }
    .references summary::-webkit-details-marker { display: none; }
    .references summary::before {
      color: #9aa1ab;
      content: "›";
      font: 1rem/1 var(--mono);
      transition: transform .12s ease;
    }
    .references[open] summary::before { transform: rotate(90deg); }
    .references summary span {
      min-width: 19px;
      padding: 0 .3rem;
      color: #858d98;
      background: #f0f1f3;
      border-radius: 9px;
      font: .6rem/18px var(--mono);
      text-align: center;
    }
    .references ul { display: grid; gap: .35rem; margin: .6rem 0 0 1.25rem; padding: 0; list-style: none; }
    .references li { display: grid; grid-template-columns: 138px minmax(0, 1fr); gap: .5rem; font: .66rem/1.45 var(--mono); }
    .references small { color: var(--muted); }
    .issue-details {
      position: sticky;
      top: 1.25rem;
      padding: 1rem;
      background: #fafbfc;
      border: 1px solid var(--line);
      border-radius: 6px;
    }
    .issue-details dl { margin: 0; }
    .issue-details dl > div {
      display: grid;
      grid-template-columns: 78px minmax(0, 1fr);
      gap: .65rem;
      padding: .7rem 0;
      border-top: 1px solid var(--line);
    }
    .issue-details dt {
      color: var(--muted);
      font-size: .68rem;
      font-weight: 700;
    }
    .issue-details dd {
      min-width: 0;
      margin: 0;
      font-size: .72rem;
      overflow-wrap: anywhere;
    }
    .empty-document { color: var(--muted); }
    .empty-state { max-width: 58ch; margin: 3rem auto 0; }
    .empty-state h1 { font-size: 1.4rem; letter-spacing: -.015em; }
    .empty-state p { color: var(--muted); font-size: .86rem; }
    .empty-state .prompt {
      padding: .8rem .95rem;
      color: var(--ink);
      background: #f7f8fa;
      border: 1px solid #e3e5e9;
      border-left: 3px solid var(--accent);
      border-radius: 0 4px 4px 0;
      font: .78rem/1.5 var(--mono);
      white-space: pre-wrap;
      user-select: all;
    }
    @media (max-width: 980px) {
      .issue-layout { grid-template-columns: 1fr; }
      .issue-details { position: static; }
    }
    @media (max-width: 760px) {
      .wiki-shell { display: block; }
      .wiki-nav {
        position: static;
        height: auto;
        max-height: 44vh;
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }
      .wiki-content { padding-top: 2rem; }
    }
    @media (max-width: 520px) {
      .scenario dl div { grid-template-columns: 1fr; }
    }
    @media print {
      .wiki-shell { display: block; }
      .wiki-nav { display: none; }
      .wiki-content { max-width: none; padding: 0; }
      .warnings { display: none; }
      .issue-layout { display: block; }
      .issue-details { margin-top: 1.5rem; }
      .references:not([open]) > ul { display: grid !important; }
      .criterion, .scenario { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="wiki-shell">
    <aside class="wiki-nav">
      <header class="wiki-brand">
        <div>
          <b>${escapeHtml(options.repositoryKey)}</b>
          <p>Specification</p>
        </div>
        <button class="print" type="button" onclick="window.print()">Print</button>
      </header>
      <label class="search">
        <input id="search" type="search" placeholder="Search stories…" autocomplete="off">
        <span aria-hidden="true">⌕</span>
      </label>
      <nav aria-label="Stories">${navigation}</nav>
      <p class="nav-empty" id="nav-empty">No matching stories.</p>
    </aside>
    <main class="wiki-main">
      <div class="wiki-content">
        ${warnings}
        <div id="story-content">${initialContent}</div>
      </div>
    </main>
  </div>
  ${templates}
  <script>
    (() => {
      const search = document.querySelector("#search");
      const links = [...document.querySelectorAll("[data-story-link]")];
      const groups = [...document.querySelectorAll("[data-nav-group]")];
      const content = document.querySelector("#story-content");
      const empty = document.querySelector("#nav-empty");

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
        }
        document.title =
          link.querySelector("span").textContent + " · Tieline spec review";
        if (window.innerWidth <= 760) {
          content.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }

      function updateSearch() {
        const query = search.value.trim().toLocaleLowerCase("en");
        let visible = 0;
        for (const item of document.querySelectorAll("[data-nav-item]")) {
          item.hidden =
            query.length > 0 && !item.dataset.search.includes(query);
          if (!item.hidden) visible += 1;
        }
        for (const group of groups) {
          group.hidden = !group.querySelector("[data-nav-item]:not([hidden])");
        }
        empty.classList.toggle("show", visible === 0);
      }

      for (const link of links) {
        link.addEventListener("click", (event) => {
          event.preventDefault();
          showStory(link);
        });
      }
      search.addEventListener("input", updateSearch);
      window.addEventListener("popstate", () => {
        const link = linkFromHash() || links[0];
        if (link) showStory(link, false);
      });
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
      });

      function linkFromHash() {
        try {
          const requestedKey = decodeURIComponent(location.hash.slice(1));
          return links.find(
            (link) => link.dataset.storyKey === requestedKey
          );
        } catch {
          return undefined;
        }
      }

      const initialLink = linkFromHash() || links[0];
      if (initialLink) showStory(initialLink, false);
    })();
  </script>
</body>
</html>
`;
}
