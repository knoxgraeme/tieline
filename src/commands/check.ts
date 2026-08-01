import { execFileSync } from "node:child_process";
import { basename, relative, resolve, sep } from "node:path";
import {
  compileContractManifest,
  readContractManifest,
  serializeContractManifest,
} from "../contract/manifest.js";
import {
  analyzeContractImpact,
  describeBrokenCause,
  isBrokenImpact,
  parseNameStatus,
  type AcceptanceCriterionImpact,
} from "../contract/impact.js";
import { findTielineWorkspace } from "../tieline/workspace.js";

interface CheckIO {
  write(message: string): void;
}

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
}

export type CheckExitReason =
  | "ok"
  | "broken_links"
  | "broken_links_warn_only";

const CRITERION_MAX_CHARS = 240;
const CRITERION_WRAP_COLUMNS = 88;

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

function wrap(text: string, columns: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (!line) {
      line = word;
      continue;
    }
    if (`${line} ${word}`.length > columns) {
      lines.push(line);
      line = word;
    } else {
      line = `${line} ${word}`;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
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
  io: CheckIO
): void {
  const head = group[0];
  io.write(
    `\n  ${head.acceptance_criterion_stable_id}  (${head.story_stable_id}: ${truncate(
      head.story_title,
      80
    )})\n`
  );
  for (const line of wrap(
    truncate(head.acceptance_criterion, CRITERION_MAX_CHARS),
    CRITERION_WRAP_COLUMNS
  )) {
    io.write(`    ${line}\n`);
  }
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
  io: CheckIO
): Promise<number> {
  const base = options.base;
  const failOnBroken = options.failOnBroken !== false;
  const requestedRoot = resolve(options.repository ?? process.cwd());
  const workspace = findTielineWorkspace(requestedRoot);
  const root = workspace?.root ?? requestedRoot;
  const repositoryKey =
    options.repo ??
    workspace?.config.product.repo_name ??
    basename(root);
  const manifestPath =
    workspace?.manifestPath ?? resolve(root, ".tieline/manifest.json");
  const specDirectory = workspace
    ? relative(root, workspace.specDirectoryPath).split(sep).join("/")
    : ".tieline/spec";
  let manifest;
  try {
    manifest = readContractManifest(manifestPath);
  } catch (error) {
    throw new Error(
      `Cannot evaluate semantic impact because ${manifestPath} is unreadable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const nameStatus = execFileSync(
    "git",
    ["diff", "--name-status", "--find-renames", base],
    { cwd: root, encoding: "utf8" }
  );
  const changes = parseNameStatus(nameStatus);
  // Recompiling refuses to run while a link points at absent evidence, so a
  // failure here is itself a finding rather than a reason to abort the check.
  let manifestCurrent = false;
  let manifestCompileError: string | null = null;
  try {
    const currentManifest = compileContractManifest({
      repositoryRoot: root,
      repositoryKey,
      commit: manifest.repository.commit,
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
  const errors = brokenLinks.map(
    (impact) =>
      `${impact.acceptance_criterion_stable_id} links to ${impact.path}, but ${describeBrokenCause(
        impact.broken_cause ?? "missing"
      )}.`
  );
  const exitCode = brokenLinks.length > 0 && failOnBroken ? 1 : 0;
  const exitReason: CheckExitReason =
    brokenLinks.length === 0
      ? "ok"
      : failOnBroken
        ? "broken_links"
        : "broken_links_warn_only";
  const result = {
    base,
    repository: repositoryKey,
    manifest_current: manifestCurrent,
    manifest_compile_error: manifestCompileError,
    changes,
    impacts,
    broken_links: brokenLinks,
    fail_on_broken: failOnBroken,
    exit_code: exitCode,
    exit_reason: exitReason,
    errors,
    warnings: [
      ...(!manifestCurrent
        ? [
            "The committed manifest does not match current YAML or linked content; compile it before merge.",
          ]
        : []),
      ...(manifestCompileError
        ? [`The manifest could not be recompiled: ${manifestCompileError}`]
        : []),
      ...impacts
        .filter((impact) => impact.freshness === "stale")
        .map(
          (impact) =>
            `${impact.acceptance_criterion_stable_id} is stale for ${impact.path}.`
        ),
    ],
  };
  if (options.json) {
    io.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const groups = groupByCriterion(impacts);
    io.write(
      `Semantic impact: ${impacts.length} AC finding(s) across ${groups.length} acceptance criteria; manifest=${manifestCurrent ? "current" : "stale"}; broken link(s)=${brokenLinks.length}.\n`
    );
    for (const group of groups) renderGroup(group, io);
    if (groups.length) io.write("\n");
    for (const error of errors) {
      io.write(`  error ${error}\n`);
    }
    for (const warning of result.warnings) {
      io.write(`  warn  ${warning}\n`);
    }
    if (exitCode !== 0) {
      io.write(
        "  Broken links fail this check. Re-run with --no-fail-on-broken to downgrade them to warnings.\n"
      );
    }
  }
  // Findings that require human judgement (stale, modified, contract
  // definition changes) stay warn-only. Broken links do not: nothing needs to
  // be judged to know the manifest points at evidence that is not there.
  return exitCode;
}
