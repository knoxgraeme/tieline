import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hasAcceptedContractSources } from "./contract/load.js";
import { findTielineWorkspace } from "./tieline/workspace.js";

const TIELINE_SKILL_FILES = [
  "SKILL.md",
  "references/onboarding.md",
  "references/contract.md",
  "references/provisioning.md",
  "references/grading.md",
  "references/report.md",
] as const;
const TIELINE_SKILL_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../skills/tieline"
);
let tielineInstructionsPromise: Promise<string> | undefined;

export interface TielinePromptOptions {
  workspaceRoot?: string;
}

function tielineInstructions(): Promise<string> {
  tielineInstructionsPromise ??= Promise.all(
    TIELINE_SKILL_FILES.map((path) =>
      readFile(resolve(TIELINE_SKILL_ROOT, path), "utf8")
    )
  ).then((files) => files.join("\n\n"));
  return tielineInstructionsPromise;
}

function activeInvocation(options: TielinePromptOptions): string {
  const workspace = findTielineWorkspace(
    options.workspaceRoot ?? process.env.TIELINE_WORKSPACE ?? process.cwd()
  );
  if (!workspace) {
    return `# Active Tieline invocation

Contract state: \`setup_required\`.
No Tieline workspace is available. Run the deterministic setup described below,
then evaluate the active workspace again before choosing a workflow.`;
  }
  if (
    !hasAcceptedContractSources(
      workspace.directory,
      workspace.config.files.spec_directory
    )
  ) {
    return `# Active Tieline invocation

Contract state: \`onboarding_required\`.
The active workspace has no accepted contract YAML. Begin semantic onboarding
immediately. Before any repository inspection or normal authoring work, the
first visible response must be the verbatim product orientation in the
onboarding workflow below.`;
  }
  return `# Active Tieline invocation

Contract state: \`contract_present\`.
The active workspace already has accepted contract YAML. Skip first-run
onboarding and choose the normal workflow that matches the user's request.`;
}

async function tielinePrompt(options: TielinePromptOptions) {
  return {
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `${activeInvocation(options)}\n\n${await tielineInstructions()}`,
        },
      },
    ],
  };
}

export function registerPrompts(
  server: McpServer,
  options: TielinePromptOptions = {}
): void {
  server.registerPrompt(
    "tieline",
    {
      title:
        "Onboard, author, grade, reconcile, or close out branch semantics with Tieline",
      description:
        "Onboard repository behavior, shape planning Stories/ACs, grade evidence, reconcile a branch, or close out semantic changes before implementation handoff, commit, push, or pull-request publication while preserving Tieline authority boundaries.",
    },
    () => tielinePrompt(options)
  );
  server.registerPrompt(
    "tieline_author",
    {
      title: "Tieline (legacy prompt name)",
      description:
        "Deprecated compatibility alias for the tieline semantic workflow prompt.",
    },
    () => tielinePrompt(options)
  );
}
