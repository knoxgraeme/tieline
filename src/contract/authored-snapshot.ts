import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { canonicalRepositoryRelativePath } from "./paths.js";
import { compileContractManifest, type ContractManifest } from "./manifest.js";

/** Read authored baseline definitions even when post-merge publication is pending.
 * Only definitions/config are materialized; absent evidence hashes are intentional.
 * This projection is for claim comparison, never published as reviewed evidence.
 */
// Validation reads selector kinds from this path in the materialized root.
const CONFIG_PATH = ".tiepoint/config.json";

export function readAuthoredContractAtBase(input: {
  repositoryRoot: string;
  repositoryKey: string;
  specDirectory: string;
  base: string;
  /**
   * Committed workspace config to materialize. A revision from before the
   * tieline -> tiepoint rename keeps it under the earlier workspace directory.
   */
  configPath?: string;
}): ContractManifest | null {
  const spec = canonicalRepositoryRelativePath(input.specDirectory);
  if (!spec) throw new Error("Post-merge grading requires a repository-relative spec directory.");
  const configPath = canonicalRepositoryRelativePath(input.configPath ?? CONFIG_PATH);
  if (!configPath) throw new Error("Authored baseline requires a repository-relative config path.");
  const git = (args: string[]) => execFileSync("git", args, {
    cwd: input.repositoryRoot, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
  });
  const commit = git(["rev-parse", "--verify", "--end-of-options", `${input.base}^{commit}`]).trim();
  const names = git(["ls-tree", "-r", "-z", "--name-only", commit, "--", spec, configPath])
    .split("\0").filter((name) => name === configPath || /\.ya?ml$/i.test(name));
  if (!names.some((name) => /\.ya?ml$/i.test(name))) return null;
  if (names.length > 1001) throw new Error("Authored baseline exceeds 1,000 spec files.");
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "tiepoint-authored-base-"));
  try {
    let bytes = 0;
    for (const name of names) {
      if (!canonicalRepositoryRelativePath(name)) throw new Error("Invalid authored baseline path.");
      const content = git(["show", `${commit}:${name}`]);
      bytes += Buffer.byteLength(content);
      if (bytes > 16 * 1024 * 1024) throw new Error("Authored baseline exceeds 16 MiB.");
      const path = resolve(temporaryRoot, name === configPath ? CONFIG_PATH : name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    return compileContractManifest({
      repositoryRoot: temporaryRoot, repositoryKey: input.repositoryKey,
      specDirectory: spec, onUnhashableArtifact: "omit_hash",
    });
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
