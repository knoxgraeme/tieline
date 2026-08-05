import type { ContractManifest } from "./manifest.js";

export interface HandoffConflict {
  story_id: string;
  story_stable_id: string;
  materialized_revision: number;
  later_planning_revision: number;
}

export interface ContractSyncOptions {
  /** Git revision whose repository projection is being synchronized. */
  commit: string;
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
  /**
   * Orphaned `code_assets` rows the projection repaired on this run. Reported
   * so drift is visible rather than accumulating silently across renames.
   */
  reconciled_code_assets: number;
}

export interface ContractSyncRepository {
  sync(
    manifest: ContractManifest,
    options: ContractSyncOptions
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
  options: ContractSyncOptions
): Promise<ContractSyncResult> {
  const commit = options.commit.trim();
  if (!commit) {
    throw new Error("Repository sync commit cannot be empty.");
  }
  return repository.sync(manifest, { ...options, commit });
}
