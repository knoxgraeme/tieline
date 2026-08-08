import { basename, relative, resolve, sep } from "node:path";
import {
  findTielineWorkspace,
  type TielineWorkspace,
} from "../tieline/workspace.js";

export interface CommandIO {
  write(message: string): void;
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
