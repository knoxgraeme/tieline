export const INTEGRATION_DATABASE_SENTINEL = "TIELINE_INTEGRATION_TEST_DATABASE";

const INTEGRATION_DATABASE_SENTINEL_VALUE = "1";
const DISPOSABLE_DATABASE_NAME = "tieline_test";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

type Environment = Record<string, string | undefined>;

/**
 * Verifies the explicit, local-only database contract before a database-writing
 * integration module is imported.
 */
export function requireIntegrationDatabaseAdminUrl(environment: Environment): string {
  const adminUrl = environment.DATABASE_URL_ADMIN;
  if (!adminUrl) {
    throw new Error(
      "DATABASE_URL_ADMIN is required for test:integration and must point to a guarded disposable blank database."
    );
  }

  if (environment[INTEGRATION_DATABASE_SENTINEL] !== INTEGRATION_DATABASE_SENTINEL_VALUE) {
    throw new Error(
      `${INTEGRATION_DATABASE_SENTINEL}=1 is required for test:integration.`
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(adminUrl);
  } catch {
    throw new Error("DATABASE_URL_ADMIN must be a valid PostgreSQL URL for test:integration.");
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL_ADMIN must use the postgres or postgresql protocol for test:integration.");
  }

  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error("DATABASE_URL_ADMIN must target a loopback host for test:integration.");
  }

  if (parsed.pathname !== `/${DISPOSABLE_DATABASE_NAME}`) {
    throw new Error(
      `DATABASE_URL_ADMIN must target the ${DISPOSABLE_DATABASE_NAME} database for test:integration.`
    );
  }

  return adminUrl;
}
