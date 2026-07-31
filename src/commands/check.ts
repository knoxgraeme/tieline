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

function option(args: string[], name: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function repositoryPath(args: string[]): string {
  const valueOptions = new Set(["base", "repo"]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) {
      if (index > 0 && valueOptions.has(args[index - 1]!.slice(2))) {
        continue;
      }
      return arg;
    }
    if (!arg.includes("=") && valueOptions.has(arg.slice(2))) index++;
  }
  return process.cwd();
}

export async function runCheckCommand(
  args: string[],
  io: CheckIO
): Promise<number> {
  const base = option(args, "base");
  if (!base) {
    throw new Error(
      "Usage: tieline check --base <ref> [repository] [--json]"
    );
  }
  const requestedRoot = resolve(repositoryPath(args));
  const workspace = findTielineWorkspace(requestedRoot);
  const root = workspace?.root ?? requestedRoot;
  const repositoryKey =
    option(args, "repo") ??
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
  const result = {
    base,
    repository: repositoryKey,
    manifest_current: manifestCurrent,
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
  if (args.includes("--json")) {
    io.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    io.write(
      `Semantic impact: ${impacts.length} AC finding(s); manifest=${manifestCurrent ? "current" : "stale"}.\n`
    );
    for (const impact of impacts) {
      io.write(
        `  warn  ${impact.acceptance_criterion_stable_id} ${impact.reason} ${impact.path} (${impact.freshness})\n`
      );
    }
    for (const warning of result.warnings) {
      io.write(`  warn  ${warning}\n`);
    }
  }
  // Semantic findings are deliberately warn-only in the MVP.
  return 0;
}
