import assert from "node:assert/strict";
import postgres from "postgres";
import { migrateDatabase } from "../src/commands/migrate.js";
import { PostgresPlanningStoryRepository } from "../src/adapters/postgres/planning-story-repository.js";

const adminUrl = process.env.DATABASE_URL_ADMIN;
if (!adminUrl) {
  console.log(
    "SKIP - DATABASE_URL_ADMIN not set; planning integration needs a disposable database."
  );
  process.exit(0);
}

await migrateDatabase(adminUrl);
const sql = postgres(adminUrl, { max: 1, prepare: false });
const planning = new PostgresPlanningStoryRepository(() => sql);

async function asPlanningWriter<T>(operation: () => Promise<T>): Promise<T> {
  await sql.unsafe("set role tieline_planning_writer");
  try {
    return await operation();
  } finally {
    await sql.unsafe("reset role");
  }
}

try {
  const [repository] = await sql<{ id: string }[]>`
    insert into repositories (key, display_name)
    values ('planning-integration', 'Planning integration')
    returning id`;
  const [capability] = await sql<{ id: string }[]>`
    insert into capabilities (
      repository_id, stable_id, name, description
    ) values (
      ${repository.id}, 'CAP-PLANNING', 'Planning authoring',
      'Shape Stories and ACs before repository materialization.'
    )
    returning id`;

  const story = await asPlanningWriter(() =>
    planning.createPlanningStory({
      repository: "planning-integration",
      capability_stable_id: "CAP-PLANNING",
      stable_id: "US-PLANNING-001",
      title: "Shape a product contract",
      actor: "product teammate",
      goal: "shape desired behavior before implementation",
      benefit: "the implementation starts from shared intent",
      motivated_by: ["BL-PLANNING-001"],
      acceptance_criteria: [
        {
          stable_id: "AC-PLANNING-001",
          criterion:
            "Planning tools must preserve Story and AC stable identity",
          aliases: ["Keep planning identity"],
          scenarios: [
            {
              given: "a planning Story is materialized",
              when: "repository sync claims it",
              then: "its stable IDs remain unchanged",
            },
          ],
        },
      ],
    })
  );
  assert.equal(story.authority, "planning");
  assert.equal(story.lifecycle, "backlog");
  assert.equal(story.revision, 0);
  assert.equal(
    story.acceptance_criteria[0].stable_id,
    "AC-PLANNING-001"
  );

  const updated = await asPlanningWriter(() =>
    planning.updatePlanningStory({
      repository: "planning-integration",
      stable_id: story.stable_id,
      expected_revision: 0,
      benefit: "the implementation and intent move through review together",
      acceptance_criteria: [
        {
          stable_id: "AC-PLANNING-001",
          criterion:
            "Planning tools must preserve Story and AC stable identity",
          aliases: ["Keep planning identity", "Same IDs after merge"],
        },
      ],
    })
  );
  assert.equal(updated.outcome, "applied");
  if (updated.outcome !== "applied") {
    throw new Error("Expected planning update.");
  }
  assert.equal(updated.story.revision, 1);
  assert.deepEqual(updated.story.acceptance_criteria[0].aliases, [
    "Keep planning identity",
    "Same IDs after merge",
  ]);
  const [inactiveScenario] = await sql<{ active: boolean }[]>`
    select active
    from scenarios
    where criterion_id = ${updated.story.acceptance_criteria[0].id}`;
  assert.equal(inactiveScenario.active, false);

  await assert.rejects(
    asPlanningWriter(() =>
      planning.updatePlanningStory({
        repository: "planning-integration",
        stable_id: story.stable_id,
        expected_revision: 1,
        superseded_by: story.stable_id,
      })
    ),
    /cannot supersede itself/i
  );

  const cycleA = await asPlanningWriter(() =>
    planning.createPlanningStory({
      repository: "planning-integration",
      capability_stable_id: "CAP-PLANNING",
      stable_id: "US-PLANNING-CYCLE-A",
      title: "Cycle predecessor",
    })
  );
  const cycleB = await asPlanningWriter(() =>
    planning.createPlanningStory({
      repository: "planning-integration",
      capability_stable_id: "CAP-PLANNING",
      stable_id: "US-PLANNING-CYCLE-B",
      title: "Cycle successor",
    })
  );
  const linkedCycle = await asPlanningWriter(() =>
    planning.updatePlanningStory({
      repository: "planning-integration",
      stable_id: cycleA.stable_id,
      expected_revision: 0,
      superseded_by: cycleB.stable_id,
    })
  );
  assert.equal(linkedCycle.outcome, "applied");
  await assert.rejects(
    asPlanningWriter(() =>
      planning.updatePlanningStory({
        repository: "planning-integration",
        stable_id: cycleB.stable_id,
        expected_revision: 0,
        superseded_by: cycleA.stable_id,
      })
    ),
    /story supersession cycle/i
  );

  const concurrentCycleA = await asPlanningWriter(() =>
    planning.createPlanningStory({
      repository: "planning-integration",
      capability_stable_id: "CAP-PLANNING",
      stable_id: "US-PLANNING-CONCURRENT-A",
      title: "Concurrent cycle predecessor",
    })
  );
  const concurrentCycleB = await asPlanningWriter(() =>
    planning.createPlanningStory({
      repository: "planning-integration",
      capability_stable_id: "CAP-PLANNING",
      stable_id: "US-PLANNING-CONCURRENT-B",
      title: "Concurrent cycle successor",
    })
  );
  const concurrentSqlA = postgres(adminUrl, { max: 1, prepare: false });
  const concurrentSqlB = postgres(adminUrl, { max: 1, prepare: false });
  const concurrentPlanningA = new PostgresPlanningStoryRepository(
    () => concurrentSqlA
  );
  const concurrentPlanningB = new PostgresPlanningStoryRepository(
    () => concurrentSqlB
  );
  try {
    const concurrentResults = await Promise.allSettled([
      concurrentPlanningA.updatePlanningStory({
        repository: "planning-integration",
        stable_id: concurrentCycleA.stable_id,
        expected_revision: 0,
        superseded_by: concurrentCycleB.stable_id,
      }),
      concurrentPlanningB.updatePlanningStory({
        repository: "planning-integration",
        stable_id: concurrentCycleB.stable_id,
        expected_revision: 0,
        superseded_by: concurrentCycleA.stable_id,
      }),
    ]);
    assert.equal(
      concurrentResults.filter((result) => result.status === "fulfilled")
        .length,
      1
    );
    const rejectedConcurrent = concurrentResults.find(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected"
    );
    assert.match(String(rejectedConcurrent?.reason), /supersession cycle/i);
  } finally {
    await concurrentSqlA.end({ timeout: 5 });
    await concurrentSqlB.end({ timeout: 5 });
  }

  const removed = await asPlanningWriter(() =>
    planning.updatePlanningStory({
      repository: "planning-integration",
      stable_id: story.stable_id,
      expected_revision: 1,
      acceptance_criteria: [],
    })
  );
  assert.equal(removed.outcome, "applied");
  if (removed.outcome !== "applied") {
    throw new Error("Expected criterion removal.");
  }
  assert.equal(removed.story.revision, 2);
  assert.equal(removed.story.acceptance_criteria[0].active, false);
  const [removedCriterion] = await sql<{
    active: boolean;
    revision: string | number;
  }[]>`
    select active, revision
    from acceptance_criteria
    where id = ${removed.story.acceptance_criteria[0].id}`;
  assert.equal(removedCriterion.active, false);
  assert.equal(Number(removedCriterion.revision), 2);
  const criterionRevisions = await sql<{
    revision: string | number;
    content: {
      criterion: string | null;
      active: boolean;
      aliases: string[];
      scenarios: Array<{
        given: string;
        active: boolean;
      }>;
    };
  }[]>`
    select revision, content
    from contract_revisions
    where entity_kind = 'acceptance_criterion'
      and entity_id = ${removed.story.acceptance_criteria[0].id}
      and authority = 'planning'
    order by revision`;
  assert.deepEqual(
    criterionRevisions.map((entry) => Number(entry.revision)),
    [0, 1, 2]
  );
  assert.equal(
    criterionRevisions[0]!.content.criterion,
    "Planning tools must preserve Story and AC stable identity"
  );
  assert.equal(criterionRevisions[0]!.content.scenarios[0]!.active, true);
  assert.deepEqual(criterionRevisions[1]!.content.aliases, [
    "Keep planning identity",
    "Same IDs after merge",
  ]);
  assert.equal(criterionRevisions[1]!.content.scenarios[0]!.active, false);
  assert.equal(criterionRevisions[2]!.content.active, false);

  const stale = await asPlanningWriter(() =>
    planning.updatePlanningStory({
      repository: "planning-integration",
      stable_id: story.stable_id,
      expected_revision: 0,
      title: "Stale write",
    })
  );
  assert.deepEqual(stale, { outcome: "stale", current_revision: 2 });

  await sql`
    update user_stories
    set authority = 'repository', lifecycle = 'in_progress',
        revision = revision + 1
    where id = ${story.id}`;
  await sql`
    update acceptance_criteria
    set authority = 'repository', revision = revision + 1
    where story_id = ${story.id}`;
  const rejected = await asPlanningWriter(() =>
    planning.updatePlanningStory({
      repository: "planning-integration",
      stable_id: story.stable_id,
      expected_revision: 2,
      title: "Bypass repository review",
    })
  );
  assert.deepEqual(rejected, { outcome: "not_found" });
  assert.ok(capability.id);
} finally {
  await sql.unsafe("reset role").catch(() => undefined);
  await sql.end({ timeout: 5 });
}

console.log("planning integration passed");
