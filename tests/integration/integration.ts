import { requireIntegrationDatabaseAdminUrl } from "../support/integration-database-preflight.js";

try {
  requireIntegrationDatabaseAdminUrl(process.env);
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "test:integration database preflight failed."
  );
  process.exit(1);
}

// Run lifecycle flows before the profile-version audit so each scenario sees
// the built-in profile definitions from the clean baseline.
await import("./integration-evidence.js");
await import("./integration-planning.js");
await import("./integration-contract-sync.js");
await import("./integration-lifecycle.js");
await import("./integration-baseline.js");

console.log("integration suite passed");
