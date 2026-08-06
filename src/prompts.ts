import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

function authoringInstructions(): string {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const skill = readFileSync(
    resolve(packageRoot, "skills/tieline-author/SKILL.md"),
    "utf8"
  );
  const contract = readFileSync(
    resolve(packageRoot, "skills/tieline-author/references/contract.md"),
    "utf8"
  );
  const onboarding = readFileSync(
    resolve(packageRoot, "skills/tieline-author/references/onboarding.md"),
    "utf8"
  );
  return `${skill}\n\n${contract}\n\n${onboarding}`;
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "tieline_author",
    {
      title: "Author or reconcile the Tieline contract",
      description:
        "Onboard repository behavior, shape planning Stories/ACs, or reconcile a branch while preserving Tieline authority boundaries.",
    },
    async () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: authoringInstructions(),
          },
        },
      ],
    })
  );
}
