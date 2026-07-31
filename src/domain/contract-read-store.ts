import type { Applicability } from "../contract/schema.js";
import type {
  ContractAuthority,
  StoryLifecycle,
} from "../types.js";

export type CoverageLevel =
  | "none"
  | "partial"
  | "complete"
  | "not_applicable";
export type Freshness =
  | "current"
  | "stale"
  | "unknown"
  | "not_applicable";

export interface ContractCodeTarget {
  kind: "code" | "test";
  repository: string;
  path: string;
  selector: string | null;
  framework_hint: string | null;
}

export interface ContractHelpTarget {
  kind: "help";
  source: string;
  external_id: string;
  title: string | null;
  url: string | null;
}

export interface ContractEvidenceLink {
  relation: "implements" | "enforces" | "tests" | "documents";
  scope: "direct" | "story_fallback";
  target: ContractCodeTarget | ContractHelpTarget;
  reviewed_content_hash: string | null;
  freshness: Freshness;
}

export interface ContractScenarioRecord {
  id: string;
  stable_id: string;
  name: string | null;
  given: string;
  when: string;
  then: string;
  position: number;
  active: boolean;
}

export interface ContractAcceptanceCriterionRecord {
  id: string;
  stable_id: string;
  criterion: string | null;
  rationale: string | null;
  position: number;
  active: boolean;
  authority: ContractAuthority;
  aliases: string[];
  applies_to: Applicability | null;
  effective_applies_to: Applicability;
  scenarios: ContractScenarioRecord[];
  direct_links: ContractEvidenceLink[];
  fallback_story_links: ContractEvidenceLink[];
  freshness: Freshness;
  superseded_by: { stable_id: string } | null;
}

export interface ContractCoverage {
  implementation: CoverageLevel;
  test: CoverageLevel;
  help: CoverageLevel;
}

export interface ContractStoryRecord {
  id: string;
  repository: string;
  repository_commit: string | null;
  capability: {
    stable_id: string;
    name: string;
    description: string;
  };
  stable_id: string;
  title: string;
  actor: string | null;
  goal: string | null;
  benefit: string | null;
  rendered_story: string | null;
  lifecycle: StoryLifecycle;
  authority: ContractAuthority;
  revision: number;
  aliases: string[];
  applies_to: Applicability | null;
  effective_applies_to: Applicability;
  motivated_by: string[];
  direct_links: ContractEvidenceLink[];
  acceptance_criteria: ContractAcceptanceCriterionRecord[];
  footprint: {
    code_paths: string[];
    help: Array<{ source: string; external_id: string }>;
  };
  coverage: ContractCoverage;
  freshness: Freshness;
  superseded_by: { stable_id: string } | null;
}

export interface ContractStoryFilters {
  repositories?: string[];
  capabilities?: string[];
  story_keys?: string[];
  actors?: string[];
  lifecycles?: StoryLifecycle[];
  authorities?: ContractAuthority[];
  code_path?: string;
  help_source?: string;
  help_external_id?: string;
  has_direct_ac_links?: boolean;
  include_inactive_criteria?: boolean;
}

export type ContractStoryGroupBy =
  | "repository"
  | "capability"
  | "lifecycle"
  | "authority"
  | "actor";

export type QueryContractStoriesResult =
  | {
      mode: "records";
      total: number;
      records: ContractStoryRecord[];
    }
  | {
      mode: "grouped";
      groups: Array<{ group: string; count: number }>;
    };

export interface ContractCriterionLookup {
  story: {
    repository: string;
    stable_id: string;
    title: string;
    lifecycle: StoryLifecycle;
    authority: ContractAuthority;
  };
  criterion: ContractAcceptanceCriterionRecord;
}

export interface ContractGraphNode {
  id: string;
  kind: "capability" | "story" | "acceptance_criterion" | "code" | "test" | "help";
  label: string;
  authority?: ContractAuthority;
  lifecycle?: StoryLifecycle;
  freshness?: Freshness;
  active?: boolean;
}

export interface ContractGraphEdge {
  source: string;
  target: string;
  relation:
    | "contains"
    | "implements"
    | "enforces"
    | "tests"
    | "documents"
    | "superseded_by";
  scope: "hierarchy" | "direct" | "story_fallback" | "lifecycle";
}

export interface ContractGraph {
  nodes: ContractGraphNode[];
  edges: ContractGraphEdge[];
}

export interface HandoffConflictRecord {
  id: string;
  repository: string;
  story_id: string;
  story_stable_id: string;
  materialized_revision: number;
  later_planning_revision: number;
  merged_content: Record<string, unknown>;
  planning_content: Record<string, unknown>;
  resolved_at: string | null;
  created_at: string;
}

export interface ContractReadStore {
  queryContractStories(opts: {
    filters: ContractStoryFilters;
    groupBy?: ContractStoryGroupBy | null;
    limit: number;
  }): Promise<QueryContractStoriesResult>;
  getAcceptanceCriterion(opts: {
    repository: string;
    stableId: string;
    includeInactive?: boolean;
  }): Promise<ContractCriterionLookup | null>;
  contractGraph(opts?: {
    repositories?: string[];
    lifecycles?: StoryLifecycle[];
    authorities?: ContractAuthority[];
    includeInactiveCriteria?: boolean;
  }): Promise<ContractGraph>;
  listHandoffConflicts(opts?: {
    repository?: string;
    story_stable_id?: string;
    include_resolved?: boolean;
    limit?: number;
  }): Promise<HandoffConflictRecord[]>;
}

export function effectiveApplicability(
  ...levels: Array<Applicability | null | undefined>
): Applicability {
  const effective: Applicability = {};
  for (const level of levels) {
    if (!level) continue;
    for (const [dimension, values] of Object.entries(level)) {
      effective[dimension] = [...values];
    }
  }
  return effective;
}

export function summarizeFreshness(
  links: ContractEvidenceLink[]
): Freshness {
  const evaluated = links
    .map((link) => link.freshness)
    .filter((freshness) => freshness !== "not_applicable");
  if (evaluated.length === 0) return "not_applicable";
  if (evaluated.includes("stale")) return "stale";
  if (evaluated.includes("unknown")) return "unknown";
  return "current";
}

function coverageFor(
  criteria: ContractAcceptanceCriterionRecord[],
  matches: (link: ContractEvidenceLink) => boolean
): CoverageLevel {
  const active = criteria.filter((criterion) => criterion.active);
  if (active.length === 0) return "none";
  const linked = active.filter((criterion) =>
    criterion.direct_links.some(matches)
  ).length;
  if (linked === 0) return "none";
  return linked === active.length ? "complete" : "partial";
}

export function computeStoryCoverage(
  authority: ContractAuthority,
  criteria: ContractAcceptanceCriterionRecord[]
): ContractCoverage {
  if (authority !== "repository") {
    return {
      implementation: "not_applicable",
      test: "not_applicable",
      help: "not_applicable",
    };
  }
  return {
    implementation: coverageFor(
      criteria,
      (link) => link.relation === "implements" || link.relation === "enforces"
    ),
    test: coverageFor(criteria, (link) => link.relation === "tests"),
    help: coverageFor(criteria, (link) => link.relation === "documents"),
  };
}

function evidenceNodeId(link: ContractEvidenceLink): string {
  if (link.target.kind === "help") {
    return `help:${link.target.source}:${link.target.external_id}`;
  }
  return `${link.target.kind}:${link.target.repository}:${link.target.path}:${
    link.target.selector ?? ""
  }`;
}

function evidenceLabel(link: ContractEvidenceLink): string {
  if (link.target.kind === "help") {
    return link.target.title ?? `${link.target.source}:${link.target.external_id}`;
  }
  return link.target.selector
    ? `${link.target.path} · ${link.target.selector}`
    : link.target.path;
}

export function buildContractGraph(
  stories: ContractStoryRecord[]
): ContractGraph {
  const nodes = new Map<string, ContractGraphNode>();
  const edges = new Map<string, ContractGraphEdge>();

  function addEdge(edge: ContractGraphEdge): void {
    const key = JSON.stringify([
      edge.source,
      edge.target,
      edge.relation,
      edge.scope,
    ]);
    edges.set(key, edge);
  }

  function addEvidence(
    source: string,
    link: ContractEvidenceLink
  ): void {
    const id = evidenceNodeId(link);
    nodes.set(id, {
      id,
      kind: link.target.kind,
      label: evidenceLabel(link),
      freshness: link.freshness,
    });
    addEdge({
      source,
      target: id,
      relation: link.relation,
      scope: link.scope,
    });
  }

  for (const story of stories) {
    const capabilityId = `capability:${story.repository}:${story.capability.stable_id}`;
    const storyId = `story:${story.repository}:${story.stable_id}`;
    nodes.set(capabilityId, {
      id: capabilityId,
      kind: "capability",
      label: story.capability.name,
    });
    nodes.set(storyId, {
      id: storyId,
      kind: "story",
      label: story.title,
      authority: story.authority,
      lifecycle: story.lifecycle,
      freshness: story.freshness,
    });
    addEdge({
      source: capabilityId,
      target: storyId,
      relation: "contains",
      scope: "hierarchy",
    });
    for (const link of story.direct_links) addEvidence(storyId, link);

    for (const criterion of story.acceptance_criteria) {
      const criterionId = `ac:${story.repository}:${criterion.stable_id}`;
      nodes.set(criterionId, {
        id: criterionId,
        kind: "acceptance_criterion",
        label: criterion.criterion ?? criterion.stable_id,
        authority: criterion.authority,
        freshness: criterion.freshness,
        active: criterion.active,
      });
      addEdge({
        source: storyId,
        target: criterionId,
        relation: "contains",
        scope: "hierarchy",
      });
      for (const link of criterion.direct_links) {
        addEvidence(criterionId, link);
      }
      if (criterion.superseded_by) {
        addEdge({
          source: criterionId,
          target: `ac:${story.repository}:${criterion.superseded_by.stable_id}`,
          relation: "superseded_by",
          scope: "lifecycle",
        });
      }
    }
    if (story.superseded_by) {
      addEdge({
        source: storyId,
        target: `story:${story.repository}:${story.superseded_by.stable_id}`,
        relation: "superseded_by",
        scope: "lifecycle",
      });
    }
  }

  return {
    nodes: [...nodes.values()].sort((left, right) =>
      left.id.localeCompare(right.id)
    ),
    edges: [...edges.values()].sort((left, right) => {
      const source = left.source.localeCompare(right.source);
      if (source !== 0) return source;
      const target = left.target.localeCompare(right.target);
      if (target !== 0) return target;
      return left.relation.localeCompare(right.relation);
    }),
  };
}
