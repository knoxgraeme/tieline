import { execFileSync } from "node:child_process";
import { basename, relative, resolve, sep } from "node:path";
import {
  compileContractManifest,
  readContractManifest,
  serializeContractManifest,
} from "../contract/manifest.js";
import {
  analyzeContractImpact,
  parseNameStatus,
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
  strict?: boolean;
}

export async function runCheckCommand(
  options: CheckCommandOptions,
  io: CheckIO
): Promise<number> {
  const base = options.base;
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
  const currentManifest = compileContractManifest({
    repositoryRoot: root,
    repositoryKey,
    commit: manifest.repository.commit,
    specDirectory,
  });
  const manifestCurrent =
    serializeContractManifest(manifest) ===
    serializeContractManifest(currentManifest);
  const impacts = analyzeContractImpact({
    repositoryRoot: root,
    manifest,
    changes,
    specDirectory,
  });
  const strict = Boolean(options.strict);
  const strictFailure = strict && !manifestCurrent;
  const result = {
    base,
    repository: repositoryKey,
    manifest_current: manifestCurrent,
    strict,
    strict_failure: strictFailure,
    changes,
    impacts,
    warnings: [
      ...(!manifestCurrent
        ? [
            "The committed manifest does not match current YAML or linked content; compile it before merge.",
          ]
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
    // Impacts are orientation, not defects: they answer "what does this change
    // touch?", which is the question an agent needs answered before it edits.
    // Labelling them `warn` trains readers to skip the whole stream, so `warn`
    // is reserved for findings that need an action.
    const definitionChanged = impacts.filter(
      (impact) => impact.reason === "contract_definition_changed"
    );
    const pathImpacts = impacts.filter(
      (impact) => impact.reason !== "contract_definition_changed"
    );
    const affectedCriteria = new Set(
      pathImpacts.map((impact) => impact.acceptance_criterion_stable_id)
    );
    io.write(
      `Contract impact vs ${base}: ${affectedCriteria.size} acceptance criteria affected across ${pathImpacts.length} linked path(s); manifest=${manifestCurrent ? "current" : "stale"}.\n`
    );
    for (const impact of pathImpacts) {
      // `current` freshness is provably redundant with the manifest gate: a
      // fresh compile recomputes every local reviewed hash, so a local link
      // cannot be stale while `manifest_current` holds. Only unmeasurable or
      // genuinely stale links carry information here.
      const freshness =
        impact.freshness === "current" || impact.freshness === "not_applicable"
          ? ""
          : ` (${impact.freshness})`;
      io.write(
        `  affects  ${impact.acceptance_criterion_stable_id} ${impact.reason} ${impact.path}${freshness}\n`
      );
    }
    if (definitionChanged.length > 0) {
      io.write(
        `  note     the contract definition changed under ${specDirectory}, which nominally affects all ${definitionChanged.length} acceptance criteria\n`
      );
    }
    // Per-link staleness is already marked inline above, and it can only occur
    // while the manifest itself is stale — one cause, one action, one warning.
    // The JSON `warnings` array stays complete for machine consumers.
    if (!manifestCurrent) {
      io.write(
        "  warn     The committed manifest does not match current YAML or linked content; compile it before merge.\n"
      );
    }
    if (strictFailure) {
      io.write(
        "  error    Strict mode: the committed manifest is stale. Run `tieline contract compile` and commit the manifest.\n"
      );
    }
  }
  // Semantic findings stay warn-only (CONTRACT-001-AC3). Only manifest currency
  // — a deterministic recompile comparison — gates `--strict`.
  return strictFailure ? 1 : 0;
}
