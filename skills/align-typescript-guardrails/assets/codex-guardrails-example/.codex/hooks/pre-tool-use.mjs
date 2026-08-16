#!/usr/bin/env node

import process from "node:process";

let input = "";
for await (const chunk of process.stdin) input += chunk;

const event = JSON.parse(input);
const patch = event?.tool_input?.command;

if (event?.hook_event_name !== "PreToolUse" || typeof patch !== "string") {
  process.exit(0);
}

const addedLines = patch
  .split("\n")
  .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
  .map((line) => line.slice(1));

const violations = [];

if (addedLines.some((line) => line.includes("@ts-ignore"))) {
  violations.push("new @ts-ignore");
}

if (
  addedLines.some((line) =>
    /\b(?:describe|it|test)\.only\s*\(|\b(?:fdescribe|fit)\s*\(/.test(line),
  )
) {
  violations.push("focused test");
}

if (
  addedLines.some((line) => {
    const marker = line.indexOf("eslint-disable");
    if (marker < 0) return false;

    const remainder = line
      .slice(marker)
      .replace(/^eslint-disable(?:-next-line|-line)?/, "")
      .replace(/\*\/.*$/, "")
      .trim();
    const ruleList = remainder.replace(/(?:^|\s)--(?:\s.*)?$/, "").trim();

    return ruleList.length === 0;
  })
) {
  violations.push("broad eslint-disable without named rules");
}

if (violations.length > 0) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `Patch introduces ${violations.join(", ")}. Fix the underlying issue or use ` +
          "a narrow, documented, reviewed exception.",
      },
    }),
  );
  process.exit(0);
}

const protectedPathPatterns = [
  /(?:^|\n)\*\*\* (?:Add|Update|Delete) File: (?:.*\/)?AGENTS(?:\.override)?\.md\b/,
  /(?:^|\n)\*\*\* (?:Add|Update|Delete) File: (?:.*\/)?\.codex\//,
  /(?:^|\n)\*\*\* (?:Add|Update|Delete) File: (?:.*\/)?\.github\/workflows\//,
  /(?:^|\n)\*\*\* (?:Add|Update|Delete) File: (?:.*\/)?package\.json\b/,
  /(?:^|\n)\*\*\* (?:Add|Update|Delete) File: (?:.*\/)?(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)\b/,
  /(?:^|\n)\*\*\* (?:Add|Update|Delete) File: (?:.*\/)?tsconfig(?:\.[^/\s]+)?\.json\b/,
  /(?:^|\n)\*\*\* (?:Add|Update|Delete) File: (?:.*\/)?(?:eslint|vitest|jest)\.[^/\s]+\b/,
  /(?:^|\n)\*\*\* (?:Add|Update|Delete) File: (?:.*\/)?migrations?\//,
];

const additionalContext = [];

if (
  addedLines.some((line) =>
    /\b(?:describe|it|test)\.skip\s*\(|\b(?:xdescribe|xit|xtest)\s*\(/.test(line),
  )
) {
  additionalContext.push(
    "This patch adds a skipped test. This baseline rejects new skips; remove it unless the repository's trusted grader explicitly validates a narrow waiver.",
  );
}

if (protectedPathPatterns.some((pattern) => pattern.test(patch))) {
  additionalContext.push(
    "This patch touches a protected control-plane surface. Preserve or strengthen " +
      "enforcement, report the control change explicitly, and run the expanded checks.",
  );
}

if (additionalContext.length > 0) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: additionalContext.join(" "),
      },
    }),
  );
}
