import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { report, test } from "../../support/harness.js";

await test("integration entrypoint fails closed without disposable admin credentials", () => {
  const entrypoint = fileURLToPath(
    new URL("../../integration/integration.ts", import.meta.url)
  );
  const environment = { ...process.env };
  delete environment.DATABASE_URL_ADMIN;

  const result = spawnSync(process.execPath, ["--import", "tsx", entrypoint], {
    encoding: "utf8",
    env: environment,
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /DATABASE_URL_ADMIN is required for test:integration and must point to a guarded disposable blank database\./
  );
});

report();
