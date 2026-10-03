import { execFileSync, spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseContractManifestSnapshot, type ContractManifest } from "./manifest.js";
import { diffReviewManifests, type ReviewChangeStatus } from "./review-changes.js";

/**
 * When each Story, acceptance criterion, and screen changed, and in which
 * pull request, read from git alone. A commit changed an item when the
 * compiled manifest it commits differs from its first parent's for that item:
 * its content, its `shows` links, its place, or, for a screen, its screenshot
 * digest or ARIA snapshot — the same comparison the review page makes against
 * a base. History follows the first-parent line, so on `main` each merged pull
 * request is one commit, and the pull request is read from that commit's
 * subject.
 */

export const CONTRACT_HISTORY_LIMITS = {
  /** Commits that changed the manifest read by default. */
  commits: 200,
  /** Most commits a caller may ask for. */
  maxCommits: 2_000,
  /** Largest `git log` or `git ls-tree` output read. */
  listingBytes: 16 * 1024 * 1024,
  /** Most manifest bytes read from git in one history. */
  blobBytes: 256 * 1024 * 1024,
} as const;

export interface HistoryCommit {
  commit: string;
  /** Committer date, ISO 8601. */
  date: string;
  subject: string;
  pull_request: number | null;
}

export type HistoryItemKind = "story" | "acceptance_criterion" | "screen";

export interface ContractHistoryChange {
  kind: HistoryItemKind;
  stable_id: string;
  /** The Story or screen title, or the criterion text, as of the change. */
  title: string;
  status: ReviewChangeStatus;
  /** Why it counts as changed; empty unless `status` is `changed`. */
  aspects: string[];
  commit: HistoryCommit;
}

export interface ContractHistory {
  ref: string;
  /** Commits that changed the manifest, newest first, with their changes counted. */
  commits: Array<HistoryCommit & { changes: number }>;
  /** Every change, newest first. */
  changes: ContractHistoryChange[];
  /** True when older commits were not read, so the oldest change may not be the first. */
  truncated: boolean;
  /** Commits whose manifest could not be read, so their changes are unknown. */
  unreadable: Array<{ commit: string; detail: string }>;
}

/**
 * The pull request a first-parent commit merged, from its subject: GitHub's
 * squash merge (`Title (#123)`) or merge commit (`Merge pull request #123`).
 */
export function pullRequestNumber(subject: string): number | null {
  const match = /\(#([1-9][0-9]{0,9})\)\s*$/.exec(subject) ?? /^Merge pull request #([1-9][0-9]{0,9})\b/.exec(subject);
  return match ? Number(match[1]) : null;
}

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: CONTRACT_HISTORY_LIMITS.listingBytes,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Reads many blobs in one `git cat-file --batch`, within the byte bound. A
 * partial clone does not hold every blob, and fetching each one on demand
 * would make reading history reach the network, so missing blobs are left
 * out instead.
 */
function readBlobs(root: string, ids: readonly string[]): Map<string, string> {
  const blobs = new Map<string, string>();
  if (ids.length === 0) return blobs;
  const result = spawnSync("git", ["cat-file", "--batch"], {
    cwd: root,
    input: `${ids.join("\n")}\n`,
    maxBuffer: CONTRACT_HISTORY_LIMITS.blobBytes,
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git cat-file failed: ${result.stderr.toString("utf8").trim()}`);
  const output = result.stdout;
  let offset = 0;
  for (const id of ids) {
    const newline = output.indexOf(0x0a, offset);
    const header = output.subarray(offset, newline).toString("utf8").split(" ");
    if (header[1] === "missing") {
      offset = newline + 1;
      continue;
    }
    if (header[1] !== "blob") throw new Error(`git object ${id} is not a blob`);
    const size = Number(header[2]);
    const start = newline + 1;
    blobs.set(id, output.subarray(start, start + size).toString("utf8"));
    offset = start + size + 1;
  }
  return blobs;
}

const MISSING_OBJECTS =
  "this clone does not hold the manifest at this commit (a partial clone); fetch the full history to read it";

/**
 * The history of the manifest at `manifestDirectory` (repository-relative),
 * along the first-parent line of `ref`, newest first: at most `limit` commits
 * that changed it. Throws when git cannot list the history at all.
 */
export function readContractHistory(
  root: string,
  manifestDirectory: string,
  options: { ref?: string; limit?: number } = {}
): ContractHistory {
  const ref = options.ref ?? "HEAD";
  const limit = options.limit ?? CONTRACT_HISTORY_LIMITS.commits;
  if (!Number.isInteger(limit) || limit < 1 || limit > CONTRACT_HISTORY_LIMITS.maxCommits) {
    throw new Error(`The history limit must be a whole number from 1 to ${CONTRACT_HISTORY_LIMITS.maxCommits}.`);
  }
  if (ref.startsWith("-")) throw new Error(`'${ref}' is not a git ref.`);
  // One more than asked: the oldest commit read is only the base of the one after it.
  const log = git(root, [
    "log",
    "--first-parent",
    "--no-color",
    `--max-count=${limit + 1}`,
    "--format=%H%x1f%cI%x1f%s",
    ref,
    "--",
    manifestDirectory,
  ]);
  const listed: HistoryCommit[] = log
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [commit, date, subject = ""] = line.split("\x1f");
      return { commit: commit!, date: date!, subject, pull_request: pullRequestNumber(subject) };
    });
  // A shallow clone's oldest commit is not where the manifest began, so its
  // history is cut short however few commits it lists.
  const shallow = git(root, ["rev-parse", "--is-shallow-repository"]).trim() === "true";
  const truncated = listed.length > limit || shallow;
  const trees = listed.map(({ commit }) =>
    git(root, ["ls-tree", "-r", commit, "--", manifestDirectory])
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [meta, path] = line.split("\t");
        return { blob: meta!.split(" ")[2]!, name: path!.slice(manifestDirectory.length + 1) };
      })
  );
  const blobs = readBlobs(root, [...new Set(trees.flat().map((entry) => entry.blob))]);
  const unreadable: ContractHistory["unreadable"] = [];
  const manifests: Array<ContractManifest | null> = trees.map((files, index) => {
    if (files.length === 0) return null;
    if (files.some((file) => !blobs.has(file.blob))) {
      unreadable.push({ commit: listed[index]!.commit, detail: MISSING_OBJECTS });
      return null;
    }
    try {
      return parseContractManifestSnapshot(
        files.map((file) => ({ name: file.name, content: blobs.get(file.blob) ?? "" })),
        `commit ${listed[index]!.commit.slice(0, 12)}`
      );
    } catch (error) {
      unreadable.push({ commit: listed[index]!.commit, detail: error instanceof Error ? error.message : String(error) });
      return null;
    }
  });

  const commits: ContractHistory["commits"] = [];
  const changes: ContractHistoryChange[] = [];
  // Past the limit, or in a shallow clone, the oldest commit listed is only a
  // base: what it changed is unknown.
  const read = listed.length > limit || shallow ? Math.min(limit, listed.length - 1) : listed.length;
  for (let index = 0; index < read; index += 1) {
    const after = manifests[index];
    const commit = listed[index]!;
    // A manifest that could not be read says nothing, nor does a base that
    // could not; the very first manifest has no base, so all of it is added.
    if (!after || (index + 1 < listed.length && manifests[index + 1] === null && trees[index + 1]!.length > 0)) {
      continue;
    }
    const diff = diffReviewManifests(index + 1 < listed.length ? manifests[index + 1]! : null, after, commit.commit);
    const found: ContractHistoryChange[] = [
      ...diff.records.map((record) => ({
        kind: record.kind,
        stable_id: record.stable_id,
        title: record.title,
        status: record.status,
        aspects: [...record.aspects],
        commit,
      })),
      ...diff.screens.map((screen) => ({
        kind: "screen" as const,
        stable_id: screen.stable_id,
        title: screen.title,
        status: screen.status,
        aspects: [...screen.aspects],
        commit,
      })),
    ];
    if (found.length === 0) continue;
    commits.push({ ...commit, changes: found.length });
    changes.push(...found);
  }
  return { ref, commits, changes, truncated, unreadable };
}

/** Each item's most recent change and how many changes the history holds. */
export function lastChanges(history: ContractHistory): Map<string, { last: ContractHistoryChange; changes: number }> {
  const summary = new Map<string, { last: ContractHistoryChange; changes: number }>();
  for (const change of history.changes) {
    const key = `${change.kind}:${change.stable_id}`;
    const existing = summary.get(key);
    if (existing) existing.changes += 1;
    else summary.set(key, { last: change, changes: 1 });
  }
  return summary;
}

/**
 * The repository's GitHub web address, from the `origin` remote, so pull
 * requests and commits can be linked; null for any other host or remote.
 */
export function githubRepositoryUrl(root: string): string | null {
  let remote: string;
  try {
    remote = git(root, ["remote", "get-url", "origin"]).trim();
  } catch {
    return null;
  }
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(remote) ??
    /^(?:ssh:\/\/)?git@github\.com[:/]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(remote);
  return match ? `https://github.com/${match[1]}/${match[2]}` : null;
}

/** What the review page shows for an item's history. */
export interface ItemHistory {
  /** `#71` for a pull request, or the short commit. */
  label: string;
  /** The pull request or commit on GitHub, or null. */
  url: string | null;
  date: string;
  changes: number;
}

/**
 * Each item's most recent change, as the review page shows it, keyed
 * `<kind>:<stable id>` (`story`, `acceptance_criterion`, or `screen`).
 */
export function itemHistories(history: ContractHistory, repositoryUrl: string | null): Map<string, ItemHistory> {
  const items = new Map<string, ItemHistory>();
  for (const [key, { last, changes }] of lastChanges(history)) {
    const { commit, pull_request: pullRequest, date } = last.commit;
    items.set(key, {
      label: pullRequest !== null ? `#${pullRequest}` : commit.slice(0, 7),
      url: repositoryUrl ? (pullRequest !== null ? `${repositoryUrl}/pull/${pullRequest}` : `${repositoryUrl}/commit/${commit}`) : null,
      date: date.slice(0, 10),
      changes,
    });
  }
  return items;
}

/**
 * The history a review page shows, or why there is none: not a git
 * repository, a manifest outside the repository, or history git cannot list.
 * A page without history is still a complete page.
 */
export function readReviewHistory(
  root: string,
  manifestPath: string,
  options: { limit?: number } = {}
):
  | { status: "read"; items: Map<string, ItemHistory>; truncated: boolean; unreadable: number; changes: number }
  | { status: "unavailable"; detail: string } {
  const directory = relative(resolve(root), resolve(manifestPath)).split(sep).join("/");
  if (!directory || directory === ".." || directory.startsWith("../") || isAbsolute(directory)) {
    return { status: "unavailable", detail: "the manifest is outside the repository" };
  }
  try {
    const history = readContractHistory(root, directory, options);
    return {
      status: "read",
      items: itemHistories(history, githubRepositoryUrl(root)),
      truncated: history.truncated,
      unreadable: history.unreadable.length,
      changes: history.changes.length,
    };
  } catch (error) {
    const stderr = (error as { stderr?: unknown } | null)?.stderr;
    const detail = typeof stderr === "string" && stderr.trim() ? stderr.trim().split("\n")[0]! : error instanceof Error ? error.message : String(error);
    return { status: "unavailable", detail };
  }
}
