import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { PostgresContractSyncRepository } from "../adapters/postgres/contract-sync-repository.js";
import { PostgresContractReadRepository } from "../adapters/postgres/contract-read-repository.js";
import { PostgresSemanticRepository } from "../adapters/postgres/semantic-repository.js";
import {
  closeConnections,
  getSyncSql,
} from "../adapters/postgres/connections.js";
import {
  attachCurrentArtifactHashes,
  compileContractManifestWithSources,
  manifestWithoutScreens,
  parseContractManifestSnapshot,
  readContractManifest,
  writeContractManifest,
  CONTRACT_MANIFEST_INDEX_FILE,
  type CompiledContractManifest,
  type ContractManifest,
} from "../contract/manifest.js";
import { resolveComparisonBase } from "../contract/comparison-base.js";
import {
  CONTRACT_HISTORY_LIMITS,
  readContractHistory,
  readReviewHistory,
  type ContractHistory,
} from "../contract/history.js";
import { PostgresContractChangeEventsRepository } from "../adapters/postgres/contract-change-events-repository.js";
import { screenSettingsForRepository } from "../contract/screen-catalog.js";
import {
  DEFAULT_HOSTED_SCREENS_DEPENDENCIES,
  publishMainScreens,
  renderMainScreensResult,
  type HostedSettings,
  type MainScreensResult,
} from "./screens-hosting.js";
import { loadAcceptedContract } from "../contract/load.js";
import {
  diffReviewManifests,
  summarizeReviewChanges,
  type ReviewComparison,
} from "../contract/review-changes.js";
import {
  TIELINE_REVIEW_PAGE,
  writeWorkspaceReviewPage,
} from "../tieline/review.js";
import { contractEmbeddingDocuments } from "../derived/embedding-documents.js";
import { getEmbedder, mapWithConcurrency } from "../embeddings.js";
import {
  MAPPING_CONFIDENCE_TIERS,
  computeRepositoryMappingCoverage,
  type RepositoryMappingCoverage,
} from "../contract/coverage.js";
import {
  analyzeLinkPlausibility,
  toLinkReviewSuggestion,
  type LinkPlausibilityReport,
} from "../contract/link-plausibility.js";
import { changesSince } from "../contract/impact.js";
import {
  lookupPathCriteria,
  renderPathCriteriaText,
} from "../contract/path-criteria.js";
import {
  analyzeContractReconciliation,
  type ContractReconciliation,
  type ExcludedChange,
} from "../contract/reconciliation.js";
import {
  buildGradeScope,
  parseGradeVerdicts,
  renderGradeReportText,
  renderGradeScopeText,
  verifyGradeVerdicts,
} from "../contract/grade.js";
import { buildCriterionGradeScope, parseCriterionGradeVerdicts, verifyCriterionGradeVerdicts } from "../contract/criterion-grade.js";
import { readAuthoredContractAtBase } from "../contract/authored-snapshot.js";
import { runContractContext } from "./contract-context.js";
export { renderIntentContextText } from "./contract-context.js";
import { resolveCommandContext, wrap, type CommandIO } from "./shared.js";

export type ContractAction =
  | "validate"
  | "review"
  | "compile"
  | "coverage"
  | "link-review"
  | "reconcile"
  | "criteria"
  | "context"
  | "grade"
  | "sync";

export interface ContractCommandOptions {
  repository?: string;
  repo?: string;
  commit?: string;
  output?: string;
  spec?: string;
  expectedPreviousCommit?: string;
  /** Git ref the working tree is compared against. Required by `reconcile`. */
  base?: string;
  unit?: string;
  scope?: string;
  emitScope?: boolean;
  verify?: string;
  strict?: boolean;
  json?: boolean;
  paths?: string[];
  path?: string;
  kind?: string;
  selector?: string;
  ac?: string;
  /** `link-review` only: persist review candidates as attribution suggestions. */
  save?: boolean;
}

interface ParsedContractCommand {
  action: ContractAction;
  repositoryRoot: string;
  repositoryKey: string;
  commit?: string;
  outputPath: string;
  manifestPath: string;
  /** The workspace configuration file, when there is a workspace. */
  configPath?: string;
  manifestMode: "committed" | "post_merge";
  specDirectory: string;
  sourceRoots: string[];
  ignore: string[];
  expectedPreviousCommit?: string;
  base?: string;
  unit: "link" | "criterion";
  scope: "claims" | "impacted";
  emitScope: boolean;
  verify?: string;
  strict: boolean;
  json: boolean;
  paths: string[];
  path?: string;
  kind?: string;
  selector?: string;
  ac?: string;
  save: boolean;
}

const SCREENS_NOT_SYNCED =
  "screens and shows links stay in the repository manifest; database sync does not store them yet.";
const SCREENS_HOSTED =
  "screens and shows links are not stored in the contract tables; main's hosted page shows them.";

function gitCommit(repositoryRoot: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(
      "Could not determine the repository commit. Run inside a Git checkout or pass --commit <sha>."
    );
  }
}

function resolveContractCommand(
  action: ContractAction,
  options: ContractCommandOptions
): ParsedContractCommand {
  const { root, workspace, repositoryKey, specDirectory, manifestPath } =
    resolveCommandContext(options);
  const resolvedOutput = options.output
    ? isAbsolute(options.output)
      ? options.output
      : resolve(root, options.output)
    : resolve(
        root,
        // `review` writes one HTML page; everything else reads or writes the
        // manifest, which is a directory of per-capability files.
        action === "review" ? TIELINE_REVIEW_PAGE : ".tieline/manifest"
      );
  if (options.unit !== undefined && options.unit !== "link" && options.unit !== "criterion") {
    throw new Error("Grading unit must be link or criterion.");
  }
  if (options.scope !== undefined && options.scope !== "claims" && options.scope !== "impacted") {
    throw new Error("Grading scope must be claims or impacted.");
  }
  if (options.scope === "claims" && options.unit !== "criterion") {
    throw new Error("--scope claims requires --unit criterion.");
  }
  return {
    action,
    unit: options.unit ?? "link",
    scope: options.scope ?? "impacted",
    repositoryRoot: root,
    repositoryKey,
    commit: options.commit,
    outputPath: resolvedOutput,
    // `review` writes a page to its output path, so without a workspace its
    // manifest is still the default directory, never the page.
    manifestPath:
      workspace?.manifestPath ?? (action === "review" ? manifestPath : resolvedOutput),
    ...(workspace ? { configPath: workspace.configPath } : {}),
    manifestMode: workspace?.config.manifest_mode ?? "committed",
    specDirectory,
    sourceRoots: workspace?.config.repository.source_roots ?? ["src"],
    ignore: workspace?.config.repository.ignore ?? [],
    expectedPreviousCommit: options.expectedPreviousCommit,
    base: options.base,
    emitScope: options.emitScope === true,
    verify: options.verify,
    strict: options.strict === true,
    json: options.json === true,
    paths: options.paths ?? [],
    path: options.path,
    kind: options.kind,
    selector: options.selector,
    ac: options.ac,
    save: options.save === true,
  };
}

async function runGrade(
  parsed: ParsedContractCommand,
  io: CommandIO
): Promise<number> {
  const selectedModes = Number(parsed.emitScope) + Number(parsed.verify !== undefined);
  if (selectedModes !== 1) {
    throw new Error(
      "`contract grade` requires exactly one of --emit-scope or --verify <verdicts.json>."
    );
  }
  if (!parsed.base) {
    throw new Error(
      "`contract grade` requires --base <ref> so its work list comes from an explicit diff."
    );
  }
  if (parsed.emitScope && parsed.strict) {
    throw new Error("`--strict` applies only with `contract grade --verify`.");
  }

  let manifest: ContractManifest;
  try {
    manifest = parsed.manifestMode === "post_merge"
      ? compileContractManifestWithSources({ repositoryRoot: parsed.repositoryRoot, repositoryKey: parsed.repositoryKey, specDirectory: parsed.specDirectory }).manifest
      : readContractManifest(parsed.manifestPath);
  } catch (error) {
    throw new Error(
      `Cannot derive grading scope because the contract manifest at '${parsed.manifestPath}' is unreadable: ${
        error instanceof Error ? error.message : String(error)
      } Run \`tieline contract compile .\` and commit the manifest.`
    );
  }
  // Both sides of the claim diff are read at the branch point, so links and
  // criteria that reached the base after it are not graded as this branch's.
  const comparison = resolveComparisonBase(parsed.repositoryRoot, parsed.base);
  const scopeInput = {
    repositoryRoot: parsed.repositoryRoot,
    base: parsed.base,
    manifest,
    // Read where the base kept it, which a branch may have moved; without a
    // committed manifest, compiled from the base's authored contract.
    baseManifest: parsed.manifestMode === "post_merge"
      ? readAuthoredContractAtBase({ repositoryRoot: parsed.repositoryRoot, repositoryKey: parsed.repositoryKey, specDirectory: parsed.specDirectory, base: comparison.commit })
      : manifestAtBase(
          parsed.repositoryRoot,
          comparison.commit,
          manifestPathAtCommit(parsed, comparison.commit)
        ),
    changes: changesSince(parsed.repositoryRoot, comparison.commit),
    sourceRoots: parsed.sourceRoots,
    ignore: parsed.ignore,
    specDirectory: parsed.specDirectory,
  };
  const scope = parsed.unit === "criterion"
    ? await buildCriterionGradeScope({ ...scopeInput, selection: parsed.scope })
    : await buildGradeScope(scopeInput);
  if (parsed.emitScope) {
    io.write(
      parsed.json
        ? `${JSON.stringify(scope, null, 2)}\n`
        : "unit" in scope ? renderCriterionScope(scope) : renderGradeScopeText(scope)
    );
    return 0;
  }

  const verdictsPath = isAbsolute(parsed.verify!)
    ? parsed.verify!
    : resolve(parsed.repositoryRoot, parsed.verify!);
  let document: unknown;
  try {
    if (statSync(verdictsPath).size > 16 * 1024 * 1024) throw new Error("Verdicts exceed 16 MiB.");
    document = JSON.parse(readFileSync(verdictsPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read grade verdicts '${verdictsPath}': ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if ("unit" in scope) {
    const report = verifyCriterionGradeVerdicts({ scope, verdicts: parseCriterionGradeVerdicts(document), strict: parsed.strict });
    io.write(parsed.json ? `${JSON.stringify(report, null, 2)}\n` :
      `Grades: ${report.scoped_criteria} criterion/criteria; ${JSON.stringify(report.counts)}.\n` +
      report.entries.map((entry) => `  ${entry.acceptance_criterion_stable_id}: ${entry.grade}: ${entry.reason}\n` +
        entry.link_findings.map((finding) => `    link ${finding.link_id}: ${finding.reason}\n`).join("")).join("") + renderReconciliationInventory(scope));
    return report.strict_failure ? 1 : 0;
  }
  const report = verifyGradeVerdicts({
    scope,
    verdicts: parseGradeVerdicts(document),
    strict: parsed.strict,
  });
  io.write(
    parsed.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderGradeReportText(report)
  );
  return report.strict_failure ? 1 : 0;
}

function renderCriterionScope(scope: Awaited<ReturnType<typeof buildCriterionGradeScope>>): string {
  return `Grading scope: ${scope.scoped_criteria} criterion/criteria (${scope.selection}).\n` +
    scope.entries.map((entry) => `  ${entry.id} ${entry.acceptance_criterion_stable_id}: ${entry.acceptance_criterion.criterion}\n` +
      entry.evidence.map((link) => `    ${link.id} ${link.path}: ${link.symbols.join(", ") || "no legal citations"}\n`).join("")).join("") +
    renderReconciliationInventory(scope);
}

function renderReconciliationInventory(scope: Awaited<ReturnType<typeof buildCriterionGradeScope>>): string {
  return `Implementation-only ACs requiring reconciliation: ${scope.implementation_only_criteria.join(", ") || "none"}.\n` +
    `Removed ACs requiring review: ${scope.removed_criteria.join(", ") || "none"}.\n`;
}

/**
 * The manifest as committed at `base`, or null when that ref carries none —
 * the initial contract, whose every link is then claim-side grading scope.
 *
 * Only a manifest inside the repository can have a version at a ref, so a
 * manifest configured elsewhere is refused: treating it as absent would grade
 * the whole contract as newly claimed, which is a fabricated scope.
 */
/**
 * The most a base revision's workspace configuration may be: a real one is a
 * few kilobytes, and it is checked before Git is asked for it.
 */
const BASE_CONFIG_BYTES = 4 * 1024 * 1024;
/** The most a base manifest directory listing may take: about 600,000 entries. */
const MANIFEST_LISTING_BYTES = 64 * 1024 * 1024;
/**
 * The most a base manifest may hold in all, read into memory at once: far
 * past any real contract, and checked from the listing before Git is asked
 * for a byte, so a pathological base is refused rather than exhausting memory.
 */
const MANIFEST_SNAPSHOT_BYTES = 256 * 1024 * 1024;

/** @internal Exported for tests, which pass a small `maxBytes`. */
export function manifestAtBase(
  repositoryRoot: string,
  base: string,
  manifestPath: string,
  maxBytes = MANIFEST_SNAPSHOT_BYTES
): ContractManifest | null {
  // Paths are taken from Git's worktree root, not `repository.root`: with a
  // nested root the workspace, and so the manifest, sits above it, yet is
  // still in the repository that `base` belongs to.
  const worktree = gitWorktree(repositoryRoot);
  const directory = worktreePath(worktree, repositoryRoot, manifestPath);
  if (directory === null) {
    throw new Error(
      `Cannot derive claim-side grading scope: the manifest at '${manifestPath}' is outside the repository, so '${base}' cannot hold a version of it.`
    );
  }
  // Only what the working-tree reader takes: the directory's own regular
  // `.json` files. Not subdirectories, links, or other files.
  let listing: string;
  try {
    listing = execFileSync("git", ["ls-tree", "-l", "-z", base, "--", `${directory}/`], {
      cwd: worktree.root,
      encoding: "utf8",
      // Metadata only, about 100 bytes an entry; far past any real manifest.
      maxBuffer: MANIFEST_LISTING_BYTES,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOBUFS") {
      throw new Error(
        `The manifest directory '${directory}' at '${base}' lists more than ${MANIFEST_LISTING_BYTES} bytes of entries, so it is not read.`
      );
    }
    throw error;
  }
  const files = listing
    .split("\0")
    .filter(Boolean)
    .flatMap((entry) => {
      const match = /^(\d+) (\w+) ([0-9a-f]+) +(\d+)\t(.+)$/s.exec(entry);
      if (!match) return [];
      const [, mode = "", type = "", object = "", size = "0", path = ""] = match;
      return type === "blob" && (mode === "100644" || mode === "100755") && path.endsWith(".json")
        ? [{ path, object, size: Number(size) }]
        : [];
    });
  if (files.length === 0) return null;
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (totalBytes > maxBytes) {
    throw new Error(
      `The manifest at '${directory}' in '${base}' holds ${totalBytes} bytes; more than the ${maxBytes} a base manifest may hold, so it is not read.`
    );
  }
  const contents = readBlobs(worktree.root, files);
  return parseContractManifestSnapshot(
    files.map(({ path }, index) => ({
      name: path.slice(`${directory}/`.length),
      content: contents[index] ?? "",
    })),
    `ref '${base}'`
  );
}

/**
 * Reads blobs through one `git cat-file --batch`, however many there are,
 * rather than a process each. The output is exactly each blob behind a
 * header naming its id, type, and size, so its buffer is the sizes the
 * listing reported plus those headers: nothing past what the base holds.
 */
function readBlobs(
  worktree: string,
  blobs: ReadonlyArray<{ object: string; size: number }>
): string[] {
  const headerBytes = (blob: { object: string; size: number }) =>
    `${blob.object} blob ${blob.size}\n`.length + 1;
  const output = execFileSync("git", ["cat-file", "--batch"], {
    cwd: worktree,
    input: `${blobs.map((blob) => blob.object).join("\n")}\n`,
    maxBuffer: blobs.reduce((total, blob) => total + blob.size + headerBytes(blob), 0) + 1,
  });
  const contents: string[] = [];
  let offset = 0;
  for (const blob of blobs) {
    const headerEnd = output.indexOf(0x0a, offset);
    const header = output.subarray(offset, headerEnd).toString("utf8");
    const [object, type, size] = header.split(" ");
    if (object !== blob.object || type !== "blob" || Number(size) !== blob.size) {
      throw new Error(`git cat-file returned '${header}' for blob ${blob.object}.`);
    }
    const start = headerEnd + 1;
    contents.push(output.subarray(start, start + blob.size).toString("utf8"));
    offset = start + blob.size + 1;
  }
  return contents;
}

/**
 * Where `repositoryRoot` sits in its Git worktree: the worktree's root, to
 * run Git from, and the root's own path within it (Git's prefix).
 */
function gitWorktree(repositoryRoot: string): { root: string; prefix: string } {
  const [root = "", prefix = ""] = execFileSync(
    "git",
    ["rev-parse", "--show-toplevel", "--show-prefix"],
    { cwd: repositoryRoot, encoding: "utf8" }
  ).split("\n");
  return { root, prefix };
}

/**
 * `path` as a `<commit>:<path>` object name takes it: relative to the
 * worktree root, `/`-separated, or null when outside the worktree. Derived
 * from the configured path as written, never through the current file
 * system, since what a link points at now says nothing about the base.
 */
function worktreePath(
  worktree: { prefix: string },
  repositoryRoot: string,
  path: string
): string | null {
  const fromRoot = relative(resolve(repositoryRoot), resolve(path)).split(sep).join("/");
  const relativePath = posix.normalize(posix.join(worktree.prefix || ".", fromRoot));
  return relativePath === ".." || relativePath.startsWith("../") || posix.isAbsolute(relativePath)
    ? null
    : relativePath;
}

/**
 * Where the manifest lived at `commit`: that revision's own configured
 * `files.manifest`, so a branch that moved the manifest still compares with
 * the base's. A commit without a usable workspace configuration there (none,
 * one that does not parse, or one naming no manifest) kept it where Tieline
 * does by default, `.tieline/manifest`.
 */
function manifestPathAtCommit(parsed: ParsedContractCommand, commit: string): string {
  if (parsed.configPath === undefined) return parsed.manifestPath;
  const defaultPath = resolve(parsed.repositoryRoot, ".tieline/manifest");
  const worktree = gitWorktree(parsed.repositoryRoot);
  const configPath = worktreePath(worktree, parsed.repositoryRoot, parsed.configPath);
  if (configPath === null) return parsed.manifestPath;
  const object = `${commit}:${configPath}`;
  let size: number;
  try {
    size = Number(
      execFileSync("git", ["cat-file", "-s", object], {
        cwd: worktree.root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim()
    );
  } catch {
    // Not in that commit: the base predates this workspace configuration.
    return defaultPath;
  }
  if (size > BASE_CONFIG_BYTES) {
    throw new Error(
      `The workspace configuration '${configPath}' at '${commit}' is ${size} bytes; more than the ${BASE_CONFIG_BYTES} a configuration may be, so it is not read.`
    );
  }
  const text = execFileSync("git", ["show", object], {
    cwd: worktree.root,
    encoding: "utf8",
    // Exactly the blob's size, whatever the configuration holds.
    maxBuffer: size + 1,
  });
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    return defaultPath;
  }
  const manifest = (config as { files?: { manifest?: unknown } } | null)?.files?.manifest;
  return typeof manifest === "string" && manifest.length > 0
    ? resolve(dirname(parsed.configPath), manifest)
    : defaultPath;
}

/**
 * What the working tree changed against `base`, for the review page. The page
 * itself renders even from an invalid contract, so a working tree that does not
 * compile only withholds the comparison and says why. The current manifest is
 * compiled tolerantly: it is a report, never written, and a missing linked file
 * is drift the page should still be able to describe.
 */
function reviewChangesAgainstBase(
  parsed: ParsedContractCommand,
  base: string
): ReviewComparison {
  // Read first: an unreadable base is the caller's error and is always reported,
  // whatever state the working tree is in. The manifest is read where this
  // branch left the base, so work that reached the base afterwards is not
  // shown as this branch's changes.
  const commit = resolveComparisonBase(parsed.repositoryRoot, base).commit;
  const baseManifest = manifestAtBase(
    parsed.repositoryRoot,
    commit,
    manifestPathAtCommit(parsed, commit)
  );
  let current: ContractManifest;
  try {
    current = compileContractManifestWithSources({
      repositoryRoot: parsed.repositoryRoot,
      repositoryKey: parsed.repositoryKey,
      specDirectory: parsed.specDirectory,
      onUnhashableArtifact: "omit_hash",
    }).manifest;
  } catch (error) {
    return {
      base,
      unavailable: `the working-tree contract does not compile (${
        error instanceof Error ? error.message.split("\n")[0] : String(error)
      }).`,
    };
  }
  return { changes: diffReviewManifests(baseManifest, current, base) };
}

type ChangeEventsResult =
  | {
      status: "recorded";
      recorded: number;
      commits_read: number;
      /** The commit recording resumed after, or null for a first, backfilling record. */
      since: string | null;
      truncated: boolean;
      unreadable_commits: number;
      /**
       * Changes newer than a commit that could not be read, left for a later
       * sync: recording them would move the resume point past the gap.
       */
      held_back: number;
    }
  | { status: "unavailable"; detail: string }
  | { status: "failed"; detail: string };

/**
 * Records when each Story, criterion, and screen changed, from the committed
 * manifest's git history: everything after the last recorded commit, or the
 * whole bounded history on the first record. History git cannot read is
 * reported and leaves the sync as it was; a database failure comes after the
 * contract was synced and is its own outcome, and running sync again records
 * what was missed, since recording is idempotent.
 */
async function recordSyncedChangeEvents(
  parsed: ParsedContractCommand,
  repositoryKey: string,
  commit: string
): Promise<ChangeEventsResult> {
  if (!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) {
    return { status: "unavailable", detail: `the synced commit '${commit}' is not a full git commit SHA` };
  }
  const directory = relative(resolve(parsed.repositoryRoot), resolve(parsed.outputPath)).split(sep).join("/");
  if (!directory || directory === ".." || directory.startsWith("../") || isAbsolute(directory)) {
    return { status: "unavailable", detail: "the manifest is outside the repository" };
  }
  const events = new PostgresContractChangeEventsRepository(getSyncSql);
  let since: string | null;
  try {
    since = await events.lastRecordedCommit(repositoryKey);
  } catch (error) {
    return { status: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
  let history: ContractHistory;
  try {
    try {
      history = readContractHistory(parsed.repositoryRoot, directory, {
        ref: commit,
        limit: CONTRACT_HISTORY_LIMITS.maxCommits,
        ...(since ? { until: since } : {}),
      });
    } catch (error) {
      if (!since) throw error;
      // The last recorded commit is not in this clone: read back from the
      // synced commit instead; commits recorded before are skipped.
      history = readContractHistory(parsed.repositoryRoot, directory, {
        ref: commit,
        limit: CONTRACT_HISTORY_LIMITS.maxCommits,
      });
    }
  } catch (error) {
    const stderr = (error as { stderr?: unknown } | null)?.stderr;
    return {
      status: "unavailable",
      detail: `git history could not be read: ${
        typeof stderr === "string" && stderr.trim() ? stderr.trim().split("\n")[0] : error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  try {
    // Recording resumes after the newest recorded change, so nothing newer
    // than an unreadable commit is recorded yet: once git can read that
    // commit (say, after the missing objects are fetched), a later sync
    // records the gap and what followed it.
    return {
      status: "recorded",
      recorded: await events.record(repositoryKey, history.beforeUnreadable),
      commits_read: history.commits.length,
      since,
      truncated: history.truncated,
      unreadable_commits: history.unreadable.length,
      held_back: history.changes.length - history.beforeUnreadable.length,
    };
  } catch (error) {
    return { status: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
}

function renderChangeEvents(result: ChangeEventsResult): string {
  switch (result.status) {
    case "recorded":
      return `Recorded ${result.recorded} change event(s) from ${result.commits_read} commit(s)${
        result.since ? ` since ${result.since.slice(0, 12)}` : ""
      }${result.truncated ? "; older history was not read" : ""}${
        result.unreadable_commits > 0 ? `; ${result.unreadable_commits} commit(s) could not be read` : ""
      }${
        result.held_back > 0
          ? `; ${result.held_back} newer change(s) wait until git can read them, so a later sync records the gap first`
          : ""
      }.\n`;
    case "unavailable":
      return `Change events were not recorded: ${result.detail}.\n`;
    case "failed":
      return `The contract was synced, but its change events were not recorded: ${result.detail}. Run \`tieline migrate\` if the table is missing, then run sync again; it records what was missed.\n`;
  }
}

/**
 * The repository's hosted screens settings, or null when screens or hosting
 * are off, which is the ordinary case and leaves sync unchanged.
 */
function hostedScreenSettings(repositoryRoot: string): HostedSettings | null {
  const settings = screenSettingsForRepository(repositoryRoot);
  return settings?.hosted ? { ...settings, hosted: settings.hosted } : null;
}

/**
 * Publishes `main`'s hosted screens after its contract is synced. A failure
 * here comes after the contract was written, so it is reported as its own
 * outcome rather than thrown: the contract sync stands, and running sync
 * again at the same commit retries only the screens.
 */
async function publishSyncedMainScreens(
  parsed: ParsedContractCommand,
  manifest: ContractManifest,
  commit: string,
  settings: HostedSettings
): Promise<MainScreensResult> {
  try {
    return await publishMainScreens({
      root: parsed.repositoryRoot,
      repositoryKey: manifest.repository.key,
      specDirectory: parsed.specDirectory,
      manifestPath: parsed.outputPath,
      manifest,
      commit,
      settings,
      repository: DEFAULT_HOSTED_SCREENS_DEPENDENCIES.repository("sync"),
      store: DEFAULT_HOSTED_SCREENS_DEPENDENCIES.store(settings.hosted),
    });
  } catch (error) {
    return {
      outcome: "failed",
      commit,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The committed manifest, when one is readable and belongs to this repository.
 * Its absence is ordinary — a repository may never have compiled one — so it is
 * never an error here.
 */
function readReviewedManifest(
  directory: string,
  repositoryKey: string
): ContractManifest | undefined {
  if (!existsSync(resolve(directory, CONTRACT_MANIFEST_INDEX_FILE))) {
    return undefined;
  }
  try {
    const reviewed = readContractManifest(directory);
    return reviewed.repository.key === repositoryKey ? reviewed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One line per confidence tier. Every mapped file appears in exactly one tier,
 * and a tier whose input was not supplied is reported as unavailable rather
 * than as zero, so an absent measurement never reads as a failed one.
 */
function renderConfidenceTiers(
  mappingCoverage: RepositoryMappingCoverage
): string {
  const { confidence } = mappingCoverage;
  const unavailable: Partial<Record<string, string>> = {
    hash_current: confidence.hash_comparison_available
      ? undefined
      : " (no hash comparison was available)",
  };
  return MAPPING_CONFIDENCE_TIERS.map((tier) => {
    const percentage = confidence.percentages[tier];
    return `  ${tier.padEnd(13)} ${confidence.counts[tier]}${
      percentage === null ? "" : ` (${percentage}% of eligible files)`
    }${unavailable[tier] ?? ""}\n`;
  }).join("");
}

/**
 * Link review in prose. Candidates are suggestions for a human to re-read, so
 * the disclaimer travels with the output and the word "verdict" never appears.
 */
function renderLinkReview(
  report: LinkPlausibilityReport,
  io: CommandIO
): void {
  io.write(
    `Link review (${report.method}): ${report.scored_links} link(s) scored, ${report.review_candidates.length} candidate(s) for human review, ${report.skipped.length} link(s) not scored.\n`
  );
  io.write(wrap(report.disclaimer, 88, "  "));
  if (report.distribution) {
    // The window is stated as a link count rather than a percentage. Links
    // tied at the cut score are all included, so more than the configured
    // fraction can be flagged and a percentage would overstate the window.
    const window = Math.floor(
      report.distribution.sample_size * report.distribution.review_percentile
    );
    io.write(
      `  distribution  min ${report.distribution.minimum}, median ${report.distribution.median}, max ${report.distribution.maximum} over ${report.distribution.sample_size} scored link(s); flagged below ${report.distribution.absolute_score_floor}, within the ${window} least-related link(s) and any tied with them.\n`
    );
  }
  for (const candidate of report.review_candidates) {
    io.write(
      `\n  ${candidate.acceptance_criterion_stable_id}  ${candidate.relation} · ${candidate.provenance} ${candidate.path}\n`
    );
    io.write(wrap(candidate.rationale, 88, "    "));
  }
  if (report.review_candidates.length) io.write("\n");
  for (const skip of report.skipped) {
    io.write(
      `  skipped ${skip.acceptance_criterion_stable_id} ${skip.path ?? "(no path)"} (${skip.provenance}, ${skip.reason})\n`
    );
  }
  for (const note of report.notes) io.write(wrap(`note  ${note}`, 88, "  "));
}

function describeExclusion(change: ExcludedChange): string {
  switch (change.reason) {
    case "contract_definition":
      return "the contract definition itself";
    case "outside_source_roots":
      return "outside the configured source roots";
    case "ignored":
      return `matched the ignore pattern '${change.matched_ignore_pattern}'`;
    case "deleted":
      return "deleted and unclaimed, so no file remains to describe";
  }
}

function changeLabel(change: { status: string; old_path?: string }): string {
  return change.old_path
    ? `${change.status} (from ${change.old_path})`
    : change.status;
}

/**
 * Reconciliation in prose. The wording stays neutral on purpose: an unclaimed
 * file is a question for a human, never an accusation that an acceptance
 * criterion is missing.
 */
function renderReconciliation(
  report: ContractReconciliation,
  base: string,
  io: CommandIO
): void {
  io.write(
    `Reconciliation against ${base}: ${report.summary.changed_paths} changed path(s); ${report.summary.claimed} already claimed by acceptance criteria, ${report.summary.unclaimed} unclaimed source file(s), ${report.summary.excluded} set aside.\n`
  );
  io.write(wrap(report.disclaimer, 88, "  "));
  if (report.claimed_changes.length) {
    io.write("\nClaimed changes (these acceptance criteria may need re-reading):\n");
    for (const change of report.claimed_changes) {
      io.write(`\n  ${change.path} (${changeLabel(change)})\n`);
      for (const claim of change.claimed_by) {
        io.write(
          `    ${claim.acceptance_criterion_stable_id}  ${claim.relation} ${claim.linked_path} (${claim.provenance}, ${claim.link_scope})\n`
        );
        io.write(wrap(claim.acceptance_criterion, 88, "      "));
      }
    }
  }
  if (report.unclaimed_changes.length) {
    io.write(
      "\nUnclaimed changes (consider whether behavior changed; a refactor needs no new criterion):\n"
    );
    for (const change of report.unclaimed_changes) {
      io.write(`  ${change.path} (${changeLabel(change)})\n`);
    }
  }
  if (report.excluded_changes.length) {
    io.write("\nSet aside (considered, not candidates for authoring):\n");
    for (const change of report.excluded_changes) {
      io.write(
        `  ${change.path} (${changeLabel(change)}) — ${describeExclusion(change)}\n`
      );
    }
  }
}

/**
 * Persists review candidates as "suggested" attribution rows, so a later
 * attribution pass can surface them instead of the report scrolling away. A
 * candidate whose acceptance criterion has never been synced has no database
 * identity to attach to, so it is counted rather than dropped silently.
 */
async function saveLinkReviewSuggestions(
  repositoryKey: string,
  report: LinkPlausibilityReport
): Promise<{ saved: number; without_synced_criterion: number }> {
  try {
    const reads = new PostgresContractReadRepository(getSyncSql);
    const projected = await reads.queryContractStories({
      filters: {
        repositories: [repositoryKey],
        authorities: ["repository"],
        include_inactive_criteria: true,
      },
      limit: 10_000,
    });
    const criterionIds = new Map<string, string>();
    if (projected.mode === "records") {
      for (const record of projected.records) {
        for (const criterion of record.acceptance_criteria) {
          criterionIds.set(criterion.stable_id, criterion.id);
        }
      }
    }
    const semantic = new PostgresSemanticRepository(getSyncSql, getEmbedder);
    let saved = 0;
    for (const candidate of report.review_candidates) {
      const acceptanceCriterionId = criterionIds.get(
        candidate.acceptance_criterion_stable_id
      );
      if (!acceptanceCriterionId) continue;
      await semantic.saveAttributionSuggestion(
        toLinkReviewSuggestion({ candidate, acceptanceCriterionId })
      );
      saved += 1;
    }
    return {
      saved,
      without_synced_criterion: report.review_candidates.length - saved,
    };
  } finally {
    await closeConnections();
  }
}

function coverage(manifest: ContractManifest): {
  stories: number;
  acceptance_criteria: number;
  criteria_with_direct_links: number;
  criteria_without_direct_links: string[];
  direct_links: number;
} {
  const stories = manifest.capabilities.flatMap((capability) => capability.stories);
  const criteria = stories.flatMap((story) => story.acceptance_criteria);
  return {
    stories: stories.length,
    acceptance_criteria: criteria.length,
    criteria_with_direct_links: criteria.filter((criterion) => criterion.links.length > 0)
      .length,
    criteria_without_direct_links: criteria
      .filter((criterion) => criterion.links.length === 0)
      .map((criterion) => criterion.stable_id),
    direct_links: criteria.reduce(
      (total, criterion) => total + criterion.links.length,
      0
    ),
  };
}

function screenCount(manifest: ContractManifest): number {
  return (manifest.screen_catalogs ?? []).reduce(
    (total, catalog) => total + catalog.screens.length,
    0
  );
}

export async function runContractCommand(
  action: ContractAction,
  options: ContractCommandOptions,
  io: CommandIO
): Promise<number> {
  const parsed = resolveContractCommand(action, options);
  if (parsed.action === "validate") {
    const result = loadAcceptedContract(parsed.repositoryRoot, parsed.specDirectory);
    const response = {
      valid: true,
      documents: result.documents.length,
      stories: result.documents.reduce(
        (total, document) => total + document.capability.stories.length,
        0
      ),
      acceptance_criteria: result.documents.reduce(
        (total, document) =>
          total +
          document.capability.stories.reduce(
            (storyTotal, story) =>
              storyTotal + story.acceptance_criteria.length,
            0
          ),
        0
      ),
      // Reported only when the repository enabled screens.
      ...(result.screens ? { screens: result.screens.screens.size } : {}),
      warnings: result.warnings,
    };
    io.write(
      parsed.json
        ? `${JSON.stringify(response, null, 2)}\n`
        : `Contract valid: ${response.stories} Stories, ${response.acceptance_criteria} acceptance criteria, ${
            response.screens === undefined ? "" : `${response.screens} screens, `
          }${response.warnings.length} warning(s).\n`
    );
    return 0;
  }

  if (parsed.action === "review") {
    const branch = parsed.base ? reviewChangesAgainstBase(parsed, parsed.base) : undefined;
    // When each item last changed is read from git; a page without it is
    // still complete, so history that cannot be read is only reported.
    const history = readReviewHistory(parsed.repositoryRoot, parsed.manifestPath);
    const result = writeWorkspaceReviewPage(
      parsed.repositoryRoot,
      parsed.repositoryKey,
      parsed.specDirectory,
      parsed.outputPath,
      branch,
      history.status === "read" ? { items: history.items, truncated: history.truncated } : undefined
    );
    const changes = branch
      ? branch.changes
        ? summarizeReviewChanges(branch.changes)
        : { base: parsed.base, unavailable: branch.unavailable }
      : undefined;
    const response = {
      output: result.path,
      bytes: result.bytes,
      capabilities: result.capabilities,
      stories: result.stories,
      acceptance_criteria: result.acceptance_criteria,
      ...(result.screens ? { screens: result.screens } : {}),
      ...(changes ? { changes } : {}),
      history:
        history.status === "read"
          ? { changes: history.changes, items: history.items.size, truncated: history.truncated, unreadable_commits: history.unreadable }
          : { unavailable: history.detail },
      warnings: result.warnings,
    };
    io.write(
      parsed.json
        ? `${JSON.stringify(response, null, 2)}\n`
        : `Wrote a browser review of ${response.stories} Stories${
            result.screens ? `, ${result.screens.screens} screens,` : ""
          } and ${response.acceptance_criteria} acceptance criteria to ${result.path}.\n${
            branch?.changes
              ? `Changes against ${parsed.base}: ${branch.changes.records.filter((record) => record.kind === "story").length} Stories, ${branch.changes.records.filter((record) => record.kind === "acceptance_criterion").length} acceptance criteria, ${branch.changes.screens.length} screens.\n`
              : branch
                ? `Changes against ${parsed.base} are not shown: ${branch.unavailable}\n`
                : ""
          }${
            history.status === "unavailable"
              ? `When each item last changed is not shown: ${history.detail}\n`
              : history.unreadable > 0
                ? `${history.unreadable} commit(s) in the history could not be read, so some items may show an older last change.\n`
                : ""
          }`
    );
    return 0;
  }

  if (parsed.action === "grade") {
    return runGrade(parsed, io);
  }

  if (parsed.action === "context") {
    return runContractContext(parsed, io);
  }

  if (parsed.action === "criteria") {
    if (parsed.paths.length === 0) {
      throw new Error(
        "`contract criteria` requires at least one repository-relative path."
      );
    }
    let manifest: ContractManifest;
    try {
      manifest = readContractManifest(parsed.manifestPath);
    } catch (error) {
      throw new Error(
        `Cannot report acceptance criteria for paths because the contract manifest at '${parsed.manifestPath}' is unreadable: ${
          error instanceof Error ? error.message : String(error)
        } Run \`tieline contract compile .\` and commit the manifest.`
      );
    }
    const report = lookupPathCriteria({
      manifest,
      repositoryRoot: parsed.repositoryRoot,
      paths: parsed.paths,
    });
    io.write(
      parsed.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : renderPathCriteriaText(report)
    );
    return 0;
  }

  if (parsed.action === "sync") {
    const reviewedManifest = readContractManifest(parsed.outputPath);
    if (reviewedManifest.repository.key !== parsed.repositoryKey) {
      throw new Error(
        `Reviewed manifest repository '${reviewedManifest.repository.key}' does not match requested repository '${parsed.repositoryKey}'.`
      );
    }
    const commit = parsed.commit ?? gitCommit(parsed.repositoryRoot);
    // The database does not store screens yet. They are removed here, before
    // anything reaches Postgres, and reported rather than dropped silently.
    const { manifest: syncableManifest, skipped: skippedScreens } =
      manifestWithoutScreens(reviewedManifest);
    const screensSkipped =
      skippedScreens.screens > 0 || skippedScreens.shows_links > 0;
    const manifest = attachCurrentArtifactHashes(
      syncableManifest,
      parsed.repositoryRoot
    );
    // Hosted screens are published after the contract is synced, for the
    // commit just synced. Their settings are read first, so a configuration
    // error stops sync before anything is written; a repository that did not
    // enable them syncs exactly as before.
    const hosted = hostedScreenSettings(parsed.repositoryRoot);
    try {
      const result = await new PostgresContractSyncRepository(getSyncSql).sync(
        manifest,
        { commit, expectedPreviousCommit: parsed.expectedPreviousCommit }
      );
      const reads = new PostgresContractReadRepository(getSyncSql);
      const projected = await reads.queryContractStories({
        filters: {
          repositories: [manifest.repository.key],
          authorities: ["repository"],
          include_inactive_criteria: true,
        },
        limit: 10_000,
      });
      const documents =
        projected.mode === "records"
          ? contractEmbeddingDocuments(projected.records)
          : [];
      const semantic = new PostgresSemanticRepository(getSyncSql, getEmbedder);
      const indexed = await mapWithConcurrency(
        documents,
        4,
        (document) => semantic.upsertEmbeddingDocument(document)
      );
      const indexing = {
        documents: documents.length,
        embedded: indexed.filter(
          (entry) => entry.embedding_status === "embedded"
        ).length,
        unchanged: indexed.filter(
          (entry) => entry.embedding_status === "unchanged"
        ).length,
        embedding_unavailable: indexed.filter(
          (entry) => entry.embedding_status === "unavailable"
        ).length,
      };
      const changeEvents = await recordSyncedChangeEvents(parsed, manifest.repository.key, commit);
      const hostedScreens = hosted
        ? await publishSyncedMainScreens(parsed, reviewedManifest, commit, hosted)
        : undefined;
      const skippedReason = hostedScreens ? SCREENS_HOSTED : SCREENS_NOT_SYNCED;
      io.write(
        parsed.json
          ? `${JSON.stringify({
              ...result,
              embedding_documents: documents.length,
              re_embedded: indexing.embedded,
              semantic_index: indexing,
              ...(screensSkipped
                ? {
                    screens_skipped: {
                      ...skippedScreens,
                      reason: skippedReason,
                    },
                  }
                : {}),
              change_events: changeEvents,
              ...(hostedScreens ? { hosted_screens: hostedScreens } : {}),
            }, null, 2)}\n`
          : `Contract ${result.outcome}: ${result.stories} Stories, ${result.acceptance_criteria} acceptance criteria, ${result.conflicts.length} handoff conflict(s), ${result.reconciled_code_assets} orphaned code asset(s) reconciled; ${indexing.documents} semantic document(s) indexed (${indexing.embedded} embedded, ${indexing.unchanged} unchanged, ${indexing.embedding_unavailable} embedding unavailable).\n${
              screensSkipped
                ? `Skipped ${skippedScreens.screens} screen(s) and ${skippedScreens.shows_links} shows link(s): ${skippedReason}\n`
                : ""
            }`
      );
      if (!parsed.json) io.write(renderChangeEvents(changeEvents));
      if (hostedScreens && !parsed.json) renderMainScreensResult(hostedScreens, io);
      return hostedScreens?.outcome === "failed" || changeEvents.status === "failed" ? 1 : 0;
    } finally {
      await closeConnections();
    }
  }

  /**
   * Compilation is deferred so each remaining action picks its own strictness,
   * and every action compiles exactly once.
   *
   * `compile` is the gate and stays strict: a manifest written for review must
   * never record a null reviewed hash for content nobody could read. The
   * advisory actions are read-only reports about drift, and a branch that
   * deleted or renamed a linked file is precisely the drift they exist to
   * describe — so they tolerate an unhashable artifact instead of aborting.
   * Neither of them writes the manifest, so a tolerant compilation cannot
   * reach `.tieline/manifest/`.
   */
  const compileManifest = (
    onUnhashableArtifact: "throw" | "omit_hash"
  ): CompiledContractManifest =>
    compileContractManifestWithSources({
      repositoryRoot: parsed.repositoryRoot,
      repositoryKey: parsed.repositoryKey,
      specDirectory: parsed.specDirectory,
      onUnhashableArtifact,
    });

  if (parsed.action === "link-review") {
    const { manifest } = compileManifest("omit_hash");
    const report = analyzeLinkPlausibility({
      repositoryRoot: parsed.repositoryRoot,
      manifest,
    });
    const saved = parsed.save
      ? await saveLinkReviewSuggestions(manifest.repository.key, report)
      : null;
    if (parsed.json) {
      io.write(
        `${JSON.stringify(
          {
            repository: manifest.repository,
            ...report,
            ...(saved ? { saved_suggestions: saved } : {}),
          },
          null,
          2
        )}\n`
      );
    } else {
      renderLinkReview(report, io);
      if (saved) {
        io.write(
          `Saved ${saved.saved} suggestion(s) for attribution review${
            saved.without_synced_criterion
              ? `; ${saved.without_synced_criterion} candidate(s) skipped because their acceptance criteria have not been synced`
              : ""
          }.\n`
        );
      }
    }
    // Advisory only. A review candidate is never a verdict and never fails a build.
    return 0;
  }

  if (parsed.action === "reconcile") {
    if (!parsed.base) {
      throw new Error(
        "Reconciliation compares the working tree against a base ref. Pass --base <ref>."
      );
    }
    const comparison = resolveComparisonBase(parsed.repositoryRoot, parsed.base);
    const { manifest } = compileManifest("omit_hash");
    const report = analyzeContractReconciliation({
      repositoryRoot: parsed.repositoryRoot,
      manifest,
      changes: changesSince(parsed.repositoryRoot, comparison.commit),
      sourceRoots: parsed.sourceRoots,
      ignore: parsed.ignore,
      specDirectory: parsed.specDirectory,
    });
    if (parsed.json) {
      io.write(
        `${JSON.stringify(
          { base: parsed.base, base_commit: comparison.commit, ...report },
          null,
          2
        )}\n`
      );
    } else {
      renderReconciliation(report, parsed.base, io);
    }
    // Reporting only. Reconciliation informs authoring and never gates a branch.
    return 0;
  }

  if (parsed.action !== "compile" && parsed.action !== "coverage") {
    throw new Error(`Unsupported contract action: ${parsed.action}`);
  }

  const compiled = compileManifest("throw");
  const manifest = compiled.manifest;

  // `manifest` holds the file hashes just measured by compilation. Compare
  // freshness against the published compilation baseline when available.
  // Neither baseline is evidence that a person reviewed semantic correctness.
  const reviewedManifest =
    parsed.action === "coverage"
      ? readReviewedManifest(parsed.outputPath, parsed.repositoryKey)
      : undefined;
  const mappingCoverage = computeRepositoryMappingCoverage(manifest, {
    repositoryRoot: parsed.repositoryRoot,
    sourceRoots: parsed.sourceRoots,
    ignore: parsed.ignore,
    ...(reviewedManifest ? { reviewedManifest } : {}),
  });

  if (parsed.action === "compile") {
    const written = writeContractManifest(parsed.outputPath, compiled);
    writeWorkspaceReviewPage(
      parsed.repositoryRoot,
      parsed.repositoryKey,
      parsed.specDirectory
    );
    const response = {
      output: parsed.outputPath,
      files: written.files,
      // Files of capabilities the contract no longer declares. Reported because
      // deleting is the one thing compilation does that a maintainer cannot see
      // by reading the output.
      removed_files: written.removed,
      bytes: written.bytes,
      review_page: TIELINE_REVIEW_PAGE,
      repository: manifest.repository,
      ...coverage(manifest),
      // Reported only when the compiled manifest carries screens.
      ...(manifest.screen_catalogs
        ? { screens: screenCount(manifest) }
        : {}),
      mapping_coverage: mappingCoverage,
    };
    io.write(
      parsed.json
        ? `${JSON.stringify(response, null, 2)}\n`
        : `Compiled ${response.acceptance_criteria} acceptance criteria to ${parsed.outputPath} (${response.files.length} files, ${response.bytes} bytes)${
            written.removed.length
              ? `; removed ${written.removed.length} file(s) for capabilities the contract no longer declares: ${written.removed.join(", ")}`
              : ""
          }. Review page: ${TIELINE_REVIEW_PAGE}.\n`
    );
    return 0;
  }

  if (parsed.action === "coverage") {
    const response = {
      repository: manifest.repository,
      ...coverage(manifest),
      mapping_coverage: mappingCoverage,
    };
    const repositoryCoverage =
      response.mapping_coverage.status === "no_eligible_files"
        ? `no eligible repository files were found under the configured source roots (${response.mapping_coverage.source_roots.join(", ")}), so mapping coverage is not measured`
        : `${response.mapping_coverage.mapped_files}/${response.mapping_coverage.eligible_files} eligible repository files mapped (${response.mapping_coverage.percentage}%)`;
    io.write(
      parsed.json
        ? `${JSON.stringify(response, null, 2)}\n`
        : `${response.criteria_with_direct_links}/${response.acceptance_criteria} acceptance criteria have direct evidence links; ${repositoryCoverage}.\n${
            response.mapping_coverage.status === "no_eligible_files"
              ? ""
              : `Mapping confidence (a mapped file counts once, at the highest tier it reaches):\n${renderConfidenceTiers(
                  response.mapping_coverage
                )}`
          }${response.mapping_coverage.unmapped_files.length ? `Unmapped: ${response.mapping_coverage.unmapped_files.join(", ")}\n` : ""}`
    );
    return 0;
  }

  throw new Error(`Unsupported contract action: ${parsed.action}`);
}
