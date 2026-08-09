import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const TIELINE_SKILL_FILES = [
  "SKILL.md",
  "references/contract.md",
  "references/onboarding.md",
  "references/provisioning.md",
  "references/grading.md",
  "references/report.md",
] as const;
const TIELINE_SKILL_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../skills/tieline"
);
let tielineInstructionsPromise: Promise<string> | undefined;

function tielineInstructions(): Promise<string> {
  tielineInstructionsPromise ??= Promise.all(
    TIELINE_SKILL_FILES.map((path) =>
      readFile(resolve(TIELINE_SKILL_ROOT, path), "utf8")
    )
  ).then((files) => files.join("\n\n"));
  return tielineInstructionsPromise;
}

async function tielinePrompt() {
  return {
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: await tielineInstructions(),
        },
      },
    ],
  };
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "tieline",
    {
      title: "Onboard, author, grade, or reconcile with Tieline",
      description:
        "Onboard repository behavior, shape planning Stories/ACs, grade evidence, or reconcile a branch while preserving Tieline authority boundaries.",
    },
    tielinePrompt
  );
  server.registerPrompt(
    "tieline_author",
    {
      title: "Tieline (legacy prompt name)",
      description:
        "Deprecated compatibility alias for the tieline semantic workflow prompt.",
    },
    tielinePrompt
  );
}
