import { compileContractManifest, type ContractManifest } from "../contract/manifest.js";
import { resolveComparisonBase } from "../contract/comparison-base.js";
import { readDeclaredCapabilityKeys } from "../contract/load.js";
import {
  readScreenCatalogSources,
  screenSettingsForRepository,
  validateScreenCatalogDocuments,
  type ValidatedScreenCatalog,
} from "../contract/screen-catalog.js";
import {
  selectRequestedScreens,
  selectScreensChangedSince,
  type ScreenDependents,
  type ScreenSelection,
  type ScreenSelectionReason,
  type ScreenSelectionScope,
} from "../contract/screen-capture-selection.js";
import { ScreenImportError } from "../contract/screen-import.js";
import { executeChangeBlastRadius } from "./code-topology.js";
import {
  escapeTerminalText,
  resolveCommandContext,
  type CommandIO,
} from "./shared.js";

const NOT_ENABLED =
  'Screens are not enabled for this repository. Add "screens": { "enabled": true } to .tieline/config.json to opt in.';

export interface ScreensCaptureOptions {
  repository?: string;
  all?: boolean;
  changed?: boolean;
  base?: string;
  screens?: readonly string[];
  dryRun?: boolean;
  json?: boolean;
}

/** What the capture command reads beyond the repository, injectable for tests. */
export interface ScreensCaptureDependencies {
  /** The code-topology blast radius of the branch's changes. */
  dependents(input: {
    repositoryRoot: string;
    repositoryKey: string;
    base: string;
  }): Promise<ScreenDependents>;
}

/**
 * Follows the existing AC-aware blast radius from every file the branch
 * changed to the files that depend on it. Unavailable topology (missing,
 * stale, or absent at the branch point) is reported, never treated as "no
 * dependents".
 */
export async function topologyDependents(input: {
  repositoryRoot: string;
  repositoryKey: string;
  base: string;
}): Promise<ScreenDependents> {
  const result = await executeChangeBlastRadius({
    repositoryRoot: input.repositoryRoot,
    repository: input.repositoryKey,
    base: input.base,
    direction: "dependents",
  });
  if (result.status !== "complete") {
    const detail = "detail" in result ? `: ${result.detail}` : "";
    return {
      status: "unavailable",
      detail: `the code-topology blast radius is unavailable (${result.status})${detail}`,
    };
  }
  const files = new Map<string, { path: string; from: string }>();
  for (const path of result.paths) {
    const from = path.nodes[0]?.locator.path;
    if (from === undefined) continue;
    for (const node of path.nodes.slice(1)) {
      if (node.locator.path === from) continue;
      files.set(`${node.locator.path}\0${from}`, { path: node.locator.path, from });
    }
  }
  return {
    status: "complete",
    files: [...files.values()].sort(
      (left, right) => left.path.localeCompare(right.path) || left.from.localeCompare(right.from)
    ),
    truncated: result.truncation.truncated,
  };
}

const DEFAULT_DEPENDENCIES: ScreensCaptureDependencies = {
  dependents: topologyDependents,
};

function captureScope(options: ScreensCaptureOptions): ScreenSelectionScope {
  const screens = options.screens ?? [];
  const chosen = [options.all === true, options.changed === true, screens.length > 0].filter(Boolean);
  if (chosen.length !== 1) {
    throw new Error("Choose exactly one of --all, --changed --base <ref>, or --screen <key>.");
  }
  if (options.changed && !options.base) {
    throw new Error("--changed needs --base <ref>: the ref the branch is compared with.");
  }
  if (!options.changed && options.base) {
    throw new Error("--base applies only to --changed.");
  }
  if (options.all) return { kind: "all" };
  if (options.changed) return { kind: "changed", base: options.base! };
  return { kind: "screens", keys: [...new Set(screens)] };
}

/** The working-tree catalog, validated against the spec's capabilities. */
function loadCaptureCatalog(root: string, specDirectory: string, settings: NonNullable<ReturnType<typeof screenSettingsForRepository>>): ValidatedScreenCatalog {
  const read = readScreenCatalogSources(root, settings);
  const issues = [...read.issues];
  const catalog = validateScreenCatalogDocuments(
    read.sources,
    readDeclaredCapabilityKeys(root, specDirectory),
    issues
  );
  if (issues.length > 0) {
    throw new ScreenImportError("The screen catalog is invalid; fix it before capturing.", issues);
  }
  return catalog;
}

export function describeSelectionReason(reason: ScreenSelectionReason): string {
  switch (reason.rule) {
    case "all":
      return "every screen (--all)";
    case "requested":
      return "requested with --screen";
    case "outputs":
      return `committed capture outputs changed in ${reason.path}`;
    case "catalog":
      return `catalog entry ${reason.change}`;
    case "scene":
      return `scene test ${reason.path} changed`;
    case "contract":
      return `${reason.owner} shows it and links ${reason.path}, which changed`;
    case "path":
      return `${reason.path} changed and matches its path ${reason.pattern}`;
    case "dependency":
      return "owner" in reason
        ? `${reason.path} depends on ${reason.from}, which changed, and ${reason.owner} shows it and links ${reason.path}`
        : `${reason.path} depends on ${reason.from}, which changed, and matches its path ${reason.pattern}`;
    case "global":
      return `global path ${reason.path} changed (${reason.pattern})`;
  }
}

function renderSelection(selection: ScreenSelection, catalogScreens: number, io: CommandIO): void {
  const scope =
    selection.base !== null
      ? `changed since ${escapeTerminalText(selection.base.ref)} (branch point ${selection.base.commit.slice(0, 12)}, ${selection.changed_files} changed file(s))`
      : selection.scope === "all"
        ? "in the catalog"
        : "requested";
  io.write(
    `Would capture ${selection.screens.length} of ${catalogScreens} screen(s) ${scope}.\n`
  );
  for (const screen of selection.screens) {
    io.write(`  ${escapeTerminalText(screen.key)} (${escapeTerminalText(screen.capability)})\n`);
    for (const reason of screen.reasons) {
      io.write(`    ${reason.rule.padEnd(10)} ${escapeTerminalText(describeSelectionReason(reason))}\n`);
    }
    if (screen.omitted_reasons > 0) {
      io.write(`    (and ${screen.omitted_reasons} more reason(s))\n`);
    }
  }
  for (const rule of selection.unavailable) {
    io.write(`  note  ${rule.rule} rule incomplete: ${escapeTerminalText(rule.detail)}\n`);
  }
}

/**
 * `tieline screens capture`: selects the screens to capture, each with the
 * reasons it was selected. `--dry-run` reports the selection without
 * capturing.
 */
export async function runScreensCaptureCommand(
  options: ScreensCaptureOptions,
  io: CommandIO,
  dependencies: ScreensCaptureDependencies = DEFAULT_DEPENDENCIES
): Promise<number> {
  const scope = captureScope(options);
  const { root, repositoryKey, specDirectory } = resolveCommandContext(options);
  const settings = screenSettingsForRepository(root);
  if (!settings) throw new Error(NOT_ENABLED);
  const catalog = loadCaptureCatalog(root, specDirectory, settings);

  let selection: ScreenSelection;
  if (scope.kind === "changed") {
    // Changes are measured from where the branch left its base, like every
    // other `--base` comparison.
    const base = resolveComparisonBase(root, scope.base);
    let manifest: ContractManifest | null;
    try {
      manifest = compileContractManifest({ repositoryRoot: root, repositoryKey, specDirectory });
    } catch {
      manifest = null;
    }
    selection = selectScreensChangedSince({
      repositoryRoot: root,
      settings,
      current: catalog,
      base,
      manifest,
      dependents: await dependencies.dependents({
        repositoryRoot: root,
        repositoryKey,
        base: base.commit,
      }),
    });
  } else {
    selection = {
      scope: scope.kind,
      base: null,
      screens: selectRequestedScreens(catalog, scope),
      changed_files: 0,
      unavailable: [],
    };
  }

  if (!options.dryRun) {
    throw new Error(
      "Capturing screens with Playwright is not available in this build yet; pass --dry-run to see the selection."
    );
  }
  if (options.json) {
    io.write(
      `${JSON.stringify({ dry_run: true, catalog_screens: catalog.screens.size, selection }, null, 2)}\n`
    );
    return 0;
  }
  renderSelection(selection, catalog.screens.size, io);
  return 0;
}
