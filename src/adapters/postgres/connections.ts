/** One connection manager for every PostgreSQL privilege boundary. */
import postgres, { type Sql } from "postgres";
import { config } from "../../config.js";

let readSql: Sql | null = null;
let writeSql: Sql | null = null;
let ingestSql: Sql | null = null;
let approvalSql: Sql | null = null;

export function getReadSql(): Sql {
  if (!readSql) {
    if (!config.dbUrl) throw new Error("DATABASE_URL is not set. Point it at a Postgres + pgvector read role.");
    readSql = postgres(config.dbUrl, { max: 5, idle_timeout: 20, prepare: false });
  }
  return readSql;
}

export function getWriteSql(): Sql {
  if (!writeSql) {
    if (!config.dbWriteUrl) throw new Error("DATABASE_URL_WRITE is not set. Write tools require the least-privilege mcp_writer connection.");
    writeSql = postgres(config.dbWriteUrl, { max: 3, idle_timeout: 20, prepare: false });
  }
  return writeSql;
}

export function getIngestSql(): Sql {
  if (!ingestSql) {
    if (!config.dbUrlIngest) throw new Error("DATABASE_URL_INGEST is not set; bulk import requires an explicit write-capable role and never falls back to DATABASE_URL.");
    ingestSql = postgres(config.dbUrlIngest, { max: 2, idle_timeout: 20, prepare: false });
  }
  return ingestSql;
}

export function getApprovalSql(): Sql {
  if (!approvalSql) {
    if (!config.dbApprovalUrl) throw new Error("DATABASE_URL_APPROVAL is not set. Human decisions and STORY_APPROVAL_MODE=off require the mcp_approver connection.");
    approvalSql = postgres(config.dbApprovalUrl, { max: 2, idle_timeout: 20, prepare: false });
  }
  return approvalSql;
}

export async function closeConnections(): Promise<void> {
  await Promise.all(
    [readSql, writeSql, ingestSql, approvalSql]
      .filter((sql): sql is Sql => sql !== null)
      .map((sql) => sql.end({ timeout: 5 }))
  );
  readSql = writeSql = ingestSql = approvalSql = null;
}

