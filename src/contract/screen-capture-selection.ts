import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { parse } from "yaml";
import { changesSince, type RepositoryPathChange } from "./impact.js";
import type { ContractManifest } from "./manifest.js";
import { screenPathPattern } from "./paths.js";
import {
  SCREEN_LIMITS,
  validateScreenCatalogDocuments,
  type ScreenCatalogDocumentInput,
  type ScreenEntry,
  type ScreenNotCapturedReason,
  type ScreenSettings,
  type ValidatedScreenCatalog,
} from "./screen-catalog.js";
import { readBoundedFile } from "./screen-import.js";
import { isSceneTestCandidate, SCREEN_SCENE_LIMITS, screenTagsIn } from "./screen-scenes.js";
import { SCREEN_TEXT_EXTENSION } from "./screen-text.js";

/**
 * Which screens a capture run should re-capture, and why each one. Selection
 * is a heuristic over what a branch changed since it left its base; every pick
 * carries the rule and the file that triggered it, so a reviewer can judge it,
 * and `tieline screens audit --capture` remains the full pass for anything the
 * rules miss.
 */

export const SCREEN_SELECTION_LIMITS = {
  /** Reasons kept per screen; the rest are counted. */
  reasonsPerScreen: 10,
  /** Largest `git ls-tree` listing of the base catalog read. */
  listedBytes: 16 * 1024 * 1024,
} as const;

/**
 * Why a screen was selected:
 *
 * - `all`, `requested`: the run asked for every screen, or for this one;
 * - `outputs`: its committed capture outputs (digest, capture record, or ARIA
 *   snapshot) changed, so `--verify` must check them against a fresh capture;
 * - `catalog`: its catalog entry was added or its fields changed;
 * - `scene`: a changed test file tags it `@screen:<key>`;
 * - `contract`: a Story or AC that shows it links a changed file;
 * - `path`: a changed file matches one of its `paths`;
 * - `dependency`: the code-topology blast radius of a changed file (`from`)
 *   reaches a file (`path`) that one of its `paths` or showing Stories and ACs
 *   names;
 * - `global`: a changed file matches `screens.capture.global_paths`.
 */
export type ScreenSelectionReason =
  | { rule: "all" }
  | { rule: "requested" }
  | { rule: "outputs"; path: string }
  | { rule: "catalog"; change: "added" | "changed" }
  | { rule: "scene"; path: string }
  | { rule: "contract"; owner: string; path: string }
  | { rule: "path"; pattern: string; path: string }
  | { rule: "dependency"; path: string; from: string; owner: string }
  | { rule: "dependency"; path: string; from: string; pattern: string }
  | { rule: "global"; pattern: string; path: string };

export type ScreenSelectionRule = ScreenSelectionReason["rule"];

const RULE_ORDER: readonly ScreenSelectionRule[] = [
  "all",
  "requested",
  "outputs",
  "catalog",
  "scene",
  "contract",
  "path",
  "dependency",
  "global",
];

export interface SelectedScreen {
  key: string;
  capability: string;
  reasons: ScreenSelectionReason[];
  /** Reasons beyond the per-screen bound, counted rather than listed. */
  omitted_reasons: number;
}

export type ScreenSelectionScope =
  | { kind: "all" }
  | { kind: "screens"; keys: readonly string[] }
  | { kind: "changed"; base: string };

/** A rule that could not be evaluated, so the selection may be narrower. */
export interface UnavailableSelectionRule {
  rule: "contract" | "dependency" | "scene" | "catalog";
  detail: string;
}

/** A screen the rules picked that is marked not captured, so it is skipped. */
export interface ExcludedScreen {
  key: string;
  capability: string;
  reason: ScreenNotCapturedReason;
  detail: string;
}

export interface ScreenSelection {
  scope: ScreenSelectionScope["kind"];
  /** The ref named and the branch point compared with; null unless `changed`. */
  base: { ref: string; commit: string } | null;
  /** Selected screens, by key. */
  screens: SelectedScreen[];
  /** Screens the scope or rules picked that are marked not captured. */
  excluded: ExcludedScreen[];
  changed_files: number;
  unavailable: UnavailableSelectionRule[];
  /**
   * Present when verification widened a `changed` selection to every screen,
   * because a rule could not run and the narrower selection proves nothing.
   */
  widened?: { reason: string };
}

/**
 * Splits off the screens marked not captured: they say why instead of being
 * captured, so a run never starts their tests.
 */
export function excludeNotCaptured(
  catalog: ValidatedScreenCatalog,
  screens: readonly SelectedScreen[]
): { screens: SelectedScreen[]; excluded: ExcludedScreen[] } {
  const kept: SelectedScreen[] = [];
  const excluded: ExcludedScreen[] = [];
  for (const screen of screens) {
    const marker = catalog.screens.get(screen.key)?.entry.not_captured;
    if (marker) excluded.push({ key: screen.key, capability: screen.capability, ...marker });
    else kept.push(screen);
  }
  return { screens: kept, excluded };
}

/**
 * Files the code-topology blast radius reaches from the changed files: each
 * dependent `path`, with the changed file it was reached `from`.
 */
export type ScreenDependents =
  | { status: "complete"; files: Array<{ path: string; from: string }>; truncated: boolean }
  | { status: "unavailable"; detail: string };

/** A file linked by a Story or AC that shows a screen. */
export interface ScreenOwnerLink {
  owner: string;
  path: string;
}

function linkedPaths(links: ContractManifest["capabilities"][number]["stories"][number]["links"]): string[] {
  return links.flatMap((link) => ("path" in link.target ? [link.target.path] : []));
}

/**
 * The files each screen's showing Stories and ACs link, by screen key. An AC
 * contributes its own links; a Story-level `shows` link is the coarse
 * fallback, so the Story contributes its own links and every AC's.
 */
export function screenOwnerLinks(manifest: ContractManifest): Map<string, ScreenOwnerLink[]> {
  const owners = new Map<string, Map<string, ScreenOwnerLink>>();
  const add = (key: string, owner: string, paths: string[]): void => {
    const links = owners.get(key) ?? new Map<string, ScreenOwnerLink>();
    for (const path of paths) links.set(`${owner}\0${path}`, { owner, path });
    owners.set(key, links);
  };
  for (const capability of manifest.capabilities) {
    for (const story of capability.stories) {
      const storyPaths = [
        ...linkedPaths(story.links),
        ...story.acceptance_criteria.flatMap((criterion) => linkedPaths(criterion.links)),
      ];
      for (const link of story.shows ?? []) add(link.target.key, story.stable_id, storyPaths);
      for (const criterion of story.acceptance_criteria) {
        for (const link of criterion.shows ?? []) {
          add(link.target.key, criterion.stable_id, linkedPaths(criterion.links));
        }
      }
    }
  }
  return new Map(
    [...owners].map(([key, links]) => [
      key,
      [...links.values()].sort(
        (left, right) => left.owner.localeCompare(right.owner) || left.path.localeCompare(right.path)
      ),
    ])
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).sort(([left], [right]) =>
            left.localeCompare(right)
          )
        )
      : entry
  );
}

/** What a screen is, without what a capture writes or what only selection reads. */
function authoredFields(entry: ScreenEntry): string {
  const { image: _image, capture: _capture, paths: _paths, ...fields } = entry;
  return stableJson(fields);
}

function outputFields(entry: ScreenEntry): string {
  return stableJson({ image: entry.image ?? null, capture: entry.capture ?? null });
}

/** The paths a change touches: both sides of a rename. */
function touchedPaths(change: RepositoryPathChange): string[] {
  return change.status === "renamed" ? [change.path, change.old_path] : [change.path];
}

export interface ChangedScreenInputs {
  settings: ScreenSettings;
  current: ValidatedScreenCatalog;
  /** Catalog entries at the branch point, by key. */
  base: ReadonlyMap<string, ScreenEntry>;
  changes: readonly RepositoryPathChange[];
  globalPaths: readonly string[];
  /** Files each screen's showing Stories and ACs link; null when unavailable. */
  owners: ReadonlyMap<string, readonly ScreenOwnerLink[]> | null;
  dependents: ScreenDependents;
  /**
   * The `@screen` keys a changed test file tags, read from the working tree,
   * or from the branch point for a deleted file. Null when it cannot be read.
   */
  sceneTags(change: RepositoryPathChange): string[] | null;
}

/**
 * Applies the selection rules to a branch's changes. Pure over its inputs:
 * git, the filesystem, and the topology are read by the caller.
 */
export function selectChangedScreens(input: ChangedScreenInputs): {
  screens: SelectedScreen[];
  unavailable: UnavailableSelectionRule[];
} {
  const { settings, current, base, changes } = input;
  const reasons = new Map<string, Map<string, ScreenSelectionReason>>();
  const select = (key: string, reason: ScreenSelectionReason): void => {
    if (!current.screens.has(key)) return;
    const existing = reasons.get(key) ?? new Map<string, ScreenSelectionReason>();
    existing.set(stableJson(reason), reason);
    reasons.set(key, existing);
  };
  const unavailable: UnavailableSelectionRule[] = [];

  // Committed outputs and authored catalog fields, compared by key with the
  // branch point.
  for (const [key, { path, entry }] of current.screens) {
    const previous = base.get(key);
    if (!previous) {
      select(key, { rule: "catalog", change: "added" });
      continue;
    }
    if (authoredFields(previous) !== authoredFields(entry)) {
      select(key, { rule: "catalog", change: "changed" });
    }
    if (outputFields(previous) !== outputFields(entry)) select(key, { rule: "outputs", path });
  }
  const textPrefix = `${settings.textPath}/`;
  for (const change of changes) {
    for (const path of touchedPaths(change)) {
      if (!path.startsWith(textPrefix) || !path.endsWith(SCREEN_TEXT_EXTENSION)) continue;
      const name = path.slice(textPrefix.length, -SCREEN_TEXT_EXTENSION.length);
      if (!name.includes("/")) select(name, { rule: "outputs", path });
    }
  }

  // Scene tests that changed.
  const sceneFiles = settings.sceneTests ? settings.sceneTests.map(screenPathPattern) : null;
  const unreadableScenes: string[] = [];
  for (const change of changes) {
    // A rename out of a test file name still drops the tags its old file had.
    if (!touchedPaths(change).some((path) => isSceneTestCandidate(path, sceneFiles))) continue;
    const keys = input.sceneTags(change);
    if (keys === null) {
      unreadableScenes.push(change.path);
      continue;
    }
    for (const key of keys) select(key, { rule: "scene", path: change.path });
  }
  if (unreadableScenes.length > 0) {
    unavailable.push({
      rule: "scene",
      detail: `${unreadableScenes.length} changed test file(s) could not be read for @screen tags (${unreadableScenes
        .slice(0, 3)
        .join(", ")}${unreadableScenes.length > 3 ? ", …" : ""})`,
    });
  }

  // Files owned by screens directly (paths) or through their Stories and ACs.
  const patterns = [...current.screens].flatMap(([key, { entry }]) =>
    (entry.paths ?? []).map((pattern) => ({ key, pattern, regex: screenPathPattern(pattern) }))
  );
  const ownersByPath = new Map<string, Array<{ key: string; owner: string }>>();
  for (const [key, links] of input.owners ?? []) {
    for (const link of links) {
      const owners = ownersByPath.get(link.path) ?? [];
      owners.push({ key, owner: link.owner });
      ownersByPath.set(link.path, owners);
    }
  }
  if (!input.owners) {
    unavailable.push({
      rule: "contract",
      detail: "the working-tree contract does not compile, so the Stories and ACs that show each screen are unknown",
    });
  }
  for (const change of changes) {
    for (const path of touchedPaths(change)) {
      for (const { key, owner } of ownersByPath.get(path) ?? []) {
        select(key, { rule: "contract", owner, path });
      }
      for (const { key, pattern, regex } of patterns) {
        if (regex.test(path)) select(key, { rule: "path", pattern, path });
      }
    }
  }

  if (input.dependents.status === "complete") {
    for (const { path, from } of input.dependents.files) {
      for (const { key, owner } of ownersByPath.get(path) ?? []) {
        select(key, { rule: "dependency", path, from, owner });
      }
      for (const { key, pattern, regex } of patterns) {
        if (regex.test(path)) select(key, { rule: "dependency", path, from, pattern });
      }
    }
    if (input.dependents.truncated) {
      unavailable.push({
        rule: "dependency",
        detail: "the code-topology blast radius reached its traversal bound, so some dependents were not followed",
      });
    }
  } else {
    unavailable.push({ rule: "dependency", detail: input.dependents.detail });
  }

  // A global path selects everything; the first matching change is the reason.
  const globals = input.globalPaths.map((pattern) => ({ pattern, regex: screenPathPattern(pattern) }));
  const global = changes
    .flatMap(touchedPaths)
    .flatMap((path) => globals.filter(({ regex }) => regex.test(path)).map(({ pattern }) => ({ pattern, path })))[0];
  if (global) {
    for (const key of current.screens.keys()) select(key, { rule: "global", ...global });
  }

  return { screens: selectedScreens(current, reasons), unavailable };
}

function compareReasons(left: ScreenSelectionReason, right: ScreenSelectionReason): number {
  return (
    RULE_ORDER.indexOf(left.rule) - RULE_ORDER.indexOf(right.rule) ||
    stableJson(left).localeCompare(stableJson(right))
  );
}

function selectedScreens(
  catalog: ValidatedScreenCatalog,
  reasons: ReadonlyMap<string, ReadonlyMap<string, ScreenSelectionReason>>
): SelectedScreen[] {
  return [...reasons]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, byIdentity]) => {
      const sorted = [...byIdentity.values()].sort(compareReasons);
      return {
        key,
        capability: catalog.screens.get(key)!.capability,
        reasons: sorted.slice(0, SCREEN_SELECTION_LIMITS.reasonsPerScreen),
        omitted_reasons: Math.max(0, sorted.length - SCREEN_SELECTION_LIMITS.reasonsPerScreen),
      };
    });
}

/** Every catalogued screen, or exactly the requested ones. */
export function selectRequestedScreens(
  catalog: ValidatedScreenCatalog,
  scope: Exclude<ScreenSelectionScope, { kind: "changed" }>
): SelectedScreen[] {
  if (scope.kind === "all") {
    return selectedScreens(
      catalog,
      new Map([...catalog.screens.keys()].map((key) => [key, new Map([["all", { rule: "all" as const }]])]))
    );
  }
  const unknown = scope.keys.filter((key) => !catalog.screens.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `The screen catalog has no screen ${unknown.map((key) => `'${key}'`).join(", ")}.`
    );
  }
  const marked = scope.keys.filter((key) => catalog.screens.get(key)!.entry.not_captured);
  if (marked.length > 0) {
    throw new Error(
      `${marked.map((key) => `'${key}'`).join(", ")} ${marked.length === 1 ? "is" : "are"} marked not captured (${marked
        .map((key) => catalog.screens.get(key)!.entry.not_captured!.reason)
        .join(", ")}); remove not_captured from the catalog entry to capture it.`
    );
  }
  return selectedScreens(
    catalog,
    new Map(scope.keys.map((key) => [key, new Map([["requested", { rule: "requested" as const }]])]))
  );
}

function git(root: string, args: string[], maxBuffer: number): Buffer {
  return execFileSync("git", args, { cwd: root, maxBuffer, stdio: ["ignore", "pipe", "pipe"] });
}

function gitDetail(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const text = Buffer.isBuffer(stderr) ? stderr.toString("utf8").trim() : "";
  return text.split("\n")[0] || (error instanceof Error ? error.message : String(error));
}

/**
 * The catalog as committed at `commit`, by key, bounded like the working-tree
 * catalog: files, bytes per file, and bytes in total. A file that cannot be
 * read or does not validate contributes no entries, so its screens read as
 * added and are selected: an unreadable branch point must widen the
 * selection, never narrow it.
 */
export function readBaseScreenCatalog(
  repositoryRoot: string,
  settings: ScreenSettings,
  commit: string,
  limits: { files: number; fileBytes: number; totalBytes: number } = {
    files: SCREEN_LIMITS.catalogFiles,
    fileBytes: SCREEN_LIMITS.catalogFileBytes,
    totalBytes: SCREEN_LIMITS.catalogTotalBytes,
  }
): { entries: Map<string, ScreenEntry>; issues: string[] } {
  const root = resolve(repositoryRoot);
  const issues: string[] = [];
  let listed: string[];
  try {
    listed = git(
      root,
      ["ls-tree", "-r", "-z", "--name-only", commit, "--", settings.catalogPath],
      SCREEN_SELECTION_LIMITS.listedBytes
    )
      .toString("utf8")
      .split("\0")
      .filter((path) => /\.ya?ml$/i.test(path));
  } catch (error) {
    return {
      entries: new Map(),
      issues: [`the catalog at ${commit.slice(0, 12)} could not be listed: ${gitDetail(error)}`],
    };
  }
  // The same bounds as the working-tree catalog walk: a branch point holding
  // more is not read at all, so every screen reads as added.
  if (listed.length > limits.files) {
    return {
      entries: new Map(),
      issues: [`the catalog at ${commit.slice(0, 12)} holds more than ${limits.files} YAML files`],
    };
  }
  const inputs: ScreenCatalogDocumentInput[] = [];
  let totalBytes = 0;
  for (const path of listed.sort()) {
    try {
      // `./` reads the path relative to the repository root, as listed.
      const content = git(root, ["show", `${commit}:./${path}`], limits.fileBytes);
      totalBytes += content.length;
      if (totalBytes > limits.totalBytes) {
        return {
          entries: new Map(),
          issues: [`the catalog at ${commit.slice(0, 12)} holds more than ${limits.totalBytes} bytes of YAML`],
        };
      }
      inputs.push({ path, document: parse(content.toString("utf8")) });
    } catch (error) {
      issues.push(`${path} at ${commit.slice(0, 12)} could not be read: ${gitDetail(error)}`);
    }
  }
  const catalog = validateScreenCatalogDocuments(inputs, undefined, issues);
  return {
    entries: new Map([...catalog.screens].map(([key, screen]) => [key, screen.entry])),
    issues,
  };
}

/**
 * Reads the `@screen` tags of a changed test file, both as the branch point
 * had it (at its old path, for a rename) and as the working tree has it, so a
 * tag the change removed or renamed still selects its screen. Bounded like
 * the audit's scan; null when either side cannot be read within the bound.
 */
export function changedSceneTagReader(
  repositoryRoot: string,
  commit: string
): (change: RepositoryPathChange) => string[] | null {
  const root = resolve(repositoryRoot);
  return (change) => {
    try {
      const before =
        change.status === "added"
          ? []
          : screenTagsIn(
              git(root, ["show", `${commit}:${change.status === "renamed" ? change.old_path : change.path}`], SCREEN_SCENE_LIMITS.fileBytes).toString("utf8")
            );
      const after =
        change.status === "deleted"
          ? []
          : screenTagsIn(readBoundedFile(resolve(root, change.path), SCREEN_SCENE_LIMITS.fileBytes, "test file").toString("utf8"));
      return [...new Set([...before, ...after])];
    } catch {
      return null;
    }
  };
}

export interface SelectChangedScreensOptions {
  repositoryRoot: string;
  settings: ScreenSettings;
  current: ValidatedScreenCatalog;
  base: { ref: string; commit: string };
  /** The working-tree manifest, or null when the contract does not compile. */
  manifest: ContractManifest | null;
  dependents: ScreenDependents;
}

/**
 * What the working tree changed since `commit`: committed and uncommitted
 * changes to tracked files, plus new files git does not ignore, which a
 * developer capturing locally has often not added yet.
 */
export function workingTreeChangesSince(repositoryRoot: string, commit: string): RepositoryPathChange[] {
  const tracked = changesSince(repositoryRoot, commit);
  const seen = new Set(tracked.map((change) => change.path));
  const untracked = git(
    resolve(repositoryRoot),
    ["ls-files", "-z", "--others", "--exclude-standard"],
    SCREEN_SELECTION_LIMITS.listedBytes
  )
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0 && !seen.has(path))
    .sort()
    .map((path): RepositoryPathChange => ({ status: "added", path }));
  return [...tracked, ...untracked];
}

/** Reads what a branch changed since its branch point and selects screens. */
export function selectScreensChangedSince(options: SelectChangedScreensOptions): ScreenSelection {
  const changes = workingTreeChangesSince(options.repositoryRoot, options.base.commit);
  const base = readBaseScreenCatalog(options.repositoryRoot, options.settings, options.base.commit);
  const selected = selectChangedScreens({
    settings: options.settings,
    current: options.current,
    base: base.entries,
    changes,
    globalPaths: options.settings.globalPaths,
    owners: options.manifest ? screenOwnerLinks(options.manifest) : null,
    dependents: options.dependents,
    sceneTags: changedSceneTagReader(options.repositoryRoot, options.base.commit),
  });
  const { screens, excluded } = excludeNotCaptured(options.current, selected.screens);
  return {
    scope: "changed",
    base: options.base,
    screens,
    excluded,
    changed_files: changes.length,
    unavailable: [
      ...(base.issues.length > 0
        ? [
            {
              rule: "catalog" as const,
              detail: `the catalog at the branch point could not be read in full, so its screens were treated as added: ${base.issues
                .slice(0, 3)
                .join("; ")}${base.issues.length > 3 ? "; …" : ""}`,
            },
          ]
        : []),
      ...selected.unavailable,
    ],
  };
}
