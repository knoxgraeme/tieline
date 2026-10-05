import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { canonicalRepositoryRelativePath } from "./paths.js";
import { compileContractManifest, type ContractManifest } from "./manifest.js";
import { screenSettingsForRepository } from "./screen-catalog.js";

/** Read authored baseline definitions even when post-merge publication is pending.
 * Only definitions/config are materialized, with the screen catalog when the
 * base enables screens, since its `shows` links name catalog screens; absent
 * evidence hashes are intentional.
 * This projection is for claim comparison, never published as reviewed evidence.
 */
export function readAuthoredContractAtBase(input: {
  repositoryRoot: string;
  repositoryKey: string;
  specDirectory: string;
  base: string;
}): ContractManifest | null {
  const spec = canonicalRepositoryRelativePath(input.specDirectory);
  if (!spec) throw new Error("Post-merge grading requires a repository-relative spec directory.");
  const git = (args: string[]) => execFileSync("git", args, {
    cwd: input.repositoryRoot, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
  });
  const commit = git(["rev-parse", "--verify", "--end-of-options", `${input.base}^{commit}`]).trim();
  const names = git(["ls-tree", "-r", "-z", "--name-only", commit, "--", spec, ".tieline/config.json"])
    .split("\0").filter((name) => name === ".tieline/config.json" || /\.ya?ml$/i.test(name));
  if (!names.some((name) => /\.ya?ml$/i.test(name))) return null;
  if (names.length > 1001) throw new Error("Authored baseline exceeds 1,000 spec files.");
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "tieline-authored-base-"));
  try {
    let bytes = 0;
    const materialize = (files: readonly string[]): void => {
      for (const name of files) {
        if (!canonicalRepositoryRelativePath(name)) throw new Error("Invalid authored baseline path.");
        const content = git(["show", `${commit}:${name}`]);
        bytes += Buffer.byteLength(content);
        if (bytes > 16 * 1024 * 1024) throw new Error("Authored baseline exceeds 16 MiB.");
        const path = resolve(temporaryRoot, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
      }
    };
    materialize(names);
    // The base's `shows` links name screens in its catalog, which the base's
    // configuration places; without it they would name unknown screens.
    const screens = screenSettingsForRepository(temporaryRoot, { specDirectory: spec });
    if (screens) {
      const catalog = git(["ls-tree", "-r", "-z", "--name-only", commit, "--", screens.catalogPath])
        .split("\0")
        .filter((name) => /\.ya?ml$/i.test(name));
      if (catalog.length > 1000) throw new Error("Authored baseline exceeds 1,000 screen catalog files.");
      materialize(catalog);
    }
    return compileContractManifest({
      repositoryRoot: temporaryRoot, repositoryKey: input.repositoryKey,
      specDirectory: spec, onUnhashableArtifact: "omit_hash",
    });
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
