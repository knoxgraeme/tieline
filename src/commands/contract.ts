import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { parseNameStatus } from "../contract/impact.js";
import {
  buildGradeScope,
  parseGradeVerdicts,
  renderGradeReportText,
  renderGradeScopeText,
  verifyGradeVerdicts,
} from "../contract/grade.js";
import {
  lookupGoverningCriteria,
  renderGoverningCriteriaText,
} from "../contract/governs.js";
import { renderContractReviewPage } from "../contract/review-page.js";
import { syncContractManifest } from "../contract/sync.js";
import { findTielineWorkspace } from "../tieline/workspace.js";
import { contractEmbeddingDocuments } from "../derived/embedding-documents.js";
import { getEmbedder, mapWithConcurrency } from "../embeddings.js";
import { computeRepositoryMappingCoverage } from "../contract/coverage.js";

interface ContractCommandIO {
  write(message: string): void;
}

export type ContractAction =
  | "validate"
  | "review"
  | "compile"
  | "coverage"
  | "governs"
  | "grade"
  | "sync";

export interface ContractCommandOptions {
  repository?: string;
  repo?: string;
  commit?: string;
  output?: string;
  spec?: string;
  expectedPreviousCommit?: string;
  json?: boolean;
  base?: string;
  emitScope?: boolean;
  verify?: string;
  strict?: boolean;
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
  json: boolean;
  base?: string;
  emitScope: boolean;
  verify?: string;
  strict: boolean;
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
        action === "review" ? ".tieline/review.html" : ".tieline/manifest.json"
      );
  return {
    action,
    repositoryRoot,
    repositoryKey,
    commit: options.commit,
    outputPath: resolvedOutput,
    manifestPath:
      workspace?.manifestPath ?? resolve(repositoryRoot, ".tieline/manifest.json"),
    specDirectory,
    sourceRoots: workspace?.config.repository.source_roots ?? ["src"],
    ignore: workspace?.config.repository.ignore ?? [],
    expectedPreviousCommit: options.expectedPreviousCommit,
    json: options.json === true,
    base: options.base,
    emitScope: options.emitScope === true,
    verify: options.verify,
    strict: options.strict === true,
    paths: options.paths ?? [],
  };
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

/**
 * `--emit-scope` and `--verify` are two modes of one action, and everything
 * semantic happens between them inside `skills/tieline-grade`. Both modes are
 * pure functions of (manifest + working tree + git diff), so grading stays on
 * the offline plane and Tieline never calls a model.
 */
function runGrade(
  parsed: ParsedContractCommand,
  io: ContractCommandIO
): number {
  if (parsed.emitScope && parsed.verify !== undefined) {
    throw new Error(
      "`--emit-scope` and `--verify` are mutually exclusive modes of `contract grade`; pass exactly one."
    );
  }
  if (!parsed.emitScope && parsed.verify === undefined) {
    throw new Error(
      "`contract grade` requires either --emit-scope or --verify <verdicts.json>."
    );
  }
  if (!parsed.base) {
    throw new Error(
      "`contract grade` requires --base <ref> so the scope is limited to the links this change touches."
    );
  }
  const manifest = readContractManifest(parsed.manifestPath);
  const nameStatus = execFileSync(
    "git",
    ["diff", "--name-status", "--find-renames", parsed.base],
    { cwd: parsed.repositoryRoot, encoding: "utf8" }
  );
  const scope = buildGradeScope({
    repositoryRoot: parsed.repositoryRoot,
    base: parsed.base,
    manifest,
    changes: parseNameStatus(nameStatus),
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
  let submitted: unknown;
  try {
    submitted = JSON.parse(readFileSync(verdictsPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read grade verdicts '${verdictsPath}': ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  const report = verifyGradeVerdicts({
    scope,
    verdicts: parseGradeVerdicts(submitted),
    strict: parsed.strict,
  });
  io.write(
    parsed.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderGradeReportText(report)
  );
  // Advisory by default: only `--strict` converts a remaining `unsupported`
  // grade into a non-zero exit.
  return report.strict_failure ? 1 : 0;
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

  if (parsed.action === "governs") {
    if (parsed.paths.length === 0) {
      throw new Error(
        "`contract governs` requires at least one repository-relative path."
      );
    }
    // Answers come from the reviewed manifest rather than a fresh compile, so
    // the reported commit names exactly the state that produced the answer.
    let manifest: ContractManifest;
    try {
      manifest = readContractManifest(parsed.manifestPath);
    } catch (error) {
      throw new Error(
        `Cannot report governing acceptance criteria because ${parsed.manifestPath} is unreadable: ${
          error instanceof Error ? error.message : String(error)
        } Run \`tieline contract compile\` and commit the manifest.`
      );
    }
    const report = lookupGoverningCriteria({
      manifest,
      repositoryRoot: parsed.repositoryRoot,
      paths: parsed.paths,
    });
    io.write(
      parsed.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : renderGoverningCriteriaText(report)
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
          : `Contract ${result.outcome}: ${result.stories} Stories, ${result.acceptance_criteria} acceptance criteria, ${result.conflicts.length} handoff conflict(s), ${result.reconciled_code_assets} orphaned code asset(s) reconciled; ${indexing.documents} semantic document(s) indexed (${indexing.embedded} embedded, ${indexing.unchanged} unchanged, ${indexing.embedding_unavailable} embedding unavailable).\n`
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
  const mappingCoverage = computeRepositoryMappingCoverage(manifest, {
    repositoryRoot: parsed.repositoryRoot,
    sourceRoots: parsed.sourceRoots,
    ignore: parsed.ignore,
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
        : `${response.criteria_with_direct_links}/${response.acceptance_criteria} acceptance criteria have direct evidence links; ${repositoryCoverage}.\n${response.mapping_coverage.unmapped_files.length ? `Unmapped: ${response.mapping_coverage.unmapped_files.join(", ")}\n` : ""}`
    );
    return 0;
  }

  throw new Error(`Unsupported contract action: ${parsed.action}`);
}
