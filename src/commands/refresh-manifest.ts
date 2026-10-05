import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { compileContractManifestWithSources, writeContractManifest } from "../contract/manifest.js";
import { findTielineWorkspace } from "../tieline/workspace.js";
import { runCheckCommand } from "./check.js";
import type { CommandIO } from "./shared.js";

interface RefreshOptions {
  repository?: string;
  branch: string;
  remote?: string;
  json?: boolean;
}

/** Publication is explicit and only touches a fetched integration branch in a
 * temporary worktree. Normal pushes provide compare-and-swap protection; a
 * concurrent merge causes a fresh compilation, never a force push or rebase.
 */
export async function runManifestRefresh(options: RefreshOptions, io: CommandIO): Promise<number> {
  const root = resolve(options.repository ?? process.cwd());
  const remote = options.remote ?? "origin";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(remote)) throw new Error("Expected a configured remote name.");
  if (options.branch.length > 255 || options.branch.startsWith("-")) throw new Error("Invalid integration branch.");
  const git = (cwd: string, args: string[]) => execFileSync("git", args, {
    cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  git(root, ["check-ref-format", `refs/heads/${options.branch}`]);
  git(root, ["remote", "get-url", remote]);
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "tieline-refresh-"));
  const checkout = resolve(temporaryRoot, "checkout");
  const privateRef = `refs/tieline-refresh/${randomUUID()}`;
  const emptyHooks = resolve(temporaryRoot, "empty-hooks");
  mkdirSync(emptyHooks);
  const treeGit = (cwd: string, args: string[]) => git(cwd, ["-c", `core.hooksPath=${emptyHooks}`, ...args]);
  const removeWorktree = () => {
    // add can register a worktree before returning a failure. Inspect the actual
    // registration rather than assuming a thrown command made no changes.
    if (git(root, ["worktree", "list", "--porcelain", "-z"]).split("\0").includes(`worktree ${checkout}`)) {
      git(root, ["worktree", "remove", "--force", checkout]);
    }
  };
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      git(root, ["fetch", "--no-tags", remote, `+refs/heads/${options.branch}:${privateRef}`]);
      const sourceCommit = git(root, ["rev-parse", privateRef]);
      // Checkout hooks cannot change the fetched source/config before compilation.
      git(root, ["-c", `core.hooksPath=${emptyHooks}`, "worktree", "add", "--detach", checkout, sourceCommit]);
      for (const path of [".tieline", ".tieline/config.json", ".tieline/spec", ".tieline/manifest"]) {
        if (existsSync(resolve(checkout, path)) && lstatSync(resolve(checkout, path)).isSymbolicLink()) {
          throw new Error(`Manifest publication refuses symlink '${path}'.`);
        }
      }
      const workspace = findTielineWorkspace(checkout);
      if (!workspace || workspace.root !== checkout || workspace.config.manifest_mode !== "post_merge") {
        throw new Error("The integration branch must opt into manifest_mode=post_merge at its repository root.");
      }
      if (workspace.manifestPath !== resolve(checkout, ".tieline/manifest") ||
          workspace.specDirectoryPath !== resolve(checkout, ".tieline/spec")) {
        throw new Error("Automatic publication requires the standard .tieline/spec and .tieline/manifest paths.");
      }
      if (existsSync(workspace.manifestPath)) {
        for (const entry of readdirSync(workspace.manifestPath, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) throw new Error("Manifest publication refuses symlinked output files.");
        }
      }
      const compiled = compileContractManifestWithSources({ repositoryRoot: checkout, repositoryKey: workspace.config.product.repo_name });
      const written = writeContractManifest(workspace.manifestPath, compiled);
      const expected = new Map(written.files.map((name) => [`.tieline/manifest/${name}`, readFileSync(resolve(workspace.manifestPath, name), "utf8")]));
      const allowedPaths = new Set([...expected.keys(), ...written.removed.map((name) => `.tieline/manifest/${name}`)]);
      let validation = "";
      const checked = await runCheckCommand({ repository: checkout, base: sourceCommit, json: true }, { write: (message) => { validation += message; } });
      if (checked !== 0) throw new Error(`Generated manifest validation failed: ${validation}`);
      treeGit(checkout, ["add", "--", ".tieline/manifest"]);
      const tree = treeGit(checkout, ["write-tree"]);
      const paths = treeGit(checkout, ["diff-tree", "-r", "--name-only", "-z", sourceCommit, tree]).split("\0").filter(Boolean);
      if (paths.some((path) => !allowedPaths.has(path))) throw new Error("Publication staged an unexpected path.");
      // Validate immutable blobs, not just the worktree: clean filters and hooks
      // must not substitute different bytes after compilation/validation.
      for (const [path, content] of expected) {
        const blob = execFileSync("git", ["show", `${tree}:${path}`], { cwd: checkout, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
        if (blob !== content) throw new Error(`Staged manifest '${path}' differs from validated compiler output.`);
      }
      if (paths.length === 0) {
        io.write(`${JSON.stringify({ status: "unchanged", source_commit: sourceCommit, attempts: attempt })}\n`);
        return 0;
      }
      // Commit the verified index tree directly. Commit hooks must not add files
      // or rewrite already-validated manifest bytes between checking and commit.
      const publishedCommit = treeGit(checkout, ["-c", "user.name=Tieline manifest publisher", "-c", "user.email=tieline-manifest@users.noreply.github.com", "commit-tree", tree, "-p", sourceCommit, "-m", `chore(tieline): refresh manifest for ${sourceCommit}`]);
      try {
        git(checkout, ["push", remote, `${publishedCommit}:refs/heads/${options.branch}`]);
        io.write(`${JSON.stringify({ status: "refreshed", source_commit: sourceCommit, published_commit: publishedCommit, attempts: attempt, files: paths.map((path) => relative(checkout, resolve(checkout, path))) })}\n`);
        return 0;
      } catch (error) {
        // Retry only if the remote actually advanced. Authentication and policy
        // failures remain terminal, with the underlying Git cause preserved.
        git(root, ["fetch", "--no-tags", remote, `+refs/heads/${options.branch}:${privateRef}`]);
        if (git(root, ["rev-parse", privateRef]) === sourceCommit || attempt === 3) {
          throw new Error(`Manifest publication failed after ${attempt} attempt(s).`, { cause: error });
        }
      }
      removeWorktree();
    }
    throw new Error("Manifest publication exhausted its three attempts.");
  } finally {
    // Each cleanup is attempted even if a prior cleanup fails.
    try {
      removeWorktree();
    } finally {
      try { git(root, ["update-ref", "-d", privateRef]); }
      finally { rmSync(temporaryRoot, { recursive: true, force: true }); }
    }
  }
}
