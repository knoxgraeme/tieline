import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  CONTRACT_HISTORY_LIMITS,
  githubRepositoryUrl,
  readContractHistory,
  type ContractHistoryChange,
  type HistoryCommit,
} from "../contract/history.js";
import { escapeTerminalText, resolveCommandContext, type CommandIO } from "./shared.js";

export interface ContractHistoryOptions {
  repository?: string;
  /** A Story, acceptance criterion, or screen stable ID; all changes when omitted. */
  key?: string;
  limit?: number;
  ref?: string;
  json?: boolean;
}

function where(commit: HistoryCommit): string {
  return `${commit.pull_request !== null ? `#${commit.pull_request}` : commit.commit.slice(0, 7)}`;
}

const KIND_LABELS: Record<ContractHistoryChange["kind"], [string, string]> = {
  story: ["Story", "Stories"],
  acceptance_criterion: ["criterion", "criteria"],
  screen: ["screen", "screens"],
};

/**
 * `tieline contract history`: when each Story, acceptance criterion, and
 * screen changed, and in which pull request, read from the committed
 * manifest's git history along the first-parent line.
 */
export function runContractHistoryCommand(options: ContractHistoryOptions, io: CommandIO): number {
  const { root, manifestPath } = resolveCommandContext(options);
  const directory = relative(root, resolve(manifestPath)).split(sep).join("/");
  if (!directory || directory === ".." || directory.startsWith("../") || isAbsolute(directory)) {
    throw new Error(`The manifest at '${manifestPath}' is outside the repository, so git holds no history of it.`);
  }
  const history = readContractHistory(root, directory, {
    ref: options.ref ?? "HEAD",
    limit: options.limit ?? CONTRACT_HISTORY_LIMITS.commits,
  });
  const repositoryUrl = githubRepositoryUrl(root);
  const link = (commit: HistoryCommit): string | null =>
    repositoryUrl
      ? commit.pull_request !== null
        ? `${repositoryUrl}/pull/${commit.pull_request}`
        : `${repositoryUrl}/commit/${commit.commit}`
      : null;
  const changes = options.key ? history.changes.filter((change) => change.stable_id === options.key) : history.changes;

  if (options.json) {
    io.write(
      `${JSON.stringify(
        {
          ref: history.ref,
          ...(options.key ? { key: options.key } : {}),
          ...(options.key
            ? { changes: changes.map((change) => ({ ...change, commit: { ...change.commit, url: link(change.commit) } })) }
            : { commits: history.commits.map((commit) => ({ ...commit, url: link(commit) })) }),
          truncated: history.truncated,
          unreadable: history.unreadable,
        },
        null,
        2
      )}\n`
    );
    return 0;
  }

  if (options.key) {
    if (changes.length === 0) {
      io.write(`No change to ${escapeTerminalText(options.key)} in the history read.\n`);
    } else {
      io.write(`${escapeTerminalText(options.key)}: ${changes.length} change(s), newest first.\n`);
      for (const change of changes) {
        io.write(
          `  ${change.commit.date.slice(0, 10)}  ${where(change.commit).padEnd(8)}  ${change.status}${
            change.aspects.length > 0 ? ` (${change.aspects.join(", ")})` : ""
          }  ${escapeTerminalText(change.commit.subject)}\n`
        );
      }
    }
  } else {
    io.write(`${history.commits.length} commit(s) changed the contract, newest first.\n`);
    for (const commit of history.commits) {
      const counts = (["story", "acceptance_criterion", "screen"] as const)
        .map((kind) => {
          const count = history.changes.filter((change) => change.commit.commit === commit.commit && change.kind === kind).length;
          return count > 0 ? `${count} ${KIND_LABELS[kind][count === 1 ? 0 : 1]}` : null;
        })
        .filter((part): part is string => part !== null)
        .join(", ");
      io.write(`  ${commit.date.slice(0, 10)}  ${where(commit).padEnd(8)}  ${counts}  ${escapeTerminalText(commit.subject)}\n`);
    }
  }
  if (history.truncated) {
    io.write(`  note  older history was not read (the limit, or a shallow clone); pass --limit or fetch more history.\n`);
  }
  if (history.unreadable.length > 0) {
    io.write(`  note  ${history.unreadable.length} commit(s) could not be read: ${escapeTerminalText(history.unreadable[0]!.detail)}\n`);
  }
  return 0;
}
