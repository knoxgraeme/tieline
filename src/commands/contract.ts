import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { PostgresContractSyncRepository } from "../adapters/postgres/contract-sync-repository.js";
import { PostgresContractReadRepository } from "../adapters/postgres/contract-read-repository.js";
import { PostgresSemanticRepository } from "../adapters/postgres/semantic-repository.js";
import {
  closeConnections,
  getSyncSql,
} from "../adapters/postgres/connections.js";
import {
  attachCurrentArtifactHashes,
  compileContractManifest,
  readContractManifest,
  serializeContractManifest,
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
  analyzeExecutionCorroboration,
  readCoverageReport,
  type ExecutionCorroborationReport,
} from "../contract/corroboration.js";
import {
  LINK_PLAUSIBILITY_DISCLAIMER,
  analyzeLinkPlausibility,
  type LinkPlausibilityReport,
} from "../contract/link-plausibility.js";

interface ContractCommandIO {
  write(message: string): void;
}

export type ContractAction =
  | "validate"
  | "review"
  | "compile"
  | "coverage"
  | "corroborate"
  | "link-review"
  | "sync";

export interface ContractCommandOptions {
  repository?: string;
  repo?: string;
  commit?: string;
  output?: string;
  spec?: string;
  expectedPreviousCommit?: string;
  /** Path to a coverage report produced by the test run. */
  coverage?: string;
  json?: boolean;
}

interface ParsedContractCommand {
  action: ContractAction;
  repositoryRoot: string;
  repositoryKey: string;
  commit?: string;
  outputPath: string;
  specDirectory: string;
  sourceRoots: string[];
  ignore: string[];
  expectedPreviousCommit?: string;
  coveragePath?: string;
  json: boolean;
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
        action === "review" ? ".tieline/review.html" : ".tieline/manifest.json"
      );
  return {
    action,
    repositoryRoot,
    repositoryKey,
    commit: options.commit,
    outputPath: resolvedOutput,
    specDirectory,
    sourceRoots: workspace?.config.repository.source_roots ?? ["src"],
    ignore: workspace?.config.repository.ignore ?? [],
    expectedPreviousCommit: options.expectedPreviousCommit,
    coveragePath: options.coverage
      ? isAbsolute(options.coverage)
        ? options.coverage
        : resolve(repositoryRoot, options.coverage)
      : undefined,
    json: options.json === true,
  };
}

/**
 * The committed manifest, when one is readable and belongs to this repository.
 * Its absence is ordinary — a repository may never have compiled one — so it is
 * never an error here.
 */
function readReviewedManifest(
  path: string,
  repositoryKey: string
): ContractManifest | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const reviewed = readContractManifest(path);
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
    execution_corroborated: confidence.execution_corroboration_available
      ? undefined
      : " (no execution corroboration was supplied)",
  };
  return MAPPING_CONFIDENCE_TIERS.map((tier) => {
    const percentage = confidence.percentages[tier];
    return `  ${tier.padEnd(23)} ${confidence.counts[tier]}${
      percentage === null ? "" : ` (${percentage}% of eligible files)`
    }${unavailable[tier] ?? ""}\n`;
  }).join("");
}

/**
 * Execution corroboration in prose. The falsifier/confirmer asymmetry is
 * restated here because the counts alone read like a pass rate, which they are
 * not: nothing in this output says an acceptance criterion holds.
 */
function renderCorroboration(
  report: ExecutionCorroborationReport,
  io: ContractCommandIO
): void {
  const { summary } = report;
  io.write(
    `Execution corroboration (${summary.coverage_format}): ${summary.reported_files} file(s) reported, ${summary.executed_files} executed, ${summary.dropped_paths_outside_repository} reported path(s) outside the repository.\n`
  );
  io.write(
    `${summary.acceptance_criteria_examined} acceptance criteria examined; ${summary.acceptance_criteria_with_test_evidence} had linked tests that ran; ${summary.acceptance_criteria_corroborated_by_execution} corroborated by execution.\n`
  );
  if (!summary.coverage_usable) {
    io.write(
      "  note  This run entered no repository file, so it falsifies nothing. Check that the report belongs to this repository.\n"
    );
  }
  if (!summary.candidate_links_evaluated) {
    io.write(
      "  note  No per-test-file coverage was supplied, so no candidate links were suggested.\n"
    );
  }
  for (const finding of report.findings) {
    io.write(
      `  ${finding.kind} ${finding.acceptance_criterion_stable_id} ${
        finding.path ?? "(no linked path)"
      } [${finding.relation}] ${finding.reason}\n`
    );
  }
  io.write(
    wrap(
      "Execution corroborates a link; it never verifies one. Code that ran is not code that satisfies the criterion, and a criterion whose linked tests did not run is reported as unexamined rather than as unsupported. Findings here never fail a build.",
      88,
      "  "
    )
  );
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
    io.write(
      `  distribution  min ${report.distribution.minimum}, median ${report.distribution.median}, max ${report.distribution.maximum} over ${report.distribution.sample_size} link(s); flagged below ${report.distribution.absolute_score_floor} within the weakest ${Math.round(report.distribution.review_percentile * 100)}%.\n`
    );
  }
  for (const candidate of report.review_candidates) {
    io.write(
      `\n  ${candidate.acceptance_criterion_stable_id}  ${candidate.relation} ${candidate.path}\n`
    );
    io.write(wrap(candidate.rationale, 88, "    "));
  }
  if (report.review_candidates.length) io.write("\n");
  for (const skip of report.skipped) {
    io.write(
      `  skipped ${skip.acceptance_criterion_stable_id} ${skip.path ?? "(no path)"} (${skip.reason})\n`
    );
  }
  for (const note of report.notes) io.write(wrap(`note  ${note}`, 88, "  "));
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

  if (parsed.action === "sync") {
    const reviewedManifest = readContractManifest(parsed.outputPath);
    if (reviewedManifest.repository.key !== parsed.repositoryKey) {
      throw new Error(
        `Reviewed manifest repository '${reviewedManifest.repository.key}' does not match requested repository '${parsed.repositoryKey}'.`
      );
    }
    const manifest = attachCurrentArtifactHashes(
      {
        ...reviewedManifest,
        repository: {
          ...reviewedManifest.repository,
          commit: parsed.commit ?? gitCommit(parsed.repositoryRoot),
        },
      },
      parsed.repositoryRoot
    );
    try {
      const result = await syncContractManifest(
        new PostgresContractSyncRepository(getSyncSql()),
        manifest,
        { expectedPreviousCommit: parsed.expectedPreviousCommit }
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
          : `Contract ${result.outcome}: ${result.stories} Stories, ${result.acceptance_criteria} acceptance criteria, ${result.conflicts.length} handoff conflict(s); ${indexing.documents} semantic document(s) indexed (${indexing.embedded} embedded, ${indexing.unchanged} unchanged, ${indexing.embedding_unavailable} embedding unavailable).\n`
      );
      return 0;
    } finally {
      await closeConnections();
    }
  }

  const manifest = compileContractManifest({
    repositoryRoot: parsed.repositoryRoot,
    repositoryKey: parsed.repositoryKey,
    commit: parsed.commit ?? gitCommit(parsed.repositoryRoot),
    specDirectory: parsed.specDirectory,
  });
  if (parsed.action === "corroborate") {
    if (!parsed.coveragePath) {
      throw new Error(
        "Execution corroboration needs a coverage report. Pass --coverage <path>."
      );
    }
    // A report that cannot be read is a usage failure, not a finding: an
    // unread report would silently read as "nothing ran anywhere".
    const executed = readCoverageReport({
      path: parsed.coveragePath,
      repositoryRoot: parsed.repositoryRoot,
    });
    const report = analyzeExecutionCorroboration({ manifest, coverage: executed });
    if (parsed.json) {
      io.write(
        `${JSON.stringify(
          {
            repository: manifest.repository,
            coverage_report: parsed.coveragePath,
            ...report,
          },
          null,
          2
        )}\n`
      );
    } else {
      renderCorroboration(report, io);
    }
    // Reporting only. Corroboration never fails a build.
    return 0;
  }

  if (parsed.action === "link-review") {
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

  const executionCorroboration = parsed.coveragePath
    ? analyzeExecutionCorroboration({
        manifest,
        coverage: readCoverageReport({
          path: parsed.coveragePath,
          repositoryRoot: parsed.repositoryRoot,
        }),
      })
    : undefined;
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
    ...(executionCorroboration ? { executionCorroboration } : {}),
    ...(reviewedManifest ? { reviewedManifest } : {}),
  });

  if (parsed.action === "compile") {
    mkdirSync(dirname(parsed.outputPath), { recursive: true });
    const serialized = serializeContractManifest(manifest);
    writeFileSync(parsed.outputPath, serialized);
    const response = {
      output: parsed.outputPath,
      bytes: Buffer.byteLength(serialized),
      repository: manifest.repository,
      ...coverage(manifest),
      mapping_coverage: mappingCoverage,
    };
    io.write(
      parsed.json
        ? `${JSON.stringify(response, null, 2)}\n`
        : `Compiled ${response.acceptance_criteria} acceptance criteria to ${parsed.outputPath} (${response.bytes} bytes).\n`
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
