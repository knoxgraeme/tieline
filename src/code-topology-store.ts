/** Composition root for immutable committed code-topology generations. */
import { PostgresCodeTopologyRepository } from "./adapters/postgres/code-topology-repository.js";
import type { CodeTopologyStore } from "./domain/code-topology-store.js";

let singleton: CodeTopologyStore | null = null;

export function getCodeTopologyStore(): CodeTopologyStore {
  if (!singleton) singleton = new PostgresCodeTopologyRepository();
  return singleton;
}

/** Test and alternate-adapter seam kept separate from the authored KnowledgeStore. */
export function setCodeTopologyStore(store: CodeTopologyStore): void {
  singleton = store;
}

export type {
  CodeTopologyReadStore,
  CodeTopologyStore,
  CodeTopologyWriteStore,
} from "./domain/code-topology-store.js";
