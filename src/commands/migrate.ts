import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { config } from "../config.js";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../migrations");
const BASELINE_MIGRATION = "0001_baseline.sql";

export interface AppliedMigration {
  filename: string;
  checksum: string;
}

export function assertBaselineHistory(
  applied: AppliedMigration[],
  expectedChecksum?: string
): void {
  const legacy = applied.filter((row) => row.filename !== BASELINE_MIGRATION);
  if (legacy.length > 0) {
    throw new Error(
      `This database contains the pre-baseline migration history (${legacy
        .map((row) => row.filename)
        .join(", ")}). Recreate the development database before applying ${BASELINE_MIGRATION}; ` +
        "Tieline will not drop or reinterpret existing data automatically."
    );
  }
  const baseline = applied.find((row) => row.filename === BASELINE_MIGRATION);
  if (baseline && expectedChecksum && baseline.checksum !== expectedChecksum) {
    throw new Error(
      `Migration drift: ${BASELINE_MIGRATION} was applied with checksum ${baseline.checksum}, ` +
        `but the packaged baseline is ${expectedChecksum}. Recreate the database or restore the packaged migration.`
    );
  }
}

function packagedBaseline(): { content: string; checksum: string } {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  if (files.length !== 1 || files[0] !== BASELINE_MIGRATION) {
    throw new Error(
      `Expected exactly ${BASELINE_MIGRATION}; found ${files.join(", ") || "no migrations"}.`
    );
  }
  const content = readFileSync(resolve(MIGRATIONS_DIR, BASELINE_MIGRATION), "utf8");
  return {
    content,
    checksum: createHash("sha256").update(content).digest("hex"),
  };
}

export async function migrateDatabase(dbUrl: string, verifyOnly = false): Promise<void> {
  const baseline = packagedBaseline();
  const sql = postgres(dbUrl, {
    max: 1,
    prepare: false,
    connection: { search_path: "public, extensions" },
  });

  try {
    await sql`
      create table if not exists schema_migrations (
        filename text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )`;
    const appliedRows = await sql<AppliedMigration[]>`
      select filename, checksum from schema_migrations order by filename`;
    assertBaselineHistory(appliedRows, baseline.checksum);
    const pending = appliedRows.length === 0;

    if (verifyOnly) {
      if (pending) throw new Error(`${BASELINE_MIGRATION} has not been applied.`);
      process.stderr.write(`Verified ${BASELINE_MIGRATION}; no checksum drift.\n`);
      return;
    }
    if (!pending) {
      process.stderr.write(`${BASELINE_MIGRATION} is already applied; no changes.\n`);
      return;
    }

    process.stderr.write(`  ${BASELINE_MIGRATION} ... `);
    await sql.begin(async (tx) => {
      await tx.unsafe(baseline.content);
      await tx`
        insert into schema_migrations (filename, checksum)
        values (${BASELINE_MIGRATION}, ${baseline.checksum})`;
    });
    process.stderr.write("ok\nApplied the clean baseline; schema is current.\n");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function runMigrateCommand(options: {
  verify?: boolean;
}): Promise<number> {
  if (!config.dbAdminUrl) {
    throw new Error(
      "Set DATABASE_URL_ADMIN to the database owner used for DDL; the MCP server never loads this connection."
    );
  }
  await migrateDatabase(config.dbAdminUrl, options.verify === true);
  return 0;
}
