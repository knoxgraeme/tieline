import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
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
  parseContractManifestSnapshot,
  readContractManifest,
  writeContractManifest,
  CONTRACT_MANIFEST_INDEX_FILE,
  type CompiledContractManifest,
  type ContractManifest,
} from "../contract/manifest.js";
import {
  loadAcceptedContract,
  loadAcceptedContractWithSources,
} from "../contract/load.js";
import { renderContractReviewPage } from "../contract/review-page.js";
import { syncContractManifest } from "../contract/sync.js";
import { findTielineWorkspace } from "../tieline/workspace.js";
import { contractEmbeddingDocuments } from "../derived/embedding-documents.js";
import { getEmbedder, mapWithConcurrency } from "../embeddings.js";
import {
  MAPPING_CONFIDENCE_TIERS,
  computeRepositoryMappingCoverage,
  type RepositoryMappingCoverage,
} from "../contract/coverage.js";
import {
  analyzeLinkPlausibility,
  type LinkPlausibilityReport,
} from "../contract/link-plausibility.js";
import { parseNameStatus } from "../contract/impact.js";
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

interface ContractCommandIO {
  write(message: string): void;
}

export type ContractAction =
  | "validate"
  | "review"
  | "compile"
  | "coverage"
  | "link-review"
  | "reconcile"
  | "criteria"
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
  emitScope?: boolean;
  verify?: string;
  strict?: boolean;
  json?: boolean;
  paths?: string[];
}

interface ParsedContractCommand {
  action: ContractAction;
  repositoryRoot: string;
  repositoryKey: string;
  commit?: string;
  outputPath: string;
  manifestPath: string;
  specDirectory: string;
  sourceRoots: string[];
  ignore: string[];
  expectedPreviousCommit?: string;
  base?: string;
  emitScope: boolean;
  verify?: string;
  strict: boolean;
  json: boolean;
  paths: string[];
}

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
  const requestedRoot = resolve(options.repository ?? process.cwd());
  const workspace = findTielineWorkspace(requestedRoot);
  const repositoryRoot = workspace?.root ?? requestedRoot;
  const repositoryKey =
    options.repo ?? workspace?.config.product.repo_name ?? basename(repositoryRoot);
  const specDirectory =
    options.spec ??
    (workspace
      ? workspace.config.files.spec_directory.startsWith(".tieline/")
        ? workspace.config.files.spec_directory
        : `.tieline/${workspace.config.files.spec_directory}`
      : ".tieline/spec");
  const resolvedOutput = options.output
    ? isAbsolute(options.output)
      ? options.output
      : resolve(repositoryRoot, options.output)
    : resolve(
        repositoryRoot,
        // `review` writes one HTML page; everything else reads or writes the
        // manifest, which is a directory of per-capability files.
        action === "review" ? ".tieline/review.html" : ".tieline/manifest"
      );
  return {
    action,
    repositoryRoot,
    repositoryKey,
    commit: options.commit,
    outputPath: resolvedOutput,
    manifestPath: workspace?.manifestPath ?? resolvedOutput,
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
  };
}

function runGrade(
  parsed: ParsedContractCommand,
  io: ContractCommandIO
): number {
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
    manifest = readContractManifest(parsed.manifestPath);
  } catch (error) {
    throw new Error(
      `Cannot derive grading scope because the contract manifest at '${parsed.manifestPath}' is unreadable: ${
        error instanceof Error ? error.message : String(error)
      } Run \`tieline contract compile .\` and commit the manifest.`
    );
  }
  const scope = buildGradeScope({
    repositoryRoot: parsed.repositoryRoot,
    base: parsed.base,
    manifest,
    baseManifest: manifestAtBase(
      parsed.repositoryRoot,
      parsed.base,
      parsed.manifestPath
    ),
    changes: changesSince(parsed.repositoryRoot, parsed.base),
    sourceRoots: parsed.sourceRoots,
    ignore: parsed.ignore,
    specDirectory: parsed.specDirectory,
  });
  if (parsed.emitScope) {
    io.write(
      parsed.json
        ? `${JSON.stringify(scope, null, 2)}\n`
        : renderGradeScopeText(scope)
    );
    return 0;
  }

  const verdictsPath = isAbsolute(parsed.verify!)
    ? parsed.verify!
    : resolve(parsed.repositoryRoot, parsed.verify!);
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(verdictsPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read grade verdicts '${verdictsPath}': ${
        error instanceof Error ? error.message : String(error)
      }`
    );
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

function changesSince(repositoryRoot: string, base: string) {
  return parseNameStatus(
    execFileSync(
      "git",
      ["diff", "--name-status", "--find-renames", base],
      { cwd: repositoryRoot, encoding: "utf8" }
    )
  );
}

/**
 * The manifest as committed at `base`, or null when that ref carries none —
 * the initial contract, whose every link is then claim-side grading scope.
 *
 * Only a manifest inside the repository can have a version at a ref, so a
 * manifest configured elsewhere is refused: treating it as absent would grade
 * the whole contract as newly claimed, which is a fabricated scope.
 */
function manifestAtBase(
  repositoryRoot: string,
  base: string,
  manifestPath: string
): ContractManifest | null {
  const directory = relative(resolve(repositoryRoot), resolve(manifestPath))
    .split(sep)
    .join("/");
  if (
    directory === ".." ||
    directory.startsWith("../") ||
    isAbsolute(directory)
  ) {
    throw new Error(
      `Cannot derive claim-side grading scope: the manifest at '${manifestPath}' is outside the repository, so '${base}' cannot hold a version of it.`
    );
  }
  const names = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", base, "--", directory],
    { cwd: repositoryRoot, encoding: "utf8" }
  )
    .split("\n")
    .filter(Boolean);
  if (names.length === 0) return null;
  return parseContractManifestSnapshot(
    names.map((name) => ({
      name: name.slice(`${directory}/`.length),
      content: execFileSync("git", ["show", `${base}:${name}`], {
        cwd: repositoryRoot,
        encoding: "utf8",
      }),
    })),
    `ref '${base}'`
  );
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

function wrap(text: string, columns: number, indent: string): string {
  const lines: string[] = [];
  let line = "";
  for (const word of text.replace(/\s+/g, " ").trim().split(" ")) {
    if (!line) {
      line = word;
    } else if (`${line} ${word}`.length > columns) {
      lines.push(line);
      line = word;
    } else {
      line = `${line} ${word}`;
    }
  }
  if (line) lines.push(line);
  return lines.map((entry) => `${indent}${entry}\n`).join("");
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
  io: ContractCommandIO
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
  io: ContractCommandIO
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

export async function runContractCommand(
  action: ContractAction,
  options: ContractCommandOptions,
  io: ContractCommandIO
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
      warnings: result.warnings,
    };
    io.write(
      parsed.json
        ? `${JSON.stringify(response, null, 2)}\n`
        : `Contract valid: ${response.stories} Stories, ${response.acceptance_criteria} acceptance criteria, ${response.warnings.length} warning(s).\n`
    );
    return 0;
  }

  if (parsed.action === "review") {
    const result = loadAcceptedContractWithSources(
      parsed.repositoryRoot,
      parsed.specDirectory
    );
    const serialized = renderContractReviewPage({
      repositoryKey: parsed.repositoryKey,
      documents: result.documents.map((document, index) => ({
        path: result.sources[index]!.path,
        document,
      })),
      warnings: result.warnings,
    });
    mkdirSync(dirname(parsed.outputPath), { recursive: true });
    writeFileSync(parsed.outputPath, serialized);
    const response = {
      output: parsed.outputPath,
      bytes: Buffer.byteLength(serialized),
      capabilities: result.documents.length,
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
      warnings: result.warnings,
    };
    io.write(
      parsed.json
        ? `${JSON.stringify(response, null, 2)}\n`
        : `Wrote a browser review of ${response.stories} Stories and ${response.acceptance_criteria} acceptance criteria to ${parsed.outputPath}.\n`
    );
    return 0;
  }

  if (parsed.action === "grade") {
    return runGrade(parsed, io);
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
    const manifest = attachCurrentArtifactHashes(
      reviewedManifest,
      parsed.repositoryRoot
    );
    try {
      const result = await syncContractManifest(
        new PostgresContractSyncRepository(getSyncSql()),
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
      io.write(
        parsed.json
          ? `${JSON.stringify({
              ...result,
              embedding_documents: documents.length,
              re_embedded: indexing.embedded,
              semantic_index: indexing,
            }, null, 2)}\n`
          : `Contract ${result.outcome}: ${result.stories} Stories, ${result.acceptance_criteria} acceptance criteria, ${result.conflicts.length} handoff conflict(s), ${result.reconciled_code_assets} orphaned code asset(s) reconciled; ${indexing.documents} semantic document(s) indexed (${indexing.embedded} embedded, ${indexing.unchanged} unchanged, ${indexing.embedding_unavailable} embedding unavailable).\n`
      );
      return 0;
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
    if (parsed.json) {
      io.write(
        `${JSON.stringify(
          { repository: manifest.repository, ...report },
          null,
          2
        )}\n`
      );
    } else {
      renderLinkReview(report, io);
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
    const { manifest } = compileManifest("omit_hash");
    const report = analyzeContractReconciliation({
      repositoryRoot: parsed.repositoryRoot,
      manifest,
      changes: changesSince(parsed.repositoryRoot, parsed.base),
      sourceRoots: parsed.sourceRoots,
      ignore: parsed.ignore,
      specDirectory: parsed.specDirectory,
    });
    if (parsed.json) {
      io.write(`${JSON.stringify({ base: parsed.base, ...report }, null, 2)}\n`);
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

  // `manifest` was compiled from the working tree, so its reviewed hashes are
  // the hashes it just measured. The committed manifest is the only record of
  // what a reviewer actually accepted, so the `hash_current` tier is compared
  // against it when one is readable; without it, no drift is observable and the
  // tier reports the compile-time measurement instead.
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
    const response = {
      output: parsed.outputPath,
      files: written.files,
      // Files of capabilities the contract no longer declares. Reported because
      // deleting is the one thing compilation does that a maintainer cannot see
      // by reading the output.
      removed_files: written.removed,
      bytes: written.bytes,
      repository: manifest.repository,
      ...coverage(manifest),
      mapping_coverage: mappingCoverage,
    };
    io.write(
      parsed.json
        ? `${JSON.stringify(response, null, 2)}\n`
        : `Compiled ${response.acceptance_criteria} acceptance criteria to ${parsed.outputPath} (${response.files.length} files, ${response.bytes} bytes)${
            written.removed.length
              ? `; removed ${written.removed.length} file(s) for capabilities the contract no longer declares: ${written.removed.join(", ")}`
              : ""
          }.\n`
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
