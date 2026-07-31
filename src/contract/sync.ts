import type { ContractManifest } from "./manifest.js";

export interface HandoffConflict {
  story_id: string;
  story_stable_id: string;
  materialized_revision: number;
  later_planning_revision: number;
}

export interface ContractSyncOptions {
  expectedPreviousCommit?: string;
}

export interface ContractSyncResult {
  outcome: "synced" | "unchanged";
  repository: string;
  commit: string;
  stories: number;
  acceptance_criteria: number;
  retired_stories: number;
  retired_acceptance_criteria: number;
  conflicts: HandoffConflict[];
}

export interface ContractSyncRepository {
  sync(
    manifest: ContractManifest,
    options?: ContractSyncOptions
  ): Promise<ContractSyncResult>;
}

export class ContractSyncCollisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractSyncCollisionError";
  }
}

export class ContractSyncCheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractSyncCheckpointError";
  }
}

export async function syncContractManifest(
  repository: ContractSyncRepository,
  manifest: ContractManifest,
  options: ContractSyncOptions = {}
): Promise<ContractSyncResult> {
  return repository.sync(manifest, options);
}
