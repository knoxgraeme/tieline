import { isAbsolute, relative, sep } from "node:path";

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
