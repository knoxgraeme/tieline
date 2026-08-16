import type { Sql } from "postgres";

export type TielineRole =
  | "tieline_planning_writer"
  | "tieline_reader"
  | "tieline_repository_sync";

export async function withRole<T>(
  sql: Sql,
  role: TielineRole,
  operation: () => Promise<T>
): Promise<T> {
  await sql.unsafe(`set role ${role}`);
  try {
    return await operation();
  } finally {
    await sql.unsafe("reset role");
  }
}
