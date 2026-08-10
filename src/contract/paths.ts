import { readdirSync, statSync } from "node:fs";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";

/**
 * Compiles an ignore or source-root pattern: `*` matches within one path
 * segment, `**` across segments, and a matched path also covers everything
 * beneath it.
 */
export function wildcardPattern(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\0/g, ".*");
  return new RegExp(`^${escaped}(?:/.*)?$`);
}

/** Whether `target` resolves to `root` itself or somewhere inside it. */
export function withinRepository(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** Canonicalize a user-supplied repository path, or reject an escaping path. */
export function canonicalRepositoryRelativePath(path: string): string | null {
  const portable = path.normalize("NFC").trim().replaceAll("\\", "/");
  if (
    portable.length === 0 ||
    portable.startsWith("/") ||
    /^[A-Za-z]:\//.test(portable)
  ) {
    return null;
  }
  const normalized = posix
    .normalize(portable)
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    return null;
  }
  return normalized;
}

export type RepositoryEntryKind = "missing" | "file" | "other";

/**
 * Inspect an entry using the repository's exact path spelling. This prevents a
 * case-insensitive filesystem alias from hiding the contract's canonical path.
 */
export function repositoryEntryKindExactly(
  root: string,
  target: string
): RepositoryEntryKind {
  if (!withinRepository(root, target)) return "missing";
  let isFile: boolean;
  try {
    isFile = statSync(target).isFile();
  } catch {
    return "missing";
  }
  const path = relative(root, target);
  if (path.length === 0) return isFile ? "file" : "other";

  let directory = root;
  for (const segment of path.split(sep)) {
    try {
      if (!readdirSync(directory).includes(segment)) return "missing";
    } catch {
      return "missing";
    }
    directory = resolve(directory, segment);
  }
  return isFile ? "file" : "other";
}
