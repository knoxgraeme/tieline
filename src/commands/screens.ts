import { resolve } from "node:path";
import { readDeclaredCapabilityKeys } from "../contract/load.js";
import { compileContractManifest } from "../contract/manifest.js";
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
  withScreenImportLock,
  type CapturesIgnoreStatus,
  type CurrentScreenCatalogFile,
  type ScreenImportPlan,
} from "../contract/screen-import.js";
import {
  loadScreenAudit,
  screenAuditStrictFailures,
  type ScreenAuditContract,
  type ScreenCaptureGap,
} from "../contract/screen-audit.js";
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

  const planAgainstCatalog = (): ScreenImportPlan => {
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
    return planScreenImport(imported, current, {
      repositoryRoot: root,
      settings,
      capabilityKeys,
      prune: options.prune === true,
      skipUnknownCapabilities: options.skipUnknownCapabilities === true,
      catalogEntries: read.entries,
      digestScreenshot: (path, key) => digests.digest(path, key),
    });
  };
  const dryRun = options.dryRun === true;
  // A dry run only reads. A real import holds the import lock from reading
  // the catalog to replacing it, so imports never interleave.
  const { plan, capturesIgnore } = dryRun
    ? { plan: planAgainstCatalog(), capturesIgnore: "dry_run" as const }
    : withScreenImportLock(root, () => {
        const planned = planAgainstCatalog();
        // The ignore file comes first: if it cannot be made, nothing has been
        // written, rather than reporting failure after the catalog changed.
        const ignore: CapturesIgnoreStatus = ensureCapturesIgnored(root, settings);
        applyScreenImport(planned);
        return { plan: planned, capturesIgnore: ignore };
      });

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

export interface ScreensAuditOptions {
  repository?: string;
  json?: boolean;
  /** Fail when anything is unaccounted for, as a required coverage check. */
  strict?: boolean;
}

const GAP_LABELS: Record<ScreenCaptureGap, string> = {
  screenshot: "screenshot digest",
  capture: "capture record",
  text: "ARIA snapshot",
  scene: "@screen test",
};

/**
 * `tieline screens audit`: lists screens whose capture outputs are missing or
 * inconsistent, page files no screen claims, and acceptance criteria whose
 * tests do not line up, without capturing anything. Findings are a report;
 * with `--strict` they fail the command, as a coverage gate.
 */
export async function runScreensAuditCommand(
  options: ScreensAuditOptions,
  io: CommandIO
): Promise<number> {
  const { root, repositoryKey, specDirectory } = resolveCommandContext(options);
  const settings = screenSettingsForRepository(root);
  if (!settings) throw new Error(NOT_ENABLED);
  let contract: ScreenAuditContract;
  try {
    contract = { manifest: compileContractManifest({ repositoryRoot: root, repositoryKey, specDirectory }) };
  } catch (error) {
    contract = {
      manifest: null,
      detail: `the working-tree contract does not compile: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const loaded = loadScreenAudit(root, settings, readDeclaredCapabilityKeys(root, specDirectory), contract);
  if (!loaded.audit) {
    throw new ScreenImportError(
      "The screen catalog is invalid; fix it before auditing.",
      loaded.issues
    );
  }
  const audit = loaded.audit;
  const failures = options.strict ? screenAuditStrictFailures(audit) : [];
  const exitCode = failures.length > 0 ? 1 : 0;
  if (options.json) {
    io.write(
      `${JSON.stringify(
        { ...audit, ...(options.strict ? { strict: { passed: exitCode === 0, failures } } : {}) },
        null,
        2
      )}\n`
    );
    return exitCode;
  }
  io.write(
    `Screen audit of ${escapeTerminalText(audit.catalog_path)}: ${audit.screens} screen(s); ${audit.incomplete.length} missing capture output(s); ${audit.not_captured.length} not captured, with a reason; ${audit.text_mismatch.length} ARIA snapshot mismatch(es); ${audit.orphaned_text.length} orphaned ARIA snapshot(s).\n`
  );
  for (const screen of audit.not_captured) {
    io.write(
      `  not captured ${escapeTerminalText(screen.key)} (${escapeTerminalText(screen.capability)}): ${screen.reason}: ${escapeTerminalText(screen.detail)}\n`
    );
  }
  for (const gap of audit.incomplete) {
    io.write(
      `  missing   ${escapeTerminalText(gap.key)} (${escapeTerminalText(gap.capability)}): ${gap.missing
        .map((missing) => GAP_LABELS[missing])
        .join(", ")}\n`
    );
  }
  for (const key of audit.text_mismatch) {
    io.write(
      `  mismatch  ${escapeTerminalText(key)}: its ARIA snapshot differs from the digest its capture recorded\n`
    );
  }
  for (const path of audit.orphaned_text) {
    io.write(`  orphaned  ${escapeTerminalText(path)}: no catalogued screen has this key\n`);
  }
  for (const tag of audit.unknown_scene_tags) {
    io.write(
      `  unknown   @screen:${escapeTerminalText(tag.key)} in ${tag.files
        .map(escapeTerminalText)
        .join(", ")}: no catalogued screen has this key\n`
    );
  }
  for (const issue of audit.text_issues) {
    io.write(`  unreadable ${escapeTerminalText(issue)}\n`);
  }
  if (audit.environments.length > 1) {
    io.write(
      `  note  screens were captured in ${audit.environments.length} environments (${audit.environments
        .map((environment) => `${environment.fingerprint.slice(0, 12)}: ${environment.screens}`)
        .join(", ")}); digests from different environments are never compared.\n`
    );
  }
  for (const page of audit.pages.unclaimed) {
    io.write(`  page      ${escapeTerminalText(page)}: no screen's paths claim this page file\n`);
  }
  const alignment = audit.acceptance_criteria;
  for (const criterion of alignment.untested) {
    io.write(
      `  untested  ${escapeTerminalText(criterion.key)} shows ${criterion.shows
        .map(escapeTerminalText)
        .join(", ")}, but no test is tagged @ac:${escapeTerminalText(criterion.key)}\n`
    );
  }
  for (const criterion of alignment.unlinked) {
    io.write(
      `  unlinked  ${escapeTerminalText(criterion.key)} is tagged in ${criterion.files
        .map(escapeTerminalText)
        .join(", ")}, which its tests links do not name\n`
    );
  }
  for (const tag of alignment.unknown_tags) {
    io.write(
      `  unknown   @ac:${escapeTerminalText(tag.key)} in ${tag.files
        .map(escapeTerminalText)
        .join(", ")}: no acceptance criterion has this key\n`
    );
  }
  for (const entry of audit.intercepting) {
    io.write(
      `  review    ${escapeTerminalText(entry.file)} intercepts the page's requests: block third-party requests only, and mark states that would need a faked response not captured\n`
    );
  }
  if (audit.scene_scan.status !== "complete") {
    io.write(
      `  note  the test scan is ${audit.scene_scan.status}: ${escapeTerminalText(
        audit.scene_scan.detail ?? ""
      )}; screens and acceptance criteria without a test are not reported.\n`
    );
  }
  if (audit.pages.status === "not_configured") {
    io.write("  note  page files are not checked; set screens.capture.pages to find pages no screen covers.\n");
  } else if (audit.pages.status !== "complete") {
    io.write(`  note  page files could not be checked in full: ${escapeTerminalText(audit.pages.detail ?? "")}\n`);
  }
  if (alignment.status === "unavailable" && alignment.detail) {
    io.write(`  note  acceptance criteria were not checked: ${escapeTerminalText(alignment.detail)}\n`);
  }
  if (options.strict) {
    io.write(
      exitCode === 0
        ? "Strict audit passed: every screen, page, and documented UI behavior is accounted for.\n"
        : `Strict audit failed: ${failures.map(escapeTerminalText).join("; ")}.\n`
    );
  }
  return exitCode;
}
