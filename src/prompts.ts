import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hasAcceptedContractSources } from "./contract/load.js";
import { findTiepointWorkspace } from "./tiepoint/workspace.js";

const TIEPOINT_SKILL_FILES = [
  "SKILL.md",
  "references/onboarding.md",
  "references/contract.md",
  "references/provisioning.md",
  "references/grading.md",
  "references/report.md",
] as const;
const TIEPOINT_SKILL_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../skills/tiepoint"
);
let tiepointInstructionsPromise: Promise<string> | undefined;

export interface TiepointPromptOptions {
  workspaceRoot?: string;
}

function tiepointInstructions(): Promise<string> {
  tiepointInstructionsPromise ??= Promise.all(
    TIEPOINT_SKILL_FILES.map((path) =>
      readFile(resolve(TIEPOINT_SKILL_ROOT, path), "utf8")
    )
  ).then((files) => files.join("\n\n"));
  return tiepointInstructionsPromise;
}

function activeInvocation(options: TiepointPromptOptions): string {
  const workspaceRoot = options.workspaceRoot ?? process.env.TIEPOINT_WORKSPACE;
  if (workspaceRoot === undefined) {
    return `# Active Tiepoint invocation

Contract state: \`client_routed\`.
This server has no explicit server-side workspace root, so it cannot determine
whether the client's active checkout has an initialized Tiepoint contract. Do
not report \`setup_required\` based on the server filesystem. Route the workflow
using the client's active workspace: inspect its Tiepoint state, onboard when it
has no accepted contract YAML, or choose the matching normal workflow when a
contract is present.`;
  }
  const workspace = findTiepointWorkspace(workspaceRoot);
  if (!workspace) {
    return `# Active Tiepoint invocation

Contract state: \`setup_required\`.
No Tiepoint workspace is available. Run the deterministic setup described below,
then evaluate the active workspace again before choosing a workflow.`;
  }
  if (
    !hasAcceptedContractSources(
      workspace.directory,
      workspace.config.files.spec_directory
    )
  ) {
    return `# Active Tiepoint invocation

Contract state: \`onboarding_required\`.
The active workspace has no accepted contract YAML. Begin semantic onboarding
immediately. Before any repository inspection or normal authoring work, the
first visible response must be the verbatim product orientation in the
onboarding workflow below.`;
  }
  return `# Active Tiepoint invocation

Contract state: \`contract_present\`.
The active workspace already has accepted contract YAML. Skip first-run
onboarding and choose the normal workflow that matches the user's request.`;
}

async function tiepointPrompt(options: TiepointPromptOptions) {
  return {
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `${activeInvocation(options)}\n\n${await tiepointInstructions()}`,
        },
      },
    ],
  };
}

export function registerPrompts(
  server: McpServer,
  options: TiepointPromptOptions = {}
): void {
  server.registerPrompt(
    "tiepoint",
    {
      title:
        "Onboard, author, grade, reconcile, or close out branch semantics with Tiepoint",
      description:
        "Onboard repository behavior, shape planning Stories/ACs, grade evidence, reconcile a branch, or close out semantic changes before implementation handoff, commit, push, or pull-request publication while preserving Tiepoint authority boundaries.",
    },
    () => tiepointPrompt(options)
  );
  server.registerPrompt(
    "tieline_author",
    {
      title: "Tiepoint (legacy prompt name)",
      description:
        "Deprecated compatibility alias for the tiepoint semantic workflow prompt.",
    },
    () => tiepointPrompt(options)
  );
}
