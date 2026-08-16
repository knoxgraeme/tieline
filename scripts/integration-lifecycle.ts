import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import postgres from "postgres";
import { PostgresBacklogRepository } from "../src/adapters/postgres/backlog-repository.js";
import { PostgresContractReadRepository } from "../src/adapters/postgres/contract-read-repository.js";
import { PostgresContractSyncRepository } from "../src/adapters/postgres/contract-sync-repository.js";
import { PostgresObservationRepository } from "../src/adapters/postgres/observation-repository.js";
import { PostgresPlanningStoryRepository } from "../src/adapters/postgres/planning-story-repository.js";
import { migrateDatabase } from "../src/commands/migrate.js";
import {
  attachCurrentArtifactHashes,
  compileContractManifest,
} from "../src/contract/manifest.js";
import { prepareObservation } from "../src/domain/evidence-write-store.js";
import { withRole } from "./lib/db.js";

const adminUrl = process.env.DATABASE_URL_ADMIN;
if (!adminUrl) {
  console.log(
    "SKIP - DATABASE_URL_ADMIN not set; lifecycle integration needs a disposable database."
  );
  process.exit(0);
}

const repositoryKey = "lifecycle-integration";
const capabilityKey = "LIFECYCLE";
const backlogKey = "BL-LIFECYCLE-001";
const storyKey = "US-LIFECYCLE-001";
const criterionKey = "AC-LIFECYCLE-001";
const storyDefinition = {
  title: "Preserve intent through delivery",
  actor: "maintainer",
  goal: "move observed needs through planning and implementation",
  benefit: "evidence remains connected to the production contract",
  criterion:
    "Tieline must preserve Story and AC identity when repository sync accepts planned intent.",
  scenario: {
    given:
      "an Observation is connected to a Backlog Item and planning Story",
    when: "reviewed YAML is synchronized from the repository",
    then: "the same Story and AC records become repository-owned",
  },
} as const;
const sql = postgres(adminUrl, { max: 1, prepare: false });
const observations = new PostgresObservationRepository(() => sql);
const backlog = new PostgresBacklogRepository(() => sql);
const planning = new PostgresPlanningStoryRepository(() => sql);
const reads = new PostgresContractReadRepository(() => sql);
const sync = new PostgresContractSyncRepository(() => sql);
const root = mkdtempSync(resolve(tmpdir(), "tieline-lifecycle-"));

function contractYaml(input: {
  planningRecordId: string;
  planningRevision: number;
  observationId: string;
}): string {
  return `version: 1
capability:
  key: ${capabilityKey}
  name: Unified lifecycle
  description: Evidence and planned intent become one repository-owned contract without changing identity.
  stories:
    - key: ${storyKey}
      title: ${storyDefinition.title}
      actor: ${storyDefinition.actor}
      goal: ${storyDefinition.goal}
      benefit: ${storyDefinition.benefit}
      lifecycle: production
      motivated_by:
        - ${backlogKey}
        - ${input.observationId}
      planning_origin:
        record_id: ${input.planningRecordId}
        revision: ${input.planningRevision}
      acceptance_criteria:
        - key: ${criterionKey}
          criterion: ${storyDefinition.criterion}
          scenarios:
            - given: ${storyDefinition.scenario.given}
              when: ${storyDefinition.scenario.when}
              then: ${storyDefinition.scenario.then}
          links:
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: ${repositoryKey}
                path: src/lifecycle.ts
            - relation: tests
              provenance: authored
              target:
                kind: test
                repository: ${repositoryKey}
                path: scripts/lifecycle.test.ts
                framework_hint: custom-script
`;
}

try {
  await migrateDatabase(adminUrl);
  mkdirSync(resolve(root, ".tieline/spec"), { recursive: true });
  mkdirSync(resolve(root, "src"), { recursive: true });
  mkdirSync(resolve(root, "scripts"), { recursive: true });
  writeFileSync(
    resolve(root, "src/lifecycle.ts"),
    "export const preservesLifecycleIdentity = true;\n"
  );
  writeFileSync(
    resolve(root, "scripts/lifecycle.test.ts"),
    "assert(preservesLifecycleIdentity);\n"
  );

  const [repository] = await sql<{ id: string }[]>`
    insert into repositories (key, display_name)
    values (${repositoryKey}, 'Lifecycle integration')
    returning id`;
  await sql`
    insert into capabilities (
      repository_id, stable_id, name, description
    ) values (
      ${repository.id}, ${capabilityKey}, 'Unified lifecycle',
      'Move evidence and planned intent into repository authority.'
    )`;

  const observation = await withRole(sql, "tieline_planning_writer", () =>
    observations.recordObservation(
      prepareObservation({
        kind: "bug",
        schema_key: "bug",
        schema_version: 1,
        summary: "Accepted product intent loses its evidence during delivery.",
        source: "intercom",
        external_id: "conversation-lifecycle-001",
        external_url:
          "https://example.test/intercom/conversation-lifecycle-001",
        observed_at: "2026-07-30T12:00:00.000Z",
        payload: {
          expected_behavior:
            "The production contract remains connected to its source evidence.",
          actual_behavior:
            "The team cannot follow an accepted Story back to the reported need.",
          reproduction:
            "Create a Backlog Item, materialize its Story, and inspect its links.",
        },
      })
    )
  );
  assert.equal(observation.outcome, "created");

  const backlogItem = await withRole(sql, "tieline_planning_writer", () =>
    backlog.createBacklogItem({
      stable_id: backlogKey,
      title: "Preserve evidence through delivery",
      summary:
        "Carry the originating Observation into the accepted product contract.",
    })
  );
  const observationLink = await withRole(sql, "tieline_planning_writer", () =>
    backlog.setBacklogItemLinks({
      stable_id: backlogItem.stable_id,
      expected_revision: backlogItem.revision,
      links: {
        observation_ids: [observation.id],
        stories: [],
        acceptance_criteria: [],
      },
    })
  );
  assert.equal(observationLink.outcome, "applied");
  if (observationLink.outcome !== "applied") {
    throw new Error("Expected the Observation to be linked to the Backlog Item.");
  }

  const planningStory = await withRole(sql, "tieline_planning_writer", () =>
    planning.createPlanningStory({
      repository: repositoryKey,
      capability_stable_id: capabilityKey,
      stable_id: storyKey,
      title: storyDefinition.title,
      actor: storyDefinition.actor,
      goal: storyDefinition.goal,
      benefit: storyDefinition.benefit,
      motivated_by: [backlogKey, observation.id],
      acceptance_criteria: [
        {
          stable_id: criterionKey,
          criterion: storyDefinition.criterion,
          scenarios: [storyDefinition.scenario],
        },
      ],
    })
  );
  const planningCriterion = planningStory.acceptance_criteria[0]!;
  assert.equal(planningStory.authority, "planning");
  assert.equal(planningStory.lifecycle, "backlog");

  const plannedLinks = await withRole(sql, "tieline_planning_writer", () =>
    backlog.setBacklogItemLinks({
      stable_id: backlogItem.stable_id,
      expected_revision: observationLink.item.revision,
      links: {
        observation_ids: [observation.id],
        stories: [{ repository: repositoryKey, stable_id: storyKey }],
        acceptance_criteria: [
          { repository: repositoryKey, stable_id: criterionKey },
        ],
      },
    })
  );
  assert.equal(plannedLinks.outcome, "applied");
  if (plannedLinks.outcome !== "applied") {
    throw new Error("Expected the planning targets to be linked.");
  }

  const attribution = await withRole(sql, "tieline_planning_writer", () =>
    observations.decideAttribution({
      observation_id: observation.id,
      target_kind: "acceptance_criterion",
      target: { repository: repositoryKey, stable_id: criterionKey },
      relation: "violates",
      decision: "confirmed",
      decided_by: "lifecycle-integration",
    })
  );
  assert.equal(attribution.target_id, planningCriterion.id);

  writeFileSync(
    resolve(root, ".tieline/spec/lifecycle.yaml"),
    contractYaml({
      planningRecordId: planningStory.id,
      planningRevision: planningStory.revision,
      observationId: observation.id,
    })
  );
  const manifest = attachCurrentArtifactHashes(
    compileContractManifest({
      repositoryRoot: root,
      repositoryKey,
    }),
    root
  );
  const materializedStory = manifest.capabilities[0]!.stories[0]!;
  assert.equal(materializedStory.planning_origin?.record_id, planningStory.id);

  const syncResult = await withRole(sql, "tieline_repository_sync", () =>
    sync.sync(manifest, {
      commit: "accepted-lifecycle-contract",
    })
  );
  assert.equal(syncResult.outcome, "synced");
  assert.deepEqual(syncResult.conflicts, []);

  const accepted = await withRole(sql, "tieline_reader", () =>
    reads.queryContractStories({
      filters: {
        repositories: [repositoryKey],
        story_keys: [storyKey],
      },
      limit: 1,
    })
  );
  assert.equal(accepted.mode, "records");
  if (accepted.mode !== "records") {
    throw new Error("Expected repository Story records.");
  }
  const acceptedStory = accepted.records[0]!;
  const acceptedCriterion = acceptedStory.acceptance_criteria[0]!;
  assert.equal(acceptedStory.id, planningStory.id);
  assert.equal(acceptedCriterion.id, planningCriterion.id);
  assert.equal(acceptedStory.authority, "repository");
  assert.equal(acceptedStory.lifecycle, "production");
  assert.deepEqual(
    acceptedStory.motivated_by,
    [backlogKey, observation.id].sort()
  );
  assert.equal(acceptedStory.coverage.implementation, "complete");
  assert.equal(acceptedStory.coverage.test, "complete");
  assert.equal(acceptedStory.freshness, "current");

  const preservedBacklog = await withRole(sql, "tieline_reader", () =>
    backlog.getBacklogItem({ stable_id: backlogKey })
  );
  assert.deepEqual(preservedBacklog?.links, plannedLinks.links);

  const [preservedAttribution] = await sql<{
    criterion_id: string;
    state: string;
  }[]>`
    select criterion_id, state::text
    from observation_criterion_attributions
    where observation_id = ${observation.id}
      and relation = 'violates'`;
  assert.equal(preservedAttribution.criterion_id, planningCriterion.id);
  assert.equal(preservedAttribution.state, "confirmed");

  const revisionAuthorities = await sql<{ authority: string }[]>`
    select distinct authority::text
    from contract_revisions
    where entity_kind = 'story' and entity_id = ${planningStory.id}
    order by authority`;
  assert.deepEqual(
    revisionAuthorities.map((row) => row.authority),
    ["planning", "repository"]
  );

  const rejectedPlanningWrite = await withRole(
    sql,
    "tieline_planning_writer",
    () =>
      planning.updatePlanningStory({
        repository: repositoryKey,
        stable_id: storyKey,
        expected_revision: acceptedStory.revision,
        title: "Planning must not edit repository truth",
      })
  );
  assert.equal(rejectedPlanningWrite.outcome, "not_found");

  const completedBacklog = await withRole(sql, "tieline_planning_writer", () =>
    backlog.updateBacklogItem({
      stable_id: backlogKey,
      expected_revision: plannedLinks.item.revision,
      stage: "done",
    })
  );
  assert.equal(completedBacklog.outcome, "applied");

  console.log("unified lifecycle integration passed");
} finally {
  rmSync(root, { recursive: true, force: true });
  await sql.unsafe("reset role").catch(() => undefined);
  await sql.end({ timeout: 5 });
}
