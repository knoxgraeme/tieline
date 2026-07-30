/**
 * DB-backed integration test for query_stories. Unlike scripts/smoke.ts (which
 * runs DB-absent and can only check wiring/error paths), this exercises the real
 * SQL against a live corpus — the only tier that can catch failures like a
 * malformed GROUP BY, a filter that doesn't actually narrow, or broken
 * zero-result suggestions.
 *
 * Read-only checks require DATABASE_URL (a read role is fine). Write checks
 * require dedicated TIELINE_TEST_DATABASE_URL* credentials plus an exact
 * TIELINE_CONFIRM_TEST_DATABASE acknowledgement. Generic write credentials are
 * deliberately ignored.
 *
 * Run read-only: DATABASE_URL=... npx tsx scripts/integration.ts
 */

import {
  clearGenericWriteDatabaseUrls,
  configureTestDatabase,
  hasTestDatabaseUrl,
  type TestDatabaseRole,
} from "./integration-safety.js";

const ingestChecksEnabled = hasTestDatabaseUrl(process.env, "ingest");
const lifecycleChecksRequested =
  hasTestDatabaseUrl(process.env, "write") ||
  hasTestDatabaseUrl(process.env, "approval");
const testRoles: TestDatabaseRole[] = [];
if (ingestChecksEnabled || lifecycleChecksRequested) testRoles.push("read");
if (ingestChecksEnabled) testRoles.push("ingest");
if (lifecycleChecksRequested) testRoles.push("write", "approval");

clearGenericWriteDatabaseUrls(process.env);
if (testRoles.length > 0) configureTestDatabase(testRoles, process.env);

if (!process.env.DATABASE_URL && !process.env.SUPABASE_DB_URL) {
  console.log("SKIP - DATABASE_URL not set; integration test needs a live corpus.");
  process.exit(0);
}
// query_stories needs no embeddings, but the server constructs find_related too.
process.env.EMBEDDING_PROVIDER = process.env.EMBEDDING_PROVIDER || "hash";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let closeSql: () => Promise<void> = async () => {};

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  ok  - ${name}`);
  } else {
    failed++;
    console.error(`  FAIL- ${name} ${detail}`);
  }
}

interface QueryResult {
  mode: string;
  total?: number;
  count?: number;
  group_by?: string | null;
  applied_filters?: Record<string, unknown>;
  records?: {
    story_key: string;
    status: string;
    section_key: string;
    actor: string | null;
    entity_slugs: string[];
    code_paths: string[];
  }[];
  groups?: { group: string; count: number }[];
  no_match?: boolean;
  suggestions?: { note: string; code_path?: string[]; entity_slug?: string[] };
}

async function main(): Promise<void> {
  const [{ createServer }, db, { getStore }] = await Promise.all([
    import("../src/server.js"),
    import("../src/db.js"),
    import("../src/store.js"),
  ]);
  const { approveStoryChange, rejectStoryChange } = db;
  closeSql = db.closeSql;

  if (ingestChecksEnabled) {
    const importedHelp = await getStore().importHelpArticles(
      [
        {
          article_slug: "integration-invite-teammates",
          title: "Invite teammates",
          summary: "Invite and manage project teammates",
          url: "https://example.test/help/invite-teammates",
          product_area: "projects",
          audience: "member",
          headings: ["Project access", "Invitations"],
          markdown: "# Invite teammates\nSend an invitation from the project access page.",
        },
      ],
      { batchSize: 1 }
    );
    check("KB batch importer upserts the fixture", importedHelp.articles === 1);
  }
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "integration-client", version: "0.0.0" });
  await client.connect(clientTransport);

  const query = async (args: Record<string, unknown>): Promise<QueryResult> => {
    const res = (await client.callTool({ name: "query_stories", arguments: args })) as {
      isError?: boolean;
      content: { type: string; text: string }[];
    };
    if (res.isError) throw new Error(`query_stories errored: ${res.content[0]?.text}`);
    return JSON.parse(res.content[0]!.text) as QueryResult;
  };
  const callTool = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { type: string; text: string }[];
    };
    const text = r.content[0]!.text;
    return { isError: r.isError, data: r.isError ? { error: text } : JSON.parse(text) };
  };

  console.log("baseline + sampling valid values from the live corpus");
  const baseline = await query({ limit: 200 });
  check("ungrouped baseline returns records", (baseline.total ?? 0) > 0, JSON.stringify(baseline).slice(0, 200));
  const sample = (baseline.records ?? []).find(
    (r) => r.actor && r.entity_slugs.length > 0 && r.code_paths.length > 0
  );
  check("found a sample story with actor + slug + path", Boolean(sample));
  if (!sample) {
    await finish(client, server);
    return;
  }
  const sampleStatus = sample.status;
  const sampleSection = sample.section_key;
  const sampleActor = sample.actor!;
  const sampleSlug = sample.entity_slugs[0]!;
  const samplePath = sample.code_paths[0]!;

  console.log("group_by (the path that previously threw a raw SQL error)");
  for (const field of ["section", "status", "actor"] as const) {
    const g = await query({ group_by: field });
    const ok =
      g.mode === "grouped" &&
      g.group_by === field &&
      Array.isArray(g.groups) &&
      g.groups.length > 0 &&
      g.groups.every((x) => typeof x.group === "string" && Number.isInteger(x.count));
    check(`group_by="${field}" returns clean grouped counts`, ok, JSON.stringify(g).slice(0, 200));
  }
  // Grouped counts must reconcile with the corpus total.
  const byStatus = await query({ group_by: "status" });
  const groupedTotal = (byStatus.groups ?? []).reduce((s, x) => s + x.count, 0);
  check("grouped counts sum to the corpus total", groupedTotal === baseline.total, `${groupedTotal} vs ${baseline.total}`);

  console.log("top-level filters actually narrow, and only to matching rows");
  const byStatusFlat = await query({ status: [sampleStatus] });
  check(
    `status=[${sampleStatus}] returns only that status`,
    (byStatusFlat.records ?? []).every((r) => r.status === sampleStatus) && (byStatusFlat.total ?? -1) <= (baseline.total ?? 0),
    JSON.stringify(byStatusFlat.applied_filters)
  );
  const bySection = await query({ section_key: [sampleSection] });
  check(
    `section_key=[${sampleSection}] returns only that section`,
    (bySection.records ?? []).every((r) => r.section_key === sampleSection) && (bySection.total ?? 0) > 0
  );
  const byActor = await query({ actor: [sampleActor] });
  check(
    `actor=[${sampleActor}] returns only that actor`,
    (byActor.records ?? []).every((r) => r.actor === sampleActor) && (byActor.total ?? 0) > 0
  );
  const bySlug = await query({ entity_slug: sampleSlug });
  check(
    `entity_slug=${sampleSlug} returns only stories carrying that slug`,
    (bySlug.records ?? []).every((r) => r.entity_slugs.includes(sampleSlug)) && (bySlug.total ?? 0) > 0
  );
  const byPath = await query({ code_path: samplePath });
  check(
    `code_path=${samplePath} returns only stories touching that path`,
    (byPath.records ?? []).every((r) => r.code_paths.includes(samplePath)) && (byPath.total ?? 0) > 0
  );

  console.log("applied_filters echo reflects what was sent");
  check(
    "applied_filters echoes the entity_slug filter",
    bySlug.applied_filters?.entity_slug === sampleSlug,
    JSON.stringify(bySlug.applied_filters)
  );
  check(
    "no-filter query reports applied_filters as empty",
    Object.keys(baseline.applied_filters ?? { x: 1 }).length === 0
  );

  console.log("nested filters{} back-compat matches the flat form");
  const nested = await query({ filters: { entity_slug: sampleSlug } });
  check("nested filters produce the same total as flat", nested.total === bySlug.total, `${nested.total} vs ${bySlug.total}`);

  console.log("zero-result suggestions (the recovery path)");
  const bogus = await query({ code_path: "src/this/path/does/not/exist.xyz" });
  check("bogus path -> total 0 + no_match flag", bogus.total === 0 && bogus.no_match === true);
  check("bogus path -> suggestions carries a note (not mistaken for results)", Boolean(bogus.suggestions?.note) && (bogus.records ?? []).length === 0);

  // Near-miss: pass only the basename of a real path; suggestions should resolve
  // the canonical full path. This is the exact situation the feedback agent hit.
  const base = samplePath.split("/").pop()!;
  if (base !== samplePath) {
    const nearMiss = await query({ code_path: base });
    const resolved = nearMiss.total === 0 && (nearMiss.suggestions?.code_path ?? []).includes(samplePath);
    check(`bare filename "${base}" -> suggests the canonical full path`, resolved, JSON.stringify(nearMiss.suggestions).slice(0, 200));
  }

  if (ingestChecksEnabled) {
    console.log("KB filtering + read-only suggestions");
    const help = await callTool("find_help", {
      query: "Invite teammates Invite and manage project teammates Project access Invitations",
      product_area: ["projects"],
      audience: ["member"],
    });
    check(
      "find_help applies facets before limit and returns the exact article",
      help.data.results?.[0]?.article_slug === "integration-invite-teammates",
      JSON.stringify(help.data).slice(0, 220)
    );
    const excluded = await callTool("find_help", {
      query: "Invite teammates Invite and manage project teammates Project access Invitations",
      product_area: ["does-not-exist"],
    });
    check("find_help unknown facet returns intentional empty", excluded.data.results?.length === 0);
    const suggestions = await callTool("suggest_story_help_links", {
      article_slug: "integration-invite-teammates",
      min_score: 0,
      limit: 5,
    });
    check(
      "story/help suggestions are read-only ranked pairs",
      suggestions.data.direction === "article_to_stories" && suggestions.data.suggestions?.length > 0
    );
  }

  // --- lifecycle + write round-trip ----------------------------------------
  // Runs only with the least-privilege writer plus dedicated human approver.
  // Test stories intentionally remain in the audit corpus: history is immutable,
  // so deleting them as "cleanup" would violate the behavior under test.
  if (lifecycleChecksRequested) {
    console.log("lifecycle round-trip (writer + human-only approver)");
    const created = await callTool("create_user_story", {
        section_key: sampleSection,
        title: "[itest] triage story",
        story_text: "As a tester, I want the write path proven so that triage is reliable.",
        actor: "member",
        status: "feature_request",
        reason: "integration lifecycle check",
      });
    const storyKey = created.data.story?.story_key as string | undefined;
    check(
      "non-production create applies with revision 1",
      created.data.outcome === "applied" && created.data.revision_number === 1 && Boolean(storyKey),
      JSON.stringify(created.data).slice(0, 200)
    );

    const prod = await callTool("create_user_story", {
        section_key: sampleSection,
        title: "[itest] production story",
        story_text: "As a tester, I want to confirm production stories can be created.",
        status: "production",
        reason: "integration production gate",
        proposed_by: "integration",
      });
    const proposalId = prod.data.proposal?.id as number | undefined;
    const proposedKey = prod.data.proposal?.story_key as string | undefined;
    check(
      "production create is proposed, not directly written",
      prod.data.outcome === "proposed" && Boolean(proposalId) && Boolean(proposedKey),
      JSON.stringify(prod.data).slice(0, 220)
    );
    if (proposedKey) {
      const beforeApproval = await query({ story_key: [proposedKey] });
      check("pending production create is absent from current search", beforeApproval.total === 0);
    }
    if (proposalId) {
      const approved = await approveStoryChange({
        proposalId,
        decidedBy: "integration-human",
        note: "approved by integration suite",
      });
      check("dedicated approver applies production create", approved.outcome === "approved", JSON.stringify(approved));
      const afterApproval = await query({ story_key: [proposedKey!] });
      check("approved production create becomes searchable", afterApproval.total === 1);

      const productionEdit = await callTool("update_user_story", {
        story_key: proposedKey,
        title: "[itest] approved production story",
        expected_revision: 1,
        reason: "verify production edit gate",
      });
      check(
        "production content edit becomes a proposal",
        productionEdit.data.outcome === "proposed",
        JSON.stringify(productionEdit.data).slice(0, 200)
      );
      if (productionEdit.data.proposal?.id) {
        const editApproval = await approveStoryChange({
          proposalId: productionEdit.data.proposal.id,
          decidedBy: "integration-human",
        });
        check("approved production edit creates revision 2", editApproval.revision_number === 2);
      }

      const productionRelationship = await callTool("update_story_relationships", {
        story_key: proposedKey,
        expected_revision: 2,
        entities: { add: [{ entity_slug: "approved-production" }] },
        reason: "verify production relationship gate",
      });
      check("production relationship edit becomes a proposal", productionRelationship.data.outcome === "proposed");
      if (productionRelationship.data.proposal?.id) {
        const relationshipApproval = await approveStoryChange({
          proposalId: productionRelationship.data.proposal.id,
          decidedBy: "integration-human",
        });
        check("human approval applies production relationship", relationshipApproval.outcome === "approved");
      }
    }

    const rejectedCreate = await callTool("create_user_story", {
      section_key: sampleSection,
      title: "[itest] rejected production story",
      story_text: "As a tester, I want rejection to remain terminal and auditable.",
      status: "production",
      proposed_by: "integration",
    });
    if (rejectedCreate.data.proposal?.id) {
      const rejected = await rejectStoryChange({
        proposalId: rejectedCreate.data.proposal.id,
        decidedBy: "integration-human",
        note: "rejection path check",
      });
      check("human rejection is terminal", rejected === "rejected");
      const proposals = await callTool("list_story_change_proposals", {
        status: ["rejected"],
        story_key: rejectedCreate.data.proposal.story_key,
      });
      check(
        "read-only proposal tool retrieves the rejected decision",
        proposals.data.proposals?.some((proposal: { id: number; status: string }) =>
          proposal.id === rejectedCreate.data.proposal.id && proposal.status === "rejected"
        )
      );
    }

    const promoted = await callTool("update_user_story", {
      story_key: storyKey,
      status: "in_progress",
      expected_revision: 1,
      reason: "start work",
    });
    check(
      "non-production update applies and increments revision",
      promoted.data.outcome === "applied" && promoted.data.revision_number === 2,
      JSON.stringify(promoted.data).slice(0, 180)
    );

    const stale = await callTool("update_user_story", {
      story_key: storyKey,
      title: "[itest] stale overwrite",
      expected_revision: 1,
    });
    check("stale revision is rejected without writing", stale.data.outcome === "stale");

    const related = await callTool("update_story_relationships", {
      story_key: storyKey,
      expected_revision: 2,
      entities: { add: [{ entity_slug: "integration-lifecycle" }] },
      code_assets: { add: [{ repo: "tieline-integration", path: "src/integration/lifecycle.ts" }] },
      reason: "relationship parity check",
    });
    check(
      "typed non-production relationships apply atomically",
      related.data.outcome === "applied",
      JSON.stringify(related.data).slice(0, 180)
    );

    const failedRelationship = await callTool("update_story_relationships", {
      story_key: storyKey,
      expected_revision: 2,
      entities: { add: [{ entity_slug: "must-roll-back" }] },
      help_articles: { add: [{ article_slug: "unknown-help-article" }] },
    });
    check("unknown relationship reference rejects the whole patch", failedRelationship.isError === true);
    const rolledBack = await query({ entity_slug: "must-roll-back" });
    check("failed multi-family patch leaves no partial entity", rolledBack.total === 0);

    const replacedRelationships = await callTool("update_story_relationships", {
      story_key: storyKey,
      expected_revision: 2,
      entities: { replace: [] },
      code_assets: { replace: [] },
      help_articles: {
        replace: [
          {
            article_slug: "integration-invite-teammates",
            relationship_type: "supporting",
            confidence: 0.9,
          },
        ],
      },
      reason: "replace/clear parity check",
    });
    check("replace=[] clears families while help metadata updates", replacedRelationships.data.outcome === "applied");
    const relationshipState = await query({ story_key: [storyKey] });
    const relationshipRecord = relationshipState.records?.[0] as unknown as {
      entity_slugs: string[];
      code_paths: string[];
      help_article_count: number;
    };
    check(
      "relationship replacement is visible in current projection",
      relationshipRecord.entity_slugs.length === 0 &&
        relationshipRecord.code_paths.length === 0 &&
        relationshipRecord.help_article_count === 1
    );

    const history = await callTool("get_story_history", { story_key: storyKey });
    check(
      "history exposes revisions and semantic events",
      history.data.history?.current?.revision_number >= 2 &&
        history.data.history?.revisions?.length >= 2 &&
        history.data.history?.events?.some((event: { event_type: string }) => event.event_type === "relationships_changed"),
      JSON.stringify(history.data).slice(0, 240)
    );

    const fr = await callTool("create_feature_request", {
        title: "[itest] customers want this",
        source: "itest",
        primary_story_key: storyKey,
        secondary_story_keys: [sample.story_key],
        link_source: "itest",
      });
    const frId = fr.data.feature_request_id as number | undefined;
    check("create_feature_request writes FR + links at version 1", fr.data.link_revision === 1 && Array.isArray(fr.data.links) && fr.data.links.length === 2, JSON.stringify(fr.data).slice(0, 180));

    const swapped = await callTool("set_feature_request_story_links", {
      feature_request_id: frId,
      primary_story_key: sample.story_key,
      secondary_story_keys: [storyKey],
      expected_version: 1,
      link_source: "itest-primary-swap",
    });
    check(
      "production-sensitive FR primary swap becomes a proposal",
      swapped.data.outcome === "proposed",
      JSON.stringify(swapped.data).slice(0, 200)
    );
    if (swapped.data.proposal?.id) {
      const approvedSwap = await approveStoryChange({
        proposalId: swapped.data.proposal.id,
        decidedBy: "integration-human",
      });
      check("human approval applies complete FR primary swap", approvedSwap.outcome === "approved");
    }
    const staleLinks = await callTool("set_feature_request_story_links", {
      feature_request_id: frId,
      primary_story_key: storyKey,
      expected_version: 1,
    });
    check("stale FR link version is rejected atomically", staleLinks.data.outcome === "stale");

    const got = await callTool("get_feature_request", { feature_request_id: frId });
    check("get_feature_request returns swapped primary + version", got.data.feature_request?.primary_story?.story_key === sample.story_key && got.data.feature_request?.link_revision === 2, JSON.stringify(got.data).slice(0, 220));

    const byKey = await query({ story_key: [storyKey] });
    check("query_stories(story_key) fetches the story with its FR link", byKey.total === 1 && (byKey.records?.[0] as { feature_requests?: unknown[] })?.feature_requests?.length === 1, JSON.stringify(byKey).slice(0, 200));

    const bad = await callTool("create_feature_request", { title: "bad", primary_story_key: "NOPE-DOES-NOT-EXIST" });
    check("create_feature_request rejects an unknown primary atomically", bad.isError === true, JSON.stringify(bad.data).slice(0, 160));
  } else {
    console.log(
      "SKIP write round-trip — TIELINE_TEST_DATABASE_URL_WRITE and TIELINE_TEST_DATABASE_URL_APPROVAL not set."
    );
  }

  await finish(client, server);
}

async function finish(client: Client, server: { close(): Promise<void> }): Promise<void> {
  await client.close();
  await server.close();
  await closeSql();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("integration failed:", err);
  await closeSql();
  process.exit(1);
});
