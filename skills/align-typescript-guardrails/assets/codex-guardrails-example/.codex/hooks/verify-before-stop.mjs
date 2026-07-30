#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import process from "node:process";

// Optional example: tailor these constants to a fast repository check before enabling.
const CHECK_PROGRAM = "npm";
const CHECK_ARGUMENTS = ["run", "check:fast"];
const CHECK_TIMEOUT_MS = 30 * 1000;

let input = "";
for await (const chunk of process.stdin) input += chunk;

const event = JSON.parse(input);
if (event?.hook_event_name !== "Stop" || event?.stop_hook_active) {
  process.stdout.write("{}");
  process.exit(0);
}

const rootResult = spawnSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: event.cwd,
  encoding: "utf8",
});

if (rootResult.status !== 0) {
  process.stdout.write("{}");
  process.exit(0);
}

const repositoryRoot = rootResult.stdout.trim();
const statusResult = spawnSync("git", ["status", "--porcelain"], {
  cwd: repositoryRoot,
  encoding: "utf8",
});

if (statusResult.status !== 0 || statusResult.stdout.trim() === "") {
  process.stdout.write("{}");
  process.exit(0);
}

const changedPaths = statusResult.stdout
  .trim()
  .split("\n")
  .flatMap((line) => line.slice(3).split(" -> "));

const requiresCodeCheck = changedPaths.some(
  (path) =>
    /\.(?:[cm]?[jt]sx?|json|ya?ml|toml|rules)$/.test(path) ||
    /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(path),
);

if (!requiresCodeCheck) {
  process.stdout.write("{}");
  process.exit(0);
}

const checkResult = spawnSync(CHECK_PROGRAM, CHECK_ARGUMENTS, {
  cwd: repositoryRoot,
  encoding: "utf8",
  timeout: CHECK_TIMEOUT_MS,
});

if (checkResult.status === 0) {
  process.stdout.write("{}");
  process.exit(0);
}

const command = [CHECK_PROGRAM, ...CHECK_ARGUMENTS].join(" ");
const detail =
  checkResult.error?.code === "ETIMEDOUT"
    ? `timed out after ${CHECK_TIMEOUT_MS} ms`
    : `exited with status ${checkResult.status ?? "unknown"}`;

process.stdout.write(
  JSON.stringify({
    decision: "block",
    reason:
      `The canonical check \`${command}\` ${detail}. Run it directly, fix the ` +
      "failure, and report any check that cannot run. This hook will not continue the " +
      "turn a second time.",
  }),
);
