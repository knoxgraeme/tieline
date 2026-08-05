import type { Sql, TransactionSql } from "postgres";
import type {
  ContractManifest,
  ManifestAcceptanceCriterion,
  ManifestCapability,
  ManifestLink,
  ManifestStory,
} from "../../contract/manifest.js";
import {
  ContractSyncCheckpointError,
  ContractSyncCollisionError,
  type ContractSyncOptions,
  type ContractSyncResult,
  type HandoffConflict,
} from "../../contract/sync.js";
import type { RepositorySyncStore } from "../../domain/repository-sync-store.js";

interface RepositoryRow {
  id: string;
}

interface StoryRow {
  id: string;
  story_id?: string;
  stable_id: string;
  authority: "planning" | "repository";
  lifecycle: "backlog" | "in_progress" | "production" | "retired";
  revision: string | number;
  materialized_revision: string | number | null;
  superseded_by_id?: string | null;
  title: string;
  actor: string | null;
  goal: string | null;
  benefit: string | null;
}

interface CriterionRow {
  id: string;
  story_id: string;
  stable_id: string;
  authority: "planning" | "repository";
  revision: string | number;
  active: boolean;
  superseded_by_id?: string | null;
}

type Tx = TransactionSql<Record<string, never>>;

function asNumber(value: string | number | null): number {
  return value === null ? 0 : Number(value);
}

function jsonValue(tx: Tx, value: unknown): ReturnType<Tx["json"]> {
  return tx.json(value as Parameters<Tx["json"]>[0]);
}

function manifestCounts(manifest: ContractManifest): {
  stories: number;
  acceptanceCriteria: number;
} {
  const stories = manifest.capabilities.flatMap((capability) => capability.stories);
  return {
    stories: stories.length,
    acceptanceCriteria: stories.reduce(
      (total, story) => total + story.acceptance_criteria.length,
      0
    ),
  };
}

async function ensureRepository(
  tx: Tx,
  key: string,
  displayName = key
): Promise<string> {
  const existing = await tx<RepositoryRow[]>`
    select id from repositories where key = ${key}`;
  if (existing[0]) return existing[0].id;
  const inserted = await tx<RepositoryRow[]>`
    insert into repositories (key, display_name)
    values (${key}, ${displayName})
    on conflict (key) do update set display_name = repositories.display_name
    returning id`;
  return inserted[0].id;
}

async function recordRevision(
  tx: Tx,
  entityKind: "story" | "acceptance_criterion",
  entityId: string,
  revision: string | number,
  content: unknown
): Promise<void> {
  await tx`
    insert into contract_revisions (
      entity_kind, entity_id, revision, authority, content
    ) values (
      ${entityKind}, ${entityId}, ${asNumber(revision)}, 'repository',
      ${jsonValue(tx, content)}
    )
    on conflict (entity_kind, entity_id, revision) do nothing`;
}

async function ensureCodeAsset(
  tx: Tx,
  ownerRepositoryKey: string,
  link: ManifestLink
): Promise<string> {
  if (link.target.kind === "help") {
    throw new Error("Help locators cannot be stored as code assets.");
  }
  const targetRepositoryId = await ensureRepository(
    tx,
    link.target.repository,
    link.target.repository
  );
  const selector = link.target.selector ?? null;
  const frameworkHint =
    link.target.kind === "test" ? link.target.framework_hint ?? null : null;
  const ownsAsset = link.target.repository === ownerRepositoryKey;
  const currentContentHash = ownsAsset
    ? link.current_content_hash === undefined
      ? link.reviewed_content_hash
      : link.current_content_hash
    : undefined;
  const existing = await tx<{ id: string }[]>`
    select id
    from code_assets
    where repository_id = ${targetRepositoryId}
      and kind = ${link.target.kind}
      and path = ${link.target.path}
      and selector is not distinct from ${selector}
      and framework_hint is not distinct from ${frameworkHint}`;
  if (existing[0]) {
    if (ownsAsset) {
      await tx`
        update code_assets
        set content_hash = ${currentContentHash ?? null}
        where id = ${existing[0].id}
          and content_hash is distinct from ${currentContentHash ?? null}`;
    }
    return existing[0].id;
  }

  const inserted = await tx<{ id: string }[]>`
    insert into code_assets (
      repository_id, kind, path, selector, framework_hint, content_hash
    ) values (
      ${targetRepositoryId}, ${link.target.kind}, ${link.target.path},
      ${selector}, ${frameworkHint}, ${currentContentHash ?? null}
    )
    on conflict do nothing
    returning id`;
  if (inserted[0]) return inserted[0].id;

  const raced = await tx<{ id: string }[]>`
    select id
    from code_assets
    where repository_id = ${targetRepositoryId}
      and kind = ${link.target.kind}
      and path = ${link.target.path}
      and selector is not distinct from ${selector}
      and framework_hint is not distinct from ${frameworkHint}`;
  if (!raced[0]) {
    throw new Error(
      `Could not resolve ${ownerRepositoryKey} link to ${link.target.repository}:${link.target.path}.`
    );
  }
  if (ownsAsset) {
    await tx`
      update code_assets
      set content_hash = ${currentContentHash ?? null}
      where id = ${raced[0].id}
        and content_hash is distinct from ${currentContentHash ?? null}`;
  }
  return raced[0].id;
}

/**
 * Every code or test locator this manifest declares against its own
 * repository, keyed by the `code_assets` identity tuple
 * `(kind, path, selector, framework_hint)`. Locators aimed at another
 * repository are excluded: this repository does not own those rows and must
 * never treat their absence from its own manifest as a reason to touch them.
 */
function localCodeAssetLinks(
  manifest: ContractManifest
): Map<string, ManifestLink> {
  const localLinks = new Map<string, ManifestLink>();
  for (const capability of manifest.capabilities) {
    for (const story of capability.stories) {
      for (const link of [
        ...story.links,
        ...story.acceptance_criteria.flatMap((criterion) => criterion.links),
      ]) {
        if (
          link.target.kind === "help" ||
          link.target.repository !== manifest.repository.key
        ) continue;
        localLinks.set(
          JSON.stringify([
            link.target.kind,
            link.target.path,
            link.target.selector ?? null,
            link.target.kind === "test"
              ? link.target.framework_hint ?? null
              : null,
          ]),
          link
        );
      }
    }
  }
  return localLinks;
}

async function refreshCodeAssetHashes(
  tx: Tx,
  manifest: ContractManifest
): Promise<void> {
  for (const link of localCodeAssetLinks(manifest).values()) {
    await ensureCodeAsset(tx, manifest.repository.key, link);
  }
}

/**
 * Removes `code_assets` rows this repository no longer declares.
 *
 * Postgres is a projection of the repository manifest, so an asset whose
 * identity tuple leaves the manifest - a renamed path, a reworded selector,
 * the same file linked once with and once without a selector - must not
 * survive as an orphan. Orphans stay reachable: `search-context.ts` joins
 * `code_assets` by `(repository, kind, path, selector)` with a null request
 * selector matching any stored selector, so a frozen orphan keeps feeding the
 * `artifact_overlap` ranking signal and the noise grows with every rename.
 *
 * Two guards make the delete safe:
 *
 * 1. `repository_id` is pinned to the repository being synced. Links may aim
 *    at another repository (`ensureCodeAsset` resolves those through
 *    `link.target.repository`), and a sync of repository X must never delete
 *    an asset owned by repository Y.
 * 2. Both junction tables are checked globally rather than per repository, so
 *    an asset that any Story or Acceptance Criterion still references -
 *    including a retired one, and including one belonging to a different
 *    repository - is retained.
 */
async function reconcileCodeAssets(
  tx: Tx,
  repositoryId: string,
  manifest: ContractManifest
): Promise<number> {
  const kinds: string[] = [];
  const paths: string[] = [];
  const selectors: string[] = [];
  const frameworkHints: string[] = [];
  for (const link of localCodeAssetLinks(manifest).values()) {
    if (link.target.kind === "help") continue;
    kinds.push(link.target.kind);
    paths.push(link.target.path);
    selectors.push(link.target.selector ?? "");
    frameworkHints.push(
      link.target.kind === "test" ? link.target.framework_hint ?? "" : ""
    );
  }
  const removed = await tx<{ id: string }[]>`
    delete from code_assets asset
    where asset.repository_id = ${repositoryId}
      and not exists (
        select 1
        from unnest(
          ${kinds}::text[],
          ${paths}::text[],
          ${selectors}::text[],
          ${frameworkHints}::text[]
        ) as declared(kind, path, selector, framework_hint)
        where declared.kind = asset.kind
          and declared.path = asset.path
          and declared.selector = coalesce(asset.selector, '')
          and declared.framework_hint = coalesce(asset.framework_hint, '')
      )
      and not exists (
        select 1 from story_code_assets link where link.asset_id = asset.id
      )
      and not exists (
        select 1 from criterion_code_assets link where link.asset_id = asset.id
      )
    returning asset.id`;
  return removed.length;
}

async function ensureHelpArticle(tx: Tx, link: ManifestLink): Promise<string> {
  if (link.target.kind !== "help") {
    throw new Error("Code and test locators cannot be stored as help articles.");
  }
  const rows = await tx<{ id: string }[]>`
    insert into help_articles (source, external_id, url)
    values (${link.target.source}, ${link.target.external_id}, ${link.target.url ?? null})
    on conflict (source, external_id) do update
      set url = coalesce(excluded.url, help_articles.url)
    returning id`;
  return rows[0].id;
}

async function replaceStoryLinks(
  tx: Tx,
  ownerRepositoryKey: string,
  storyId: string,
  links: ManifestLink[]
): Promise<void> {
  await tx`delete from story_code_assets where story_id = ${storyId}`;
  await tx`delete from story_help_articles where story_id = ${storyId}`;
  for (const link of links) {
    if (link.target.kind === "help") {
      const articleId = await ensureHelpArticle(tx, link);
      await tx`
        insert into story_help_articles (
          story_id, article_id, relation, provenance
        ) values (
          ${storyId}, ${articleId}, 'documents', ${link.provenance}
        )
        on conflict do nothing`;
    } else {
      const assetId = await ensureCodeAsset(tx, ownerRepositoryKey, link);
      await tx`
        insert into story_code_assets (
          story_id, asset_id, relation, provenance, reviewed_content_hash
        ) values (
          ${storyId}, ${assetId}, ${link.relation}, ${link.provenance},
          ${link.reviewed_content_hash}
        )
        on conflict (story_id, asset_id, relation) do update
          set provenance = excluded.provenance,
              reviewed_content_hash = excluded.reviewed_content_hash`;
    }
  }
}

async function replaceCriterionLinks(
  tx: Tx,
  ownerRepositoryKey: string,
  criterionId: string,
  links: ManifestLink[]
): Promise<void> {
  await tx`delete from criterion_code_assets where criterion_id = ${criterionId}`;
  await tx`delete from criterion_help_articles where criterion_id = ${criterionId}`;
  for (const link of links) {
    if (link.target.kind === "help") {
      const articleId = await ensureHelpArticle(tx, link);
      await tx`
        insert into criterion_help_articles (
          criterion_id, article_id, relation, provenance
        ) values (
          ${criterionId}, ${articleId}, 'documents', ${link.provenance}
        )
        on conflict do nothing`;
    } else {
      const assetId = await ensureCodeAsset(tx, ownerRepositoryKey, link);
      await tx`
        insert into criterion_code_assets (
          criterion_id, asset_id, relation, provenance, reviewed_content_hash
        ) values (
          ${criterionId}, ${assetId}, ${link.relation}, ${link.provenance},
          ${link.reviewed_content_hash}
        )
        on conflict (criterion_id, asset_id, relation) do update
          set provenance = excluded.provenance,
              reviewed_content_hash = excluded.reviewed_content_hash`;
    }
  }
}

async function replaceStoryAliases(
  tx: Tx,
  storyId: string,
  aliases: string[]
): Promise<void> {
  await tx`delete from story_aliases where story_id = ${storyId}`;
  for (const alias of aliases) {
    await tx`
      insert into story_aliases (story_id, alias, authority)
      values (${storyId}, ${alias}, 'repository')`;
  }
}

async function replaceCriterionAliases(
  tx: Tx,
  criterionId: string,
  aliases: string[]
): Promise<void> {
  await tx`delete from criterion_aliases where criterion_id = ${criterionId}`;
  for (const alias of aliases) {
    await tx`
      insert into criterion_aliases (criterion_id, alias, authority)
      values (${criterionId}, ${alias}, 'repository')`;
  }
}

async function replaceScenarios(
  tx: Tx,
  criterionId: string,
  criterion: ManifestAcceptanceCriterion
): Promise<void> {
  await tx`
    update scenarios
    set active = false, authority = 'repository', updated_at = now()
    where criterion_id = ${criterionId}
      and (active or authority <> 'repository')`;
  for (const scenario of criterion.scenarios) {
    await tx`
      insert into scenarios (
        criterion_id, stable_id, name, given_text, when_text, then_text,
        position, active, authority
      ) values (
        ${criterionId}, ${scenario.stable_id}, ${scenario.name ?? null},
        ${scenario.given}, ${scenario.when}, ${scenario.then},
        ${scenario.position}, true, 'repository'
      )
      on conflict (criterion_id, stable_id) do update set
        name = excluded.name,
        given_text = excluded.given_text,
        when_text = excluded.when_text,
        then_text = excluded.then_text,
        position = excluded.position,
        active = true,
        authority = 'repository',
        updated_at = now()`;
  }
}

async function upsertCapability(
  tx: Tx,
  repositoryId: string,
  commit: string,
  capability: ManifestCapability
): Promise<string> {
  const rows = await tx<{ id: string }[]>`
    insert into capabilities (
      repository_id, stable_id, name, description, aliases, applies_to,
      active, repository_commit, contract_hash
    ) values (
      ${repositoryId}, ${capability.stable_id}, ${capability.name},
      ${capability.description}, ${capability.aliases},
      ${jsonValue(tx, capability.applies_to ?? {})}, true, ${commit},
      ${capability.contract_hash}
    )
    on conflict (repository_id, stable_id) do update set
      name = excluded.name,
      description = excluded.description,
      aliases = excluded.aliases,
      applies_to = excluded.applies_to,
      active = true,
      repository_commit = excluded.repository_commit,
      contract_hash = excluded.contract_hash,
      updated_at = now()
    returning id`;
  return rows[0].id;
}

async function planningStorySnapshot(
  tx: Tx,
  story: StoryRow
): Promise<Record<string, unknown>> {
  const criteria = await tx<
    Array<{
      id: string;
      stable_id: string;
      criterion: string | null;
      rationale: string | null;
      position: number;
      active: boolean;
      revision: string | number;
      aliases: string[];
      applies_to: Record<string, string[]>;
    }>
  >`
    select
      id, stable_id, criterion, rationale, position, active, revision,
      aliases, applies_to
    from acceptance_criteria
    where story_id = ${story.id} and authority = 'planning'
    order by position, stable_id`;
  const acceptanceCriteria: Array<Record<string, unknown>> = [];
  for (const criterion of criteria) {
    const scenarios = await tx<
      Array<{
        stable_id: string;
        name: string | null;
        given: string;
        when: string;
        then: string;
        position: number;
        active: boolean;
      }>
    >`
      select
        stable_id, name, given_text as given, when_text as when,
        then_text as then, position, active
      from scenarios
      where criterion_id = ${criterion.id}
      order by position, stable_id`;
    acceptanceCriteria.push({
      ...criterion,
      revision: asNumber(criterion.revision),
      scenarios,
    });
  }
  return {
    stable_id: story.stable_id,
    title: story.title,
    actor: story.actor,
    goal: story.goal,
    benefit: story.benefit,
    lifecycle: story.lifecycle,
    authority: story.authority,
    revision: asNumber(story.revision),
    acceptance_criteria: acceptanceCriteria,
  };
}

async function resolveHandoffConflicts(
  tx: Tx,
  storyId: string,
  materializedRevision: number | null
): Promise<void> {
  if (materializedRevision === null) return;
  const resolved = await tx<{ id: string }[]>`
    update handoff_conflicts
    set resolved_at = now()
    where story_id = ${storyId}
      and resolved_at is null
      and later_planning_revision <= ${materializedRevision}
    returning id`;
  for (const conflict of resolved) {
    await tx`
      insert into audit_events (
        event_kind, entity_kind, entity_id, detail
      ) values (
        'handoff_conflict_resolved', 'story', ${storyId},
        ${jsonValue(tx, {
          conflict_id: conflict.id,
          materialized_revision: materializedRevision,
        })}
      )`;
  }
}

async function upsertStory(
  tx: Tx,
  input: {
    repositoryId: string;
    repositoryKey: string;
    capabilityId: string;
    commit: string;
    story: ManifestStory;
    conflicts: HandoffConflict[];
    claimedPlanningStories: Set<string>;
  }
): Promise<string> {
  const { repositoryId, capabilityId, commit, story } = input;
  const rows = await tx<StoryRow[]>`
    select
      id, stable_id, authority::text, lifecycle::text, revision,
      materialized_revision, title, actor, goal, benefit
    from user_stories
    where repository_id = ${repositoryId} and stable_id = ${story.stable_id}
    for update`;
  const existing = rows[0];
  let storyId: string;
  let revision: string | number;
  let materializedRevision: number | null = story.planning_origin?.revision ?? null;

  if (!existing) {
    if (story.planning_origin) {
      throw new ContractSyncCollisionError(
        `Story '${story.stable_id}' names planning record '${story.planning_origin.record_id}', but that record does not exist in repository '${repositoryId}'.`
      );
    }
    const inserted = await tx<{ id: string; revision: string | number }[]>`
      insert into user_stories (
        repository_id, capability_id, stable_id, title, actor, goal, benefit,
        lifecycle, authority, aliases, applies_to, motivated_by,
        repository_commit, contract_hash
      ) values (
        ${repositoryId}, ${capabilityId}, ${story.stable_id}, ${story.title},
        ${story.actor}, ${story.goal}, ${story.benefit}, ${story.lifecycle},
        'repository', ${story.aliases}, ${jsonValue(tx, story.applies_to ?? {})},
        ${story.motivated_by}, ${commit}, ${story.contract_hash}
      )
      returning id, revision`;
    storyId = inserted[0].id;
    revision = inserted[0].revision;
  } else {
    if (existing.authority === "planning") {
      const origin = story.planning_origin;
      if (!origin || origin.record_id !== existing.id) {
        throw new ContractSyncCollisionError(
          `Story '${story.stable_id}' collides with planning record '${existing.id}'. Add matching planning_origin metadata before repository sync.`
        );
      }
      const currentRevision = asNumber(existing.revision);
      if (currentRevision < origin.revision) {
        throw new ContractSyncCollisionError(
          `Story '${story.stable_id}' claims planning revision ${origin.revision}, but the stored record is only revision ${currentRevision}.`
        );
      }
      if (currentRevision > origin.revision) {
        const planningContent = await planningStorySnapshot(tx, existing);
        await tx`
          insert into handoff_conflicts (
            repository_id, story_id, materialized_revision,
            later_planning_revision, merged_content, planning_content
          ) values (
            ${repositoryId}, ${existing.id}, ${origin.revision},
            ${currentRevision}, ${jsonValue(tx, story)}, ${jsonValue(tx, planningContent)}
          )
          on conflict (story_id, materialized_revision, later_planning_revision)
          do nothing`;
        input.conflicts.push({
          story_id: existing.id,
          story_stable_id: story.stable_id,
          materialized_revision: origin.revision,
          later_planning_revision: currentRevision,
        });
      }
      input.claimedPlanningStories.add(existing.id);
      materializedRevision = origin.revision;
    } else if (
      story.planning_origin &&
      story.planning_origin.record_id !== existing.id
    ) {
      throw new ContractSyncCollisionError(
        `Story '${story.stable_id}' has planning_origin '${story.planning_origin.record_id}', but repository identity is '${existing.id}'.`
      );
    } else {
      const existingMaterializedRevision =
        existing.materialized_revision === null
          ? null
          : asNumber(existing.materialized_revision);
      const origin = story.planning_origin;
      if (
        origin &&
        origin.revision > (existingMaterializedRevision ?? -1)
      ) {
        const knownPlanningRevision = await tx<{ present: boolean }[]>`
          select exists (
            select 1
            from contract_revisions
            where entity_kind = 'story'
              and entity_id = ${existing.id}
              and revision = ${origin.revision}
              and authority = 'planning'
          ) as present`;
        if (!knownPlanningRevision[0].present) {
          throw new ContractSyncCollisionError(
            `Story '${story.stable_id}' names unknown planning revision ${origin.revision}.`
          );
        }
        materializedRevision = origin.revision;
      } else {
        materializedRevision = existingMaterializedRevision;
      }
    }

    const updated = await tx<{ revision: string | number }[]>`
      update user_stories set
        capability_id = ${capabilityId},
        title = ${story.title},
        actor = ${story.actor},
        goal = ${story.goal},
        benefit = ${story.benefit},
        lifecycle = ${story.lifecycle},
        authority = 'repository',
        revision = revision + 1,
        materialized_revision = ${materializedRevision},
        aliases = ${story.aliases},
        applies_to = ${jsonValue(tx, story.applies_to ?? {})},
        motivated_by = ${story.motivated_by},
        repository_commit = ${commit},
        contract_hash = ${story.contract_hash}
      where id = ${existing.id}
      returning revision`;
    storyId = existing.id;
    revision = updated[0].revision;
  }

  await recordRevision(tx, "story", storyId, revision, story);
  await resolveHandoffConflicts(tx, storyId, materializedRevision);
  await replaceStoryAliases(tx, storyId, story.aliases);
  await replaceStoryLinks(tx, input.repositoryKey, storyId, story.links);
  return storyId;
}

async function upsertCriterion(
  tx: Tx,
  input: {
    repositoryId: string;
    repositoryKey: string;
    storyId: string;
    commit: string;
    criterion: ManifestAcceptanceCriterion;
    claimedPlanningStories: Set<string>;
  }
): Promise<string> {
  const { repositoryId, storyId, commit, criterion } = input;
  const rows = await tx<CriterionRow[]>`
    select id, story_id, stable_id, authority::text, revision, active
    from acceptance_criteria
    where repository_id = ${repositoryId} and stable_id = ${criterion.stable_id}
    for update`;
  const existing = rows[0];
  let criterionId: string;
  let revision: string | number;

  if (!existing) {
    const inserted = await tx<{ id: string; revision: string | number }[]>`
      insert into acceptance_criteria (
        story_id, repository_id, stable_id, criterion, rationale, position,
        active, authority, aliases, applies_to, repository_commit, contract_hash
      ) values (
        ${storyId}, ${repositoryId}, ${criterion.stable_id}, ${criterion.criterion},
        ${criterion.rationale}, ${criterion.position}, true, 'repository',
        ${criterion.aliases}, ${jsonValue(tx, criterion.applies_to ?? {})},
        ${commit}, ${criterion.contract_hash}
      )
      returning id, revision`;
    criterionId = inserted[0].id;
    revision = inserted[0].revision;
  } else {
    if (existing.story_id !== storyId) {
      throw new ContractSyncCollisionError(
        `Acceptance criterion '${criterion.stable_id}' belongs to a different Story and cannot be re-parented.`
      );
    }
    if (
      existing.authority === "planning" &&
      !input.claimedPlanningStories.has(storyId)
    ) {
      throw new ContractSyncCollisionError(
        `Acceptance criterion '${criterion.stable_id}' is planning-owned but its parent Story was not claimed by this manifest.`
      );
    }
    const updated = await tx<{ revision: string | number }[]>`
      update acceptance_criteria set
        criterion = ${criterion.criterion},
        rationale = ${criterion.rationale},
        position = ${criterion.position},
        active = true,
        authority = 'repository',
        revision = revision + 1,
        aliases = ${criterion.aliases},
        applies_to = ${jsonValue(tx, criterion.applies_to ?? {})},
        repository_commit = ${commit},
        contract_hash = ${criterion.contract_hash}
      where id = ${existing.id}
      returning revision`;
    criterionId = existing.id;
    revision = updated[0].revision;
  }

  await recordRevision(
    tx,
    "acceptance_criterion",
    criterionId,
    revision,
    criterion
  );
  await replaceCriterionAliases(tx, criterionId, criterion.aliases);
  await replaceScenarios(tx, criterionId, criterion);
  await replaceCriterionLinks(
    tx,
    input.repositoryKey,
    criterionId,
    criterion.links
  );
  return criterionId;
}

async function applySupersession(
  tx: Tx,
  repositoryId: string,
  manifest: ContractManifest
): Promise<void> {
  const capabilityRows = await tx<{
    id: string;
    stable_id: string;
    superseded_by_id: string | null;
  }[]>`
    select id, stable_id, superseded_by_id
    from capabilities
    where repository_id = ${repositoryId}`;
  const capabilityIds = new Map(
    capabilityRows.map((row) => [row.stable_id, row.id])
  );
  const capabilityTargets = new Map<string, string>();
  for (const capability of manifest.capabilities) {
    if (capability.supersedes) {
      capabilityTargets.set(capability.supersedes, capability.stable_id);
    }
  }
  for (const row of capabilityRows) {
    const targetId = capabilityTargets.has(row.stable_id)
      ? capabilityIds.get(capabilityTargets.get(row.stable_id)!) ?? null
      : null;
    if (row.superseded_by_id !== targetId) {
      await tx`
        update capabilities
        set superseded_by_id = ${targetId}, updated_at = now()
        where id = ${row.id}`;
    }
  }

  const storyRows = await tx<StoryRow[]>`
    select
      id, stable_id, authority::text, lifecycle::text, revision,
      materialized_revision, superseded_by_id, title, actor, goal, benefit
    from user_stories
    where repository_id = ${repositoryId} and authority = 'repository'`;
  const storyIds = new Map(storyRows.map((row) => [row.stable_id, row.id]));
  const storyTargets = new Map<string, string>();
  const storyContent = new Map<string, ManifestStory>();
  for (const capability of manifest.capabilities) {
    for (const story of capability.stories) {
      storyContent.set(story.stable_id, story);
      if (story.supersedes) storyTargets.set(story.supersedes, story.stable_id);
    }
  }
  for (const row of storyRows) {
    const targetStableId = storyTargets.get(row.stable_id);
    const targetId = targetStableId ? storyIds.get(targetStableId) ?? null : null;
    if (row.superseded_by_id !== targetId) {
      const updated = await tx<{ revision: string | number }[]>`
        update user_stories
        set superseded_by_id = ${targetId}, revision = revision + 1
        where id = ${row.id}
        returning revision`;
      await recordRevision(tx, "story", row.id, updated[0].revision, {
        ...(storyContent.get(row.stable_id) ?? {
          stable_id: row.stable_id,
          lifecycle: row.lifecycle,
        }),
        superseded_by: targetStableId ?? null,
      });
    }
  }

  const criterionRows = await tx<CriterionRow[]>`
    select
      id, story_id, stable_id, authority::text, revision, active,
      superseded_by_id
    from acceptance_criteria
    where repository_id = ${repositoryId} and authority = 'repository'`;
  const criterionIds = new Map(
    criterionRows.map((row) => [row.stable_id, row.id])
  );
  const criterionTargets = new Map<string, string>();
  const criterionContent = new Map<string, ManifestAcceptanceCriterion>();
  for (const capability of manifest.capabilities) {
    for (const story of capability.stories) {
      for (const criterion of story.acceptance_criteria) {
        criterionContent.set(criterion.stable_id, criterion);
        if (criterion.supersedes) {
          criterionTargets.set(criterion.supersedes, criterion.stable_id);
        }
      }
    }
  }
  for (const row of criterionRows) {
    const targetStableId = criterionTargets.get(row.stable_id);
    const targetId = targetStableId
      ? criterionIds.get(targetStableId) ?? null
      : null;
    if (row.superseded_by_id !== targetId) {
      const updated = await tx<{ revision: string | number }[]>`
        update acceptance_criteria
        set superseded_by_id = ${targetId}, revision = revision + 1
        where id = ${row.id}
        returning revision`;
      await recordRevision(
        tx,
        "acceptance_criterion",
        row.id,
        updated[0].revision,
        {
          ...(criterionContent.get(row.stable_id) ?? {
            stable_id: row.stable_id,
            active: row.active,
          }),
          superseded_by: targetStableId ?? null,
        }
      );
    }
  }
}

export class PostgresContractSyncRepository
  implements RepositorySyncStore
{
  constructor(private readonly sql: Sql<Record<string, never>>) {}

  async sync(
    manifest: ContractManifest,
    options: ContractSyncOptions
  ): Promise<ContractSyncResult> {
    const commit = options.commit.trim();
    if (!commit) throw new Error("Repository sync commit cannot be empty.");
    const counts = manifestCounts(manifest);
    return this.sql.begin(async (tx) => {
      await tx`
        select pg_advisory_xact_lock(
          hashtext('tieline-repository-sync'),
          hashtext(${manifest.repository.key})
        )`;
      const repositoryId = await ensureRepository(
        tx,
        manifest.repository.key,
        manifest.repository.key
      );
      const checkpoints = await tx<{ commit_sha: string }[]>`
        select commit_sha
        from repository_sync_checkpoints
        where repository_id = ${repositoryId}
        for update`;
      const currentCommit = checkpoints[0]?.commit_sha;

      if (currentCommit === commit) {
        await refreshCodeAssetHashes(tx, manifest);
        // Reconcile on the unchanged path too: re-running sync at the same
        // commit is how a projection carrying orphans from an earlier release
        // repairs itself, without forcing a rebuild from scratch.
        const reconciledCodeAssets = await reconcileCodeAssets(
          tx,
          repositoryId,
          manifest
        );
        return {
          outcome: "unchanged" as const,
          repository: manifest.repository.key,
          commit,
          stories: counts.stories,
          acceptance_criteria: counts.acceptanceCriteria,
          retired_stories: 0,
          retired_acceptance_criteria: 0,
          reconciled_code_assets: reconciledCodeAssets,
          conflicts: [],
        };
      }
      if (
        options.expectedPreviousCommit !== undefined &&
        options.expectedPreviousCommit !== currentCommit
      ) {
        throw new ContractSyncCheckpointError(
          `Repository '${manifest.repository.key}' is at '${currentCommit ?? "<never-synced>"}', not expected previous commit '${options.expectedPreviousCommit}'.`
        );
      }

      const capabilityIds = new Map<string, string>();
      for (const capability of manifest.capabilities) {
        capabilityIds.set(
          capability.stable_id,
          await upsertCapability(
            tx,
            repositoryId,
            commit,
            capability
          )
        );
      }
      const capabilityStableIds = manifest.capabilities.map(
        (capability) => capability.stable_id
      );
      await tx`
        update capabilities
        set active = false, updated_at = now()
        where repository_id = ${repositoryId}
          and active
          and stable_id <> all(${capabilityStableIds})`;

      const conflicts: HandoffConflict[] = [];
      const claimedPlanningStories = new Set<string>();
      const storyStableIds: string[] = [];
      const criterionStableIds: string[] = [];

      for (const capability of manifest.capabilities) {
        const capabilityId = capabilityIds.get(capability.stable_id)!;
        for (const story of capability.stories) {
          storyStableIds.push(story.stable_id);
          const storyId = await upsertStory(tx, {
            repositoryId,
            repositoryKey: manifest.repository.key,
            capabilityId,
            commit,
            story,
            conflicts,
            claimedPlanningStories,
          });
          for (const criterion of story.acceptance_criteria) {
            criterionStableIds.push(criterion.stable_id);
            await upsertCriterion(tx, {
              repositoryId,
              repositoryKey: manifest.repository.key,
              storyId,
              commit,
              criterion,
              claimedPlanningStories,
            });
          }
        }
      }

      const retiredStories = await tx<{ id: string; revision: string | number }[]>`
        update user_stories
        set lifecycle = 'retired',
            revision = revision + 1,
            repository_commit = ${commit}
        where repository_id = ${repositoryId}
          and authority = 'repository'
          and lifecycle <> 'retired'
          and stable_id <> all(${storyStableIds})
        returning id, revision`;
      for (const row of retiredStories) {
        await recordRevision(tx, "story", row.id, row.revision, {
          lifecycle: "retired",
          reason: "absent_from_repository_contract",
          repository_commit: commit,
        });
      }

      const retiredCriteria = await tx<{
        id: string;
        revision: string | number;
      }[]>`
        update acceptance_criteria
        set active = false,
            authority = 'repository',
            revision = revision + 1,
            repository_commit = ${commit}
        where repository_id = ${repositoryId}
          and (
            authority = 'repository'
            or story_id in (
              select id
              from user_stories
              where repository_id = ${repositoryId}
                and id = any(${[...claimedPlanningStories]})
            )
          )
          and (active or authority = 'planning')
          and stable_id <> all(${criterionStableIds})
        returning id, revision`;
      for (const row of retiredCriteria) {
        await recordRevision(
          tx,
          "acceptance_criterion",
          row.id,
          row.revision,
          {
            active: false,
            reason: "absent_from_repository_contract",
            repository_commit: commit,
          }
        );
      }
      const retiredCriterionIds = retiredCriteria.map((row) => row.id);
      if (retiredCriterionIds.length > 0) {
        await tx`
          update scenarios
          set active = false, authority = 'repository', updated_at = now()
          where criterion_id = any(${retiredCriterionIds})
            and (active or authority <> 'repository')`;
        await tx`
          update criterion_aliases
          set authority = 'repository'
          where criterion_id = any(${retiredCriterionIds})
            and authority <> 'repository'`;
      }

      await applySupersession(tx, repositoryId, manifest);

      // Runs last so every junction row this manifest declares has already
      // been rebuilt; anything still unreferenced is genuinely orphaned.
      const reconciledCodeAssets = await reconcileCodeAssets(
        tx,
        repositoryId,
        manifest
      );

      await tx`
        insert into repository_sync_checkpoints (
          repository_id, commit_sha, synced_at
        ) values (
          ${repositoryId}, ${commit}, now()
        )
        on conflict (repository_id) do update
          set commit_sha = excluded.commit_sha, synced_at = excluded.synced_at`;
      await tx`
        insert into audit_events (event_kind, detail)
        values (
          'repository_contract_synced',
          ${jsonValue(tx, {
            repository: manifest.repository.key,
            commit,
            stories: counts.stories,
            acceptance_criteria: counts.acceptanceCriteria,
            retired_stories: retiredStories.length,
            retired_acceptance_criteria: retiredCriteria.length,
            reconciled_code_assets: reconciledCodeAssets,
            handoff_conflicts: conflicts.length,
          })}
        )`;

      return {
        outcome: "synced" as const,
        repository: manifest.repository.key,
        commit,
        stories: counts.stories,
        acceptance_criteria: counts.acceptanceCriteria,
        retired_stories: retiredStories.length,
        retired_acceptance_criteria: retiredCriteria.length,
        reconciled_code_assets: reconciledCodeAssets,
        conflicts,
      };
    });
  }
}
