import type { Sql } from "postgres";
import { renderUserStory } from "../../contract/schema.js";
import {
  buildContractGraph,
  computeStoryCoverage,
  effectiveApplicability,
  summarizeFreshness,
  type ContractAcceptanceCriterionRecord,
  type ContractCriterionLookup,
  type ContractEvidenceLink,
  type ContractGraph,
  type ContractReadStore,
  type ContractScenarioRecord,
  type ContractStoryFilters,
  type ContractStoryGroupBy,
  type ContractStoryRecord,
  type Freshness,
  type HandoffConflictRecord,
  type QueryContractStoriesResult,
} from "../../domain/contract-read-store.js";
import type { Applicability } from "../../contract/schema.js";
import type {
  ContractAuthority,
  StoryLifecycle,
} from "../../types.js";
import { getReadSql } from "./connections.js";

interface StoryRow {
  id: string;
  repository: string;
  repository_commit: string | null;
  capability_stable_id: string;
  capability_name: string;
  capability_description: string;
  capability_applies_to: Applicability;
  stable_id: string;
  title: string;
  actor: string | null;
  goal: string | null;
  benefit: string | null;
  lifecycle: StoryLifecycle;
  authority: ContractAuthority;
  revision: string | number;
  aliases: string[];
  applies_to: Applicability;
  motivated_by: string[];
  superseded_by: string | null;
}

interface CriterionRow {
  id: string;
  story_id: string;
  stable_id: string;
  criterion: string | null;
  rationale: string | null;
  position: number;
  active: boolean;
  authority: ContractAuthority;
  aliases: string[];
  applies_to: Applicability;
  superseded_by: string | null;
}

interface ScenarioRow {
  id: string;
  criterion_id: string;
  stable_id: string;
  name: string | null;
  given: string;
  when: string;
  then: string;
  position: number;
  active: boolean;
}

interface CodeLinkRow {
  owner_id: string;
  relation: "implements" | "enforces" | "tests";
  reviewed_content_hash: string | null;
  current_content_hash: string | null;
  kind: "code" | "test";
  repository: string;
  path: string;
  selector: string | null;
  framework_hint: string | null;
}

interface HelpLinkRow {
  owner_id: string;
  source: string;
  external_id: string;
  title: string | null;
  url: string | null;
}

const MAX_GRAPH_STORIES = 10_000;
const MAX_QUERY_LIMIT = MAX_GRAPH_STORIES;

function nonEmptyApplicability(value: Applicability): Applicability | null {
  return Object.keys(value).length > 0 ? value : null;
}

function freshnessForCodeLink(
  authority: ContractAuthority,
  ownerRepository: string,
  row: CodeLinkRow
): Freshness {
  if (authority === "planning") return "unknown";
  if (row.repository !== ownerRepository) return "unknown";
  if (!row.reviewed_content_hash) return "unknown";
  return row.reviewed_content_hash === row.current_content_hash
    ? "current"
    : "stale";
}

function codeEvidenceLink(
  row: CodeLinkRow,
  authority: ContractAuthority,
  ownerRepository: string,
  scope: "direct" | "story_fallback"
): ContractEvidenceLink {
  return {
    relation: row.relation,
    scope,
    target: {
      kind: row.kind,
      repository: row.repository,
      path: row.path,
      selector: row.selector,
      framework_hint: row.framework_hint,
    },
    reviewed_content_hash: row.reviewed_content_hash,
    freshness: freshnessForCodeLink(authority, ownerRepository, row),
  };
}

function helpEvidenceLink(
  row: HelpLinkRow,
  scope: "direct" | "story_fallback"
): ContractEvidenceLink {
  return {
    relation: "documents",
    scope,
    target: {
      kind: "help",
      source: row.source,
      external_id: row.external_id,
      title: row.title,
      url: row.url,
    },
    reviewed_content_hash: null,
    freshness: "not_applicable",
  };
}

function whereClause(
  sql: Sql,
  filters: ContractStoryFilters
): ReturnType<Sql> {
  const conditions: ReturnType<Sql>[] = [];
  if (filters.repositories?.length) {
    conditions.push(sql`r.key = any(${filters.repositories})`);
  }
  if (filters.capabilities?.length) {
    conditions.push(sql`c.stable_id = any(${filters.capabilities})`);
  }
  if (filters.story_keys?.length) {
    conditions.push(sql`us.stable_id = any(${filters.story_keys})`);
  }
  if (filters.actors?.length) {
    conditions.push(sql`us.actor = any(${filters.actors})`);
  }
  if (filters.lifecycles?.length) {
    conditions.push(
      sql`us.lifecycle = any(${filters.lifecycles}::story_lifecycle[])`
    );
  }
  if (filters.authorities?.length) {
    conditions.push(
      sql`us.authority = any(${filters.authorities}::contract_authority[])`
    );
  }
  if (filters.code_path) {
    conditions.push(sql`(
      exists (
        select 1
        from story_code_assets sca
        join code_assets ca on ca.id = sca.asset_id
        where sca.story_id = us.id and ca.path = ${filters.code_path}
      )
      or exists (
        select 1
        from acceptance_criteria ac
        join criterion_code_assets cca on cca.criterion_id = ac.id
        join code_assets ca on ca.id = cca.asset_id
        where ac.story_id = us.id
          and ac.active
          and ca.path = ${filters.code_path}
      )
    )`);
  }
  if (filters.help_source || filters.help_external_id) {
    const source = filters.help_source;
    const externalId = filters.help_external_id;
    conditions.push(sql`(
      exists (
        select 1
        from story_help_articles sha
        join help_articles ha on ha.id = sha.article_id
        where sha.story_id = us.id
          and (${source ?? null}::text is null or ha.source = ${source ?? null})
          and (${externalId ?? null}::text is null or ha.external_id = ${externalId ?? null})
      )
      or exists (
        select 1
        from acceptance_criteria ac
        join criterion_help_articles cha on cha.criterion_id = ac.id
        join help_articles ha on ha.id = cha.article_id
        where ac.story_id = us.id
          and ac.active
          and (${source ?? null}::text is null or ha.source = ${source ?? null})
          and (${externalId ?? null}::text is null or ha.external_id = ${externalId ?? null})
      )
    )`);
  }
  if (filters.has_direct_ac_links === true) {
    conditions.push(sql`exists (
      select 1
      from acceptance_criteria ac
      where ac.story_id = us.id
        and ac.active
        and (
          exists (
            select 1 from criterion_code_assets cca
            where cca.criterion_id = ac.id
          )
          or exists (
            select 1 from criterion_help_articles cha
            where cha.criterion_id = ac.id
          )
        )
    )`);
  }
  if (filters.has_direct_ac_links === false) {
    conditions.push(sql`not exists (
      select 1
      from acceptance_criteria ac
      where ac.story_id = us.id
        and ac.active
        and (
          exists (
            select 1 from criterion_code_assets cca
            where cca.criterion_id = ac.id
          )
          or exists (
            select 1 from criterion_help_articles cha
            where cha.criterion_id = ac.id
          )
        )
    )`);
  }
  if (conditions.length === 0) return sql``;
  return conditions.reduce(
    (combined, condition, index) =>
      index === 0 ? sql`where ${condition}` : sql`${combined} and ${condition}`,
    sql``
  );
}

async function fetchCriteria(
  sql: Sql,
  storyIds: string[],
  includeInactive: boolean
): Promise<CriterionRow[]> {
  if (storyIds.length === 0) return [];
  return sql<CriterionRow[]>`
    select
      ac.id,
      ac.story_id,
      ac.stable_id,
      ac.criterion,
      ac.rationale,
      ac.position,
      ac.active,
      ac.authority::text,
      ac.aliases,
      ac.applies_to,
      successor.stable_id as superseded_by
    from acceptance_criteria ac
    left join acceptance_criteria successor on successor.id = ac.superseded_by_id
    where ac.story_id in ${sql(storyIds)}
      and (${includeInactive} or ac.active)
    order by ac.story_id, ac.position, ac.stable_id`;
}

async function fetchScenarios(
  sql: Sql,
  criterionIds: string[],
  includeInactive: boolean
): Promise<ScenarioRow[]> {
  if (criterionIds.length === 0) return [];
  return sql<ScenarioRow[]>`
    select
      id,
      criterion_id,
      stable_id,
      name,
      given_text as given,
      when_text as when,
      then_text as then,
      position,
      active
    from scenarios
    where criterion_id in ${sql(criterionIds)}
      and (${includeInactive} or active)
    order by criterion_id, position, stable_id`;
}

async function fetchStoryCodeLinks(
  sql: Sql,
  storyIds: string[]
): Promise<CodeLinkRow[]> {
  if (storyIds.length === 0) return [];
  return sql<CodeLinkRow[]>`
    select
      sca.story_id as owner_id,
      sca.relation,
      sca.reviewed_content_hash,
      ca.content_hash as current_content_hash,
      ca.kind,
      target_repository.key as repository,
      ca.path,
      ca.selector,
      ca.framework_hint
    from story_code_assets sca
    join code_assets ca on ca.id = sca.asset_id
    join repositories target_repository on target_repository.id = ca.repository_id
    where sca.story_id in ${sql(storyIds)}
    order by sca.story_id, ca.path, ca.selector nulls first`;
}

async function fetchCriterionCodeLinks(
  sql: Sql,
  criterionIds: string[]
): Promise<CodeLinkRow[]> {
  if (criterionIds.length === 0) return [];
  return sql<CodeLinkRow[]>`
    select
      cca.criterion_id as owner_id,
      cca.relation,
      cca.reviewed_content_hash,
      ca.content_hash as current_content_hash,
      ca.kind,
      target_repository.key as repository,
      ca.path,
      ca.selector,
      ca.framework_hint
    from criterion_code_assets cca
    join code_assets ca on ca.id = cca.asset_id
    join repositories target_repository on target_repository.id = ca.repository_id
    where cca.criterion_id in ${sql(criterionIds)}
    order by cca.criterion_id, ca.path, ca.selector nulls first`;
}

async function fetchStoryHelpLinks(
  sql: Sql,
  storyIds: string[]
): Promise<HelpLinkRow[]> {
  if (storyIds.length === 0) return [];
  return sql<HelpLinkRow[]>`
    select
      sha.story_id as owner_id,
      ha.source,
      ha.external_id,
      ha.title,
      ha.url
    from story_help_articles sha
    join help_articles ha on ha.id = sha.article_id
    where sha.story_id in ${sql(storyIds)}
    order by sha.story_id, ha.source, ha.external_id`;
}

async function fetchCriterionHelpLinks(
  sql: Sql,
  criterionIds: string[]
): Promise<HelpLinkRow[]> {
  if (criterionIds.length === 0) return [];
  return sql<HelpLinkRow[]>`
    select
      cha.criterion_id as owner_id,
      ha.source,
      ha.external_id,
      ha.title,
      ha.url
    from criterion_help_articles cha
    join help_articles ha on ha.id = cha.article_id
    where cha.criterion_id in ${sql(criterionIds)}
    order by cha.criterion_id, ha.source, ha.external_id`;
}

function groupByOwner<T extends { owner_id: string }>(
  rows: T[]
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const values = grouped.get(row.owner_id) ?? [];
    values.push(row);
    grouped.set(row.owner_id, values);
  }
  return grouped;
}

function groupScenarios(
  rows: ScenarioRow[]
): Map<string, ContractScenarioRecord[]> {
  const grouped = new Map<string, ContractScenarioRecord[]>();
  for (const row of rows) {
    const values = grouped.get(row.criterion_id) ?? [];
    values.push({
      id: row.id,
      stable_id: row.stable_id,
      name: row.name,
      given: row.given,
      when: row.when,
      then: row.then,
      position: row.position,
      active: row.active,
    });
    grouped.set(row.criterion_id, values);
  }
  return grouped;
}

async function hydrateStories(
  sql: Sql,
  rows: StoryRow[],
  includeInactiveCriteria: boolean
): Promise<ContractStoryRecord[]> {
  const storyIds = rows.map((row) => row.id);
  const criteria = await fetchCriteria(
    sql,
    storyIds,
    includeInactiveCriteria
  );
  const criterionIds = criteria.map((criterion) => criterion.id);
  const [
    scenarios,
    storyCodeRows,
    criterionCodeRows,
    storyHelpRows,
    criterionHelpRows,
  ] = await Promise.all([
    fetchScenarios(sql, criterionIds, includeInactiveCriteria),
    fetchStoryCodeLinks(sql, storyIds),
    fetchCriterionCodeLinks(sql, criterionIds),
    fetchStoryHelpLinks(sql, storyIds),
    fetchCriterionHelpLinks(sql, criterionIds),
  ]);

  const criteriaByStory = new Map<string, CriterionRow[]>();
  for (const criterion of criteria) {
    const values = criteriaByStory.get(criterion.story_id) ?? [];
    values.push(criterion);
    criteriaByStory.set(criterion.story_id, values);
  }
  const scenariosByCriterion = groupScenarios(scenarios);
  const storyCodeByOwner = groupByOwner(storyCodeRows);
  const criterionCodeByOwner = groupByOwner(criterionCodeRows);
  const storyHelpByOwner = groupByOwner(storyHelpRows);
  const criterionHelpByOwner = groupByOwner(criterionHelpRows);

  return rows.map((row) => {
    const storyDirectLinks: ContractEvidenceLink[] = [
      ...(storyCodeByOwner.get(row.id) ?? []).map((link) =>
        codeEvidenceLink(link, row.authority, row.repository, "story_fallback")
      ),
      ...(storyHelpByOwner.get(row.id) ?? []).map((link) =>
        helpEvidenceLink(link, "story_fallback")
      ),
    ];
    const storyApplicability = effectiveApplicability(
      row.capability_applies_to,
      row.applies_to
    );
    const acceptanceCriteria: ContractAcceptanceCriterionRecord[] = (
      criteriaByStory.get(row.id) ?? []
    ).map((criterion) => {
      const directLinks: ContractEvidenceLink[] = [
        ...(criterionCodeByOwner.get(criterion.id) ?? []).map((link) =>
          codeEvidenceLink(
            link,
            criterion.authority,
            row.repository,
            "direct"
          )
        ),
        ...(criterionHelpByOwner.get(criterion.id) ?? []).map((link) =>
          helpEvidenceLink(link, "direct")
        ),
      ];
      return {
        id: criterion.id,
        stable_id: criterion.stable_id,
        criterion: criterion.criterion,
        rationale: criterion.rationale,
        position: criterion.position,
        active: criterion.active,
        authority: criterion.authority,
        aliases: criterion.aliases,
        applies_to: nonEmptyApplicability(criterion.applies_to),
        effective_applies_to: effectiveApplicability(
          storyApplicability,
          criterion.applies_to
        ),
        scenarios: scenariosByCriterion.get(criterion.id) ?? [],
        direct_links: directLinks,
        fallback_story_links: storyDirectLinks,
        freshness: summarizeFreshness([...directLinks, ...storyDirectLinks]),
        superseded_by: criterion.superseded_by
          ? { stable_id: criterion.superseded_by }
          : null,
      };
    });

    const activeLinks = acceptanceCriteria
      .filter((criterion) => criterion.active)
      .flatMap((criterion) => criterion.direct_links);
    const footprintLinks = [...storyDirectLinks, ...activeLinks];
    const codePaths = new Set<string>();
    const help = new Map<string, { source: string; external_id: string }>();
    for (const link of footprintLinks) {
      if (link.target.kind === "help") {
        help.set(`${link.target.source}\0${link.target.external_id}`, {
          source: link.target.source,
          external_id: link.target.external_id,
        });
      } else {
        codePaths.add(link.target.path);
      }
    }
    const renderedStory =
      row.actor && row.goal && row.benefit
        ? renderUserStory({
            actor: row.actor,
            goal: row.goal,
            benefit: row.benefit,
          })
        : null;
    return {
      id: row.id,
      repository: row.repository,
      repository_commit: row.repository_commit,
      capability: {
        stable_id: row.capability_stable_id,
        name: row.capability_name,
        description: row.capability_description,
      },
      stable_id: row.stable_id,
      title: row.title,
      actor: row.actor,
      goal: row.goal,
      benefit: row.benefit,
      rendered_story: renderedStory,
      lifecycle: row.lifecycle,
      authority: row.authority,
      revision: Number(row.revision),
      aliases: row.aliases,
      applies_to: nonEmptyApplicability(row.applies_to),
      effective_applies_to: storyApplicability,
      motivated_by: row.motivated_by,
      direct_links: storyDirectLinks,
      acceptance_criteria: acceptanceCriteria,
      footprint: {
        code_paths: [...codePaths].sort(),
        help: [...help.values()].sort(
          (left, right) =>
            left.source.localeCompare(right.source) ||
            left.external_id.localeCompare(right.external_id)
        ),
      },
      coverage: computeStoryCoverage(row.authority, acceptanceCriteria),
      freshness: summarizeFreshness(footprintLinks),
      superseded_by: row.superseded_by
        ? { stable_id: row.superseded_by }
        : null,
    };
  });
}

export class PostgresContractReadRepository implements ContractReadStore {
  constructor(private readonly sqlProvider: () => Sql = getReadSql) {}

  async queryContractStories(opts: {
    filters: ContractStoryFilters;
    groupBy?: ContractStoryGroupBy | null;
    limit: number;
  }): Promise<QueryContractStoriesResult> {
    const sql = this.sqlProvider();
    const filter = whereClause(sql, opts.filters);

    if (opts.groupBy) {
      const groupColumn =
        opts.groupBy === "repository"
          ? sql`r.key`
          : opts.groupBy === "capability"
            ? sql`coalesce(c.stable_id, '(unassigned)')`
            : opts.groupBy === "lifecycle"
              ? sql`us.lifecycle::text`
              : opts.groupBy === "authority"
                ? sql`us.authority::text`
                : sql`coalesce(us.actor, '(none)')`;
      const groups = await sql<{ group_value: string; count: number }[]>`
        select ${groupColumn} as group_value, count(*)::int as count
        from user_stories us
        join repositories r on r.id = us.repository_id
        left join capabilities c on c.id = us.capability_id
        ${filter}
        group by ${groupColumn}
        order by count desc, group_value`;
      return {
        mode: "grouped",
        groups: groups.map((group) => ({
          group: group.group_value,
          count: group.count,
        })),
      };
    }

    const [count] = await sql<{ count: number }[]>`
      select count(*)::int as count
      from user_stories us
      join repositories r on r.id = us.repository_id
      left join capabilities c on c.id = us.capability_id
      ${filter}`;
    const limit = Math.min(Math.max(opts.limit, 1), MAX_QUERY_LIMIT);
    const rows = await sql<StoryRow[]>`
      select
        us.id,
        r.key as repository,
        us.repository_commit,
        coalesce(c.stable_id, '(unassigned)') as capability_stable_id,
        coalesce(c.name, 'Unassigned planning') as capability_name,
        coalesce(c.description, 'Planning Story not yet assigned to a capability.') as capability_description,
        coalesce(c.applies_to, '{}'::jsonb) as capability_applies_to,
        us.stable_id,
        us.title,
        us.actor,
        us.goal,
        us.benefit,
        us.lifecycle::text,
        us.authority::text,
        us.revision,
        us.aliases,
        us.applies_to,
        us.motivated_by,
        successor.stable_id as superseded_by
      from user_stories us
      join repositories r on r.id = us.repository_id
      left join capabilities c on c.id = us.capability_id
      left join user_stories successor on successor.id = us.superseded_by_id
      ${filter}
      order by r.key, c.stable_id, us.stable_id
      limit ${limit}`;
    return {
      mode: "records",
      total: count?.count ?? 0,
      records: await hydrateStories(
        sql,
        rows,
        opts.filters.include_inactive_criteria ?? false
      ),
    };
  }

  async getAcceptanceCriterion(opts: {
    repository: string;
    stableId: string;
    includeInactive?: boolean;
  }): Promise<ContractCriterionLookup | null> {
    const sql = this.sqlProvider();
    const [parent] = await sql<{ story_stable_id: string }[]>`
      select us.stable_id as story_stable_id
      from acceptance_criteria ac
      join user_stories us on us.id = ac.story_id
      join repositories r on r.id = ac.repository_id
      where r.key = ${opts.repository}
        and ac.stable_id = ${opts.stableId}
        and (${opts.includeInactive ?? false} or ac.active)`;
    if (!parent) return null;
    const result = await this.queryContractStories({
      filters: {
        repositories: [opts.repository],
        story_keys: [parent.story_stable_id],
        include_inactive_criteria: opts.includeInactive,
      },
      limit: 1,
    });
    if (result.mode !== "records" || !result.records[0]) return null;
    const story = result.records[0];
    const criterion = story.acceptance_criteria.find(
      (candidate) => candidate.stable_id === opts.stableId
    );
    if (!criterion) return null;
    return {
      story: {
        repository: story.repository,
        stable_id: story.stable_id,
        title: story.title,
        lifecycle: story.lifecycle,
        authority: story.authority,
      },
      criterion,
    };
  }

  async contractGraph(opts: {
    repositories?: string[];
    lifecycles?: StoryLifecycle[];
    authorities?: ContractAuthority[];
    includeInactiveCriteria?: boolean;
  } = {}): Promise<ContractGraph> {
    const result = await this.queryContractStories({
      filters: {
        repositories: opts.repositories,
        lifecycles: opts.lifecycles,
        authorities: opts.authorities,
        include_inactive_criteria: opts.includeInactiveCriteria,
      },
      limit: MAX_GRAPH_STORIES,
    });
    return buildContractGraph(result.mode === "records" ? result.records : []);
  }

  async listHandoffConflicts(
    opts: {
      repository?: string;
      story_stable_id?: string;
      include_resolved?: boolean;
      limit?: number;
    } = {}
  ): Promise<HandoffConflictRecord[]> {
    const sql = this.sqlProvider();
    const rows = await sql<
      Array<
        Omit<
          HandoffConflictRecord,
          | "materialized_revision"
          | "later_planning_revision"
          | "resolved_at"
          | "created_at"
        > & {
          materialized_revision: string | number;
          later_planning_revision: string | number;
          resolved_at: string | Date | null;
          created_at: string | Date;
        }
      >
    >`
      select
        conflict.id,
        repository.key as repository,
        story.id as story_id,
        story.stable_id as story_stable_id,
        conflict.materialized_revision,
        conflict.later_planning_revision,
        conflict.merged_content,
        conflict.planning_content,
        conflict.resolved_at,
        conflict.created_at
      from handoff_conflicts conflict
      join repositories repository
        on repository.id = conflict.repository_id
      join user_stories story on story.id = conflict.story_id
      where (
        ${opts.repository ?? null}::text is null
        or repository.key = ${opts.repository ?? null}
      )
        and (
          ${opts.story_stable_id ?? null}::text is null
          or story.stable_id = ${opts.story_stable_id ?? null}
        )
        and (${opts.include_resolved ?? false} or conflict.resolved_at is null)
      order by conflict.created_at desc, conflict.id
      limit ${Math.min(Math.max(opts.limit ?? 50, 1), 200)}`;
    return rows.map((row) => ({
      ...row,
      materialized_revision: Number(row.materialized_revision),
      later_planning_revision: Number(row.later_planning_revision),
      resolved_at:
        row.resolved_at instanceof Date
          ? row.resolved_at.toISOString()
          : row.resolved_at
            ? new Date(row.resolved_at).toISOString()
            : null,
      created_at:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : new Date(row.created_at).toISOString(),
    }));
  }
}
