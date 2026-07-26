/**
 * Human-only CLI for reviewing and deciding story change proposals.
 *
 * Examples:
 *   npm run changes -- list
 *   npm run changes -- show 42
 *   npm run changes -- approve 42 --by "release-manager" --note "Verified against release"
 *   npm run changes -- reject 42 --by "product-owner" --note "Needs a narrower story"
 */

import "../src/loadEnv.js";
import { getStore } from "../src/store.js";
import { approveStoryChange, rejectStoryChange } from "../src/db.js";

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function proposalId(raw: string | undefined): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new Error("A positive proposal id is required.");
  return id;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "list";
  const store = getStore();
  try {
    if (command === "list") {
      const rawStatuses = valueAfter(args, "--status") ?? "pending";
      const allowed = new Set(["pending", "approved", "rejected", "stale"]);
      const status = rawStatuses.split(",").map((s) => s.trim());
      if (status.some((s) => !allowed.has(s))) {
        throw new Error("--status must contain pending, approved, rejected, or stale.");
      }
      const proposals = await store.listStoryChangeProposals({
        status: status as Array<"pending" | "approved" | "rejected" | "stale">,
        storyKey: valueAfter(args, "--story-key"),
        limit: Number(valueAfter(args, "--limit") ?? 50),
      });
      console.log(JSON.stringify({ proposals }, null, 2));
      return;
    }
    if (command === "show") {
      const proposal = await store.getStoryChangeProposal(proposalId(args[1]));
      console.log(JSON.stringify({ proposal }, null, 2));
      process.exitCode = proposal ? 0 : 2;
      return;
    }
    if (command === "approve") {
      const id = proposalId(args[1]);
      const decidedBy = valueAfter(args, "--by");
      if (!decidedBy) throw new Error("--by is required for an approval decision.");
      const result = await approveStoryChange({
        proposalId: id,
        decidedBy,
        note: valueAfter(args, "--note") ?? null,
      });
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.outcome === "approved" ? 0 : 2;
      return;
    }
    if (command === "reject") {
      const id = proposalId(args[1]);
      const decidedBy = valueAfter(args, "--by");
      if (!decidedBy) throw new Error("--by is required for a rejection decision.");
      const outcome = await rejectStoryChange({
        proposalId: id,
        decidedBy,
        note: valueAfter(args, "--note") ?? null,
      });
      console.log(JSON.stringify({ outcome }, null, 2));
      process.exitCode = outcome === "rejected" ? 0 : 2;
      return;
    }
    throw new Error(`Unknown command '${command}'. Use list, show, approve, or reject.`);
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
