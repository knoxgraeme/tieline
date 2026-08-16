if (!process.env.DATABASE_URL_ADMIN) {
  console.error(
    "DATABASE_URL_ADMIN is required for test:integration and must point to a guarded disposable blank database."
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
