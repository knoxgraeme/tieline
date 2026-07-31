/** One connection manager for every PostgreSQL privilege boundary. */
import postgres, { type Sql } from "postgres";
import { config } from "../../config.js";

let readSql: Sql | null = null;
let writeSql: Sql | null = null;
let syncSql: Sql | null = null;
let adminSql: Sql | null = null;

export function getReadSql(): Sql {
  if (!readSql) {
    if (!config.dbUrl) throw new Error("DATABASE_URL is not set. Point it at a Postgres + pgvector read role.");
    readSql = postgres(config.dbUrl, { max: 5, idle_timeout: 20, prepare: false });
  }
  return readSql;
}

export function getWriteSql(): Sql {
  if (!writeSql) {
    if (!config.dbWriteUrl) {
      throw new Error(
        "DATABASE_URL_WRITE is not set. Evidence and planning tools require the least-privilege tieline_planning_writer connection."
      );
    }
    writeSql = postgres(config.dbWriteUrl, { max: 3, idle_timeout: 20, prepare: false });
  }
  return writeSql;
}

export function getSyncSql(): Sql {
  if (!syncSql) {
    if (!config.dbSyncUrl) {
      throw new Error(
        "DATABASE_URL_SYNC is not set. Repository projection requires the dedicated sync role."
      );
    }
    syncSql = postgres(config.dbSyncUrl, { max: 2, idle_timeout: 20, prepare: false });
  }
  return syncSql;
}

export function getAdminSql(): Sql {
  if (!adminSql) {
    if (!config.dbAdminUrl) {
      throw new Error(
        "DATABASE_URL_ADMIN is not set. DDL and privileged retention require an offline admin connection."
      );
    }
    adminSql = postgres(config.dbAdminUrl, { max: 1, idle_timeout: 20, prepare: false });
  }
  return adminSql;
}

export async function closeConnections(): Promise<void> {
  await Promise.all(
    [readSql, writeSql, syncSql, adminSql]
      .filter((sql): sql is Sql => sql !== null)
      .map((sql) => sql.end({ timeout: 5 }))
  );
  readSql = writeSql = syncSql = adminSql = null;
}
