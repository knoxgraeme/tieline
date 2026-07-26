import { config } from "../../config.js";
import type { Sql } from "postgres";
import { getEmbedder, storyEmbeddingText } from "../../embeddings.js";
import type { WrittenStory } from "../../types.js";
import type { StoryChangeProposal, StoryChangeProposalSummary, StoryHistory, StoryMutationResult, RelationshipMutationResult, StoryRelationshipPatch } from "../../domain/knowledge-store.js";
import { getApprovalSql, getReadSql, getWriteSql } from "./connections.js";
import { vectorLiteral } from "./vector.js";
const getSql = getReadSql;

// --- writes (current projection + immutable lifecycle history) ---------------

function proposalSummary(row: {
  id: number;
  operation: "create" | "update" | "relationships";
  status: "pending" | "approved" | "rejected" | "stale";
  proposed_story_key: string | null;
  base_revision_number: number | null;
  reason: string | null;
  source: string;
  created_at: string | Date;
}): StoryChangeProposalSummary {
  return {
    id: Number(row.id),
    operation: row.operation,
    status: row.status,
    story_key: row.proposed_story_key,
    base_revision_number: row.base_revision_number,
    reason: row.reason,
    source: row.source,
    created_at: new Date(row.created_at).toISOString(),
  };
}

async function fetchWrittenStory(storyId: number): Promise<WrittenStory> {
  const read = getSql();
  const rows = await read<
    {
      id: number;
      story_key: string;
      section_key: string;
      title: string;
      actor: string | null;
      story_text: string;
      status: string;
    }[]
  >`
    select us.id, us.story_key, s.section_key, us.title, us.actor, us.story_text,
           us.status::text as status
    from user_stories us join sections s on s.id = us.section_id
    where us.id = ${storyId}`;
  if (!rows[0]) throw new Error(`Story ${storyId} was written but could not be read back.`);
  return { ...rows[0], id: Number(rows[0].id) };
}

async function approveProposalAutomatically(
  proposalId: number,
  embedding: number[] | null,
  actor: string | null
): Promise<StoryMutationResult> {
  const approval = getApprovalSql();
  const rows = await approval<
    { outcome: string; story_id: number | null; story_key: string | null; revision_number: number | null }[]
  >`
    select * from approve_story_change(
      ${proposalId}, ${actor ?? "auto-approval"}, ${"STORY_APPROVAL_MODE=off"},
      ${embedding ? vectorLiteral(embedding) : null}::vector
    )`;
  const result = rows[0];
  if (!result) throw new Error(`Approval function returned no result for proposal ${proposalId}.`);
  if (result.outcome === "stale") {
    return { outcome: "stale", current_revision_number: Number(result.revision_number ?? 0) };
  }
  if (result.outcome !== "approved" || result.story_id == null) {
    throw new Error(`Automatic approval failed with outcome '${result.outcome}'.`);
  }
  return {
    outcome: "applied",
    story: await fetchWrittenStory(Number(result.story_id)),
    revision_number: Number(result.revision_number),
  };
}

/** Create current state directly when non-sensitive, otherwise create a proposal. */
export async function createUserStory(opts: {
  sectionKey: string;
  title: string;
  storyText: string;
  actor?: string | null;
  status?: string;
  reason?: string | null;
  source?: string;
  proposedBy?: string | null;
}): Promise<StoryMutationResult> {
  const read = getSql();
  const sec = await read<{ id: number }[]>`
    select id from sections where section_key = ${opts.sectionKey}`;
  if (sec.length === 0) {
    throw new Error(
      `Unknown section_key '${opts.sectionKey}'. List valid sections via query_stories(group_by='section') or schema://taxonomy.`
    );
  }
  const sectionId = sec[0].id;
  const status = opts.status ?? "idea";
  const source = opts.source ?? "mcp";
  const requiresProposal =
    config.storyApprovalMode === "all" ||
    (config.storyApprovalMode === "production" && status === "production") ||
    (config.storyApprovalMode === "off" && status === "production");

  if (requiresProposal) {
    const write = getWriteSql();
    const proposal = await write.begin(async (tx) => {
      const keyRows = await tx<{ k: string }[]>`select mint_story_key(${sectionId}) as k`;
      const patch = {
        section_key: opts.sectionKey,
        title: opts.title,
        story_text: opts.storyText,
        actor: opts.actor ?? null,
        status,
      };
      const rows = await tx<
        {
          id: number;
          operation: "create";
          status: "pending";
          proposed_story_key: string;
          base_revision_number: null;
          reason: string | null;
          source: string;
          created_at: string | Date;
        }[]
      >`
        insert into story_change_proposals
          (proposed_story_key, operation, patch, reason, proposed_by, source)
        values
          (${keyRows[0].k}, 'create', ${tx.json(patch)}, ${opts.reason ?? null},
           ${opts.proposedBy ?? null}, ${source})
        returning id, operation, status, proposed_story_key, base_revision_number,
                  reason, source, created_at`;
      return proposalSummary(rows[0]);
    });
    if (config.storyApprovalMode === "off") {
      const embedding = await getEmbedder().embed(storyEmbeddingText(opts.title, opts.storyText));
      return approveProposalAutomatically(proposal.id, embedding, opts.proposedBy ?? null);
    }
    return { outcome: "proposed", proposal };
  }

  const embedding = await getEmbedder().embed(storyEmbeddingText(opts.title, opts.storyText));
  const sql = getWriteSql();
  const written = await sql.begin(async (tx) => {
    const k = await tx<{ k: string }[]>`select mint_story_key(${sectionId}) as k`;
    const storyKey = k[0].k;
    const inserted = await tx<
      { id: number; story_key: string; title: string; actor: string | null; story_text: string; status: string }[]
    >`
      insert into user_stories (section_id, story_key, title, story_text, actor, status, embedding)
      values (${sectionId}, ${storyKey}, ${opts.title}, ${opts.storyText}, ${opts.actor ?? null},
              ${status}::story_status, ${vectorLiteral(embedding)}::vector)
      returning id, story_key, title, actor, story_text, status::text as status`;
    const row = inserted[0];
    const revisions = await tx<{ id: number }[]>`
      insert into story_revisions
        (story_id, revision_number, section_id, title, actor, story_text, status,
         change_reason, actor_label, source)
      values
        (${row.id}, 1, ${sectionId}, ${row.title}, ${row.actor}, ${row.story_text},
         ${row.status}::story_status, ${opts.reason ?? null}, ${opts.proposedBy ?? null}, ${source})
      returning id`;
    await tx`
      insert into story_events
        (story_id, revision_id, event_type, to_status, details, actor_label, source)
      values
        (${row.id}, ${revisions[0].id}, 'created', ${row.status}::story_status,
         ${tx.json({ direct: true })}, ${opts.proposedBy ?? null}, ${source})`;
    return { ...row, id: Number(row.id), section_key: opts.sectionKey };
  });
  return { outcome: "applied", story: written, revision_number: 1 };
}

/** Edit accepted current state or submit a revision-pinned proposal. */
export async function updateUserStory(opts: {
  storyKey: string;
  title?: string;
  storyText?: string;
  actor?: string | null;
  sectionKey?: string;
  status?: string;
  expectedRevision?: number;
  reason?: string | null;
  source?: string;
  proposedBy?: string | null;
}): Promise<StoryMutationResult> {
  const read = getSql();
  const cur = await read<
    {
      id: number;
      status: string;
      section_key: string;
      title: string;
      actor: string | null;
      story_text: string;
      revision_number: number;
    }[]
  >`
    select us.id, us.status::text as status, s.section_key, us.title, us.actor,
           us.story_text, us.revision_number
    from user_stories us join sections s on s.id = us.section_id
    where us.story_key = ${opts.storyKey}`;
  if (cur.length === 0) return { outcome: "not_found" };

  if (
    opts.title === undefined &&
    opts.storyText === undefined &&
    opts.actor === undefined &&
    opts.sectionKey === undefined &&
    opts.status === undefined
  ) {
    return { outcome: "no_fields" };
  }

  const current = cur[0];
  const expectedRevision = opts.expectedRevision ?? current.revision_number;
  if (expectedRevision !== current.revision_number) {
    return { outcome: "stale", current_revision_number: current.revision_number };
  }
  const targetStatus = opts.status ?? current.status;
  const source = opts.source ?? "mcp";
  const productionSensitive = current.status === "production" || targetStatus === "production";
  const requiresProposal =
    config.storyApprovalMode === "all" ||
    (config.storyApprovalMode === "production" && productionSensitive) ||
    (config.storyApprovalMode === "off" && productionSensitive);

  if (requiresProposal) {
    const patch: Record<string, unknown> = {};
    if (opts.title !== undefined) patch.title = opts.title;
    if (opts.storyText !== undefined) patch.story_text = opts.storyText;
    if (opts.actor !== undefined) patch.actor = opts.actor;
    if (opts.sectionKey !== undefined) patch.section_key = opts.sectionKey;
    if (opts.status !== undefined) patch.status = opts.status;
    const write = getWriteSql();
    const rows = await write<
      {
        id: number;
        operation: "update";
        status: "pending";
        proposed_story_key: string;
        base_revision_number: number;
        reason: string | null;
        source: string;
        created_at: string | Date;
      }[]
    >`
      insert into story_change_proposals
        (story_id, proposed_story_key, operation, patch, base_revision_number,
         reason, proposed_by, source)
      values
        (${current.id}, ${opts.storyKey}, 'update', ${write.json(patch as Parameters<typeof write.json>[0])}, ${expectedRevision},
         ${opts.reason ?? null}, ${opts.proposedBy ?? null}, ${source})
      returning id, operation, status, proposed_story_key, base_revision_number,
                reason, source, created_at`;
    const proposal = proposalSummary(rows[0]);
    if (config.storyApprovalMode === "off") {
      const embedding =
        opts.title !== undefined || opts.storyText !== undefined
          ? await getEmbedder().embed(
              storyEmbeddingText(opts.title ?? current.title, opts.storyText ?? current.story_text)
            )
          : null;
      return approveProposalAutomatically(proposal.id, embedding, opts.proposedBy ?? null);
    }
    return { outcome: "proposed", proposal };
  }

  const patch: Record<string, unknown> = {};
  if (opts.title !== undefined) patch.title = opts.title;
  if (opts.storyText !== undefined) patch.story_text = opts.storyText;
  if (opts.actor !== undefined) patch.actor = opts.actor;
  if (opts.sectionKey !== undefined) {
    const sec = await read<{ id: number }[]>`select id from sections where section_key = ${opts.sectionKey}`;
    if (sec.length === 0) throw new Error(`Unknown section_key '${opts.sectionKey}'.`);
    patch.section_id = sec[0].id;
  }
  // status is an enum column, so it needs an explicit cast — handled as a
  // fragment below rather than in the plain-column patch.
  if (Object.keys(patch).length === 0 && opts.status === undefined) {
    return { outcome: "no_fields" };
  }
  const changedFields = [
    ...Object.keys(patch),
    ...(opts.status !== undefined ? ["status"] : []),
  ];
  patch.updated_at = new Date().toISOString();

  const write = getWriteSql();
  // Enum-cast status + re-embed on write when title/story_text change, appended
  // to the plain-column patch as SQL fragments (both need explicit casts).
  let extra: ReturnType<Sql> = write``;
  if (opts.status !== undefined) {
    extra = write`${extra}, status = ${opts.status}::story_status`;
  }
  if (opts.title !== undefined || opts.storyText !== undefined) {
    const newTitle = opts.title ?? cur[0].title;
    const newText = opts.storyText ?? cur[0].story_text;
    const embedding = await getEmbedder().embed(storyEmbeddingText(newTitle, newText));
    extra = write`${extra}, embedding = ${vectorLiteral(embedding)}::vector`;
  }

  extra = write`${extra}, revision_number = us.revision_number + 1`;
  const result = await write.begin(async (tx) => {
    const rows = await tx<
      {
        id: number;
        story_key: string;
        section_id: number;
        title: string;
        actor: string | null;
        story_text: string;
        status: string;
        revision_number: number;
      }[]
    >`
      update user_stories us
      set ${tx(patch)}${extra}
      where us.story_key = ${opts.storyKey}
        and us.revision_number = ${expectedRevision}
      returning us.id, us.story_key, us.section_id, us.title, us.actor, us.story_text,
                us.status::text as status, us.revision_number`;
    if (rows.length === 0) return null;
    const row = rows[0];
    const revisions = await tx<{ id: number }[]>`
      insert into story_revisions
        (story_id, revision_number, section_id, title, actor, story_text, status,
         change_reason, actor_label, source)
      values
        (${row.id}, ${row.revision_number}, ${row.section_id}, ${row.title}, ${row.actor},
         ${row.story_text}, ${row.status}::story_status, ${opts.reason ?? null},
         ${opts.proposedBy ?? null}, ${source})
      returning id`;
    await tx`
      insert into story_events
        (story_id, revision_id, event_type, from_status, to_status, details, actor_label, source)
      values
        (${row.id}, ${revisions[0].id}, 'revised', ${current.status}::story_status,
         ${row.status}::story_status, ${tx.json({ patch: changedFields, direct: true })},
         ${opts.proposedBy ?? null}, ${source})`;
    const sectionRows = await tx<{ section_key: string }[]>`
      select section_key from sections where id = ${row.section_id}`;
    return {
      story: { ...row, id: Number(row.id), section_key: sectionRows[0]?.section_key ?? "" },
      revision_number: Number(row.revision_number),
    };
  });
  if (!result) {
    const latest = await read<{ revision_number: number }[]>`
      select revision_number from user_stories where story_key = ${opts.storyKey}`;
    if (!latest[0]) return { outcome: "not_found" };
    return { outcome: "stale", current_revision_number: latest[0].revision_number };
  }
  return { outcome: "applied", ...result };
}

export async function updateStoryRelationships(opts: {
  storyKey: string;
  patch: StoryRelationshipPatch;
  expectedRevision?: number;
  reason?: string | null;
  source?: string;
  proposedBy?: string | null;
}): Promise<RelationshipMutationResult> {
  if (Object.keys(opts.patch).length === 0) return { outcome: "no_fields" };
  const read = getSql();
  const currentRows = await read<{ id: number; status: string; revision_number: number }[]>`
    select id, status::text as status, revision_number
    from user_stories where story_key = ${opts.storyKey}`;
  const current = currentRows[0];
  if (!current) return { outcome: "not_found" };
  const expectedRevision = opts.expectedRevision ?? current.revision_number;
  if (expectedRevision !== current.revision_number) {
    return { outcome: "stale", current_revision_number: current.revision_number };
  }
  const source = opts.source ?? "mcp";
  const sensitive = current.status === "production";
  const requiresProposal =
    config.storyApprovalMode === "all" ||
    (config.storyApprovalMode === "production" && sensitive) ||
    (config.storyApprovalMode === "off" && sensitive);
  const write = getWriteSql();
  if (requiresProposal) {
    const rows = await write<
      {
        id: number;
        operation: "relationships";
        status: "pending";
        proposed_story_key: string;
        base_revision_number: number;
        reason: string | null;
        source: string;
        created_at: string | Date;
      }[]
    >`
      insert into story_change_proposals
        (story_id, proposed_story_key, operation, patch, base_revision_number,
         reason, proposed_by, source)
      values
        (${current.id}, ${opts.storyKey}, 'relationships',
         ${write.json(opts.patch as Parameters<typeof write.json>[0])}, ${expectedRevision},
         ${opts.reason ?? null}, ${opts.proposedBy ?? null}, ${source})
      returning id, operation, status, proposed_story_key, base_revision_number,
                reason, source, created_at`;
    const proposal = proposalSummary(rows[0]);
    if (config.storyApprovalMode === "off") {
      const approval = getApprovalSql();
      const approved = await approval<
        { outcome: string; revision_number: number | null }[]
      >`
        select * from approve_story_relationship_change(
          ${proposal.id}, ${opts.proposedBy ?? "auto-approval"},
          ${"STORY_APPROVAL_MODE=off"}
        )`;
      const result = approved[0];
      if (result?.outcome === "stale") {
        return { outcome: "stale", current_revision_number: Number(result.revision_number ?? 0) };
      }
      if (result?.outcome !== "approved") {
        throw new Error(`Automatic relationship approval failed with outcome '${result?.outcome}'.`);
      }
      return { outcome: "applied", revision_number: Number(result.revision_number) };
    }
    return { outcome: "proposed", proposal };
  }

  const rows = await write<{ outcome: string; current_revision_number: number | null }[]>`
    select * from mutate_nonproduction_story_relationships(
      ${current.id}, ${expectedRevision},
      ${write.json(opts.patch as Parameters<typeof write.json>[0])},
      ${opts.proposedBy ?? null}, ${source}, ${opts.reason ?? null}
    )`;
  const result = rows[0];
  if (!result || result.outcome === "not_found") return { outcome: "not_found" };
  if (result.outcome === "stale") {
    return { outcome: "stale", current_revision_number: Number(result.current_revision_number ?? 0) };
  }
  if (result.outcome === "requires_approval") {
    throw new Error("Production relationship change was not routed to approval.");
  }
  return { outcome: "applied", revision_number: Number(result.current_revision_number) };
}

// --- lifecycle history + proposal reads/decisions ---------------------------

function mapProposal(row: {
  id: number;
  story_id: number | null;
  operation: "create" | "update" | "relationships";
  status: "pending" | "approved" | "rejected" | "stale";
  proposed_story_key: string | null;
  patch_version: number;
  patch: unknown;
  base_revision_number: number | null;
  reason: string | null;
  proposed_by: string | null;
  source: string;
  decided_by: string | null;
  decision_note: string | null;
  created_at: string | Date;
  decided_at: string | Date | null;
}): StoryChangeProposal {
  return {
    ...proposalSummary(row),
    story_id: row.story_id == null ? null : Number(row.story_id),
    patch_version: row.patch_version,
    patch:
      row.patch && typeof row.patch === "object" && !Array.isArray(row.patch)
        ? (row.patch as Record<string, unknown>)
        : {},
    proposed_by: row.proposed_by,
    decided_by: row.decided_by,
    decision_note: row.decision_note,
    decided_at: row.decided_at == null ? null : new Date(row.decided_at).toISOString(),
  };
}

export async function getStoryChangeProposal(id: number): Promise<StoryChangeProposal | null> {
  const sql = getSql();
  const rows = await sql<
    {
      id: number;
      story_id: number | null;
      operation: "create" | "update" | "relationships";
      status: "pending" | "approved" | "rejected" | "stale";
      proposed_story_key: string | null;
      patch_version: number;
      patch: unknown;
      base_revision_number: number | null;
      reason: string | null;
      proposed_by: string | null;
      source: string;
      decided_by: string | null;
      decision_note: string | null;
      created_at: string | Date;
      decided_at: string | Date | null;
    }[]
  >`
    select id, story_id, operation, status, proposed_story_key, patch_version, patch,
           base_revision_number, reason, proposed_by, source, decided_by, decision_note,
           created_at, decided_at
    from story_change_proposals where id = ${id}`;
  return rows[0] ? mapProposal(rows[0]) : null;
}

export async function listStoryChangeProposals(
  opts: {
    status?: Array<"pending" | "approved" | "rejected" | "stale">;
    storyKey?: string;
    limit?: number;
  } = {}
): Promise<StoryChangeProposal[]> {
  const sql = getSql();
  const statuses = opts.status?.length ? opts.status : ["pending"];
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = await sql<
    {
      id: number;
      story_id: number | null;
      operation: "create" | "update" | "relationships";
      status: "pending" | "approved" | "rejected" | "stale";
      proposed_story_key: string | null;
      patch_version: number;
      patch: unknown;
      base_revision_number: number | null;
      reason: string | null;
      proposed_by: string | null;
      source: string;
      decided_by: string | null;
      decision_note: string | null;
      created_at: string | Date;
      decided_at: string | Date | null;
    }[]
  >`
    select id, story_id, operation, status, proposed_story_key, patch_version, patch,
           base_revision_number, reason, proposed_by, source, decided_by, decision_note,
           created_at, decided_at
    from story_change_proposals
    where status = any(${statuses})
      ${opts.storyKey ? sql`and proposed_story_key = ${opts.storyKey}` : sql``}
    order by created_at desc, id desc
    limit ${limit}`;
  return rows.map(mapProposal);
}

export async function getStoryHistory(
  storyKey: string,
  opts: { revisionLimit?: number; eventLimit?: number } = {}
): Promise<StoryHistory | null> {
  const sql = getSql();
  const currentRows = await sql<
    {
      id: number;
      story_key: string;
      section_key: string;
      title: string;
      actor: string | null;
      story_text: string;
      status: string;
      revision_number: number;
    }[]
  >`
    select us.id, us.story_key, s.section_key, us.title, us.actor, us.story_text,
           us.status::text as status, us.revision_number
    from user_stories us join sections s on s.id = us.section_id
    where us.story_key = ${storyKey}`;
  const current = currentRows[0];
  if (!current) return null;
  const revisionLimit = Math.min(Math.max(opts.revisionLimit ?? 20, 1), 100);
  const eventLimit = Math.min(Math.max(opts.eventLimit ?? 100, 1), 500);
  const revisions = await sql<
    {
      revision_number: number;
      section_key: string;
      title: string;
      actor: string | null;
      story_text: string;
      status: string;
      change_reason: string | null;
      actor_label: string | null;
      source: string;
      created_at: string | Date;
    }[]
  >`
    select sr.revision_number, s.section_key, sr.title, sr.actor, sr.story_text,
           sr.status::text as status, sr.change_reason, sr.actor_label, sr.source, sr.created_at
    from story_revisions sr join sections s on s.id = sr.section_id
    where sr.story_id = ${current.id}
    order by sr.revision_number desc
    limit ${revisionLimit}`;
  const events = await sql<
    {
      id: number;
      revision_number: number | null;
      proposal_id: number | null;
      event_type: string;
      from_status: string | null;
      to_status: string | null;
      details: unknown;
      actor_label: string | null;
      source: string;
      created_at: string | Date;
    }[]
  >`
    select se.id, sr.revision_number, se.proposal_id, se.event_type,
           se.from_status::text as from_status, se.to_status::text as to_status,
           se.details, se.actor_label, se.source, se.created_at
    from story_events se left join story_revisions sr on sr.id = se.revision_id
    where se.story_id = ${current.id}
    order by se.created_at desc, se.id desc
    limit ${eventLimit}`;
  return {
    current: { ...current, id: Number(current.id) },
    revisions: revisions.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() })),
    events: events.map((e) => ({
      ...e,
      id: Number(e.id),
      proposal_id: e.proposal_id == null ? null : Number(e.proposal_id),
      details:
        e.details && typeof e.details === "object" && !Array.isArray(e.details)
          ? (e.details as Record<string, unknown>)
          : {},
      created_at: new Date(e.created_at).toISOString(),
    })),
  };
}

export async function approveStoryChange(opts: {
  proposalId: number;
  decidedBy: string;
  note?: string | null;
}): Promise<{ outcome: string; story_id: number | null; story_key: string | null; revision_number: number | null }> {
  const proposal = await getStoryChangeProposal(opts.proposalId);
  if (!proposal) return { outcome: "not_found", story_id: null, story_key: null, revision_number: null };
  if (proposal.operation === "relationships") {
    const approval = getApprovalSql();
    if ("feature_request_links" in proposal.patch) {
      const rows = await approval<
        { outcome: string; story_id: number | null; story_key: string | null; revision_number: number | null }[]
      >`
        select * from approve_feature_request_link_change(
          ${proposal.id}, ${opts.decidedBy}, ${opts.note ?? null}
        )`;
      return rows[0] ?? { outcome: "not_found", story_id: null, story_key: null, revision_number: null };
    }
    const rows = await approval<
      { outcome: string; story_id: number | null; story_key: string | null; revision_number: number | null }[]
    >`
      select * from approve_story_relationship_change(
        ${proposal.id}, ${opts.decidedBy}, ${opts.note ?? null}
      )`;
    return rows[0] ?? { outcome: "not_found", story_id: null, story_key: null, revision_number: null };
  }
  let embedding: number[] | null = null;
  if (proposal.operation === "create") {
    embedding = await getEmbedder().embed(
      storyEmbeddingText(String(proposal.patch.title ?? ""), String(proposal.patch.story_text ?? ""))
    );
  } else if ("title" in proposal.patch || "story_text" in proposal.patch) {
    const history = proposal.story_key ? await getStoryHistory(proposal.story_key) : null;
    if (!history) throw new Error(`Story for proposal ${proposal.id} no longer exists.`);
    embedding = await getEmbedder().embed(
      storyEmbeddingText(
        String(proposal.patch.title ?? history.current.title),
        String(proposal.patch.story_text ?? history.current.story_text)
      )
    );
  }
  const approval = getApprovalSql();
  const rows = await approval<
    { outcome: string; story_id: number | null; story_key: string | null; revision_number: number | null }[]
  >`
    select * from approve_story_change(
      ${proposal.id}, ${opts.decidedBy}, ${opts.note ?? null},
      ${embedding ? vectorLiteral(embedding) : null}::vector
    )`;
  return rows[0] ?? { outcome: "not_found", story_id: null, story_key: null, revision_number: null };
}

export async function rejectStoryChange(opts: {
  proposalId: number;
  decidedBy: string;
  note?: string | null;
}): Promise<string> {
  const approval = getApprovalSql();
  const rows = await approval<{ outcome: string }[]>`
    select reject_story_change(${opts.proposalId}, ${opts.decidedBy}, ${opts.note ?? null}) as outcome`;
  return rows[0]?.outcome ?? "not_found";
}
