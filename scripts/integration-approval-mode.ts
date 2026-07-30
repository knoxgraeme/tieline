/** Live check for STORY_APPROVAL_MODE=all|off. Requires the integration fixture. */
import {
  clearGenericWriteDatabaseUrls,
  configureTestDatabase,
  hasTestDatabaseUrl,
} from "./integration-safety.js";

async function main(): Promise<void> {
  const enabled =
    hasTestDatabaseUrl(process.env, "write") ||
    hasTestDatabaseUrl(process.env, "approval");
  clearGenericWriteDatabaseUrls(process.env);
  if (!enabled) {
    console.log(
      "SKIP - dedicated TIELINE_TEST_DATABASE_URL, TIELINE_TEST_DATABASE_URL_WRITE, and TIELINE_TEST_DATABASE_URL_APPROVAL credentials are required."
    );
    return;
  }
  configureTestDatabase(["read", "write", "approval"], process.env);

  const [{ config }, { getStore }] = await Promise.all([
    import("../src/config.js"),
    import("../src/store.js"),
  ]);
  if (config.storyApprovalMode === "production") {
    throw new Error("Set STORY_APPROVAL_MODE=all or off for this focused check.");
  }
  const status = config.storyApprovalMode === "all" ? "idea" : "production";
  const sectionKey = process.env.INTEGRATION_SECTION_KEY;
  if (!sectionKey) throw new Error("Set INTEGRATION_SECTION_KEY to an existing section.");
  const store = getStore();
  try {
    const result = await store.createUserStory({
      sectionKey,
      title: `[itest] ${config.storyApprovalMode} approval mode`,
      storyText: `As a tester, I want ${config.storyApprovalMode} mode verified.`,
      status,
      source: "integration-approval-mode",
      proposedBy: "integration",
    });
    const expected = config.storyApprovalMode === "all" ? "proposed" : "applied";
    if (result.outcome !== expected) {
      throw new Error(
        `Expected ${expected} in ${config.storyApprovalMode} mode; got ${result.outcome}.`
      );
    }
    console.log(
      `ok - STORY_APPROVAL_MODE=${config.storyApprovalMode} returned ${result.outcome}`
    );
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
