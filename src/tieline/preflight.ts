import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import postgres from "postgres";
import type { EmbeddingProvider } from "../config.js";
import {
  assertMigrationHistory,
  readPackagedMigrations,
  type AppliedMigration,
} from "../commands/migrate.js";

export interface PreflightCheck {
  key: string;
  status: "pass" | "warning";
  message: string;
}

export function resolveEmbeddingProvider(env: NodeJS.ProcessEnv): EmbeddingProvider {
  const explicit = env.EMBEDDING_PROVIDER?.trim();
  if (explicit === "local" || explicit === "openai" || explicit === "supabase-edge" || explicit === "hash") {
    return explicit;
  }
  if (explicit) {
    throw new Error(
      `Invalid EMBEDDING_PROVIDER '${explicit}'. Must be one of: local, openai, supabase-edge, hash.`
    );
  }
  return env.SUPABASE_URL && env.SUPABASE_ANON_KEY ? "supabase-edge" : "local";
}

function localEmbedderInstalled(env: NodeJS.ProcessEnv): boolean {
  try {
    createRequire(import.meta.url).resolve("@huggingface/transformers");
    return true;
  } catch {
    const root = env.TIELINE_LOCAL_EMBEDDER_ROOT;
    if (!root) return false;
    try {
      createRequire(resolve(root, "package.json")).resolve("@huggingface/transformers");
      return true;
    } catch {
      return false;
    }
  }
}

export function runInitPreflight(
  targetPath: string,
  provider: EmbeddingProvider,
  env: NodeJS.ProcessEnv = process.env
): PreflightCheck[] {
  const gitDetected = existsSync(resolve(targetPath, ".git"));
  const adminConfigured = Boolean(env.DATABASE_URL_ADMIN);
  const readConfigured = Boolean(env.DATABASE_URL);
  const checks: PreflightCheck[] = [
    {
      key: "repository",
      status: gitDetected ? "pass" : "warning",
      message: gitDetected
        ? "Git repository metadata detected."
        : "No .git metadata detected; onboarding can continue, but code provenance will be less useful.",
    },
    {
      key: "database_admin",
      status: adminConfigured ? "pass" : "warning",
      message: adminConfigured
        ? "Explicit admin credentials are configured for setup and migrations."
        : "DATABASE_URL_ADMIN is not configured; offline authoring remains available.",
    },
    {
      key: "database_read",
      status: readConfigured ? "pass" : "warning",
      message: readConfigured
        ? "Read credentials are configured for taxonomy reuse and duplicate checks."
        : "DATABASE_URL is not configured; the agent cannot reuse existing taxonomy or run duplicate checks yet.",
    },
    {
      key: "review_workflow",
      status: "pass",
      message:
        "Repository contract changes are validated locally and accepted through normal pull-request review and merge.",
    },
  ];

  if (provider === "local") {
    const installed = localEmbedderInstalled(env);
    checks.push({
      key: "embedding_provider",
      status: installed ? "pass" : "warning",
      message: installed
        ? "Local gte-small embedding runtime is installed."
        : "Embedding provider is local, but @huggingface/transformers is not installed; install it before semantic search or sync.",
    });
  } else if (provider === "hash") {
    checks.push({
      key: "embedding_provider",
      status: "warning",
      message: "Hash embeddings are selected; they are suitable only for development and tests.",
    });
  } else {
    checks.push({
      key: "embedding_provider",
      status: "pass",
      message: `Embedding provider '${provider}' is selected; import and retrieval must use this same provider.`,
    });
  }
  return checks;
}

/** Read-only verification of the database required by migrate/sync. Offline init remains valid. */
export async function runDatabasePreflight(
  env: NodeJS.ProcessEnv = process.env
): Promise<PreflightCheck[]> {
  const dbUrl = env.DATABASE_URL_ADMIN;
  if (!dbUrl) return [];
  let sql: ReturnType<typeof postgres> | null = null;
  try {
    sql = postgres(dbUrl, { max: 1, prepare: false, connect_timeout: 3 });
    const [capabilities] = await sql<{
      vector_available: boolean;
      migrations_available: boolean;
    }[]>`
      select
        exists(select 1 from pg_extension where extname = 'vector') as vector_available,
        to_regclass('public.schema_migrations') is not null as migrations_available`;
    const checks: PreflightCheck[] = [
      { key: "database_connection", status: "pass", message: "Admin database connection succeeded." },
      {
        key: "pgvector",
        status: capabilities.vector_available ? "pass" : "warning",
        message: capabilities.vector_available
          ? "pgvector extension is available."
          : "pgvector extension is not installed; run migrations with an extension-capable owner.",
      },
    ];
    if (!capabilities.migrations_available) {
      checks.push({
        key: "migrations",
        status: "warning",
        message: "schema_migrations is missing; run `tieline migrate` before import.",
      });
      return checks;
    }

    const migrations = readPackagedMigrations();
    const applied = await sql<AppliedMigration[]>`
      select filename, checksum from schema_migrations order by filename`;
    let historyIssue: string | null = null;
    try {
      assertMigrationHistory(applied, migrations);
    } catch (error) {
      historyIssue = error instanceof Error ? error.message : String(error);
    }
    const pending = historyIssue === null ? migrations.slice(applied.length) : [];
    checks.push({
      key: "migrations",
      status: pending.length === 0 && historyIssue === null ? "pass" : "warning",
      message:
        historyIssue !== null
          ? `Migration verification needs attention: ${historyIssue}`
          : pending.length === 0
            ? `All ${migrations.length} migrations are applied with matching checksums.`
            : `Migration verification needs attention: ${pending.length} pending (${pending
                .map((migration) => migration.filename)
                .join(", ")}).`,
    });
    return checks;
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).replaceAll(dbUrl, "<redacted>");
    return [
      {
        key: "database_connection",
        status: "warning",
        message: `Could not verify the admin database: ${message}`,
      },
    ];
  } finally {
    await sql?.end({ timeout: 1 }).catch(() => undefined);
  }
}
