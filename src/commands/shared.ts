import { basename, relative, resolve, sep } from "node:path";
import {
  findTielineWorkspace,
  type TielineWorkspace,
} from "../tieline/workspace.js";

export interface CommandIO {
  write(message: string): void;
}

const UNSAFE_TERMINAL_TEXT =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

/**
 * Makes repository-controlled text inert before it is embedded in terminal
 * output. Callers add their own newlines after encoding so the renderer alone
 * controls line boundaries.
 */
export function escapeTerminalText(text: string): string {
  return text.replace(UNSAFE_TERMINAL_TEXT, (character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0xff
      ? `\\x${codePoint.toString(16).padStart(2, "0")}`
      : `\\u{${codePoint.toString(16)}}`;
  });
}

/** Default sink for commands whose stdout carries data, not narration. */
export const stderrIO: CommandIO = {
  write(message: string): void {
    process.stderr.write(message);
  },
};

export interface CommandContextOptions {
  repository?: string;
  repo?: string;
  spec?: string;
}

export interface CommandContext {
  root: string;
  workspace: TielineWorkspace | null;
  repositoryKey: string;
  manifestPath: string;
  specDirectory: string;
}

/**
 * Resolves where a command runs and what it runs against. The workspace, when
 * one exists, is the single source of truth for every derived path; the spec
 * directory is derived from the workspace's resolved path so the answer is the
 * same however the configuration spelled it.
 */
export function resolveCommandContext(
  options: CommandContextOptions
): CommandContext {
  const requestedRoot = resolve(options.repository ?? process.cwd());
  const workspace = findTielineWorkspace(requestedRoot);
  const root = workspace?.root ?? requestedRoot;
  return {
    root,
    workspace,
    repositoryKey:
      options.repo ?? workspace?.config.product.repo_name ?? basename(root),
    manifestPath: workspace?.manifestPath ?? resolve(root, ".tieline/manifest"),
    specDirectory:
      options.spec ??
      (workspace
        ? relative(root, workspace.specDirectoryPath).split(sep).join("/")
        : ".tieline/spec"),
  };
}

export function wrap(text: string, columns: number, indent = ""): string {
  const lines: string[] = [];
  let line = "";
  for (const word of text.replace(/\s+/g, " ").trim().split(" ")) {
    if (!line) {
      line = word;
    } else if (`${line} ${word}`.length > columns) {
      lines.push(line);
      line = word;
    } else {
      line = `${line} ${word}`;
    }
  }
  if (line) lines.push(line);
  return lines.map((entry) => `${indent}${entry}\n`).join("");
}
