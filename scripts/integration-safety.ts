/**
 * Safety boundary for integration tests that can mutate PostgreSQL.
 *
 * Production code intentionally consumes DATABASE_URL_* variables. Integration
 * tests must instead receive dedicated TIELINE_TEST_DATABASE_URL_* credentials
 * and an exact database-name confirmation. This module validates those inputs
 * before mapping them to the production variable names expected by the app.
 */

export type TestDatabaseRole = "read" | "ingest" | "write" | "approval";

const TEST_URL_VARIABLES: Record<TestDatabaseRole, string> = {
  read: "TIELINE_TEST_DATABASE_URL",
  ingest: "TIELINE_TEST_DATABASE_URL_INGEST",
  write: "TIELINE_TEST_DATABASE_URL_WRITE",
  approval: "TIELINE_TEST_DATABASE_URL_APPROVAL",
};

const RUNTIME_URL_VARIABLES: Record<TestDatabaseRole, string> = {
  read: "DATABASE_URL",
  ingest: "DATABASE_URL_INGEST",
  write: "DATABASE_URL_WRITE",
  approval: "DATABASE_URL_APPROVAL",
};

const LEGACY_WRITE_URL_VARIABLES = [
  "SUPABASE_DB_URL_INGEST",
  "SUPABASE_DB_URL_WRITE",
] as const;

const SAFE_DATABASE_TOKEN = /(?:^|[_-])(?:test|testing|itest|integration)(?:[_-]|$)/i;
const UNSAFE_DATABASE_TOKEN = /(?:^|[_-])(?:prod|production|stage|staging|live)(?:[_-]|$)/i;

export interface TestDatabaseConfiguration {
  databaseName: string;
  roles: TestDatabaseRole[];
}

export function hasTestDatabaseUrl(
  env: NodeJS.ProcessEnv,
  role: TestDatabaseRole
): boolean {
  return Boolean(env[TEST_URL_VARIABLES[role]]?.trim());
}

/**
 * Generic write-capable credentials must never opt an integration test into
 * mutation. Clear both current and legacy names before config is imported.
 */
export function clearGenericWriteDatabaseUrls(env: NodeJS.ProcessEnv = process.env): void {
  for (const role of ["ingest", "write", "approval"] as const) {
    delete env[RUNTIME_URL_VARIABLES[role]];
  }
  for (const variable of LEGACY_WRITE_URL_VARIABLES) delete env[variable];
}

/**
 * Validate dedicated test credentials and expose them under the runtime names
 * used by application code. All requested roles must target the same database.
 */
export function configureTestDatabase(
  roles: readonly TestDatabaseRole[],
  env: NodeJS.ProcessEnv = process.env
): TestDatabaseConfiguration {
  const uniqueRoles = [...new Set(roles)];
  if (uniqueRoles.length === 0) {
    throw new Error("At least one test database role is required.");
  }

  const parsed = uniqueRoles.map((role) => {
    const variable = TEST_URL_VARIABLES[role];
    const raw = env[variable]?.trim();
    if (!raw) {
      throw new Error(
        `Missing ${variable}. Write-capable integration tests never use generic DATABASE_URL_* credentials.`
      );
    }
    return { role, variable, raw, ...parseTestDatabaseTarget(variable, raw) };
  });

  const databaseName = parsed[0]!.databaseName;
  const server = parsed[0]!.server;
  const mismatched = parsed.find(
    (entry) => entry.databaseName !== databaseName || entry.server !== server
  );
  if (mismatched) {
    throw new Error(
      `${mismatched.variable} targets a different PostgreSQL server or database; all test roles must share one disposable target.`
    );
  }

  const confirmation = env.TIELINE_CONFIRM_TEST_DATABASE?.trim();
  if (confirmation !== databaseName) {
    throw new Error(
      `Set TIELINE_CONFIRM_TEST_DATABASE=${databaseName} to confirm the exact disposable database targeted by this integration test.`
    );
  }

  clearGenericWriteDatabaseUrls(env);
  delete env.SUPABASE_DB_URL;
  for (const entry of parsed) {
    env[RUNTIME_URL_VARIABLES[entry.role]] = entry.raw;
  }

  return { databaseName, roles: uniqueRoles };
}

function parseTestDatabaseTarget(
  variable: string,
  raw: string
): { databaseName: string; server: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${variable} must be a valid PostgreSQL URL.`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`${variable} must use the postgres: or postgresql: protocol.`);
  }
  if (!url.hostname) {
    throw new Error(`${variable} must identify a PostgreSQL host.`);
  }
  for (const key of ["host", "hostaddr", "port", "database", "dbname"]) {
    if (url.searchParams.has(key)) {
      throw new Error(
        `${variable} must encode its server and database in the URL authority and path, not target-overriding query parameters.`
      );
    }
  }

  const encodedName = url.pathname.replace(/^\/+|\/+$/g, "");
  if (!encodedName || encodedName.includes("/")) {
    throw new Error(`${variable} must identify exactly one database in its URL path.`);
  }

  let databaseName: string;
  try {
    databaseName = decodeURIComponent(encodedName);
  } catch {
    throw new Error(`${variable} contains an invalid encoded database name.`);
  }

  if (!SAFE_DATABASE_TOKEN.test(databaseName) || UNSAFE_DATABASE_TOKEN.test(databaseName)) {
    throw new Error(
      `${variable} database '${databaseName}' is not visibly disposable. Use a name containing a standalone test, itest, or integration token and no prod, stage, or live token.`
    );
  }
  const server = `${url.hostname.toLowerCase()}:${url.port || "5432"}`;
  return { databaseName, server };
}
