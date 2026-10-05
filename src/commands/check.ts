import { inspectManifestLocators } from "../contract/manifest-locators.js";
import {
  compileContractManifest,
  readContractManifest,
  serializeContractManifest,
  type ContractManifest,
  type ManifestScreenLink,
} from "../contract/manifest.js";
import {
  readDeclaredScreenReferences,
  type DeclaredShowsLink,
} from "../contract/load.js";
import {
  loadScreenCatalog,
  screenSettingsForRepository,
} from "../contract/screen-catalog.js";
import { ContractValidationError } from "../contract/validate.js";
import {
  auditScreenCaptures,
  screenAuditWarnings,
  summarizeScreenAudit,
  type ScreenAuditContract,
  type ScreenAuditSummary,
} from "../contract/screen-audit.js";
import { workingTreeChangesSince } from "../contract/screen-capture-selection.js";
import { scanPageFiles, scanScreenScenes } from "../contract/screen-scenes.js";
import { readScreenTextDirectory } from "../contract/screen-text.js";
import {
  analyzeContractImpact,
  changesSince,
  describeBrokenCause,
  isBrokenImpact,
  type AcceptanceCriterionImpact,
  type RepositoryPathChange,
} from "../contract/impact.js";
import { resolveComparisonBase } from "../contract/comparison-base.js";
import { isEligibleSourcePath } from "../contract/coverage.js";
import {
  escapeTerminalText,
  resolveCommandContext,
  wrap,
  type CommandIO,
} from "./shared.js";

export interface CheckCommandOptions {
  base: string;
  repository?: string;
  repo?: string;
  json?: boolean;
  /**
   * Broken links fail the command by default because deciding they are wrong
   * needs no human judgement. Set to `false` to downgrade them to warnings.
   */
  failOnBroken?: boolean;
  /**
   * A committed manifest that differs from the one compilation produces fails
   * for the same reason broken links do: the comparison is a byte diff of a
   * deterministic function's output, so nothing is being judged. Set to `false`
   * to downgrade it to a warning.
   */
  failOnStaleManifest?: boolean;
}

export type CheckExitReason =
  | "ok"
  | "broken_links"
  | "broken_links_warn_only"
  | "invalid_screen_catalog"
  | "stale_manifest"
  | "stale_manifest_warn_only"
  | "invalid_locators";

/**
 * A `shows` link in the working-tree spec whose screen the working-tree
 * catalog does not contain — the screen counterpart of a link to a deleted
 * file.
 */
export interface BrokenScreenLink {
  owner_kind: "story" | "acceptance_criterion";
  owner_stable_id: string;
  story_stable_id: string;
  screen_key: string;
  provenance: string;
}

/**
 * The screen part of a check, reported only when the repository enabled
 * screens. `catalog_invalid` means the working-tree catalog, or the spec's
 * `shows` declarations, failed validation, so links were not resolved.
 */
export interface ScreenCheck {
  /**
   * `disabled_with_screen_data`: screens are off, yet the committed manifest
   * still records screens or shows links — a configuration the contract can
   * no longer compile, so it fails like an invalid catalog.
   */
  status: "evaluated" | "catalog_invalid" | "disabled_with_screen_data";
  /** Null when screens are disabled. */
  catalog_path: string | null;
  catalog_screens: number;
  shows_links: number;
  broken_links: BrokenScreenLink[];
  /** Catalog problems, and `shows` declarations the validator refuses. */
  catalog_issues: string[];
  /**
   * What `tieline screens audit` reports as missing, counted. Advisory: it
   * never changes the exit code. Null when the catalog is invalid or screens
   * are disabled.
   */
  captures: ScreenAuditSummary | null;
}

type ScreenLinkOwner = Omit<BrokenScreenLink, "screen_key" | "provenance">;

function manifestScreenLinks(
  manifest: ContractManifest
): Array<{ owner: ScreenLinkOwner; key: string; provenance: string }> {
  const links: Array<{ owner: ScreenLinkOwner; key: string; provenance: string }> = [];
  const add = (
    owner: ScreenLinkOwner,
    shows: ManifestScreenLink[] | undefined
  ): void => {
    for (const link of shows ?? []) {
      links.push({ owner, key: link.target.key, provenance: link.provenance });
    }
  };
  for (const capability of manifest.capabilities) {
    for (const story of capability.stories) {
      add(
        {
          owner_kind: "story",
          owner_stable_id: story.stable_id,
          story_stable_id: story.stable_id,
        },
        story.shows
      );
      for (const criterion of story.acceptance_criteria) {
        add(
          {
            owner_kind: "acceptance_criterion",
            owner_stable_id: criterion.stable_id,
            story_stable_id: story.stable_id,
          },
          criterion.shows
        );
      }
    }
  }
  return links;
}

/** The working-tree spec's `shows` links, in the shape check resolves. */
function declaredScreenLinks(
  declared: readonly DeclaredShowsLink[]
): Array<{ owner: ScreenLinkOwner; key: string; provenance: string }> {
  const seen = new Set<string>();
  return declared.flatMap((link) => {
    const identity = `${link.owner_kind}\0${link.owner_stable_id}\0${link.screen_key}`;
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [
      {
        owner: {
          owner_kind: link.owner_kind,
          owner_stable_id: link.owner_stable_id,
          story_stable_id: link.story_stable_id,
        },
        key: link.screen_key,
        provenance: link.provenance,
      },
    ];
  });
}

/**
 * Resolves `shows` links against the working-tree catalog, or returns null
 * when the repository has not enabled screens. The links are the ones the
 * working-tree spec declares, read leniently: a link to a screen that does not
 * exist stops the spec from compiling, so the manifest would never hold it,
 * and a compile failure by itself does not fail check. A link the branch
 * removed is not resolved, even while the committed manifest still records
 * it; that manifest is reported stale instead.
 */
function checkScreens(
  root: string,
  specDirectory: string,
  manifest: ContractManifest,
  audited: { contract: ScreenAuditContract; added: ReadonlySet<string> }
): { check: ScreenCheck; warnings: string[] } | null {
  const settings = screenSettingsForRepository(root, { specDirectory });
  if (!settings) {
    // A repository that never enabled screens has no screen data in its
    // manifest, so this stays null and check is unchanged for it.
    const links = manifestScreenLinks(manifest);
    const screens = (manifest.screen_catalogs ?? []).reduce(
      (total, catalog) => total + catalog.screens.length,
      0
    );
    if (links.length === 0 && manifest.screen_catalogs === undefined) return null;
    return {
      check: {
        status: "disabled_with_screen_data",
        catalog_path: null,
        catalog_screens: screens,
        shows_links: links.length,
        broken_links: [],
        catalog_issues: [
          `the committed manifest records ${screens} screen(s) and ${links.length} shows link(s), but screens are not enabled in .tieline/config.json; enable screens again, or remove the screens and shows links and recompile`,
        ],
        captures: null,
      },
      warnings: [],
    };
  }
  // Capability keys and links are read leniently, so a catalog naming an
  // undeclared capability, or a link naming an unknown screen, fails here even
  // while the rest of the spec does not compile. When a spec file cannot even
  // be parsed, the declared capabilities are unknown, and that alone makes the
  // catalog unverifiable rather than silently skipping the check.
  let capabilityKeys: ReadonlySet<string> | undefined;
  let declaredLinks: DeclaredShowsLink[] | undefined;
  const capabilityIssues: string[] = [];
  try {
    const declared = readDeclaredScreenReferences(root, specDirectory);
    capabilityKeys = declared.capabilityKeys;
    declaredLinks = declared.showsLinks;
    // A link the validator refuses (malformed, or a target named twice) stops
    // the spec from compiling, which alone does not fail check.
    capabilityIssues.push(...declared.showsIssues);
  } catch (error) {
    if (!(error instanceof ContractValidationError)) throw error;
    capabilityIssues.push(
      ...error.issues.map(
        (issue) => `cannot confirm screen catalog capabilities because the spec does not parse: ${issue}`
      )
    );
  }
  const loaded = loadScreenCatalog(root, settings, capabilityKeys);
  const catalog = loaded.catalog;
  const issues = [...capabilityIssues, ...loaded.issues];
  // A spec that cannot be read leaves the catalog invalid, so nothing is
  // resolved; the committed links are then only counted.
  const links = declaredLinks
    ? declaredScreenLinks(declaredLinks)
    : manifestScreenLinks(manifest);
  const catalogInvalid = issues.length > 0;
  const audit = catalogInvalid
    ? null
    : auditScreenCaptures({
        settings,
        catalog,
        text: readScreenTextDirectory(settings),
        scenes: scanScreenScenes(root, settings.sceneTests),
        pages: scanPageFiles(root, settings.capture.pages),
        contract: audited.contract,
      });
  const captures = audit ? summarizeScreenAudit(audit) : null;
  const check: ScreenCheck = {
    status: catalogInvalid ? "catalog_invalid" : "evaluated",
    catalog_path: settings.catalogPath,
    catalog_screens: catalog.screens.size,
    shows_links: links.length,
    // An invalid catalog cannot say which keys exist, so its links are left
    // unresolved rather than all reported as broken.
    broken_links: catalogInvalid
      ? []
      : links
          .filter((link) => !catalog.screens.has(link.key))
          .map((link) => ({
            ...link.owner,
            screen_key: link.key,
            provenance: link.provenance,
          })),
    catalog_issues: issues,
    captures,
  };
  return {
    check,
    warnings: audit ? screenAuditWarnings(audit, audited.added) : [],
  };
}

/**
 * A changed source file that no manifest link names.
 *
 * It is an invitation to judge, never a verdict: plenty of changes are
 * refactors, renames, or internal plumbing that no acceptance criterion should
 * have to name, and a contract should not grow criteria to make a number fall.
 */
export interface UnclaimedChange {
  path: string;
  /** Never `deleted`; see `unclaimedChanges` for why. */
  status: "modified" | "added" | "renamed";
  /** The name the file had before this change, for renames. */
  previous_path?: string;
}

/** Whether source-root eligibility could be decided at all. */
export type UnclaimedChangesStatus = "evaluated" | "not_evaluated";

const UNCLAIMED_NOT_EVALUATED =
  "Changed files were not weighed against the contract because no Tieline workspace configuration was found, so the configured source roots are unknown.";

function unclaimedSummaryWarning(count: number): string {
  return `${count} changed source file(s) are named by no acceptance criterion; consider whether any of them changes behavior someone should accept.`;
}

/**
 * Changed source files that no manifest link names.
 *
 * Deletions are left out on purpose. Removing a file the contract never named
 * leaves nothing behind for a criterion to describe, so it cannot be something
 * to link; and where a criterion did name the removed path, the link itself is
 * already reported as broken. Renames are kept under their new path, because
 * the file still exists to be judged, and a link naming either the old or the
 * new path counts as naming it.
 */
function unclaimedChanges(input: {
  changes: RepositoryPathChange[];
  impacts: AcceptanceCriterionImpact[];
  sourceRoots: string[];
  ignore: string[];
  specDirectory: string;
}): UnclaimedChange[] {
  // Impacts already carry the resolved target path of every link the diff
  // touches, so link targets are read back from them rather than matched again.
  const claimed = new Set(
    input.impacts
      .filter((impact) => impact.link_scope !== "contract")
      .map((impact) => impact.path)
  );
  const specRoot = input.specDirectory.replace(/\/+$/, "");
  return input.changes
    .flatMap((change): UnclaimedChange[] => {
      if (change.status === "deleted") return [];
      const previousPath =
        change.status === "renamed" ? change.old_path : null;
      const path = change.path;
      if (claimed.has(path)) return [];
      if (previousPath && claimed.has(previousPath)) return [];
      // The contract's own YAML is reported as a contract definition change,
      // never as source work the contract does not describe.
      if (path === specRoot || path.startsWith(`${specRoot}/`)) return [];
      if (
        !isEligibleSourcePath(path, {
          sourceRoots: input.sourceRoots,
          ignore: input.ignore,
        })
      ) {
        return [];
      }
      return [
        {
          path,
          status: change.status,
          ...(previousPath ? { previous_path: previousPath } : {}),
        },
      ];
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function renderUnclaimedChanges(
  unclaimed: UnclaimedChange[],
  io: CommandIO
): void {
  if (!unclaimed.length) return;
  io.write(
    `  Changes to consider (${unclaimed.length} changed source file(s) named by no acceptance criterion)\n`
  );
  io.write(
    "    Many changes are refactors, renames, or internal plumbing that no\n"
  );
  io.write(
    "    criterion needs to name. If one of these changes behavior someone\n"
  );
  io.write("    should be able to accept, consider linking it to a criterion.\n");
  for (const change of unclaimed) {
    const rename =
      change.previous_path && change.previous_path !== change.path
        ? ` (from ${escapeTerminalText(change.previous_path)})`
        : "";
    io.write(
      `    warn  ${change.status} ${escapeTerminalText(change.path)}${rename}\n`
    );
  }
}

const CRITERION_MAX_CHARS = 240;
const CRITERION_WRAP_COLUMNS = 88;

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

function findingLine(impact: AcceptanceCriterionImpact): string {
  const level = isBrokenImpact(impact) ? "error" : "warn ";
  const details = [
    impact.broken_cause
      ? `broken: ${describeBrokenCause(impact.broken_cause)}`
      : impact.freshness_reason
        ? `${impact.freshness} (${impact.freshness_reason})`
        : impact.freshness,
  ];
  if (impact.target_kind !== null) {
    const locator = impact.selector
      ? `selector ${impact.selector}`
      : "locator";
    switch (impact.locator_resolution) {
      case "resolved":
        details.push(`${locator} resolved`);
        break;
      case "ambiguous":
        details.push(
          `${locator} ambiguous (${impact.locator_matches.length} structural matches); qualify the locator`
        );
        break;
      case "unresolved":
        details.push(`${locator} unresolved; re-read the exact locator`);
        break;
      case "not_checked":
        details.push(
          `${locator} not checked (${impact.locator_reason ?? "reason unavailable"}; inspection limitation)`
        );
        break;
      case "not_applicable":
        details.push("locator not applicable (file-level link)");
        break;
    }
    if (impact.source_evidence) {
      details.push(
        `source ${impact.source_evidence.language} line ${impact.source_evidence.range.start.line + 1}`
      );
    }
  }
  return `    ${level} ${impact.reason} ${impact.path} (${details.join("; ")})`;
}

function groupByCriterion(
  impacts: AcceptanceCriterionImpact[]
): AcceptanceCriterionImpact[][] {
  const groups = new Map<string, AcceptanceCriterionImpact[]>();
  for (const impact of impacts) {
    const group = groups.get(impact.acceptance_criterion_stable_id);
    if (group) group.push(impact);
    else groups.set(impact.acceptance_criterion_stable_id, [impact]);
  }
  return [...groups.values()];
}

function renderGroup(
  group: AcceptanceCriterionImpact[],
  io: CommandIO
): void {
  const head = group[0];
  io.write(
    `\n  ${escapeTerminalText(head.acceptance_criterion_stable_id)}  (${escapeTerminalText(head.story_stable_id)}: ${truncate(
      escapeTerminalText(head.story_title),
      80
    )})\n`
  );
  io.write(
    wrap(
      truncate(
        escapeTerminalText(head.acceptance_criterion),
        CRITERION_MAX_CHARS
      ),
      CRITERION_WRAP_COLUMNS,
      "    "
    )
  );
  const needsJudgement = group.some((impact) => !isBrokenImpact(impact));
  if (needsJudgement) {
    io.write("    Does this change still satisfy this criterion?\n");
  }
  if (group.some(isBrokenImpact)) {
    io.write(
      "    Relink this criterion: its recorded evidence no longer exists.\n"
    );
  }
  for (const impact of group) {
    io.write(`${escapeTerminalText(findingLine(impact))}\n`);
    if (impact.source_evidence) {
      const suffix = impact.source_evidence.snippet.truncated ? " (truncated)" : "";
      io.write(`      source snippet${suffix}:\n`);
      for (const line of impact.source_evidence.snippet.text.split("\n")) {
        io.write(`        ${escapeTerminalText(line)}\n`);
      }
    }
  }
}

/** Human-readable rendering for one Acceptance Criterion impact group. */
export function renderCheckImpactGroupText(
  group: AcceptanceCriterionImpact[]
): string {
  const output: string[] = [];
  renderGroup(group, { write: (message) => output.push(message) });
  return output.join("");
}

export async function runCheckCommand(
  options: CheckCommandOptions,
  io: CommandIO
): Promise<number> {
  const base = options.base;
  const failOnBroken = options.failOnBroken !== false;

  const { root, workspace, repositoryKey, manifestPath, specDirectory } =
    resolveCommandContext(options);
  const postMerge = workspace?.config.manifest_mode === "post_merge";
  const failOnStaleManifest = !postMerge && options.failOnStaleManifest !== false;
  let manifest;
  let publishedManifest = null;
  let publicationError: string | null = null;
  if (postMerge) {
    // Validate today's authored claims before allowing any publication deferral.
    // Strict compilation still rejects missing/unreadable linked artifacts.
    manifest = compileContractManifest({ repositoryRoot: root, repositoryKey, specDirectory });
    try { publishedManifest = readContractManifest(manifestPath); } catch (error) {
      publicationError = error instanceof Error ? error.message : String(error);
      // Missing or malformed generated output is explicitly pending publication;
      // it never substitutes for the validated authored contract above.
    }
  } else try {
    manifest = readContractManifest(manifestPath);
  } catch (error) {
    throw new Error(
      `Cannot evaluate semantic impact because the contract manifest in ${manifestPath} is unreadable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  // Changes are measured from where this branch left the base, so commits that
  // reached the base afterwards are not reported as this branch's changes.
  const comparison = resolveComparisonBase(root, base);
  const changes = changesSince(root, comparison.commit);
  // Recompiling refuses to run while a link points at absent evidence, so a
  // failure here is itself a finding rather than a reason to abort the check.
  let manifestCurrent = false;
  let manifestCompileError: string | null = null;
  let currentManifest: ContractManifest | null = null;
  try {
    currentManifest = compileContractManifest({
      repositoryRoot: root,
      repositoryKey,
      specDirectory,
    });
    manifestCurrent =
      (postMerge ? publishedManifest !== null && serializeContractManifest(publishedManifest) === serializeContractManifest(currentManifest)
        : serializeContractManifest(manifest) === serializeContractManifest(currentManifest));
  } catch (error) {
    manifestCompileError =
      error instanceof Error ? error.message : String(error);
  }
  const impacts = await analyzeContractImpact({
    repositoryRoot: root,
    manifest,
    changes,
    specDirectory,
  });
  const brokenLinks = impacts.filter(isBrokenImpact);
  // Null unless the repository enabled screens, so a disabled feature adds
  // nothing to the result, the output, or the exit code.
  // Tests are matched against the working-tree contract, the one a branch is
  // changing; when it does not compile, the audit says so.
  const screenResult = checkScreens(root, specDirectory, manifest, {
    contract: currentManifest
      ? { manifest: currentManifest }
      : { manifest: null, detail: `the working-tree contract does not compile: ${manifestCompileError ?? "unknown error"}` },
    // New files a developer has not added to git yet count as added here, so
    // a page file created locally is named before it is committed.
    added: screenSettingsForRepository(root, { specDirectory })
      ? new Set(
          workingTreeChangesSince(root, comparison.commit).flatMap((change) =>
            change.status === "added" || change.status === "renamed" ? [change.path] : []
          )
        )
      : new Set<string>(),
  });
  const screens = screenResult?.check ?? null;
  const brokenScreenLinks = screens?.broken_links ?? [];
  const screenCatalogInvalid =
    screens?.status === "catalog_invalid" || screens?.status === "disabled_with_screen_data";
  const brokenLinkCount = brokenLinks.length + brokenScreenLinks.length;
  const locatorFindings = postMerge ? await inspectManifestLocators(root, manifest) : [];
  const invalidLocators = locatorFindings.filter((finding) => finding.resolution === "unresolved" || finding.resolution === "ambiguous");
  // A manifest that does not match its own recompilation is drift, not a
  // judgement call, so it gates alongside broken links. A compile failure is
  // deliberately excluded: it is already reported on its own, and counting it
  // as staleness would report one fault twice.
  const staleManifest = !manifestCurrent && manifestCompileError === null;
  const staleManifestMessage =
    postMerge
      ? "The published manifest is stale, absent, or unreadable; post-merge refresh is pending. Current authored rules were compiled for this check."
      : "The committed manifest does not match current YAML or linked content; compile it before merge.";
  const errors = [
    ...invalidLocators.map((finding) => `${finding.path}: ${finding.selector} is ${finding.resolution}.`),
    ...brokenLinks.map(
      (impact) =>
        `${impact.acceptance_criterion_stable_id} links to ${impact.path}, but ${describeBrokenCause(
          impact.broken_cause ?? "missing"
        )}.`
    ),
    ...brokenScreenLinks.map(
      (link) =>
        `${link.owner_stable_id} shows screen '${link.screen_key}', but the screen catalog does not contain it.`
    ),
    ...(screenCatalogInvalid
      ? screens.catalog_issues.map((issue) => `Screens: ${issue}`)
      : []),
    ...(staleManifest && failOnStaleManifest ? [staleManifestMessage] : []),
  ];
  // Without a workspace there is no configured `source_roots`, and guessing at
  // eligibility would report doc, fixture, and lockfile changes as source work.
  // A missing workspace already falls back elsewhere in this command, so the
  // completeness view simply stands down and says so.
  const unclaimedStatus: UnclaimedChangesStatus = workspace
    ? "evaluated"
    : "not_evaluated";
  const unclaimed = workspace
    ? unclaimedChanges({
        changes,
        impacts,
        sourceRoots: workspace.config.repository.source_roots,
        ignore: workspace.config.repository.ignore,
        specDirectory,
      })
    : [];
  const brokenLinksFail = brokenLinkCount > 0 && failOnBroken;
  const staleManifestFails = staleManifest && failOnStaleManifest;
  // An invalid screen catalog always fails: like a broken link, nothing has to
  // be judged to know that it does not validate.
  const exitCode =
    brokenLinksFail || screenCatalogInvalid || staleManifestFails || invalidLocators.length > 0 ? 1 : 0;
  // Broken links outrank a stale manifest when both hold: recorded evidence
  // that no longer exists is the more severe fault, and the full picture stays
  // available in `errors`, `warnings`, and `manifest_current`.
  const exitReason: CheckExitReason =
    invalidLocators.length > 0 ? "invalid_locators" : brokenLinkCount > 0
      ? failOnBroken
        ? "broken_links"
        : "broken_links_warn_only"
      : screenCatalogInvalid
        ? "invalid_screen_catalog"
        : staleManifest
          ? failOnStaleManifest
            ? "stale_manifest"
            : "stale_manifest_warn_only"
          : "ok";
  const result = {
    base,
    base_commit: comparison.commit,
    repository: repositoryKey,
    manifest_current: manifestCurrent,
    ...(postMerge ? { manifest_mode: "post_merge", manifest_publication: manifestCurrent ? "current" : "pending", authored_contract_validated: true, manifest_publication_error: publicationError, locator_findings: locatorFindings } : {}),
    manifest_compile_error: manifestCompileError,
    changes,
    impacts,
    broken_links: brokenLinks,
    ...(screens ? { screens } : {}),
    unclaimed_changes: unclaimed,
    unclaimed_change_count: unclaimed.length,
    unclaimed_changes_status: unclaimedStatus,
    fail_on_broken: failOnBroken,
    fail_on_stale_manifest: failOnStaleManifest,
    exit_code: exitCode,
    exit_reason: exitReason,
    errors,
    warnings: [
      ...locatorFindings.filter((finding) => finding.resolution === "not_checked").map((finding) => `${finding.path}: ${finding.selector} could not be checked (${finding.reason}).`),
      // Reported here only when it is not already an error, so a gating stale
      // manifest is named once rather than in both lists.
      ...(staleManifest && !failOnStaleManifest ? [staleManifestMessage] : []),
      ...(manifestCompileError
        ? [`The manifest could not be recompiled: ${manifestCompileError}`]
        : []),
      ...impacts
        .filter((impact) => impact.freshness === "stale")
        .map(
          (impact) =>
            `${impact.acceptance_criterion_stable_id} is stale for ${impact.path}.`
        ),
      ...(unclaimedStatus === "not_evaluated"
        ? [UNCLAIMED_NOT_EVALUATED]
        : unclaimed.length
          ? [unclaimedSummaryWarning(unclaimed.length)]
          : []),
      ...(screenResult?.warnings ?? []),
    ],
  };
  if (options.json) {
    io.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const groups = groupByCriterion(impacts);
    const completeness =
      unclaimedStatus === "evaluated"
        ? `; changes to consider=${unclaimed.length}`
        : "";
    const screenSummary = screens
      ? `; broken screen link(s)=${brokenScreenLinks.length}${
          screenCatalogInvalid ? "; screen catalog=invalid" : ""
        }${
          screens.captures
            ? `; screens missing capture output(s)=${screens.captures.incomplete}`
            : ""
        }`
      : "";
    io.write(
      `Semantic impact: ${impacts.length} AC finding(s) across ${groups.length} acceptance criteria; manifest=${manifestCurrent ? "current" : "stale"}; broken link(s)=${brokenLinks.length}${screenSummary}${completeness}.\n`
    );
    for (const group of groups) io.write(renderCheckImpactGroupText(group));
    if (groups.length || unclaimed.length) io.write("\n");
    renderUnclaimedChanges(unclaimed, io);
    if (unclaimed.length) io.write("\n");
    for (const error of errors) {
      io.write(`  error ${escapeTerminalText(error)}\n`);
    }
    for (const warning of result.warnings) {
      io.write(`  warn  ${escapeTerminalText(warning)}\n`);
    }
    if (brokenLinksFail) {
      io.write(
        "  Broken links fail this check. Re-run with --no-fail-on-broken to downgrade them to warnings.\n"
      );
    }
    if (screenCatalogInvalid) {
      io.write(
        "  An invalid screen catalog fails this check. Fix the issues above until `tieline contract validate` passes.\n"
      );
    }
    for (const finding of invalidLocators) io.write(`  Invalid locator: ${finding.path} ${finding.selector} (${finding.resolution}).\n`);
    if (staleManifestFails) {
      io.write(
        "  A stale manifest fails this check. Run `tieline contract compile` and commit the result, or re-run with --no-fail-on-stale-manifest to downgrade it to a warning.\n"
      );
    }
  }
  // Findings that require human judgement (stale links, modified paths,
  // contract definition changes, changed files no criterion names) stay
  // warn-only: whether a change is a behavior change or a refactor is exactly
  // the kind of call a build must not make. Broken links and a stale manifest
  // do not. Nothing needs to be judged to know the manifest points at evidence
  // that is not there, or that the committed manifest is not the one this
  // contract compiles to.
  return exitCode;
}
