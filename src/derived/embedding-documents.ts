import { createHash } from "node:crypto";
import type {
  ContractAcceptanceCriterionRecord,
  ContractScenarioRecord,
  ContractStoryRecord,
} from "../domain/contract-read-store.js";
import type {
  BacklogItemRecord,
  ObservationRecord,
} from "../domain/evidence-write-store.js";

export const EMBEDDING_DOCUMENT_VERSION = "contract-v1";

export type EmbeddingDocumentKind =
  | "story"
  | "acceptance_criterion"
  | "scenario"
  | "backlog_item"
  | "observation";

export interface DerivedEmbeddingDocument {
  entity_kind: EmbeddingDocumentKind;
  entity_id: string;
  document_kind: EmbeddingDocumentKind;
  canonical_text: string;
  source_text_hash: string;
  filter_metadata: Record<string, unknown>;
}

function compact(lines: Array<string | null | undefined>): string {
  return lines
    .map((line) => line?.replace(/\s+/g, " ").trim())
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function aliases(values: string[]): string | null {
  return values.length > 0 ? `Also known as: ${values.join("; ")}` : null;
}

function applicability(value: Record<string, string[]>): string | null {
  const dimensions = Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([dimension, values]) => `${dimension}: ${[...values].sort().join(", ")}`);
  return dimensions.length > 0 ? `Applies to: ${dimensions.join("; ")}` : null;
}

function baseMetadata(
  story: ContractStoryRecord
): Record<string, unknown> {
  return {
    repository: story.repository,
    authority: story.authority,
    lifecycle: story.lifecycle,
    active: story.lifecycle !== "retired",
    story_id: story.id,
    story_stable_id: story.stable_id,
    capability_stable_id: story.capability.stable_id,
    coverage: story.coverage,
    freshness: story.freshness,
  };
}

function storyContext(story: ContractStoryRecord): string {
  return compact([
    story.title,
    story.rendered_story,
    `Capability: ${story.capability.name}`,
  ]);
}

function criterionContext(
  story: ContractStoryRecord,
  criterion: ContractAcceptanceCriterionRecord
): string {
  return compact([
    storyContext(story),
    criterion.criterion,
    criterion.rationale ? `Why: ${criterion.rationale}` : null,
  ]);
}

function document(
  entityKind: EmbeddingDocumentKind,
  entityId: string,
  canonicalText: string,
  filterMetadata: Record<string, unknown>
): DerivedEmbeddingDocument {
  return {
    entity_kind: entityKind,
    entity_id: entityId,
    document_kind: entityKind,
    canonical_text: canonicalText,
    source_text_hash: hash(canonicalText),
    filter_metadata: filterMetadata,
  };
}

export function storyEmbeddingDocument(
  story: ContractStoryRecord
): DerivedEmbeddingDocument {
  const text = compact([
    storyContext(story),
    aliases(story.aliases),
    applicability(story.effective_applies_to),
  ]);
  return document("story", story.id, text, {
    ...baseMetadata(story),
    matched_level: "story",
    aliases: story.aliases,
    applicability: story.effective_applies_to,
  });
}

export function criterionEmbeddingDocument(
  story: ContractStoryRecord,
  criterion: ContractAcceptanceCriterionRecord
): DerivedEmbeddingDocument {
  const text = compact([
    criterionContext(story, criterion),
    aliases(criterion.aliases),
    applicability(criterion.effective_applies_to),
  ]);
  return document("acceptance_criterion", criterion.id, text, {
    ...baseMetadata(story),
    authority: criterion.authority,
    active: story.lifecycle !== "retired" && criterion.active,
    matched_level: "acceptance_criterion",
    acceptance_criterion_id: criterion.id,
    acceptance_criterion_stable_id: criterion.stable_id,
    aliases: criterion.aliases,
    applicability: criterion.effective_applies_to,
    freshness: criterion.freshness,
  });
}

export function scenarioEmbeddingDocument(
  story: ContractStoryRecord,
  criterion: ContractAcceptanceCriterionRecord,
  scenario: ContractScenarioRecord
): DerivedEmbeddingDocument {
  const text = compact([
    criterionContext(story, criterion),
    scenario.name,
    `Given ${scenario.given}`,
    `When ${scenario.when}`,
    `Then ${scenario.then}`,
    applicability(criterion.effective_applies_to),
  ]);
  return document("scenario", scenario.id, text, {
    ...baseMetadata(story),
    authority: criterion.authority,
    active:
      story.lifecycle !== "retired" &&
      criterion.active &&
      scenario.active,
    matched_level: "scenario",
    acceptance_criterion_id: criterion.id,
    acceptance_criterion_stable_id: criterion.stable_id,
    scenario_stable_id: scenario.stable_id,
    applicability: criterion.effective_applies_to,
    freshness: criterion.freshness,
  });
}

export function contractEmbeddingDocuments(
  stories: ContractStoryRecord[]
): DerivedEmbeddingDocument[] {
  return stories.flatMap((story) => [
    storyEmbeddingDocument(story),
    ...story.acceptance_criteria.flatMap((criterion) => [
      criterionEmbeddingDocument(story, criterion),
      ...criterion.scenarios.map((scenario) =>
        scenarioEmbeddingDocument(story, criterion, scenario)
      ),
    ]),
  ]);
}

export function observationEmbeddingDocument(
  observation: ObservationRecord
): DerivedEmbeddingDocument {
  return document(
    "observation",
    observation.id,
    compact([observation.search_text]),
    {
      matched_level: "observation",
      observation_kind: observation.kind,
      active: true,
      coverage: null,
      freshness: "not_applicable",
    }
  );
}

export function backlogEmbeddingDocument(
  item: BacklogItemRecord
): DerivedEmbeddingDocument {
  return document(
    "backlog_item",
    item.id,
    compact([item.title, item.summary]),
    {
      matched_level: "backlog_item",
      backlog_stable_id: item.stable_id,
      backlog_stage: item.stage,
      active: item.superseded_by === null,
      coverage: null,
      freshness: "not_applicable",
    }
  );
}

export function documentsNeedingEmbedding(
  current: DerivedEmbeddingDocument[],
  previousHashes: Map<string, string>
): DerivedEmbeddingDocument[] {
  return current.filter(
    (entry) =>
      previousHashes.get(
        `${entry.entity_kind}:${entry.entity_id}:${entry.document_kind}`
      ) !== entry.source_text_hash
  );
}
