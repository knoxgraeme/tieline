import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runCodeTopologyArtifactCommand } from "../src/commands/code-topology-artifact.js";
import {
  runBlastRadiusCommand,
  runDependencyTraceCommand,
} from "../src/commands/code-topology.js";
import { runContractCommand } from "../src/commands/contract.js";
import {
  readCodeTopologyArtifact,
} from "../src/contract/code-topology-artifact.js";
import { selectWorkspaceManifestRole } from "../src/contract/intent-aware-role-snapshot.js";
import { readWorkspaceCodeTopologyFiles } from "../src/contract/topology-role-snapshot.js";
import { findTielineWorkspace } from "../src/tieline/workspace.js";
import type { TielineCliIO } from "../src/cli.js";

export type GeneratedArtifactName = "manifest" | "topology";

export interface GeneratedArtifactMismatch {
  artifact: GeneratedArtifactName;
  /** Compiler files absent from the reviewed checkout. */
  missing_files: string[];
  /** Reviewed files the compiler did not produce. */
  unexpected_files: string[];
  /** Files present in both places whose canonical bytes differ. */
  changed_files: string[];
}

export type GeneratedArtifactGateResult =
  | {
      status: "current";
      artifacts: GeneratedArtifactName[];
      trace_status: "complete";
      blast_radius_status: "complete";
      checkout_unchanged: true;
    }
  | {
      status: "generated_artifact_mismatch";
      artifacts: GeneratedArtifactMismatch[];
      remediation: string;
      checkout_unchanged: true;
    }
  | {
      status: "reviewed_checkout_changed";
      changed_files: string[];
      detail: string;
    };

interface FileSnapshot {
  type: "file" | "symlink" | "missing";
  digest: string;
  mode: number;
}

function repositoryPath(path: string): string {
  return path.split(sep).join("/");
}

function gitVisiblePaths(repositoryRoot: string): string[] {
  const output = execFileSync(
    "git",
    [
      "-C",
      repositoryRoot,
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }
  );
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
}

function snapshotGitVisibleFiles(repositoryRoot: string): Map<string, FileSnapshot> {
  const snapshot = new Map<string, FileSnapshot>();
  for (const path of gitVisiblePaths(repositoryRoot)) {
    const absolute = resolve(repositoryRoot, path);
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      snapshot.set(path, { type: "missing", digest: "", mode: 0 });
      continue;
    }
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(absolute);
      snapshot.set(path, {
        type: "symlink",
        digest: createHash("sha256").update(target).digest("hex"),
        mode: stat.mode,
      });
      continue;
    }
    if (!stat.isFile()) continue;
    snapshot.set(path, {
      type: "file",
      digest: createHash("sha256").update(readFileSync(absolute)).digest("hex"),
      mode: stat.mode,
    });
  }
  return snapshot;
}

function changedSnapshotPaths(
  before: ReadonlyMap<string, FileSnapshot>,
  after: ReadonlyMap<string, FileSnapshot>
): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => {
      const left = before.get(path);
      const right = after.get(path);
      return left?.type !== right?.type ||
        left?.digest !== right?.digest ||
        left?.mode !== right?.mode;
    })
    .sort();
}

function copyGitVisibleCheckout(repositoryRoot: string, targetRoot: string): void {
  for (const path of gitVisiblePaths(repositoryRoot)) {
    const source = resolve(repositoryRoot, path);
    let stat;
    try {
      stat = lstatSync(source);
    } catch {
      continue;
    }
    const target = resolve(targetRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    if (stat.isSymbolicLink()) {
      symlinkSync(readlinkSync(source), target);
    } else if (stat.isFile()) {
      copyFileSync(source, target);
    }
  }
}

function directoryFiles(root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  if (!existsSync(root)) return files;
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory()) {
    files.set(
      ".",
      rootStat.isSymbolicLink()
        ? Buffer.from(`\0symlink\0${readlinkSync(root)}`)
        : rootStat.isFile()
          ? readFileSync(root)
          : Buffer.from("\0non-regular\0")
    );
    return files;
  }
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name)
    )) {
      const absolute = resolve(directory, entry.name);
      const name = repositoryPath(relative(root, absolute));
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        files.set(name, readFileSync(absolute));
      } else if (entry.isSymbolicLink()) {
        files.set(name, Buffer.from(`\0symlink\0${readlinkSync(absolute)}`));
      } else {
        files.set(name, Buffer.from("\0non-regular\0"));
      }
    }
  };
  visit(root);
  return files;
}

export function compareGeneratedArtifact(
  artifact: GeneratedArtifactName,
  reviewedRoot: string,
  generatedRoot: string
): GeneratedArtifactMismatch | null {
  const reviewed = directoryFiles(reviewedRoot);
  const generated = directoryFiles(generatedRoot);
  const reviewedNames = new Set(reviewed.keys());
  const generatedNames = new Set(generated.keys());
  const mismatch: GeneratedArtifactMismatch = {
    artifact,
    missing_files: [...generatedNames]
      .filter((name) => !reviewedNames.has(name))
      .sort(),
    unexpected_files: [...reviewedNames]
      .filter((name) => !generatedNames.has(name))
      .sort(),
    changed_files: [...generatedNames]
      .filter(
        (name) =>
          reviewed.has(name) && !generated.get(name)!.equals(reviewed.get(name)!)
      )
      .sort(),
  };
  return mismatch.missing_files.length > 0 ||
    mismatch.unexpected_files.length > 0 ||
    mismatch.changed_files.length > 0
    ? mismatch
    : null;
}

function commandIo(output: string[] = []): TielineCliIO {
  return {
    write(message) {
      output.push(message);
    },
    error(message) {
      throw new Error(message);
    },
    async question() {
      throw new Error("The generated artifact gate must not prompt.");
    },
  };
}

async function compileAndValidate(repositoryRoot: string): Promise<void> {
  const output: string[] = [];
  const io = commandIo(output);
  const lastResult = (): string => output.at(-1)?.trim() ?? "no structured result";
  if (
    (await runContractCommand(
      "compile",
      { repository: repositoryRoot, json: true },
      io
    )) !== 0
  ) {
    throw new Error(`Temporary manifest compilation did not complete: ${lastResult()}`);
  }
  if (
    (await runContractCommand(
      "validate",
      { repository: repositoryRoot, json: true },
      io
    )) !== 0
  ) {
    throw new Error(`Temporary contract validation did not complete: ${lastResult()}`);
  }
  const workspace = findTielineWorkspace(repositoryRoot);
  if (!workspace) throw new Error("The temporary root is not a Tieline workspace.");
  const manifest = selectWorkspaceManifestRole(
    workspace,
    workspace.config.product.repo_name
  );
  if (manifest.status !== "current") {
    throw new Error(
      `Temporary manifest validation returned '${manifest.status}': ${manifest.detail}`
    );
  }
  if (
    (await runCodeTopologyArtifactCommand(
      "compile",
      { repository: repositoryRoot, json: true },
      io
    )) !== 0
  ) {
    throw new Error(`Temporary topology compilation did not complete: ${lastResult()}`);
  }
  if (
    (await runCodeTopologyArtifactCommand(
      "validate",
      { repository: repositoryRoot, json: true },
      io
    )) !== 0
  ) {
    throw new Error(`Temporary topology validation did not complete: ${lastResult()}`);
  }
}

async function artifactFirstSmoke(repositoryRoot: string): Promise<void> {
  const workspace = findTielineWorkspace(repositoryRoot);
  if (!workspace) throw new Error("The temporary root is not a Tieline workspace.");
  const files = readWorkspaceCodeTopologyFiles(repositoryRoot);
  if (files.status !== "complete") {
    throw new Error(`Temporary topology read returned '${files.status}': ${files.detail}`);
  }
  const parsed = readCodeTopologyArtifact(files.files);
  if (parsed.status !== "complete") {
    throw new Error(`Temporary topology parse returned '${parsed.status}': ${parsed.detail}`);
  }
  const symbol = parsed.read_model.symbols[0];
  const file = parsed.read_model.files[0];
  if (!symbol && !file) {
    throw new Error("Temporary topology has no locator for artifact-first smoke checks.");
  }
  const locator = symbol
    ? {
        path: symbol.file_path,
        kind: symbol.asset_kind,
        selector: symbol.canonical_selector,
      }
    : { path: file!.path, kind: file!.kind };
  const io = commandIo();
  if (
    (await runDependencyTraceCommand(
      {
        repositoryRoot,
        repository: workspace.config.product.repo_name,
        locator,
        direction: "dependencies",
        role: "current",
        json: true,
      },
      io
    )) !== 0
  ) {
    throw new Error("Temporary artifact-first trace did not complete.");
  }
  if (
    (await runBlastRadiusCommand(
      {
        repositoryRoot,
        repository: workspace.config.product.repo_name,
        changes: [{ ...locator, status: "modified" }],
        direction: "dependents",
        json: true,
      },
      io
    )) !== 0
  ) {
    throw new Error("Temporary artifact-first blast radius did not complete.");
  }
}

/**
 * Rebuilds only inside a unique temporary repository root. There is
 * intentionally no output-path option: compilers always write their normal
 * `.tieline/manifest` and `.tieline/topology` authorities in that root.
 */
export async function runGeneratedArtifactGate(
  repositoryRoot = process.cwd()
): Promise<GeneratedArtifactGateResult> {
  const reviewedRoot = realpathSync(resolve(repositoryRoot));
  const before = snapshotGitVisibleFiles(reviewedRoot);
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "tieline-derivation-gate-"));
  try {
    copyGitVisibleCheckout(reviewedRoot, temporaryRoot);
    // A clean authority root prevents reviewed immutable shards from influencing
    // or blocking compilation. The reviewed bytes remain only in reviewedRoot
    // for the subsequent complete-set comparison.
    rmSync(resolve(temporaryRoot, ".tieline/manifest"), {
      recursive: true,
      force: true,
    });
    rmSync(resolve(temporaryRoot, ".tieline/topology"), {
      recursive: true,
      force: true,
    });
    await compileAndValidate(temporaryRoot);
    const mismatches = (
      [
        ["manifest", ".tieline/manifest"],
        ["topology", ".tieline/topology"],
      ] as const
    ).flatMap(([artifact, path]) => {
      const mismatch = compareGeneratedArtifact(
        artifact,
        resolve(reviewedRoot, path),
        resolve(temporaryRoot, path)
      );
      return mismatch ? [mismatch] : [];
    });
    const changedFiles = changedSnapshotPaths(
      before,
      snapshotGitVisibleFiles(reviewedRoot)
    );
    if (changedFiles.length > 0) {
      return {
        status: "reviewed_checkout_changed",
        changed_files: changedFiles,
        detail:
          "The derivation gate changed Git-visible bytes in the reviewed checkout.",
      };
    }
    if (mismatches.length > 0) {
      return {
        status: "generated_artifact_mismatch",
        artifacts: mismatches,
        remediation:
          "Run `tieline contract compile .` and `tieline code compile .`, then commit the complete generated artifacts.",
        checkout_unchanged: true,
      };
    }
    await artifactFirstSmoke(temporaryRoot);
    const smokeChangedFiles = changedSnapshotPaths(
      before,
      snapshotGitVisibleFiles(reviewedRoot)
    );
    if (smokeChangedFiles.length > 0) {
      return {
        status: "reviewed_checkout_changed",
        changed_files: smokeChangedFiles,
        detail:
          "The derivation gate changed Git-visible bytes in the reviewed checkout.",
      };
    }
    return {
      status: "current",
      artifacts: ["manifest", "topology"],
      trace_status: "complete",
      blast_radius_status: "complete",
      checkout_unchanged: true,
    };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if (process.argv.length > 2) {
    throw new Error(
      "The generated artifact gate accepts no paths; it always checks the current reviewed checkout."
    );
  }
  const result = await runGeneratedArtifactGate();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== "current") process.exitCode = 1;
}

if (
  process.argv[1] &&
  realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)
) {
  void main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify(
        {
          status: "generated_artifact_gate_failed",
          detail: error instanceof Error ? error.message : String(error),
        },
        null,
        2
      )}\n`
    );
    process.exitCode = 1;
  });
}
