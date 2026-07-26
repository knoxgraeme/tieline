/** Live check for STORY_APPROVAL_MODE=all|off. Requires the integration fixture. */
import "../src/loadEnv.js";
import { config } from "../src/config.js";
import { getStore } from "../src/store.js";

async function main(): Promise<void> {
  if (config.storyApprovalMode === "production") {
    throw new Error("Set STORY_APPROVAL_MODE=all or off for this focused check.");
  }
  const status = config.storyApprovalMode === "all" ? "idea" : "production";
  const sectionKey = process.env.INTEGRATION_SECTION_KEY;
  if (!sectionKey) throw new Error("Set INTEGRATION_SECTION_KEY to an existing section.");
  const result = await getStore().createUserStory({
    sectionKey,
    title: `[itest] ${config.storyApprovalMode} approval mode`,
    storyText: `As a tester, I want ${config.storyApprovalMode} mode verified.`,
    status,
    source: "integration-approval-mode",
    proposedBy: "integration",
  });
  const expected = config.storyApprovalMode === "all" ? "proposed" : "applied";
  if (result.outcome !== expected) {
    throw new Error(`Expected ${expected} in ${config.storyApprovalMode} mode; got ${result.outcome}.`);
  }
  console.log(`ok - STORY_APPROVAL_MODE=${config.storyApprovalMode} returned ${result.outcome}`);
  await getStore().close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
