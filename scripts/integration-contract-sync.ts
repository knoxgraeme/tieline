import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import postgres from "postgres";
import { PostgresContractReadRepository } from "../src/adapters/postgres/contract-read-repository.js";
import { PostgresContractSyncRepository } from "../src/adapters/postgres/contract-sync-repository.js";
import { migrateDatabase } from "../src/commands/migrate.js";
import {
  attachCurrentArtifactHashes,
  compileContractManifest,
} from "../src/contract/manifest.js";
import {
  ContractSyncCheckpointError,
  ContractSyncCollisionError,
  type ContractSyncOptions,
  syncContractManifest,
} from "../src/contract/sync.js";
import type { ContractManifest } from "../src/contract/manifest.js";

const adminUrl = process.env.DATABASE_URL_ADMIN;
if (!adminUrl) {
  console.log(
    "SKIP - DATABASE_URL_ADMIN not set; contract sync integration needs a disposable database."
  );
  process.exit(0);
}

function contractYaml(input: {
  capabilityKey: string;
  storyKey: string;
  title: string;
  originId: string;
  originRevision: number;
  includeSecondCriterion?: boolean;
}): string {
  return `version: 1
capability:
  key: ${input.capabilityKey}
  name: Contract synchronization
  description: Repository truth is projected without losing planning history.
  applies_to:
    editions: [cloud]
    regions: [ca, us]
  stories:
    - key: ${input.storyKey}
      title: ${input.title}
      actor: maintainer
      goal: merge reviewed product intent with code
      benefit: repository and planning records keep one identity
      lifecycle: production
      applies_to:
        regions: [ca]
      planning_origin:
        record_id: ${input.originId}
        revision: ${input.originRevision}
      links:
        - relation: documents
          target:
            kind: help
            source: intercom
            external_id: story-fallback-help
      acceptance_criteria:
        - key: ${input.storyKey}-AC1
          criterion: Tieline must preserve a matching planning acceptance criterion identity.
          applies_to:
            roles: [admin]
          links:
            - relation: tests
              target:
                kind: test
                repository: sync-integration
                path: scripts/sync.test.ts
                framework_hint: custom
            - relation: documents
              target:
                kind: help
                source: intercom
                external_id: unresolved-help-article
${
  input.includeSecondCriterion
    ? `        - key: ${input.storyKey}-AC2
          criterion: Tieline must retire a removed acceptance criterion without deleting observations.
          supersedes: ${input.storyKey}-AC1
          scenarios:
            - given: an accepted criterion with linked observations
              when: the criterion is removed from repository YAML
              then: its projection must become inactive without deleting evidence
`
    : ""
}`;
}

await migrateDatabase(adminUrl);
const sql = postgres(adminUrl, { max: 1, prepare: false });
const root = mkdtempSync(resolve(tmpdir(), "tieline-contract-sync-"));
mkdirSync(resolve(root, ".tieline/spec"), { recursive: true });
mkdirSync(resolve(root, "scripts"), { recursive: true });
writeFileSync(resolve(root, "scripts/sync.test.ts"), "assert(contractSync);\n");

try {
  const [repository] = await sql<{ id: string }[]>`
    insert into repositories (key, display_name)
    values ('sync-integration', 'Sync integration')
    returning id`;
  const [planningStory] = await sql<{ id: string }[]>`
    insert into user_stories (
      repository_id, stable_id, title, lifecycle, authority
    ) values (
      ${repository.id}, 'SYNC-001', 'Plan contract synchronization', 'backlog', 'planning'
    )
    returning id`;
  const planningCriteria = await sql<{ id: string; stable_id: string }[]>`
    insert into acceptance_criteria (
      story_id, repository_id, stable_id, criterion, position, authority
    ) values
      (
        ${planningStory.id}, ${repository.id}, 'SYNC-001-AC1',
        'Tieline must preserve a matching planning acceptance criterion identity.',
        0, 'planning'
      ),
      (
        ${planningStory.id}, ${repository.id}, 'SYNC-001-AC2',
        'Tieline must preserve observations when accepted intent changes.',
        1, 'planning'
      ),
      (
        ${planningStory.id}, ${repository.id}, 'SYNC-001-AC3',
        'Tieline must transfer omitted planning criteria with their Story.',
        2, 'planning'
      )
    returning id, stable_id`;
  const ac1Id = planningCriteria.find((row) => row.stable_id === "SYNC-001-AC1")!.id;
  const ac2Id = planningCriteria.find((row) => row.stable_id === "SYNC-001-AC2")!.id;
  const ac3Id = planningCriteria.find((row) => row.stable_id === "SYNC-001-AC3")!.id;
  await sql`
    insert into criterion_aliases (criterion_id, alias, authority)
    values (${ac3Id}, 'Omitted planning criterion', 'planning')`;
  const [omittedScenario] = await sql<{ id: string }[]>`
    insert into scenarios (
      criterion_id, stable_id, given_text, when_text, then_text, authority
    ) values (
      ${ac3Id}, 'SYNC-001-AC3-S1', 'a planning Story is accepted',
      'its YAML omits one planning criterion',
      'the omitted child moves under repository authority as inactive',
      'planning'
    )
    returning id`;

  writeFileSync(
    resolve(root, ".tieline/spec/sync.yaml"),
    contractYaml({
      capabilityKey: "SYNC",
      storyKey: "SYNC-001",
      title: "Synchronize reviewed contract",
      originId: planningStory.id,
      originRevision: 0,
      includeSecondCriterion: true,
    })
  );

  const store = new PostgresContractSyncRepository(sql);
  const reads = new PostgresContractReadRepository(() => sql);
  const syncAsRepositoryRole = async (
    manifest: ContractManifest,
    options?: ContractSyncOptions
  ) => {
    await sql.unsafe("set role tieline_repository_sync");
    try {
      return await syncContractManifest(store, manifest, options);
    } finally {
      await sql.unsafe("reset role");
    }
  };
  const reviewedFirstManifest = compileContractManifest({
    repositoryRoot: root,
    repositoryKey: "sync-integration",
    commit: "commit-one",
  });
  writeFileSync(
    resolve(root, "scripts/sync.test.ts"),
    "assert(contractSync && changedAfterReview);\n"
  );
  const firstManifest = attachCurrentArtifactHashes(
    reviewedFirstManifest,
    root
  );
  const runInitialSync = async () => {
    const syncSql = postgres(adminUrl, { max: 1, prepare: false });
    try {
      await syncSql.unsafe("set role tieline_repository_sync");
      return await syncContractManifest(
        new PostgresContractSyncRepository(syncSql),
        firstManifest
      );
    } finally {
      await syncSql.unsafe("reset role");
      await syncSql.end({ timeout: 5 });
    }
  };
  const initialSyncs = await Promise.all([
    runInitialSync(),
    runInitialSync(),
  ]);
  assert.deepEqual(
    initialSyncs.map((result) => result.outcome).sort(),
    ["synced", "unchanged"]
  );
  const first = initialSyncs.find((result) => result.outcome === "synced")!;
  assert.equal(first.outcome, "synced");
  assert.deepEqual(first.conflicts, []);
  const reviewedTestLink =
    firstManifest.capabilities[0]!.stories[0]!.acceptance_criteria[0]!.links.find(
      (link) => link.target.kind === "test"
    )!;
  const [firstSyncedAsset] = await sql<{ content_hash: string | null }[]>`
    select asset.content_hash
    from code_assets asset
    join repositories target_repository
      on target_repository.id = asset.repository_id
    where target_repository.key = 'sync-integration'
      and asset.path = 'scripts/sync.test.ts'`;
  assert.equal(
    firstSyncedAsset.content_hash,
    reviewedTestLink.current_content_hash
  );

  const [materialized] = await sql<{
    id: string;
    authority: string;
    lifecycle: string;
    materialized_revision: string;
  }[]>`
    select id, authority::text, lifecycle::text, materialized_revision
    from user_stories
    where repository_id = ${repository.id} and stable_id = 'SYNC-001'`;
  assert.equal(materialized.id, planningStory.id);
  assert.equal(materialized.authority, "repository");
  assert.equal(materialized.lifecycle, "production");
  assert.equal(Number(materialized.materialized_revision), 0);

  const materializedCriteria = await sql<{
    id: string;
    stable_id: string;
    authority: string;
    active: boolean;
  }[]>`
    select id, stable_id, authority::text, active
    from acceptance_criteria
    where repository_id = ${repository.id}
    order by stable_id`;
  assert.equal(materializedCriteria[0]!.id, ac1Id);
  assert.equal(materializedCriteria[1]!.id, ac2Id);
  assert.ok(materializedCriteria.every((criterion) => criterion.authority === "repository"));
  assert.deepEqual(
    materializedCriteria.find((criterion) => criterion.id === ac3Id),
    {
      id: ac3Id,
      stable_id: "SYNC-001-AC3",
      authority: "repository",
      active: false,
    }
  );
  const [omittedScenarioAfter] = await sql<{
    active: boolean;
    authority: string;
  }[]>`
    select active, authority::text
    from scenarios
    where id = ${omittedScenario.id}`;
  assert.deepEqual(omittedScenarioAfter, {
    active: false,
    authority: "repository",
  });
  const [omittedAliasAfter] = await sql<{ authority: string }[]>`
    select authority::text
    from criterion_aliases
    where criterion_id = ${ac3Id}`;
  assert.equal(omittedAliasAfter.authority, "repository");

  await sql.unsafe("set role tieline_reader");
  const repositoryRead = await reads.queryContractStories({
    filters: {
      repositories: ["sync-integration"],
      story_keys: ["SYNC-001"],
    },
    limit: 1,
  });
  const criterionRead = await reads.getAcceptanceCriterion({
    repository: "sync-integration",
    stableId: "SYNC-001-AC1",
  });
  const repositoryGraph = await reads.contractGraph({
    repositories: ["sync-integration"],
  });
  await sql.unsafe("reset role");
  assert.equal(repositoryRead.mode, "records");
  if (repositoryRead.mode !== "records") {
    throw new Error("Expected repository contract records.");
  }
  const readStory = repositoryRead.records[0]!;
  assert.equal(
    readStory.rendered_story,
    "As a maintainer, I want to merge reviewed product intent with code, so that repository and planning records keep one identity."
  );
  assert.deepEqual(readStory.effective_applies_to, {
    editions: ["cloud"],
    regions: ["ca"],
  });
  assert.deepEqual(
    readStory.acceptance_criteria[0]!.effective_applies_to,
    {
      editions: ["cloud"],
      regions: ["ca"],
      roles: ["admin"],
    }
  );
  assert.deepEqual(readStory.coverage, {
    implementation: "none",
    test: "partial",
    help: "partial",
  });
  assert.equal(readStory.freshness, "stale");
  assert.equal(readStory.acceptance_criteria[0]!.freshness, "stale");
  assert.equal(
    readStory.acceptance_criteria[0]!.direct_links.find(
      (link) => link.relation === "tests"
    )?.freshness,
    "stale"
  );
  assert.equal(
    readStory.acceptance_criteria[0]!.fallback_story_links[0]!.scope,
    "story_fallback"
  );
  assert.equal(criterionRead?.criterion.direct_links.length, 2);
  assert.ok(
    repositoryGraph.edges.some(
      (edge) =>
        edge.source === "ac:sync-integration:SYNC-001-AC1" &&
        edge.relation === "tests"
    )
  );
  assert.ok(
    repositoryGraph.edges.some(
      (edge) =>
        edge.source === "ac:sync-integration:SYNC-001-AC1" &&
        edge.target === "ac:sync-integration:SYNC-001-AC2" &&
        edge.relation === "superseded_by"
    )
  );

  const [auditBeforeRepeat] = await sql<{ count: string }[]>`
    select count(*) from audit_events where event_kind = 'repository_contract_synced'`;
  const repeated = await syncAsRepositoryRole(firstManifest);
  const [auditAfterRepeat] = await sql<{ count: string }[]>`
    select count(*) from audit_events where event_kind = 'repository_contract_synced'`;
  assert.equal(repeated.outcome, "unchanged");
  assert.equal(auditAfterRepeat.count, auditBeforeRepeat.count);

  const [observation] = await sql<{ id: string }[]>`
    insert into observations (
      kind, schema_key, schema_version, summary, source, observed_at, payload, search_text
    ) values (
      'bug', 'bug.v1', 1, 'Removed behavior still has evidence', 'integration',
      now(), '{}', 'Removed behavior still has evidence'
    )
    returning id`;
  await sql`
    insert into observation_criterion_attributions (
      observation_id, criterion_id, relation, state, method, confidence
    ) values (
      ${observation.id}, ${ac2Id}, 'violates', 'confirmed', 'integration', 1
    )`;

  writeFileSync(
    resolve(root, ".tieline/spec/sync.yaml"),
    contractYaml({
      capabilityKey: "SYNC",
      storyKey: "SYNC-001",
      title: "Synchronize reviewed contract",
      originId: planningStory.id,
      originRevision: 0,
    })
  );
  const second = await syncAsRepositoryRole(
    compileContractManifest({
      repositoryRoot: root,
      repositoryKey: "sync-integration",
      commit: "commit-two",
    }),
    { expectedPreviousCommit: "commit-one" }
  );
  assert.equal(second.retired_acceptance_criteria, 1);
  const [retiredCriterion] = await sql<{ active: boolean }[]>`
    select active from acceptance_criteria where id = ${ac2Id}`;
  assert.equal(retiredCriterion.active, false);
  const [activeRetiredScenarios] = await sql<{ count: string }[]>`
    select count(*) from scenarios where criterion_id = ${ac2Id} and active`;
  assert.equal(Number(activeRetiredScenarios.count), 0);
  const [preservedAttribution] = await sql<{ count: string }[]>`
    select count(*) from observation_criterion_attributions
    where observation_id = ${observation.id} and criterion_id = ${ac2Id}`;
  assert.equal(Number(preservedAttribution.count), 1);

  const [collisionStory] = await sql<{ id: string }[]>`
    insert into user_stories (
      repository_id, stable_id, title, lifecycle, authority
    ) values (
      ${repository.id}, 'COLLISION-001', 'Unrelated planning work', 'backlog', 'planning'
    )
    returning id`;
  await sql.unsafe("set role tieline_reader");
  const planningRead = await reads.queryContractStories({
    filters: {
      repositories: ["sync-integration"],
      story_keys: ["COLLISION-001"],
      authorities: ["planning"],
    },
    limit: 1,
  });
  await sql.unsafe("reset role");
  assert.equal(planningRead.mode, "records");
  if (planningRead.mode !== "records") {
    throw new Error("Expected planning contract records.");
  }
  assert.equal(planningRead.records[0]!.rendered_story, null);
  assert.deepEqual(planningRead.records[0]!.coverage, {
    implementation: "not_applicable",
    test: "not_applicable",
    help: "not_applicable",
  });
  writeFileSync(
    resolve(root, ".tieline/spec/sync.yaml"),
    contractYaml({
      capabilityKey: "COLLISION",
      storyKey: "COLLISION-001",
      title: "Do not claim unrelated planning work",
      originId: "00000000-0000-4000-8000-000000000099",
      originRevision: 0,
    })
  );
  await assert.rejects(
    syncAsRepositoryRole(
      compileContractManifest({
        repositoryRoot: root,
        repositoryKey: "sync-integration",
        commit: "collision-commit",
      }),
      { expectedPreviousCommit: "commit-two" }
    ),
    ContractSyncCollisionError
  );
  const [collisionAfter] = await sql<{ authority: string }[]>`
    select authority::text from user_stories where id = ${collisionStory.id}`;
  assert.equal(collisionAfter.authority, "planning");
  const [checkpointAfterCollision] = await sql<{ commit_sha: string }[]>`
    select commit_sha from repository_sync_checkpoints where repository_id = ${repository.id}`;
  assert.equal(checkpointAfterCollision.commit_sha, "commit-two");

  const [conflictStory] = await sql<{ id: string }[]>`
    insert into user_stories (
      repository_id, stable_id, title, lifecycle, authority
    ) values (
      ${repository.id}, 'CONFLICT-001', 'Planning title at revision zero', 'backlog', 'planning'
    )
    returning id`;
  const [conflictCriterion] = await sql<{ id: string }[]>`
    insert into acceptance_criteria (
      story_id, repository_id, stable_id, criterion, position, authority
    ) values (
      ${conflictStory.id}, ${repository.id}, 'CONFLICT-001-AC1',
      'Later planning criterion content', 0, 'planning'
    )
    returning id`;
  await sql`
    insert into scenarios (
      criterion_id, stable_id, given_text, when_text, then_text, authority
    ) values (
      ${conflictCriterion.id}, 'CONFLICT-001-AC1-S1',
      'planning changes after materialization begins',
      'the repository definition is synchronized',
      'the complete later planning snapshot remains readable',
      'planning'
    )`;
  await sql`
    update user_stories
    set title = 'Later planning title', revision = revision + 1
    where id = ${conflictStory.id}`;
  await sql`
    insert into contract_revisions (
      entity_kind, entity_id, revision, authority, content
    ) values (
      'story', ${conflictStory.id}, 1, 'planning',
      ${{ title: "Later planning title" }}
    )`;
  writeFileSync(
    resolve(root, ".tieline/spec/sync.yaml"),
    contractYaml({
      capabilityKey: "CONFLICT",
      storyKey: "CONFLICT-001",
      title: "Merged repository title",
      originId: conflictStory.id,
      originRevision: 0,
    })
  );
  const conflictResult = await syncAsRepositoryRole(
    compileContractManifest({
      repositoryRoot: root,
      repositoryKey: "sync-integration",
      commit: "commit-three",
    }),
    { expectedPreviousCommit: "commit-two" }
  );
  assert.deepEqual(conflictResult.conflicts, [
    {
      story_id: conflictStory.id,
      story_stable_id: "CONFLICT-001",
      materialized_revision: 0,
      later_planning_revision: 1,
    },
  ]);
  const [conflict] = await sql<{
    merged_title: string;
    planning_title: string;
    planning_criteria: unknown[];
  }[]>`
    select
      merged_content->>'title' as merged_title,
      planning_content->>'title' as planning_title,
      planning_content->'acceptance_criteria' as planning_criteria
    from handoff_conflicts
    where story_id = ${conflictStory.id}`;
  assert.equal(conflict.merged_title, "Merged repository title");
  assert.equal(conflict.planning_title, "Later planning title");
  assert.equal(conflict.planning_criteria.length, 1);
  assert.deepEqual(
    (conflict.planning_criteria[0] as { scenarios: unknown[] }).scenarios
      .length,
    1
  );

  await sql.unsafe("set role tieline_reader");
  const visibleConflicts = await reads.listHandoffConflicts({
    repository: "sync-integration",
    story_stable_id: "CONFLICT-001",
  });
  await sql.unsafe("reset role");
  assert.equal(visibleConflicts.length, 1);
  assert.equal(visibleConflicts[0]?.planning_content.title, "Later planning title");

  writeFileSync(
    resolve(root, ".tieline/spec/sync.yaml"),
    contractYaml({
      capabilityKey: "CONFLICT",
      storyKey: "CONFLICT-001",
      title: "Reconciled repository title",
      originId: conflictStory.id,
      originRevision: 1,
    })
  );
  const reconciled = await syncAsRepositoryRole(
    compileContractManifest({
      repositoryRoot: root,
      repositoryKey: "sync-integration",
      commit: "commit-four",
    }),
    { expectedPreviousCommit: "commit-three" }
  );
  assert.deepEqual(reconciled.conflicts, []);
  await sql.unsafe("set role tieline_reader");
  const unresolvedAfterReconciliation = await reads.listHandoffConflicts({
    story_stable_id: "CONFLICT-001",
  });
  const conflictHistory = await reads.listHandoffConflicts({
    story_stable_id: "CONFLICT-001",
    include_resolved: true,
  });
  await sql.unsafe("reset role");
  assert.deepEqual(unresolvedAfterReconciliation, []);
  assert.ok(conflictHistory[0]?.resolved_at);

  await assert.rejects(
    syncAsRepositoryRole(
      compileContractManifest({
        repositoryRoot: root,
        repositoryKey: "sync-integration",
        commit: "delayed-old-commit",
      }),
      { expectedPreviousCommit: "commit-one" }
    ),
    ContractSyncCheckpointError
  );

  const [helpStub] = await sql<{ title: string | null; markdown: string | null }[]>`
    select title, markdown from help_articles
    where source = 'intercom' and external_id = 'unresolved-help-article'`;
  assert.equal(helpStub.title, null);
  assert.equal(helpStub.markdown, null);
} finally {
  await sql.end({ timeout: 5 });
  rmSync(root, { recursive: true, force: true });
}

console.log("contract sync integration passed");
