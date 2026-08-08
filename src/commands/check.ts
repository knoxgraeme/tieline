import {
  compileContractManifest,
  readContractManifest,
  serializeContractManifest,
} from "../contract/manifest.js";
import {
  analyzeContractImpact,
  changesSince,
  describeBrokenCause,
  isBrokenImpact,
  type AcceptanceCriterionImpact,
  type RepositoryPathChange,
} from "../contract/impact.js";
import { isEligibleSourcePath } from "../contract/coverage.js";
import { resolveCommandContext, wrap, type CommandIO } from "./shared.js";

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
  | "stale_manifest"
  | "stale_manifest_warn_only";

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
        ? ` (from ${change.previous_path})`
        : "";
    io.write(`    warn  ${change.status} ${change.path}${rename}\n`);
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
  const detail = impact.broken_cause
    ? `broken: ${describeBrokenCause(impact.broken_cause)}`
    : impact.freshness;
  return `    ${level} ${impact.reason} ${impact.path} (${detail})`;
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
    `\n  ${head.acceptance_criterion_stable_id}  (${head.story_stable_id}: ${truncate(
      head.story_title,
      80
    )})\n`
  );
  io.write(
    wrap(
      truncate(head.acceptance_criterion, CRITERION_MAX_CHARS),
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
  for (const impact of group) io.write(`${findingLine(impact)}\n`);
}

export async function runCheckCommand(
  options: CheckCommandOptions,
  io: CommandIO
): Promise<number> {
  const base = options.base;
  const failOnBroken = options.failOnBroken !== false;
  const failOnStaleManifest = options.failOnStaleManifest !== false;
  const { root, workspace, repositoryKey, manifestPath, specDirectory } =
    resolveCommandContext(options);
  let manifest;
  try {
    manifest = readContractManifest(manifestPath);
  } catch (error) {
    throw new Error(
      `Cannot evaluate semantic impact because the contract manifest in ${manifestPath} is unreadable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const changes = changesSince(root, base);
  // Recompiling refuses to run while a link points at absent evidence, so a
  // failure here is itself a finding rather than a reason to abort the check.
  let manifestCurrent = false;
  let manifestCompileError: string | null = null;
  try {
    const currentManifest = compileContractManifest({
      repositoryRoot: root,
      repositoryKey,
      specDirectory,
    });
    manifestCurrent =
      serializeContractManifest(manifest) ===
      serializeContractManifest(currentManifest);
  } catch (error) {
    manifestCompileError =
      error instanceof Error ? error.message : String(error);
  }
  const impacts = analyzeContractImpact({
    repositoryRoot: root,
    manifest,
    changes,
    specDirectory,
  });
  const brokenLinks = impacts.filter(isBrokenImpact);
  // A manifest that does not match its own recompilation is drift, not a
  // judgement call, so it gates alongside broken links. A compile failure is
  // deliberately excluded: it is already reported on its own, and counting it
  // as staleness would report one fault twice.
  const staleManifest = !manifestCurrent && manifestCompileError === null;
  const staleManifestMessage =
    "The committed manifest does not match current YAML or linked content; compile it before merge.";
  const errors = [
    ...brokenLinks.map(
      (impact) =>
        `${impact.acceptance_criterion_stable_id} links to ${impact.path}, but ${describeBrokenCause(
          impact.broken_cause ?? "missing"
        )}.`
    ),
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
  const brokenLinksFail = brokenLinks.length > 0 && failOnBroken;
  const staleManifestFails = staleManifest && failOnStaleManifest;
  const exitCode = brokenLinksFail || staleManifestFails ? 1 : 0;
  // Broken links outrank a stale manifest when both hold: recorded evidence
  // that no longer exists is the more severe fault, and the full picture stays
  // available in `errors`, `warnings`, and `manifest_current`.
  const exitReason: CheckExitReason =
    brokenLinks.length > 0
      ? failOnBroken
        ? "broken_links"
        : "broken_links_warn_only"
      : staleManifest
        ? failOnStaleManifest
          ? "stale_manifest"
          : "stale_manifest_warn_only"
        : "ok";
  const result = {
    base,
    repository: repositoryKey,
    manifest_current: manifestCurrent,
    manifest_compile_error: manifestCompileError,
    changes,
    impacts,
    broken_links: brokenLinks,
    unclaimed_changes: unclaimed,
    unclaimed_change_count: unclaimed.length,
    unclaimed_changes_status: unclaimedStatus,
    fail_on_broken: failOnBroken,
    fail_on_stale_manifest: failOnStaleManifest,
    exit_code: exitCode,
    exit_reason: exitReason,
    errors,
    warnings: [
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
    io.write(
      `Semantic impact: ${impacts.length} AC finding(s) across ${groups.length} acceptance criteria; manifest=${manifestCurrent ? "current" : "stale"}; broken link(s)=${brokenLinks.length}${completeness}.\n`
    );
    for (const group of groups) renderGroup(group, io);
    if (groups.length || unclaimed.length) io.write("\n");
    renderUnclaimedChanges(unclaimed, io);
    if (unclaimed.length) io.write("\n");
    for (const error of errors) {
      io.write(`  error ${error}\n`);
    }
    for (const warning of result.warnings) {
      io.write(`  warn  ${warning}\n`);
    }
    if (brokenLinksFail) {
      io.write(
        "  Broken links fail this check. Re-run with --no-fail-on-broken to downgrade them to warnings.\n"
      );
    }
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
