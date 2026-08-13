import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { config } from "../config.js";
import { stderrIO, type CommandIO } from "./shared.js";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../migrations");
const MIGRATION_FILENAME_PATTERN = /^(\d{4})_[a-z0-9][a-z0-9_]*\.sql$/;
const MIGRATION_LOCK_KEY = "tieline-schema-migrations";

export interface AppliedMigration {
  filename: string;
  checksum: string;
}

export interface PackagedMigration extends AppliedMigration {
  content: string;
}

export function readPackagedMigrations(
  migrationDirectory = MIGRATIONS_DIR
): PackagedMigration[] {
  const files = readdirSync(migrationDirectory)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  if (files.length === 0) {
    throw new Error("Expected at least one packaged SQL migration; found none.");
  }
  for (const [index, file] of files.entries()) {
    const match = file.match(MIGRATION_FILENAME_PATTERN);
    const expectedSequence = index + 1;
    if (!match || Number(match[1]) !== expectedSequence) {
      throw new Error(
        `Expected contiguous migration ${String(expectedSequence).padStart(4, "0")}_*.sql; found ${file}.`
      );
    }
  }
  return files.map((filename) => {
    const content = readFileSync(resolve(migrationDirectory, filename), "utf8");
    return {
      filename,
      content,
      checksum: createHash("sha256").update(content).digest("hex"),
    };
  });
}

export function assertMigrationHistory(
  applied: readonly AppliedMigration[],
  packaged: readonly AppliedMigration[]
): void {
  if (applied.length > packaged.length) {
    const extra = applied.slice(packaged.length).map((row) => row.filename);
    throw new Error(
      `This database contains migration history not packaged by this Tieline version (${extra.join(", ")}). ` +
        "Install a compatible version or recreate the development database."
    );
  }
  for (const [index, row] of applied.entries()) {
    const expected = packaged[index];
    if (!expected || row.filename !== expected.filename) {
      throw new Error(
        `Migration history is not an ordered packaged prefix at position ${index + 1}: ` +
          `found ${row.filename}, expected ${expected?.filename ?? "no migration"}. ` +
          "Recreate the development database; Tieline will not reorder or reinterpret existing data automatically."
      );
    }
    if (row.checksum !== expected.checksum) {
      throw new Error(
        `Migration drift: ${row.filename} was applied with checksum ${row.checksum}, ` +
          `but the packaged migration is ${expected.checksum}. Recreate the database or restore the packaged migration.`
      );
    }
  }
}

export async function migrateDatabase(
  dbUrl: string,
  verifyOnly = false,
  io: CommandIO = stderrIO
): Promise<void> {
  const migrations = readPackagedMigrations();
  const sql = postgres(dbUrl, {
    max: 1,
    prepare: false,
    connection: { search_path: "public, extensions" },
  });

  try {
    await sql`select pg_advisory_lock(hashtext(${MIGRATION_LOCK_KEY}))`;
    try {
      await sql`
        create table if not exists schema_migrations (
          filename text primary key,
          checksum text not null,
          applied_at timestamptz not null default now()
        )`;
      const applied = await sql<AppliedMigration[]>`
        select filename, checksum from schema_migrations order by filename`;
      assertMigrationHistory(applied, migrations);
      const pending = migrations.slice(applied.length);

      if (verifyOnly) {
        if (pending.length > 0) {
          throw new Error(
            `Pending migrations: ${pending.map((migration) => migration.filename).join(", ")}.`
          );
        }
        io.write(`Verified ${migrations.length} migrations; no checksum drift.\n`);
        return;
      }

      if (pending.length === 0) {
        io.write(`All ${migrations.length} migrations are already applied; no changes.\n`);
        return;
      }

      for (const migration of pending) {
        io.write(`  ${migration.filename} ... `);
        await sql.begin(async (tx) => {
          await tx.unsafe(migration.content);
          await tx`
            insert into schema_migrations (filename, checksum)
            values (${migration.filename}, ${migration.checksum})`;
        });
        io.write("ok\n");
      }
      io.write(`Applied ${pending.length} migration${pending.length === 1 ? "" : "s"}; schema is current.\n`);
    } finally {
      await sql`select pg_advisory_unlock(hashtext(${MIGRATION_LOCK_KEY}))`.catch(() => undefined);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function runMigrateCommand(
  options: { verify?: boolean },
  io: CommandIO = stderrIO
): Promise<number> {
  if (!config.dbAdminUrl) {
    throw new Error(
      "Set DATABASE_URL_ADMIN to the database owner used for DDL; the MCP server never loads this connection."
    );
  }
  await migrateDatabase(config.dbAdminUrl, options.verify === true, io);
  return 0;
}
