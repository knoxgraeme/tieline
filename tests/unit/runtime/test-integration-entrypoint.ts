import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  INTEGRATION_DATABASE_SENTINEL,
  requireIntegrationDatabaseAdminUrl,
} from "../../support/integration-database-preflight.js";
import { report, test } from "../../support/harness.js";

const guardedEnvironment = {
  DATABASE_URL_ADMIN: "postgresql://admin:secret@localhost:5432/tieline_test",
  [INTEGRATION_DATABASE_SENTINEL]: "1",
};

await test("integration database preflight requires a URL", () => {
  assert.throws(
    () => requireIntegrationDatabaseAdminUrl({ [INTEGRATION_DATABASE_SENTINEL]: "1" }),
    /DATABASE_URL_ADMIN is required/
  );
});

await test("integration database preflight requires the dedicated test sentinel", () => {
  assert.throws(
    () => requireIntegrationDatabaseAdminUrl({
      DATABASE_URL_ADMIN: guardedEnvironment.DATABASE_URL_ADMIN,
    }),
    new RegExp(`${INTEGRATION_DATABASE_SENTINEL}=1 is required`)
  );
});

await test("integration database preflight rejects malformed URLs", () => {
  assert.throws(
    () => requireIntegrationDatabaseAdminUrl({
      ...guardedEnvironment,
      DATABASE_URL_ADMIN: "not a URL",
    }),
    /must be a valid PostgreSQL URL/
  );
});

await test("integration database preflight rejects general database targets", () => {
  assert.throws(
    () => requireIntegrationDatabaseAdminUrl({
      ...guardedEnvironment,
      DATABASE_URL_ADMIN: "postgresql://admin:secret@localhost:5432/tieline",
    }),
    /must target the tieline_test database/
  );
});

await test("integration database preflight rejects non-local targets", () => {
  assert.throws(
    () => requireIntegrationDatabaseAdminUrl({
      ...guardedEnvironment,
      DATABASE_URL_ADMIN: "postgresql://admin:secret@example.test:5432/tieline_test",
    }),
    /must target a loopback host/
  );
});

await test("integration database preflight accepts the guarded disposable target", () => {
  assert.equal(
    requireIntegrationDatabaseAdminUrl(guardedEnvironment),
    guardedEnvironment.DATABASE_URL_ADMIN
  );
});

const integrationEntrypoints = [
  ["test:integration", "../../integration/integration.ts"],
  ["test:integration:contract-sync", "../../integration/integration-contract-sync.ts"],
  ["test:integration:code-topology", "../../integration/integration-code-topology.ts"],
  ["test:integration:evidence", "../../integration/integration-evidence.ts"],
  ["test:integration:planning", "../../integration/integration-planning.ts"],
  ["test:integration:lifecycle", "../../integration/integration-lifecycle.ts"],
  ["test:integration:baseline", "../../integration/integration-baseline.ts"],
] as const;

const rejectedEnvironments = [
  {
    name: "a missing admin URL",
    environment: { [INTEGRATION_DATABASE_SENTINEL]: "1" },
    message:
      /DATABASE_URL_ADMIN is required for test:integration and must point to a guarded disposable blank database\./,
  },
  {
    name: "a missing test sentinel",
    environment: { DATABASE_URL_ADMIN: guardedEnvironment.DATABASE_URL_ADMIN },
    message: new RegExp(`${INTEGRATION_DATABASE_SENTINEL}=1 is required`),
  },
  {
    name: "a general database target",
    environment: {
      ...guardedEnvironment,
      DATABASE_URL_ADMIN: "postgresql://admin:secret@localhost:5432/tieline",
    },
    message: /must target the tieline_test database/,
  },
  {
    name: "a remote database target",
    environment: {
      ...guardedEnvironment,
      DATABASE_URL_ADMIN: "postgresql://admin:secret@example.test:5432/tieline_test",
    },
    message: /must target a loopback host/,
  },
] as const;

for (const [script, relativePath] of integrationEntrypoints) {
  for (const rejected of rejectedEnvironments) {
    await test(`${script} fails closed for ${rejected.name}`, () => {
      const entrypoint = fileURLToPath(new URL(relativePath, import.meta.url));
      const environment = { ...process.env };
      delete environment.DATABASE_URL_ADMIN;
      delete environment[INTEGRATION_DATABASE_SENTINEL];
      Object.assign(environment, rejected.environment);

      const result = spawnSync(process.execPath, ["--import", "tsx", entrypoint], {
        encoding: "utf8",
        env: environment,
      });

      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, rejected.message);
    });
  }
}

report();
