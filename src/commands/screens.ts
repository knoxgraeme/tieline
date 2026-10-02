import { resolve } from "node:path";
import { readDeclaredCapabilityKeys } from "../contract/load.js";
import {
  readScreenCatalogSources,
  screenSettingsForRepository,
  validateScreenCatalogDocuments,
} from "../contract/screen-catalog.js";
import {
  applyScreenImport,
  createCaptureDigester,
  ensureCapturesIgnored,
  parseScreenImport,
  planScreenImport,
  readScreenImportFile,
  ScreenImportError,
  type CapturesIgnoreStatus,
  type CurrentScreenCatalogFile,
} from "../contract/screen-import.js";
import {
  escapeTerminalText,
  resolveCommandContext,
  type CommandIO,
} from "./shared.js";

export interface ScreensImportOptions {
  repository?: string;
  prune?: boolean;
  skipUnknownCapabilities?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

const NOT_ENABLED =
  'Screens are not enabled for this repository. Add "screens": { "enabled": true } to .tieline/config.json to opt in.';

/**
 * `tieline screens import <file>`: create or update screen catalog entries
 * from a JSON file. The import is planned and validated in full before any
 * file is written, so an invalid input changes nothing.
 */
export async function runScreensImportCommand(
  file: string,
  options: ScreensImportOptions,
  io: CommandIO
): Promise<number> {
  const { root, specDirectory } = resolveCommandContext(options);
  const settings = screenSettingsForRepository(root);
  if (!settings) throw new Error(NOT_ENABLED);

  const inputPath = resolve(file);
  const imported = parseScreenImport(readScreenImportFile(inputPath));
  // Screenshots are read during planning, only for screens the import
  // accepts, so skipped entries never touch the filesystem.
  const digests = createCaptureDigester(settings);

  // The existing catalog must be valid before it is merged into: editing an
  // invalid file would either hide the problem or compound it.
  const capabilityKeys = readDeclaredCapabilityKeys(root, specDirectory);
  const read = readScreenCatalogSources(root, settings);
  const issues = [...read.issues];
  const catalog = validateScreenCatalogDocuments(read.sources, capabilityKeys, issues);
  if (issues.length > 0) {
    throw new ScreenImportError(
      "The existing screen catalog is invalid; fix it before importing.",
      issues
    );
  }
  const documents = new Map(catalog.files.map((entry) => [entry.path, entry.document]));
  const current: CurrentScreenCatalogFile[] = read.sources.map((source) => ({
    source,
    document: documents.get(source.path)!,
  }));

  const plan = planScreenImport(imported, current, {
    repositoryRoot: root,
    settings,
    capabilityKeys,
    prune: options.prune === true,
    skipUnknownCapabilities: options.skipUnknownCapabilities === true,
    digestScreenshot: (path, key) => digests.digest(path, key),
  });
  const dryRun = options.dryRun === true;
  let capturesIgnore: CapturesIgnoreStatus | "dry_run" = "dry_run";
  if (!dryRun) {
    // The ignore file comes first: if it cannot be made, nothing has been
    // written, rather than reporting failure after the catalog changed.
    capturesIgnore = ensureCapturesIgnored(root, settings);
    applyScreenImport(plan);
  }

  const files = plan.files.map(({ path, status }) => ({ path, status }));
  if (options.json) {
    io.write(
      `${JSON.stringify(
        {
          input: inputPath,
          dry_run: dryRun,
          catalog_directory: settings.catalogPath,
          captures_directory: settings.capturesPath,
          entries: plan.entries,
          created: plan.created,
          updated: plan.updated,
          moved: plan.moved,
          unchanged: plan.unchanged.length,
          pruned: plan.pruned,
          skipped_unknown_capability: plan.skipped_unknown_capability,
          image_digests: { computed: digests.computed, missing: digests.missing },
          files,
          captures_gitignore: capturesIgnore,
        },
        null,
        2
      )}\n`
    );
    return 0;
  }
  io.write(
    `${dryRun ? "Dry run: would import" : "Imported"} ${plan.entries} screen(s) into ${escapeTerminalText(settings.catalogPath)}: ${plan.created.length} created, ${plan.updated.length} updated, ${plan.moved.length} moved, ${plan.unchanged.length} unchanged, ${plan.pruned.length} pruned, ${plan.skipped_unknown_capability.length} skipped for unknown capabilities.\n`
  );
  for (const entry of files) {
    if (entry.status === "unchanged") continue;
    io.write(`  ${dryRun ? `would ${entry.status === "created" ? "create" : "update"}` : entry.status} ${escapeTerminalText(entry.path)}\n`);
  }
  for (const skipped of plan.skipped_unknown_capability) {
    io.write(
      `  skipped ${escapeTerminalText(skipped.key)} (unknown capability '${escapeTerminalText(skipped.capability)}')\n`
    );
  }
  if (digests.missing.length > 0) {
    io.write(
      `  note  ${digests.missing.length} screenshot(s) are not in ${escapeTerminalText(settings.capturesPath)}; their digests were not recorded, and a digest already reviewed for the same path was kept.\n`
    );
  }
  if (capturesIgnore === "not_managed") {
    io.write(
      `  note  ${escapeTerminalText(settings.capturesPath)} resolves outside .tieline/; make sure screenshots there are git-ignored.\n`
    );
  } else if (capturesIgnore === "unverified") {
    io.write(
      `  note  ${escapeTerminalText(settings.capturesPath)}/.gitignore does not ignore everything in ${escapeTerminalText(settings.capturesPath)} (or is not a regular file), and Tieline leaves it unchanged; make sure screenshots there are git-ignored.\n`
    );
  }
  if (!dryRun && files.some((entry) => entry.status !== "unchanged")) {
    io.write(
      "Run `tieline contract compile .` to refresh the manifest and review page.\n"
    );
  }
  return 0;
}
