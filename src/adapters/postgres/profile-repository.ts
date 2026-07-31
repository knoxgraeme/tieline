import type { Sql } from "postgres";
import { z } from "zod";
import {
  RETRIEVAL_PROFILE_KEYS,
  type ResolvedRetrievalProfile,
  type RetrievalProfileDefinition,
} from "../../domain/semantic-search-store.js";
import { getAdminSql, getReadSql } from "./connections.js";

const profileDefinitionSchema = z
  .object({
    authorities: z
      .array(z.enum(["planning", "repository"]))
      .min(1)
      .optional(),
    lifecycles: z
      .array(z.enum(["backlog", "in_progress", "production", "retired"]))
      .min(1)
      .optional(),
    backlog_stages: z
      .array(z.enum(["open", "planned", "in_progress", "done", "declined"]))
      .min(1)
      .optional(),
    include_inactive: z.boolean().optional(),
    observation_attribution_states: z
      .array(z.enum(["suggested", "confirmed", "dismissed"]))
      .min(1)
      .optional(),
    include: z
      .array(
        z.enum([
          "story",
          "acceptance_criterion",
          "scenario",
          "backlog_item",
          "observation",
        ])
      )
      .min(1)
      .optional(),
  })
  .strict();

export function parseRetrievalProfileDefinition(
  value: unknown
): RetrievalProfileDefinition {
  return profileDefinitionSchema.parse(value);
}

export class PostgresProfileRepository {
  constructor(
    private readonly readProvider: () => Sql = getReadSql,
    private readonly adminProvider: () => Sql = getAdminSql
  ) {}

  async listProfiles(): Promise<
    Array<ResolvedRetrievalProfile & { active: boolean; created_by: string }>
  > {
    return this.readProvider()<
      Array<{
        profile_key: string;
        version: number;
        definition: RetrievalProfileDefinition;
        active: boolean;
        created_by: string;
      }>
    >`
      select profile_key, version, definition, active, created_by
      from retrieval_profiles
      order by profile_key, version desc`.then((rows) =>
      rows.map((row) => ({
        key: row.profile_key,
        version: row.version,
        definition: row.definition,
        active: row.active,
        created_by: row.created_by,
      }))
    );
  }

  async putProfile(input: {
    key: string;
    definition: unknown;
    created_by: string;
  }): Promise<ResolvedRetrievalProfile> {
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(input.key)) {
      throw new Error(
        "Profile key must start with a lowercase letter and contain 2-64 lowercase letters, digits, underscores, or hyphens."
      );
    }
    const definition = parseRetrievalProfileDefinition(input.definition);
    const sql = this.adminProvider();
    return sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${`tieline-profile:${input.key}`}))`;
      const [latest] = await tx<{ version: number }[]>`
        select coalesce(max(version), 0)::int as version
        from retrieval_profiles
        where profile_key = ${input.key}`;
      const version = latest.version + 1;
      await tx`
        update retrieval_profiles set active = false
        where profile_key = ${input.key} and active`;
      const [row] = await tx<{
        profile_key: string;
        version: number;
        definition: RetrievalProfileDefinition;
      }[]>`
        insert into retrieval_profiles (
          profile_key, version, definition, active, created_by
        ) values (
          ${input.key}, ${version},
          ${tx.json(definition as Parameters<typeof tx.json>[0])},
          true, ${input.created_by}
        )
        returning profile_key, version, definition`;
      await tx`
        insert into audit_events (event_kind, actor, detail)
        values (
          'retrieval_profile_published', ${input.created_by},
          ${tx.json({
            profile_key: input.key,
            version,
          })}
        )`;
      return {
        key: row.profile_key,
        version: row.version,
        definition: row.definition,
      };
    });
  }
}

export const BUILT_IN_RETRIEVAL_PROFILES = RETRIEVAL_PROFILE_KEYS;
