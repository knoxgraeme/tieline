import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { config } from "../config.js";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../migrations");

// Exact checksums from edits made to already-applied migrations. The first two
// files were sanitized before Tieline's first general release; 0018 only had a
// comment reworded by the icebox -> tieline rename, leaving its SQL byte-for-byte
// identical. Accepting only their known prior bytes lets existing development
// databases advance without weakening drift detection for any other edit.
const ACCEPTED_PRIOR_CHECKSUMS: Record<string, string[]> = {
  "0002_schema.sql": ["942807af1f6bd118984457cc1c5ef1a24ab4d23c3005a9d9f499f5954191b657"],
  "0011_typed_story_relationships.sql": [
    "bf3ec9a92f6805ffca04763e776130f1644ad49b929a4cdb187382060c3abca8",
  ],
  "0018_explicit_repository_identity.sql": [
    "39429e5d3c1118c7a1ae93504e64abbba37fd5defe427db0c2b46bf089eeeb5f",
  ],
};

export async function migrateDatabase(dbUrl: string, verifyOnly = false): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const sql = postgres(dbUrl, {
    max: 1,
    prepare: false,
    connection: { search_path: "public, extensions" },
    // Migrations use idempotent `drop ... if exists` / `add column if not exists`,
    // which raise benign NOTICEs on a fresh DB. Suppress them so the apply log
    // stays readable; genuine errors still reject.
    onnotice: () => {},
  });

  try {
    await sql`
      create table if not exists schema_migrations (
        filename text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )`;
    const appliedRows = await sql<{ filename: string; checksum: string }[]>`
      select filename, checksum from schema_migrations order by filename`;
    const applied = new Map(appliedRows.map((row) => [row.filename, row.checksum]));

    let pending = 0;
    for (const file of files) {
      const content = readFileSync(resolve(MIGRATIONS_DIR, file), "utf8");
      const checksum = createHash("sha256").update(content).digest("hex");
      const prior = applied.get(file);
      if (prior) {
        if (prior !== checksum) {
          if (ACCEPTED_PRIOR_CHECKSUMS[file]?.includes(prior)) {
            await sql`update schema_migrations set checksum = ${checksum} where filename = ${file}`;
            process.stderr.write(`  ${file} ... accepted pre-release cleanup\n`);
          } else {
            throw new Error(
              `Migration drift: ${file} was applied with checksum ${prior}, but the packaged file is ${checksum}. ` +
                "Create a new migration instead of editing an applied one."
            );
          }
        }
        continue;
      }
      pending++;
      if (verifyOnly) continue;
      process.stderr.write(`  ${file} ... `);
      await sql.begin(async (tx) => {
        await tx.unsafe(content);
        await tx`insert into schema_migrations (filename, checksum) values (${file}, ${checksum})`;
      });
      process.stderr.write("ok\n");
    }

    if (verifyOnly) {
      if (pending > 0) throw new Error(`${pending} migration(s) have not been applied.`);
      process.stderr.write(`Verified ${files.length} applied migration(s); no checksum drift.\n`);
    } else if (pending === 0) {
      process.stderr.write(`All ${files.length} migration(s) already applied; no changes.\n`);
    } else {
      process.stderr.write(`Applied ${pending} migration(s); schema is current.\n`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function runMigrateCommand(args: string[]): Promise<number> {
  const unknown = args.filter((arg) => arg !== "--verify");
  if (unknown.length > 0) {
    throw new Error(`Unknown migrate option '${unknown[0]}'. Usage: tieline migrate [--verify]`);
  }
  if (!config.dbUrlIngest) {
    throw new Error(
      "Set DATABASE_URL_INGEST to a role that can run DDL; it never falls back to DATABASE_URL."
    );
  }
  await migrateDatabase(config.dbUrlIngest, args.includes("--verify"));
  return 0;
}
