import assert from "node:assert/strict";
import {
  clearGenericWriteDatabaseUrls,
  configureTestDatabase,
  hasTestDatabaseUrl,
} from "./integration-safety.js";

let passed = 0;

function test(name: string, run: () => void): void {
  try {
    run();
    passed += 1;
    console.log(`  ok  - ${name}`);
  } catch (error) {
    console.error(`  not ok - ${name}`);
    throw error;
  }
}

function validEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    TIELINE_TEST_DATABASE_URL:
      "postgresql://reader:secret@127.0.0.1:5432/tieline_integration_test",
    TIELINE_TEST_DATABASE_URL_WRITE:
      "postgresql://writer:secret@127.0.0.1:5432/tieline_integration_test",
    TIELINE_TEST_DATABASE_URL_APPROVAL:
      "postgresql://approver:secret@127.0.0.1:5432/tieline_integration_test",
    TIELINE_CONFIRM_TEST_DATABASE: "tieline_integration_test",
    ...overrides,
  };
}

console.log("integration database safety");

test("generic write credentials are cleared and never count as test credentials", () => {
  const env: NodeJS.ProcessEnv = {
    DATABASE_URL_INGEST: "postgresql://owner:secret@db.example/production",
    DATABASE_URL_WRITE: "postgresql://writer:secret@db.example/production",
    DATABASE_URL_APPROVAL: "postgresql://approver:secret@db.example/production",
    SUPABASE_DB_URL_INGEST: "postgresql://owner:secret@db.example/production",
    SUPABASE_DB_URL_WRITE: "postgresql://writer:secret@db.example/production",
  };
  assert.equal(hasTestDatabaseUrl(env, "write"), false);
  clearGenericWriteDatabaseUrls(env);
  assert.equal(env.DATABASE_URL_INGEST, undefined);
  assert.equal(env.DATABASE_URL_WRITE, undefined);
  assert.equal(env.DATABASE_URL_APPROVAL, undefined);
  assert.equal(env.SUPABASE_DB_URL_INGEST, undefined);
  assert.equal(env.SUPABASE_DB_URL_WRITE, undefined);
});

test("valid dedicated URLs replace generic runtime credentials", () => {
  const env = validEnv({
    DATABASE_URL: "postgresql://reader:secret@db.example/production",
    DATABASE_URL_WRITE: "postgresql://writer:secret@db.example/production",
  });
  const result = configureTestDatabase(["read", "write", "approval"], env);
  assert.equal(result.databaseName, "tieline_integration_test");
  assert.equal(env.DATABASE_URL, env.TIELINE_TEST_DATABASE_URL);
  assert.equal(env.DATABASE_URL_WRITE, env.TIELINE_TEST_DATABASE_URL_WRITE);
  assert.equal(env.DATABASE_URL_APPROVAL, env.TIELINE_TEST_DATABASE_URL_APPROVAL);
});

test("a missing dedicated role is rejected even when a generic URL exists", () => {
  const env = validEnv({
    TIELINE_TEST_DATABASE_URL_WRITE: undefined,
    DATABASE_URL_WRITE: "postgresql://writer:secret@127.0.0.1/tieline_integration_test",
  });
  assert.throws(
    () => configureTestDatabase(["read", "write"], env),
    /Missing TIELINE_TEST_DATABASE_URL_WRITE/
  );
});

test("confirmation must exactly match the parsed database name", () => {
  const env = validEnv({ TIELINE_CONFIRM_TEST_DATABASE: "yes" });
  assert.throws(
    () => configureTestDatabase(["read", "write"], env),
    /TIELINE_CONFIRM_TEST_DATABASE=tieline_integration_test/
  );
});

test("all roles must target the same database", () => {
  const env = validEnv({
    TIELINE_TEST_DATABASE_URL_WRITE:
      "postgresql://writer:secret@127.0.0.1:5432/other_integration_test",
  });
  assert.throws(
    () => configureTestDatabase(["read", "write"], env),
    /all test roles must share one disposable target/
  );
});

test("all roles must target the same server", () => {
  const env = validEnv({
    TIELINE_TEST_DATABASE_URL_WRITE:
      "postgresql://writer:secret@db.example.test:5432/tieline_integration_test",
  });
  assert.throws(
    () => configureTestDatabase(["read", "write"], env),
    /all test roles must share one disposable target/
  );
});

test("database names without an explicit test marker are rejected", () => {
  const env = validEnv({
    TIELINE_TEST_DATABASE_URL_WRITE:
      "postgresql://writer:secret@127.0.0.1:5432/tieline_development",
  });
  assert.throws(() => configureTestDatabase(["write"], env), /not visibly disposable/);
});

test("production-like database names remain rejected even with a test marker", () => {
  const env = validEnv({
    TIELINE_TEST_DATABASE_URL_WRITE:
      "postgresql://writer:secret@127.0.0.1:5432/tieline_prod_test",
    TIELINE_CONFIRM_TEST_DATABASE: "tieline_prod_test",
  });
  assert.throws(() => configureTestDatabase(["write"], env), /not visibly disposable/);
});

test("non-PostgreSQL and malformed URLs are rejected without echoing secrets", () => {
  const wrongProtocol = validEnv({
    TIELINE_TEST_DATABASE_URL_WRITE:
      "https://writer:do-not-print@example.test/tieline_integration_test",
  });
  assert.throws(
    () => configureTestDatabase(["write"], wrongProtocol),
    (error: unknown) =>
      error instanceof Error &&
      /postgres: or postgresql:/.test(error.message) &&
      !error.message.includes("do-not-print")
  );

  const malformed = validEnv({
    TIELINE_TEST_DATABASE_URL_WRITE: "not a URL with password=do-not-print",
  });
  assert.throws(
    () => configureTestDatabase(["write"], malformed),
    (error: unknown) =>
      error instanceof Error &&
      /valid PostgreSQL URL/.test(error.message) &&
      !error.message.includes("do-not-print")
  );
});

test("query parameters cannot override the validated target", () => {
  const env = validEnv({
    TIELINE_TEST_DATABASE_URL_WRITE:
      "postgresql://writer:secret@127.0.0.1:5432/tieline_integration_test?host=production.example",
  });
  assert.throws(
    () => configureTestDatabase(["write"], env),
    /not target-overriding query parameters/
  );
});

console.log(`\n${passed} passed, 0 failed`);
