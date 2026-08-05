import type {
  SemanticAdmissionSignal,
  SemanticRankingFeatures,
} from "./ranking.js";

export interface BacklogCandidate {
  suggestion_id: string;
  target_kind:
    | "backlog_item"
    | "story"
    | "acceptance_criterion"
    | "observation";
  target_stable_id: string;
  repository?: string;
  score: number;
  features: SemanticRankingFeatures;
  admitted_by: SemanticAdmissionSignal[];
  reason: string;
}

export interface BacklogCreateAdvice {
  candidates: BacklogCandidate[];
  require_explicit_continue: boolean;
}

export interface BacklogCreateAdvisor {
  beforeCreate(input: {
    title: string;
    summary: string;
  }): Promise<BacklogCreateAdvice>;
}

let advisor: BacklogCreateAdvisor | null = null;

/** U7 installs semantic match-before-create behavior through this seam. */
export function setBacklogCreateAdvisor(
  next: BacklogCreateAdvisor | null
): void {
  advisor = next;
}

export async function adviseBacklogCreate(input: {
  title: string;
  summary: string;
}): Promise<BacklogCreateAdvice | null> {
  return advisor?.beforeCreate(input) ?? null;
}
