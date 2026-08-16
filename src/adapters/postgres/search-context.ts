import type { Sql } from "postgres";
import type {
  SearchDocumentKind,
  SemanticSearchAnchor,
  SemanticSearchCandidate,
  SemanticSearchContext,
} from "../../domain/semantic-search-store.js";

const GRAPH_PROXIMITY_BY_DISTANCE = [1, 0.75, 0.5, 0.25] as const;
const HELP_ANCHOR_GRAPH_FRONTIER_LIMIT = 500;

interface ResolvedAnchor {
  kind: SemanticSearchAnchor["kind"];
  id: string;
}

interface ArtifactFeatureRow {
  document_id: string;
  artifact_overlap: number | string | null;
}

interface GraphFeatureRow {
  document_id: string;
  distance: number | string;
}

type SearchContextFeatures = Pick<
  SemanticSearchCandidate,
  "artifact_overlap" | "graph_proximity"
>;

interface SearchContextCandidate {
  document_id: string;
  entity_kind: SearchDocumentKind;
  entity_id: string;
}

function anchorLabel(anchor: SemanticSearchAnchor): string {
  if (anchor.kind === "observation") return anchor.id;
  if (anchor.kind === "backlog_item") return anchor.stable_id;
  if (anchor.kind === "help_article") {
    return `${anchor.source}:${anchor.external_id}`;
  }
  return `${anchor.repository}/${anchor.stable_id}`;
}

async function resolveAnchor(
  sql: Sql,
  anchor: SemanticSearchAnchor
): Promise<ResolvedAnchor> {
  let rows: Array<{ id: string }>;
  switch (anchor.kind) {
    case "observation":
      rows = await sql<Array<{ id: string }>>`
        select id from observation_search where id = ${anchor.id}`;
      break;
    case "backlog_item":
      rows = await sql<Array<{ id: string }>>`
        select id from backlog_items where stable_id = ${anchor.stable_id}`;
      break;
    case "help_article":
      rows = await sql<Array<{ id: string }>>`
        select id from help_articles
        where source = ${anchor.source}
          and external_id = ${anchor.external_id}`;
      break;
    case "story":
      rows = await sql<Array<{ id: string }>>`
        select story.id
        from user_stories story
        join repositories repository on repository.id = story.repository_id
        where repository.key = ${anchor.repository}
          and story.stable_id = ${anchor.stable_id}`;
      break;
    case "acceptance_criterion":
      rows = await sql<Array<{ id: string }>>`
        select criterion.id
        from acceptance_criteria criterion
        join repositories repository
          on repository.id = criterion.repository_id
        where repository.key = ${anchor.repository}
          and criterion.stable_id = ${anchor.stable_id}`;
      break;
  }
  if (!rows[0]) {
    throw new Error(
      `Unknown ${anchor.kind} search context anchor '${anchorLabel(anchor)}'.`
    );
  }
  return { kind: anchor.kind, id: rows[0].id };
}

async function artifactFeatures(
  sql: Sql,
  candidates: SearchContextCandidate[],
  context: SemanticSearchContext,
  includeInactiveCriteria: boolean,
  anchor?: ResolvedAnchor
): Promise<ArtifactFeatureRow[]> {
  const candidateJson = sql.json(
    candidates as unknown as Parameters<Sql["json"]>[0]
  );
  const artifactJson = sql.json(
    (context.artifacts ?? []) as Parameters<Sql["json"]>[0]
  );
  return sql<ArtifactFeatureRow[]>`
    with
    candidate_documents as materialized (
      select candidate.*
      from jsonb_to_recordset(${candidateJson}::jsonb) as candidate(
        document_id uuid,
        entity_kind text,
        entity_id uuid
      )
    ),
    anchor_entity as (
      select
        ${anchor?.kind ?? null}::text as entity_kind,
        ${anchor?.id ?? null}::uuid as entity_id
      where ${anchor?.id ?? null}::uuid is not null
    ),
    entities as (
      select entity_kind, entity_id from candidate_documents
      union
      select entity_kind, entity_id from anchor_entity
    ),
    observation_targets as (
      select
        attribution.observation_id,
        'story'::text as target_kind,
        attribution.story_id as target_id
      from entities entity
      join observation_story_attributions attribution
        on entity.entity_kind = 'observation'
       and attribution.observation_id = entity.entity_id
       and attribution.state = 'confirmed'
      union
      select
        attribution.observation_id,
        'acceptance_criterion',
        attribution.criterion_id
      from entities entity
      join observation_criterion_attributions attribution
        on entity.entity_kind = 'observation'
       and attribution.observation_id = entity.entity_id
       and attribution.state = 'confirmed'
      union
      select
        attribution.observation_id,
        'backlog_item',
        attribution.backlog_item_id
      from entities entity
      join observation_backlog_attributions attribution
        on entity.entity_kind = 'observation'
       and attribution.observation_id = entity.entity_id
       and attribution.state = 'confirmed'
      union
      select
        suggestion.source_id,
        suggestion.target_kind::text,
        suggestion.target_id
      from entities entity
      join attribution_suggestions suggestion
        on entity.entity_kind = 'observation'
       and suggestion.source_kind = 'observation'
       and suggestion.source_id = entity.entity_id
       and suggestion.state = 'confirmed'
    ),
    owners as (
      select entity_kind, entity_id from entities
      union
      select target_kind, target_id from observation_targets
    ),
    eligible_criteria as not materialized (
      select criterion.*
      from acceptance_criteria criterion
      where ${includeInactiveCriteria} or criterion.active
    ),
    contract_nodes as (
      select
        owner.entity_kind as owner_kind,
        owner.entity_id as owner_id,
        'story'::text as contract_kind,
        story.id as contract_id
      from owners owner
      join user_stories story
        on owner.entity_kind = 'story' and story.id = owner.entity_id
      union
      select owner.entity_kind, owner.entity_id, 'acceptance_criterion', criterion.id
      from owners owner
      join eligible_criteria criterion
        on owner.entity_kind = 'story'
       and criterion.story_id = owner.entity_id
      union
      select owner.entity_kind, owner.entity_id, 'acceptance_criterion', criterion.id
      from owners owner
      join eligible_criteria criterion
        on owner.entity_kind = 'acceptance_criterion'
       and criterion.id = owner.entity_id
      union
      select owner.entity_kind, owner.entity_id, 'story', criterion.story_id
      from owners owner
      join eligible_criteria criterion
        on owner.entity_kind = 'acceptance_criterion'
       and criterion.id = owner.entity_id
      union
      select owner.entity_kind, owner.entity_id, 'acceptance_criterion', criterion.id
      from owners owner
      join scenarios scenario
        on owner.entity_kind = 'scenario' and scenario.id = owner.entity_id
      join eligible_criteria criterion on criterion.id = scenario.criterion_id
      union
      select owner.entity_kind, owner.entity_id, 'story', criterion.story_id
      from owners owner
      join scenarios scenario
        on owner.entity_kind = 'scenario' and scenario.id = owner.entity_id
      join eligible_criteria criterion on criterion.id = scenario.criterion_id
      union
      select owner.entity_kind, owner.entity_id, 'story', target.story_id
      from owners owner
      join backlog_story_targets target
        on owner.entity_kind = 'backlog_item'
       and target.backlog_item_id = owner.entity_id
      union
      select owner.entity_kind, owner.entity_id, 'acceptance_criterion', criterion.id
      from owners owner
      join backlog_story_targets target
        on owner.entity_kind = 'backlog_item'
       and target.backlog_item_id = owner.entity_id
      join eligible_criteria criterion on criterion.story_id = target.story_id
      union
      select owner.entity_kind, owner.entity_id, 'acceptance_criterion', criterion.id
      from owners owner
      join backlog_criterion_targets target
        on owner.entity_kind = 'backlog_item'
       and target.backlog_item_id = owner.entity_id
      join eligible_criteria criterion on criterion.id = target.criterion_id
      union
      select owner.entity_kind, owner.entity_id, 'story', criterion.story_id
      from owners owner
      join backlog_criterion_targets target
        on owner.entity_kind = 'backlog_item'
       and target.backlog_item_id = owner.entity_id
      join eligible_criteria criterion on criterion.id = target.criterion_id
    ),
    entity_contract_nodes as (
      select owner_kind, owner_id, contract_kind, contract_id
      from contract_nodes
      union
      select
        'observation'::text,
        target.observation_id,
        node.contract_kind,
        node.contract_id
      from observation_targets target
      join contract_nodes node
        on node.owner_kind = target.target_kind
       and node.owner_id = target.target_id
    ),
    contract_artifacts as not materialized (
      select
        'story'::text as contract_kind,
        link.story_id as contract_id,
        'code_asset'::text as artifact_kind,
        link.asset_id as artifact_id
      from story_code_assets link
      union all
      select 'acceptance_criterion', link.criterion_id, 'code_asset', link.asset_id
      from criterion_code_assets link
      union all
      select 'story', link.story_id, 'help_article', link.article_id
      from story_help_articles link
      union all
      select 'acceptance_criterion', link.criterion_id, 'help_article', link.article_id
      from criterion_help_articles link
    ),
    provided_artifact_refs as (
      select
        'provided:' || reference.value::text as context_key,
        reference.value as definition
      from jsonb_array_elements(${artifactJson}::jsonb) reference(value)
    ),
    provided_artifacts as (
      select
        reference.context_key,
        'code_asset'::text as artifact_kind,
        asset.id as artifact_id
      from provided_artifact_refs reference
      join repositories repository
        on repository.key = reference.definition->>'repository'
      join code_assets asset
        on asset.repository_id = repository.id
       and asset.kind = reference.definition->>'kind'
       and asset.path = reference.definition->>'path'
       and (
         reference.definition->>'selector' is null
         or asset.selector = reference.definition->>'selector'
       )
       and (
         reference.definition->>'framework_hint' is null
         or asset.framework_hint = reference.definition->>'framework_hint'
       )
      where reference.definition->>'kind' in ('code', 'test')
      union
      select
        reference.context_key,
        'help_article',
        article.id
      from provided_artifact_refs reference
      join help_articles article
        on article.source = reference.definition->>'source'
       and article.external_id = reference.definition->>'external_id'
      where reference.definition->>'kind' = 'help'
    ),
    anchor_artifacts as (
      select
        concat(
          'anchor:',
          artifact.artifact_kind,
          ':',
          artifact.artifact_id::text
        ) as context_key,
        artifact.artifact_kind,
        artifact.artifact_id
      from anchor_entity anchor
      join entity_contract_nodes node
        on node.owner_kind = anchor.entity_kind
       and node.owner_id = anchor.entity_id
      join contract_artifacts artifact
        on artifact.contract_kind = node.contract_kind
       and artifact.contract_id = node.contract_id
    ),
    context_keys as (
      select context_key from provided_artifact_refs
      union
      select context_key from anchor_artifacts
    ),
    context_artifacts as (
      select context_key, artifact_kind, artifact_id
      from provided_artifacts
      union
      select context_key, artifact_kind, artifact_id
      from anchor_artifacts
    ),
    candidate_artifacts as (
      select distinct
        candidate.document_id,
        artifact.artifact_kind,
        artifact.artifact_id
      from candidate_documents candidate
      join entity_contract_nodes node
        on node.owner_kind = candidate.entity_kind
       and node.owner_id = candidate.entity_id
      join contract_artifacts artifact
        on artifact.contract_kind = node.contract_kind
       and artifact.contract_id = node.contract_id
    )
    select
      candidate.document_id,
      coalesce(
        (
          select count(distinct context.context_key)::double precision
          from context_artifacts context
          join candidate_artifacts artifact
            on artifact.document_id = candidate.document_id
           and artifact.artifact_kind = context.artifact_kind
           and artifact.artifact_id = context.artifact_id
        ) / nullif(
          (select count(*)::double precision from context_keys),
          0
        ),
        0
      ) as artifact_overlap
    from candidate_documents candidate`;
}

/**
 * Returns only indexed neighbors of the current frontier node. Keeping the
 * lookup lateral prevents a contextual search from assembling the full graph.
 */
function graphNeighbors(sql: Sql): ReturnType<Sql> {
  return sql`
    select 'acceptance_criterion'::text as target_kind, criterion.id as target_id
    from acceptance_criteria criterion
    where frontier.entity_kind = 'story'
      and criterion.story_id = frontier.entity_id
    union all
    select 'story', criterion.story_id
    from acceptance_criteria criterion
    where frontier.entity_kind = 'acceptance_criterion'
      and criterion.id = frontier.entity_id
    union all
    select 'scenario', scenario.id
    from scenarios scenario
    where frontier.entity_kind = 'acceptance_criterion'
      and scenario.criterion_id = frontier.entity_id
    union all
    select 'acceptance_criterion', scenario.criterion_id
    from scenarios scenario
    where frontier.entity_kind = 'scenario'
      and scenario.id = frontier.entity_id
    union all
    select 'help_article', link.article_id
    from story_help_articles link
    where frontier.entity_kind = 'story'
      and link.story_id = frontier.entity_id
    union all
    select 'story', link.story_id
    from story_help_articles link
    where frontier.entity_kind = 'help_article'
      and link.article_id = frontier.entity_id
    union all
    select 'help_article', link.article_id
    from criterion_help_articles link
    where frontier.entity_kind = 'acceptance_criterion'
      and link.criterion_id = frontier.entity_id
    union all
    select 'acceptance_criterion', link.criterion_id
    from criterion_help_articles link
    where frontier.entity_kind = 'help_article'
      and link.article_id = frontier.entity_id
    union all
    select 'story', attribution.story_id
    from observation_story_attributions attribution
    where frontier.entity_kind = 'observation'
      and attribution.observation_id = frontier.entity_id
      and attribution.state = 'confirmed'
    union all
    select 'observation', attribution.observation_id
    from observation_story_attributions attribution
    where frontier.entity_kind = 'story'
      and attribution.story_id = frontier.entity_id
      and attribution.state = 'confirmed'
    union all
    select 'acceptance_criterion', attribution.criterion_id
    from observation_criterion_attributions attribution
    where frontier.entity_kind = 'observation'
      and attribution.observation_id = frontier.entity_id
      and attribution.state = 'confirmed'
    union all
    select 'observation', attribution.observation_id
    from observation_criterion_attributions attribution
    where frontier.entity_kind = 'acceptance_criterion'
      and attribution.criterion_id = frontier.entity_id
      and attribution.state = 'confirmed'
    union all
    select 'backlog_item', attribution.backlog_item_id
    from observation_backlog_attributions attribution
    where frontier.entity_kind = 'observation'
      and attribution.observation_id = frontier.entity_id
      and attribution.state = 'confirmed'
    union all
    select 'observation', attribution.observation_id
    from observation_backlog_attributions attribution
    where frontier.entity_kind = 'backlog_item'
      and attribution.backlog_item_id = frontier.entity_id
      and attribution.state = 'confirmed'
    union all
    select suggestion.target_kind::text, suggestion.target_id
    from attribution_suggestions suggestion
    where suggestion.source_kind = frontier.entity_kind::semantic_entity_kind
      and suggestion.source_id = frontier.entity_id
      and suggestion.state = 'confirmed'
    union all
    select suggestion.source_kind::text, suggestion.source_id
    from attribution_suggestions suggestion
    where suggestion.target_kind = frontier.entity_kind::semantic_entity_kind
      and suggestion.target_id = frontier.entity_id
      and suggestion.state = 'confirmed'
    union all
    select 'story', target.story_id
    from backlog_story_targets target
    where frontier.entity_kind = 'backlog_item'
      and target.backlog_item_id = frontier.entity_id
    union all
    select 'backlog_item', target.backlog_item_id
    from backlog_story_targets target
    where frontier.entity_kind = 'story'
      and target.story_id = frontier.entity_id
    union all
    select 'acceptance_criterion', target.criterion_id
    from backlog_criterion_targets target
    where frontier.entity_kind = 'backlog_item'
      and target.backlog_item_id = frontier.entity_id
    union all
    select 'backlog_item', target.backlog_item_id
    from backlog_criterion_targets target
    where frontier.entity_kind = 'acceptance_criterion'
      and target.criterion_id = frontier.entity_id
    union all
    select 'story', story.superseded_by_id
    from user_stories story
    where frontier.entity_kind = 'story'
      and story.id = frontier.entity_id
      and story.superseded_by_id is not null
    union all
    select 'story', story.id
    from user_stories story
    where frontier.entity_kind = 'story'
      and story.superseded_by_id = frontier.entity_id
    union all
    select 'acceptance_criterion', criterion.superseded_by_id
    from acceptance_criteria criterion
    where frontier.entity_kind = 'acceptance_criterion'
      and criterion.id = frontier.entity_id
      and criterion.superseded_by_id is not null
    union all
    select 'acceptance_criterion', criterion.id
    from acceptance_criteria criterion
    where frontier.entity_kind = 'acceptance_criterion'
      and criterion.superseded_by_id = frontier.entity_id
    union all
    select 'backlog_item', item.superseded_by_id
    from backlog_items item
    where frontier.entity_kind = 'backlog_item'
      and item.id = frontier.entity_id
      and item.superseded_by_id is not null
    union all
    select 'backlog_item', item.id
    from backlog_items item
    where frontier.entity_kind = 'backlog_item'
      and item.superseded_by_id = frontier.entity_id
    union all
    select 'observation', observation.supersedes_observation_id
    from observation_search observation
    where frontier.entity_kind = 'observation'
      and observation.id = frontier.entity_id
      and observation.supersedes_observation_id is not null
    union all
    select 'observation', observation.id
    from observation_search observation
    where frontier.entity_kind = 'observation'
      and observation.supersedes_observation_id = frontier.entity_id
    union all
    select 'backlog_item', item.id
    from user_stories story
    cross join unnest(story.motivated_by) motivation(stable_id)
    join backlog_items item on item.stable_id = motivation.stable_id
    where frontier.entity_kind = 'story'
      and story.id = frontier.entity_id
    union all
    select 'story', story.id
    from backlog_items item
    join user_stories story
      on story.motivated_by @> array[item.stable_id]
    where frontier.entity_kind = 'backlog_item'
      and item.id = frontier.entity_id`;
}

async function graphFeatures(
  sql: Sql,
  candidates: SearchContextCandidate[],
  anchor: ResolvedAnchor
): Promise<GraphFeatureRow[]> {
  const candidateJson = sql.json(
    candidates as unknown as Parameters<Sql["json"]>[0]
  );
  const frontierCap = anchor.kind === "help_article"
    ? sql`order by edge.target_kind, edge.target_id
          limit ${HELP_ANCHOR_GRAPH_FRONTIER_LIMIT}`
    : sql``;
  return sql<GraphFeatureRow[]>`
    with
    candidate_documents as materialized (
      select candidate.*
      from jsonb_to_recordset(${candidateJson}::jsonb) as candidate(
        document_id uuid,
        entity_kind text,
        entity_id uuid
      )
    ),
    hop0(entity_kind, entity_id) as (
      select ${anchor.kind}::text, ${anchor.id}::uuid
    ),
    hop1(entity_kind, entity_id) as (
      select distinct edge.target_kind, edge.target_id
      from hop0 frontier
      cross join lateral (${graphNeighbors(sql)}) edge
      where not exists (
        select 1
        from hop0 visited
        where visited.entity_kind = edge.target_kind
          and visited.entity_id = edge.target_id
      )
      ${frontierCap}
    ),
    hop2(entity_kind, entity_id) as (
      select distinct edge.target_kind, edge.target_id
      from hop1 frontier
      cross join lateral (${graphNeighbors(sql)}) edge
      where not exists (
        select 1
        from hop0 visited
        where visited.entity_kind = edge.target_kind
          and visited.entity_id = edge.target_id
      )
        and not exists (
          select 1
          from hop1 visited
          where visited.entity_kind = edge.target_kind
            and visited.entity_id = edge.target_id
        )
      ${frontierCap}
    ),
    hop3(entity_kind, entity_id) as (
      select distinct edge.target_kind, edge.target_id
      from hop2 frontier
      cross join lateral (${graphNeighbors(sql)}) edge
      where not exists (
        select 1
        from hop0 visited
        where visited.entity_kind = edge.target_kind
          and visited.entity_id = edge.target_id
      )
        and not exists (
          select 1
          from hop1 visited
          where visited.entity_kind = edge.target_kind
            and visited.entity_id = edge.target_id
        )
        and not exists (
          select 1
          from hop2 visited
          where visited.entity_kind = edge.target_kind
            and visited.entity_id = edge.target_id
        )
      ${frontierCap}
    ),
    distances as (
      select entity_kind, entity_id, 0 as distance from hop0
      union all
      select entity_kind, entity_id, 1 from hop1
      union all
      select entity_kind, entity_id, 2 from hop2
      union all
      select entity_kind, entity_id, 3 from hop3
    )
    select document.document_id, distance.distance
    from candidate_documents document
    join distances distance
      on distance.entity_kind = document.entity_kind
     and distance.entity_id = document.entity_id`;
}

function graphScore(distance: number): number {
  return GRAPH_PROXIMITY_BY_DISTANCE[distance] ?? 0;
}

export async function scoreSearchContext(
  sql: Sql,
  candidates: SearchContextCandidate[],
  context: SemanticSearchContext,
  includeInactiveCriteria: boolean
): Promise<Map<string, SearchContextFeatures>> {
  const anchor = context.anchor
    ? await resolveAnchor(sql, context.anchor)
    : undefined;
  if (candidates.length === 0) return new Map();
  const [artifactRows, graphRows] = await Promise.all([
    artifactFeatures(
      sql,
      candidates,
      context,
      includeInactiveCriteria,
      anchor
    ),
    anchor ? graphFeatures(sql, candidates, anchor) : Promise.resolve([]),
  ]);
  const features = new Map<string, SearchContextFeatures>(
    candidates.map((candidate) => [
      candidate.document_id,
      { artifact_overlap: 0, graph_proximity: 0 },
    ])
  );
  for (const row of artifactRows) {
    const feature = features.get(row.document_id);
    if (feature) {
      feature.artifact_overlap = Number(row.artifact_overlap ?? 0);
    }
  }
  for (const row of graphRows) {
    const feature = features.get(row.document_id);
    if (feature) {
      feature.graph_proximity = graphScore(Number(row.distance));
    }
  }
  return features;
}
