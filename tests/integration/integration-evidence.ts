import assert from "node:assert/strict";
import postgres from "postgres";
import { PostgresBacklogRepository } from "../../src/adapters/postgres/backlog-repository.js";
import { PostgresObservationRepository } from "../../src/adapters/postgres/observation-repository.js";
import { migrateDatabase } from "../../src/commands/migrate.js";
import { prepareObservation } from "../../src/domain/evidence-write-store.js";
import { PostgresSemanticRepository } from "../../src/adapters/postgres/semantic-repository.js";
import { observationEmbeddingDocument } from "../../src/derived/embedding-documents.js";
import { backlogEmbeddingDocument } from "../../src/derived/embedding-documents.js";
import { HashEmbedder } from "../../src/embeddings.js";
import { createHash } from "node:crypto";
import { withRole } from "../support/db.js";

const adminUrl = process.env.DATABASE_URL_ADMIN;
if (!adminUrl) {
  console.log(
    "SKIP - DATABASE_URL_ADMIN not set; evidence integration needs a disposable database."
  );
  process.exit(0);
}

await migrateDatabase(adminUrl);
const sql = postgres(adminUrl, { max: 1, prepare: false });
const observations = new PostgresObservationRepository(() => sql);
const backlog = new PostgresBacklogRepository(() => sql);
const deterministicEmbedder = new HashEmbedder();
const semantics = new PostgresSemanticRepository(
  () => sql,
  () => deterministicEmbedder
);

const asPlanningWriter = <T>(operation: () => Promise<T>): Promise<T> =>
  withRole(sql, "tieline_planning_writer", operation);
const asReader = <T>(operation: () => Promise<T>): Promise<T> =>
  withRole(sql, "tieline_reader", operation);

try {
  const [repository] = await sql<{ id: string }[]>`
    insert into repositories (key, display_name)
    values ('evidence-integration', 'Evidence integration')
    returning id`;
  const [capability] = await sql<{ id: string }[]>`
    insert into capabilities (
      repository_id, stable_id, name, description
    ) values (
      ${repository.id}, 'EVIDENCE', 'Evidence plane',
      'Requests, bugs, and questions remain independent evidence.'
    )
    returning id`;
  const [repositoryStory] = await sql<{ id: string }[]>`
    insert into user_stories (
      repository_id, capability_id, stable_id, title, actor, goal, benefit,
      lifecycle, authority
    ) values (
      ${repository.id}, ${capability.id}, 'EVIDENCE-001',
      'Capture observations', 'maintainer', 'record source evidence',
      'semantic context survives planning changes', 'production', 'repository'
    )
    returning id`;
  const [repositoryCriterion] = await sql<{ id: string }[]>`
    insert into acceptance_criteria (
      story_id, repository_id, stable_id, criterion, authority
    ) values (
      ${repositoryStory.id}, ${repository.id}, 'EVIDENCE-001-AC1',
      'Tieline must preserve observations without requiring a work item.',
      'repository'
    )
    returning id`;
  const [inactiveCriterion] = await sql<{ id: string }[]>`
    insert into acceptance_criteria (
      story_id, repository_id, stable_id, criterion, active, authority
    ) values (
      ${repositoryStory.id}, ${repository.id}, 'EVIDENCE-001-INACTIVE',
      'A retired implementation detail must stay outside default context.',
      false, 'repository'
    )
    returning id`;
  const [repositoryScenario] = await sql<{ id: string }[]>`
    insert into scenarios (
      criterion_id, stable_id, name, given_text, when_text, then_text,
      authority
    ) values (
      ${repositoryCriterion.id}, 'EVIDENCE-001-AC1-S1',
      'Preserve independent evidence',
      'an observation has no work item',
      'knowledge is searched',
      'the observation remains discoverable',
      'repository'
    )
    returning id`;
  const [searchAsset] = await sql<{ id: string }[]>`
    insert into code_assets (
      repository_id, kind, path
    ) values (
      ${repository.id}, 'code', 'src/evidence-search.ts'
    )
    returning id`;
  await sql`
    insert into code_assets (
      repository_id, kind, path, selector
    ) values (
      ${repository.id}, 'code', 'src/evidence-search.ts',
      'resolveEvidence'
    )`;
  await sql`
    insert into criterion_code_assets (
      criterion_id, asset_id, relation, provenance
    ) values (
      ${repositoryCriterion.id}, ${searchAsset.id}, 'implements', 'authored'
    )`;
  const [inactiveAsset] = await sql<{ id: string }[]>`
    insert into code_assets (
      repository_id, kind, path
    ) values (
      ${repository.id}, 'code', 'src/retired-evidence.ts'
    )
    returning id`;
  await sql`
    insert into criterion_code_assets (
      criterion_id, asset_id, relation, provenance
    ) values (
      ${inactiveCriterion.id}, ${inactiveAsset.id}, 'implements', 'authored'
    )`;
  const regionalCriteria = await sql<{ id: string; stable_id: string }[]>`
    insert into acceptance_criteria (
      story_id, repository_id, stable_id, criterion, authority
    ) values
      (
        ${repositoryStory.id}, ${repository.id}, 'EVIDENCE-001-US',
        'Tieline must find evidence applicable to the United States.',
        'repository'
      ),
      (
        ${repositoryStory.id}, ${repository.id}, 'EVIDENCE-001-EU',
        'Tieline must find evidence applicable to Europe.',
        'repository'
      ),
      (
        ${repositoryStory.id}, ${repository.id}, 'EVIDENCE-001-CA',
        'Tieline must find evidence applicable to Canada.',
        'repository'
      )
    returning id, stable_id`;
  const [planningStory] = await sql<{ id: string }[]>`
    insert into user_stories (
      repository_id, capability_id, stable_id, title, lifecycle, authority
    ) values (
      ${repository.id}, ${capability.id}, 'EVIDENCE-PLANNING-001',
      'Plan evidence consolidation', 'backlog', 'planning'
    )
    returning id`;
  const [planningCriterion] = await sql<{ id: string }[]>`
    insert into acceptance_criteria (
      story_id, repository_id, stable_id, criterion, authority
    ) values (
      ${planningStory.id}, ${repository.id}, 'EVIDENCE-PLANNING-001-AC1',
      null, 'planning'
    )
    returning id`;

  const requestInput = prepareObservation({
    kind: "request",
    schema_key: "request",
    schema_version: 1,
    summary: "Support needs AC-centered search.",
    source: "intercom",
    external_id: "thread-123",
    external_url: "https://example.test/private/thread-123",
    observed_at: "2026-07-29T12:00:00.000Z",
    payload: {
      requested_change: "Return direct AC evidence.",
      context: "SECRET-RAW-CONTEXT",
    },
  });
  const request = await asPlanningWriter(() =>
    observations.recordObservation(requestInput)
  );
  assert.equal(request.outcome, "created");
  const retried = await asPlanningWriter(() =>
    observations.recordObservation(requestInput)
  );
  assert.equal(retried.outcome, "existing");
  assert.equal(retried.id, request.id);

  const firstIndex = await asPlanningWriter(() =>
    semantics.upsertEmbeddingDocument(
      observationEmbeddingDocument(request)
    )
  );
  const secondIndex = await asPlanningWriter(() =>
    semantics.upsertEmbeddingDocument(
      observationEmbeddingDocument(request)
    )
  );
  assert.equal(firstIndex.embedded, true);
  assert.equal(secondIndex.embedded, false);
  const criterionText =
    "Capture observations\nTieline must preserve observations without requiring a work item.";
  await asPlanningWriter(() =>
    semantics.upsertEmbeddingDocument({
      entity_kind: "acceptance_criterion",
      entity_id: repositoryCriterion.id,
      document_kind: "acceptance_criterion",
      canonical_text: criterionText,
      source_text_hash: createHash("sha256")
        .update(criterionText)
        .digest("hex"),
      filter_metadata: {
        repository: "evidence-integration",
        authority: "repository",
        lifecycle: "production",
        active: true,
        story_id: repositoryStory.id,
        story_stable_id: "EVIDENCE-001",
        acceptance_criterion_id: repositoryCriterion.id,
        acceptance_criterion_stable_id: "EVIDENCE-001-AC1",
        aliases: [],
        applicability: {},
      },
    })
  );
  const storyText =
    "Capture observations\nAs a maintainer, I want to record source evidence so semantic context survives planning changes.";
  await asPlanningWriter(() =>
    semantics.upsertEmbeddingDocument({
      entity_kind: "story",
      entity_id: repositoryStory.id,
      document_kind: "story",
      canonical_text: storyText,
      source_text_hash: createHash("sha256").update(storyText).digest("hex"),
      filter_metadata: {
        repository: "evidence-integration",
        authority: "repository",
        lifecycle: "production",
        active: true,
        story_id: repositoryStory.id,
        story_stable_id: "EVIDENCE-001",
        aliases: [],
        applicability: {},
      },
    })
  );
  const scenarioText =
    "Preserve independent evidence\nGiven an observation has no work item\nWhen knowledge is searched\nThen the observation remains discoverable";
  await asPlanningWriter(() =>
    semantics.upsertEmbeddingDocument({
      entity_kind: "scenario",
      entity_id: repositoryScenario.id,
      document_kind: "scenario",
      canonical_text: scenarioText,
      source_text_hash: createHash("sha256")
        .update(scenarioText)
        .digest("hex"),
      filter_metadata: {
        repository: "evidence-integration",
        authority: "repository",
        lifecycle: "production",
        active: true,
        story_id: repositoryStory.id,
        story_stable_id: "EVIDENCE-001",
        acceptance_criterion_id: repositoryCriterion.id,
        acceptance_criterion_stable_id: "EVIDENCE-001-AC1",
        aliases: [],
        applicability: {},
      },
    })
  );
  const regionalApplicability = [
    { stableId: "EVIDENCE-001-US", region: "us" },
    { stableId: "EVIDENCE-001-EU", region: "eu" },
    { stableId: "EVIDENCE-001-CA", region: "ca" },
  ];
  const regionalCriteriaByStableId = new Map(
    regionalCriteria.map((criterion) => [criterion.stable_id, criterion])
  );
  for (const regional of regionalApplicability) {
    const criterion = regionalCriteriaByStableId.get(regional.stableId)!;
    const canonicalText = `Regional evidence\n${regional.stableId}`;
    await asPlanningWriter(() =>
      semantics.upsertEmbeddingDocument({
        entity_kind: "acceptance_criterion",
        entity_id: criterion.id,
        document_kind: "acceptance_criterion",
        canonical_text: canonicalText,
        source_text_hash: createHash("sha256")
          .update(canonicalText)
          .digest("hex"),
        filter_metadata: {
          repository: "evidence-integration",
          authority: "repository",
          lifecycle: "production",
          active: true,
          story_id: repositoryStory.id,
          story_stable_id: "EVIDENCE-001",
          acceptance_criterion_id: criterion.id,
          acceptance_criterion_stable_id: regional.stableId,
          aliases: [],
          applicability: { regions: [regional.region] },
        },
      })
    );
  }
  const applicabilityHits = await asPlanningWriter(async () => {
    const profile = await semantics.resolveRetrievalProfile("discovery");
    return semantics.searchSemantic({
      query: "regional evidence",
      embedding: await deterministicEmbedder.embed("regional evidence"),
      profile,
      filters: { applicability: { regions: ["us", "eu"] } },
      limit: 50,
    });
  });
  const applicabilityIds = new Set(
    applicabilityHits.map((hit) => hit.entity_id)
  );
  assert.ok(applicabilityIds.has(repositoryCriterion.id));
  assert.ok(
    applicabilityIds.has(
      regionalCriteriaByStableId.get("EVIDENCE-001-US")!.id
    )
  );
  assert.ok(
    applicabilityIds.has(
      regionalCriteriaByStableId.get("EVIDENCE-001-EU")!.id
    )
  );
  assert.ok(
    !applicabilityIds.has(
      regionalCriteriaByStableId.get("EVIDENCE-001-CA")!.id
    )
  );
  const semanticHits = await asPlanningWriter(async () => {
    const profile = await semantics.resolveRetrievalProfile("discovery");
    return semantics.searchSemantic({
      query: "preserve observations without a work item",
      embedding: await deterministicEmbedder.embed(
        "preserve observations without a work item"
      ),
      profile,
      limit: 5,
    });
  });
  assert.ok(
    semanticHits.some(
      (hit) =>
        hit.entity_kind === "acceptance_criterion" &&
        hit.entity_id === repositoryCriterion.id
    )
  );
  const suggestion = await asPlanningWriter(() =>
    semantics.saveAttributionSuggestion({
      source_kind: "observation",
      source_id: request.id,
      target_kind: "acceptance_criterion",
      target_id: repositoryCriterion.id,
      state: "suggested",
      method: "semantic_similarity",
      score: 0.9,
      rationale: { matched_level: "acceptance_criterion" },
    })
  );
  assert.equal(suggestion.state, "suggested");
  await asPlanningWriter(() =>
    semantics.decideAttributionSuggestion({
      suggestion_id: suggestion.id,
      decision: "dismissed",
    })
  );
  const pendingSuggestions = await asPlanningWriter(() =>
    semantics.listAttributionSuggestions({
      source_id: request.id,
    })
  );
  assert.equal(pendingSuggestions.length, 0);
  const dismissedSuggestions = await asPlanningWriter(() =>
    semantics.listAttributionSuggestions({
      source_id: request.id,
      state: ["dismissed"],
    })
  );
  assert.equal(dismissedSuggestions.length, 1);

  const bug = await asPlanningWriter(() =>
    observations.recordObservation(
      prepareObservation({
        kind: "bug",
        schema_key: "bug",
        schema_version: 1,
        summary: "A retired AC appears active.",
        source: "github",
        observed_at: "2026-07-29T12:05:00.000Z",
        payload: {
          expected_behavior: "The AC is inactive.",
          actual_behavior: "It appears active.",
        },
      })
    )
  );
  const question = await asPlanningWriter(() =>
    observations.recordObservation(
      prepareObservation({
        kind: "question",
        schema_key: "question",
        schema_version: 1,
        summary: "Who owns production definitions?",
        source: "slack",
        observed_at: "2026-07-29T12:10:00.000Z",
        payload: {
          question: "Does repository YAML own production definitions?",
        },
      })
    )
  );
  const dismissedQuestion = await asPlanningWriter(() =>
    observations.recordObservation(
      prepareObservation({
        kind: "question",
        schema_key: "question",
        schema_version: 1,
        summary: "Is a dismissed observation still labelled correctly?",
        source: "integration",
        observed_at: "2026-07-29T12:11:00.000Z",
        payload: {
          question:
            "Does semantic discovery preserve a dismissed attribution state?",
        },
      })
    )
  );
  const farObservation = await asPlanningWriter(() =>
    observations.recordObservation(
      prepareObservation({
        kind: "question",
        schema_key: "question",
        schema_version: 1,
        summary: "Can a fourth-hop observation influence local context?",
        source: "integration",
        observed_at: "2026-07-29T12:12:00.000Z",
        payload: {
          question: "Should contextual traversal stop after three hops?",
        },
      })
    )
  );
  assert.equal(bug.outcome, "created");
  assert.equal(question.outcome, "created");
  assert.equal(dismissedQuestion.outcome, "created");
  assert.equal(farObservation.outcome, "created");

  const correction = await asPlanningWriter(() =>
    observations.recordObservation(
      prepareObservation({
        kind: "request",
        schema_key: "request",
        schema_version: 1,
        summary: "Correction: support needs AC and Story context.",
        source: "intercom",
        external_id: "thread-123-correction",
        observed_at: "2026-07-29T12:15:00.000Z",
        payload: { requested_change: "Return AC and parent Story context." },
        supersedes_observation_id: request.id,
      })
    )
  );
  assert.equal(correction.supersedes_observation_id, request.id);
  const [original] = await sql<{ summary: string; payload: unknown }[]>`
    select summary, payload from observations where id = ${request.id}`;
  assert.equal(original.summary, "Support needs AC-centered search.");
  assert.deepEqual(original.payload, {
    requested_change: "Return direct AC evidence.",
    context: "SECRET-RAW-CONTEXT",
  });

  await assert.rejects(
    asPlanningWriter(() =>
      observations.recordObservation({
        ...requestInput,
        supersedes_observation_id: request.id,
      })
    ),
    /cannot supersede itself/i
  );
  await assert.rejects(
    asPlanningWriter(() =>
      observations.recordObservation({
        ...requestInput,
        supersedes_observation_id: correction.id,
      })
    ),
    /immutable.*supersedes relationship/i
  );

  const [searchColumns] = await sql<{ columns: string[] }[]>`
    select array_agg(column_name order by ordinal_position) as columns
    from information_schema.columns
    where table_schema = 'public' and table_name = 'observation_search'`;
  assert.ok(!searchColumns.columns.includes("payload"));
  const [requestSearch] = await sql<{ search_text: string }[]>`
    select search_text from observation_search where id = ${request.id}`;
  assert.ok(!requestSearch.search_text.includes("https://"));
  const [observationEmbeddings] = await sql<{ count: string }[]>`
    select count(*) from embedding_documents
    where entity_kind = 'observation' and entity_id = ${request.id}`;
  assert.equal(Number(observationEmbeddings.count), 1);
  const [storedObservationDocument] = await sql<{
    canonical_text: string;
    filter_metadata: Record<string, unknown>;
  }[]>`
    select canonical_text, filter_metadata
    from embedding_documents
    where entity_kind = 'observation' and entity_id = ${request.id}`;
  assert.ok(!storedObservationDocument.canonical_text.includes("https://"));
  assert.ok(
    !JSON.stringify(storedObservationDocument.filter_metadata).includes(
      "thread-123"
    )
  );

  const firstBacklog = await asPlanningWriter(() =>
    backlog.createBacklogItem({
      stable_id: "BL-EVIDENCE-001",
      title: "Improve evidence retrieval",
      summary: "Make AC evidence easy to find.",
    })
  );
  const secondBacklog = await asPlanningWriter(() =>
    backlog.createBacklogItem({
      stable_id: "BL-EVIDENCE-002",
      title: "Consolidate evidence workflows",
      summary: "Tie multiple observations to reusable work.",
      stage: "planned",
    })
  );
  assert.equal(firstBacklog.revision, 0);
  assert.equal(secondBacklog.revision, 0);

  const linkedFirst = await asPlanningWriter(() =>
    backlog.setBacklogItemLinks({
      stable_id: firstBacklog.stable_id,
      expected_revision: 0,
      links: {
        observation_ids: [request.id, bug.id],
        stories: [
          { repository: "evidence-integration", stable_id: "EVIDENCE-001" },
          {
            repository: "evidence-integration",
            stable_id: "EVIDENCE-PLANNING-001",
          },
        ],
        acceptance_criteria: [
          {
            repository: "evidence-integration",
            stable_id: "EVIDENCE-001-AC1",
          },
          {
            repository: "evidence-integration",
            stable_id: "EVIDENCE-PLANNING-001-AC1",
          },
        ],
      },
    })
  );
  assert.equal(linkedFirst.outcome, "applied");
  assert.equal(linkedFirst.item?.revision, 1);
  assert.equal(linkedFirst.links?.stories.length, 2);
  const readableBacklog = await asReader(() =>
    backlog.getBacklogItem({ stable_id: firstBacklog.stable_id })
  );
  assert.equal(readableBacklog?.item.revision, 1);
  assert.deepEqual(readableBacklog?.links.observation_ids, [
    bug.id,
    request.id,
  ].sort());
  assert.deepEqual(readableBacklog?.links.stories, [
    { repository: "evidence-integration", stable_id: "EVIDENCE-001" },
    {
      repository: "evidence-integration",
      stable_id: "EVIDENCE-PLANNING-001",
    },
  ]);
  assert.deepEqual(readableBacklog?.links.acceptance_criteria, [
    {
      repository: "evidence-integration",
      stable_id: "EVIDENCE-001-AC1",
    },
    {
      repository: "evidence-integration",
      stable_id: "EVIDENCE-PLANNING-001-AC1",
    },
  ]);

  const linkedSecond = await asPlanningWriter(() =>
    backlog.setBacklogItemLinks({
      stable_id: secondBacklog.stable_id,
      expected_revision: 0,
      links: {
        observation_ids: [request.id],
        stories: [],
        acceptance_criteria: [],
      },
    })
  );
  assert.equal(linkedSecond.outcome, "applied");
  const [requestBacklogs] = await sql<{ count: string }[]>`
    select count(*) from observation_backlog_attributions
    where observation_id = ${request.id}`;
  assert.equal(Number(requestBacklogs.count), 2);

  const stale = await asPlanningWriter(() =>
    backlog.updateBacklogItem({
      stable_id: firstBacklog.stable_id,
      expected_revision: 0,
      stage: "done",
    })
  );
  assert.deepEqual(stale, { outcome: "stale", current_revision: 1 });
  const moved = await asPlanningWriter(() =>
    backlog.updateBacklogItem({
      stable_id: firstBacklog.stable_id,
      expected_revision: 1,
      stage: "done",
    })
  );
  assert.equal(moved.outcome, "applied");
  if (moved.outcome !== "applied") throw new Error("Expected applied update.");
  assert.equal(moved.item.stage, "done");
  assert.equal(moved.item.revision, 2);
  await assert.rejects(
    asPlanningWriter(() =>
      backlog.updateBacklogItem({
        stable_id: firstBacklog.stable_id,
        expected_revision: 2,
        stage: "unknown" as never,
      })
    ),
    /invalid input value for enum backlog_stage/i
  );

  await assert.rejects(
    asPlanningWriter(() =>
      backlog.setBacklogItemLinks({
        stable_id: firstBacklog.stable_id,
        expected_revision: 2,
        links: {
          observation_ids: [request.id],
          stories: [
            {
              repository: "evidence-integration",
              stable_id: "DOES-NOT-EXIST",
            },
          ],
          acceptance_criteria: [],
        },
      })
    ),
    /Nothing was written/i
  );
  const [preservedLinks] = await sql<{ count: string }[]>`
    select count(*) from observation_backlog_attributions
    where backlog_item_id = ${firstBacklog.id}`;
  assert.equal(Number(preservedLinks.count), 2);

  const firstSuperseded = await asPlanningWriter(() =>
    backlog.updateBacklogItem({
      stable_id: firstBacklog.stable_id,
      expected_revision: 2,
      superseded_by: secondBacklog.stable_id,
    })
  );
  assert.equal(firstSuperseded.outcome, "applied");
  await assert.rejects(
    asPlanningWriter(() =>
      backlog.updateBacklogItem({
        stable_id: secondBacklog.stable_id,
        expected_revision: 1,
        superseded_by: firstBacklog.stable_id,
      })
    ),
    /supersession cycle/i
  );

  const concurrentFirst = await asPlanningWriter(() =>
    backlog.createBacklogItem({
      stable_id: "BL-EVIDENCE-CONCURRENT-001",
      title: "First concurrent consolidation",
      summary: "Exercise serialized backlog supersession.",
    })
  );
  const concurrentSecond = await asPlanningWriter(() =>
    backlog.createBacklogItem({
      stable_id: "BL-EVIDENCE-CONCURRENT-002",
      title: "Second concurrent consolidation",
      summary: "Exercise serialized backlog supersession.",
    })
  );
  const concurrentSqlA = postgres(adminUrl, { max: 1, prepare: false });
  const concurrentSqlB = postgres(adminUrl, { max: 1, prepare: false });
  const concurrentA = new PostgresBacklogRepository(() => concurrentSqlA);
  const concurrentB = new PostgresBacklogRepository(() => concurrentSqlB);
  try {
    const concurrentResults = await Promise.allSettled([
      concurrentA.updateBacklogItem({
        stable_id: concurrentFirst.stable_id,
        expected_revision: 0,
        superseded_by: concurrentSecond.stable_id,
      }),
      concurrentB.updateBacklogItem({
        stable_id: concurrentSecond.stable_id,
        expected_revision: 0,
        superseded_by: concurrentFirst.stable_id,
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

  const storyDecision = await asPlanningWriter(() =>
    observations.decideAttribution({
      observation_id: request.id,
      target_kind: "story",
      target: {
        repository: "evidence-integration",
        stable_id: "EVIDENCE-001",
      },
      relation: "requests_change",
      decision: "confirmed",
      decided_by: "integration",
    })
  );
  const criterionDecision = await asPlanningWriter(() =>
    observations.decideAttribution({
      observation_id: dismissedQuestion.id,
      target_kind: "acceptance_criterion",
      target: {
        repository: "evidence-integration",
        stable_id: "EVIDENCE-001-AC1",
      },
      relation: "violates",
      decision: "dismissed",
      decided_by: "integration",
    })
  );
  assert.equal(storyDecision.state, "confirmed");
  assert.equal(criterionDecision.state, "dismissed");

  await asPlanningWriter(() =>
    semantics.upsertEmbeddingDocument(
      observationEmbeddingDocument(dismissedQuestion)
    )
  );
  await asPlanningWriter(() =>
    semantics.upsertEmbeddingDocument(observationEmbeddingDocument(question))
  );
  await asPlanningWriter(() =>
    semantics.upsertEmbeddingDocument(
      observationEmbeddingDocument(farObservation)
    )
  );
  await asPlanningWriter(() =>
    semantics.upsertEmbeddingDocument(backlogEmbeddingDocument(moved.item))
  );
  await asPlanningWriter(() =>
    semantics.saveAttributionSuggestion({
      source_kind: "observation",
      source_id: question.id,
      target_kind: "acceptance_criterion",
      target_id: repositoryCriterion.id,
      state: "suggested",
      method: "semantic_similarity",
      score: 0.8,
      rationale: { test_case: "suggested edges do not affect proximity" },
    })
  );
  const farSuggestion = await asPlanningWriter(() =>
    semantics.saveAttributionSuggestion({
      source_kind: "observation",
      source_id: farObservation.id,
      target_kind: "scenario",
      target_id: repositoryScenario.id,
      state: "suggested",
      method: "semantic_similarity",
      score: 0.8,
      rationale: { test_case: "graph traversal stops at three hops" },
    })
  );
  await asPlanningWriter(() =>
    semantics.decideAttributionSuggestion({
      suggestion_id: farSuggestion.id,
      decision: "confirmed",
    })
  );

  const artifactContextHits = await asReader(async () => {
    const profile = await semantics.resolveRetrievalProfile("discovery");
    const query = "preserve observations without a work item";
    return semantics.searchSemantic({
      query,
      embedding: await deterministicEmbedder.embed(query),
      profile,
      context: {
        artifacts: [
          {
            kind: "code",
            repository: "evidence-integration",
            path: "src/evidence-search.ts",
          },
        ],
      },
      limit: 20,
    });
  });
  const artifactContextCriterion = artifactContextHits.find(
    (hit) => hit.entity_id === repositoryCriterion.id
  );
  assert.equal(artifactContextCriterion?.artifact_overlap, 1);
  assert.equal(artifactContextCriterion?.graph_proximity, 0);

  const unresolvedArtifactHits = await asReader(async () => {
    const profile = await semantics.resolveRetrievalProfile("discovery");
    const query = "preserve observations without a work item";
    return semantics.searchSemantic({
      query,
      embedding: await deterministicEmbedder.embed(query),
      profile,
      context: {
        artifacts: [
          {
            kind: "code",
            repository: "evidence-integration",
            path: "src/evidence-search.ts",
          },
          {
            kind: "code",
            repository: "evidence-integration",
            path: "src/does-not-exist.ts",
          },
        ],
      },
      limit: 20,
    });
  });
  assert.equal(
    unresolvedArtifactHits.find(
      (hit) => hit.entity_id === repositoryCriterion.id
    )?.artifact_overlap,
    0.5
  );

  const anchorContextHits = await asReader(async () => {
    const profile = await semantics.resolveRetrievalProfile("discovery");
    const query = "preserve observations without a work item";
    return semantics.searchSemantic({
      query,
      embedding: await deterministicEmbedder.embed(query),
      profile,
      filters: { include_inactive: false },
      context: {
        anchor: { kind: "observation", id: request.id },
      },
      limit: 50,
    });
  });
  const anchorContextCriterion = anchorContextHits.find(
    (hit) => hit.entity_id === repositoryCriterion.id
  );
  assert.equal(anchorContextCriterion?.artifact_overlap, 1);
  assert.equal(anchorContextCriterion?.graph_proximity, 0.5);
  assert.equal(
    anchorContextHits.find((hit) => hit.entity_id === repositoryScenario.id)
      ?.graph_proximity,
    0.25
  );
  assert.equal(
    anchorContextHits.find((hit) => hit.entity_id === farObservation.id)
      ?.graph_proximity,
    0
  );

  const suggestedContextHits = await asReader(async () => {
    const profile = await semantics.resolveRetrievalProfile("discovery");
    const query = "preserve observations without a work item";
    return semantics.searchSemantic({
      query,
      embedding: await deterministicEmbedder.embed(query),
      profile,
      context: {
        anchor: { kind: "observation", id: question.id },
      },
      limit: 20,
    });
  });
  assert.equal(
    suggestedContextHits.find(
      (hit) => hit.entity_id === repositoryCriterion.id
    )?.graph_proximity,
    0
  );

  const dismissedContextHits = await asReader(async () => {
    const profile = await semantics.resolveRetrievalProfile("discovery");
    const query = "preserve observations without a work item";
    return semantics.searchSemantic({
      query,
      embedding: await deterministicEmbedder.embed(query),
      profile,
      context: {
        anchor: { kind: "observation", id: dismissedQuestion.id },
      },
      limit: 20,
    });
  });
  assert.equal(
    dismissedContextHits.find(
      (hit) => hit.entity_id === repositoryCriterion.id
    )?.graph_proximity,
    0
  );

  const inactiveArtifactHits = await asReader(async () => {
    const profile = await semantics.resolveRetrievalProfile("discovery");
    const query = "capture observations";
    return semantics.searchSemantic({
      query,
      embedding: await deterministicEmbedder.embed(query),
      profile,
      filters: {
        document_kinds: ["story"],
        include_inactive: false,
      },
      context: {
        artifacts: [
          {
            kind: "code",
            repository: "evidence-integration",
            path: "src/retired-evidence.ts",
          },
        ],
      },
      limit: 20,
    });
  });
  assert.equal(
    inactiveArtifactHits.find((hit) => hit.entity_id === repositoryStory.id)
      ?.artifact_overlap,
    0
  );

  await assert.rejects(
    asReader(async () => {
      const profile = await semantics.resolveRetrievalProfile("discovery");
      const query = "preserve observations without a work item";
      return semantics.searchSemantic({
        query,
        embedding: await deterministicEmbedder.embed(query),
        profile,
        filters: { repositories: ["does-not-exist"] },
        context: {
          anchor: {
            kind: "observation",
            id: "00000000-0000-4000-8000-000000000099",
          },
        },
        limit: 20,
      });
    }),
    /Unknown observation search context anchor/i
  );
  const planningText =
    "Plan evidence consolidation\nPlanning evidence may remain incomplete";
  await asPlanningWriter(() =>
    semantics.upsertEmbeddingDocument({
      entity_kind: "acceptance_criterion",
      entity_id: planningCriterion.id,
      document_kind: "acceptance_criterion",
      canonical_text: planningText,
      source_text_hash: createHash("sha256").update(planningText).digest("hex"),
      filter_metadata: {
        repository: "evidence-integration",
        authority: "planning",
        lifecycle: "backlog",
        active: true,
        story_id: planningStory.id,
        story_stable_id: "EVIDENCE-PLANNING-001",
        acceptance_criterion_id: planningCriterion.id,
        acceptance_criterion_stable_id: "EVIDENCE-PLANNING-001-AC1",
        aliases: [],
        applicability: {},
      },
    })
  );

  const profileSearch = async (profileKey: string) => {
    const profile = await semantics.resolveRetrievalProfile(profileKey);
    return semantics.searchSemantic({
      query: "evidence planning observations",
      embedding: await deterministicEmbedder.embed(
        "evidence planning observations"
      ),
      profile,
      limit: 50,
    });
  };
  const supportHits = await asPlanningWriter(() => profileSearch("support"));
  assert.ok(supportHits.some((hit) => hit.entity_id === request.id));
  assert.ok(!supportHits.some((hit) => hit.entity_id === question.id));
  assert.ok(!supportHits.some((hit) => hit.entity_id === planningCriterion.id));
  assert.ok(!supportHits.some((hit) => hit.entity_id === moved.item.id));
  const contextualSupportHits = await asReader(async () => {
    const profile = await semantics.resolveRetrievalProfile("support");
    const query = "evidence planning observations";
    return semantics.searchSemantic({
      query,
      embedding: await deterministicEmbedder.embed(query),
      profile,
      context: {
        anchor: {
          kind: "acceptance_criterion",
          repository: "evidence-integration",
          stable_id: "EVIDENCE-PLANNING-001-AC1",
        },
      },
      limit: 50,
    });
  });
  assert.ok(
    !contextualSupportHits.some(
      (hit) => hit.entity_id === planningCriterion.id
    )
  );
  assert.ok(
    !contextualSupportHits.some((hit) => hit.entity_id === moved.item.id)
  );

  const engineeringHits = await asPlanningWriter(() =>
    profileSearch("engineering")
  );
  assert.ok(
    engineeringHits.some((hit) => hit.entity_id === repositoryCriterion.id)
  );
  assert.ok(
    !engineeringHits.some((hit) => hit.entity_id === planningCriterion.id)
  );
  assert.ok(!engineeringHits.some((hit) => hit.entity_id === moved.item.id));

  const discoveryHits = await asPlanningWriter(() =>
    profileSearch("discovery")
  );
  assert.ok(
    discoveryHits.some((hit) => hit.entity_id === planningCriterion.id)
  );
  assert.ok(discoveryHits.some((hit) => hit.entity_id === moved.item.id));
  assert.ok(discoveryHits.some((hit) => hit.entity_id === question.id));
  assert.equal(
    discoveryHits.find((hit) => hit.entity_id === dismissedQuestion.id)
      ?.metadata.attribution_state,
    "dismissed"
  );

  await assert.rejects(
    asPlanningWriter(async () => {
      const profile = await semantics.resolveRetrievalProfile("discovery");
      return semantics.searchSemantic({
        query: "evidence planning observations",
        embedding: await deterministicEmbedder.embed(
          "evidence planning observations"
        ),
        profile,
        filters: { authorities: [] },
        limit: 10,
      });
    }),
    /does not intersect/i
  );

  const [unattributedQuestion] = await sql<{ count: string }[]>`
    select (
      (select count(*) from observation_story_attributions where observation_id = ${question.id}) +
      (select count(*) from observation_criterion_attributions where observation_id = ${question.id}) +
      (select count(*) from observation_backlog_attributions where observation_id = ${question.id})
    )::text as count`;
  assert.equal(Number(unattributedQuestion.count), 0);

  const [auditLeak] = await sql<{ count: string }[]>`
    select count(*) from audit_events
    where detail::text like '%SECRET-RAW-CONTEXT%'`;
  assert.equal(Number(auditLeak.count), 0);
  assert.equal(repositoryCriterion.id.length > 0, true);
  assert.equal(planningCriterion.id.length > 0, true);
} finally {
  await sql.unsafe("reset role").catch(() => undefined);
  await sql.end({ timeout: 5 });
}

console.log("evidence integration passed");
