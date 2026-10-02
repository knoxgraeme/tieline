import { execFileSync } from "node:child_process";

/** The commit a `--base` comparison actually uses, and the ref it came from. */
export interface ComparisonBase {
  /** The ref the caller named. */
  ref: string;
  /** Where HEAD's history left `ref`: their merge-base. */
  commit: string;
}

function gitFailure(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const detail =
    typeof stderr === "string"
      ? stderr
      : Buffer.isBuffer(stderr)
        ? stderr.toString("utf8")
        : error instanceof Error
          ? error.message
          : String(error);
  return detail.trim().split("\n")[0] ?? "";
}

/**
 * Resolves `--base <ref>` to the commit where the current branch left it.
 *
 * Comparing with the merge-base rather than the ref's tip keeps commits that
 * landed on the base after the branch point out of the branch's changes;
 * against the tip they read as if the branch had reverted them. In CI a pull
 * request is normally checked out merged into the base's tip, whose merge-base
 * with the base is that tip, so results there are the same as before.
 *
 * A ref that is not a commit, histories that share no commit, a shallow clone
 * that does not contain the branch point, and a criss-cross history with more
 * than one equally good branch point all fail loudly: guessing a comparison
 * point would report changes the branch never made, or hide ones it did.
 */
export function resolveComparisonBase(
  repositoryRoot: string,
  base: string
): ComparisonBase {
  const ref = base.trim();
  if (ref.length === 0 || ref.startsWith("-")) {
    throw new Error(`Base ref '${base}' is not a Git revision.`);
  }
  let output: string;
  try {
    output = execFileSync("git", ["merge-base", "--all", ref, "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const status = (error as { status?: unknown } | null)?.status;
    if (status === 1) {
      throw new Error(
        `Base ref '${ref}' shares no commit with HEAD, so there is no branch point to compare with. In a shallow clone, fetch the full history (for example actions/checkout with fetch-depth: 0).`
      );
    }
    throw new Error(`Cannot resolve base ref '${ref}': ${gitFailure(error)}`);
  }
  const candidates = output.split(/\s+/).filter(Boolean);
  if (candidates.length > 1) {
    throw new Error(
      `Base ref '${ref}' and HEAD have ${candidates.length} equally good branch points (${candidates
        .map((commit) => commit.slice(0, 12))
        .join(", ")}), as a criss-cross merge history does. Pass the commit to compare with as --base.`
    );
  }
  const commit = candidates[0] ?? "";
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) {
    throw new Error(`Base ref '${ref}' did not resolve to one merge-base commit.`);
  }
  return { ref, commit };
}
