import type {
  ContractSyncOptions,
  ContractSyncRepository,
  ContractSyncResult,
} from "../contract/sync.js";
import type { ContractManifest } from "../contract/manifest.js";

/** Write-only port used by repository projection; it is never exposed to MCP reads. */
export interface RepositorySyncStore extends ContractSyncRepository {
  sync(
    manifest: ContractManifest,
    options: ContractSyncOptions
  ): Promise<ContractSyncResult>;
}
