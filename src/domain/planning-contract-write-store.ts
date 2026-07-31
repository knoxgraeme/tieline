import type {
  Applicability,
  ContractScenario,
} from "../contract/schema.js";
import type { ContractStoryRecord } from "./contract-read-store.js";

export interface PlanningCriterionInput {
  stable_id?: string;
  criterion?: string | null;
  rationale?: string | null;
  aliases?: string[];
  applies_to?: Applicability | null;
  scenarios?: ContractScenario[];
}

export interface CreatePlanningStoryInput {
  repository: string;
  capability_stable_id?: string | null;
  stable_id?: string;
  title: string;
  actor?: string | null;
  goal?: string | null;
  benefit?: string | null;
  aliases?: string[];
  applies_to?: Applicability | null;
  motivated_by?: string[];
  acceptance_criteria?: PlanningCriterionInput[];
}

export interface UpdatePlanningStoryInput {
  repository: string;
  stable_id: string;
  expected_revision: number;
  capability_stable_id?: string | null;
  title?: string;
  actor?: string | null;
  goal?: string | null;
  benefit?: string | null;
  aliases?: string[];
  applies_to?: Applicability | null;
  motivated_by?: string[];
  superseded_by?: string | null;
  acceptance_criteria?: PlanningCriterionInput[];
}

export type PlanningStoryMutationResult =
  | { outcome: "applied"; story: ContractStoryRecord }
  | { outcome: "stale"; current_revision: number }
  | { outcome: "not_found" | "no_fields" };

export interface PlanningContractWriteStore {
  createPlanningStory(
    input: CreatePlanningStoryInput
  ): Promise<ContractStoryRecord>;
  updatePlanningStory(
    input: UpdatePlanningStoryInput
  ): Promise<PlanningStoryMutationResult>;
}
