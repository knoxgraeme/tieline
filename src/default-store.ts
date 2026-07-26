/** Composition root for the bundled persistence adapter. */
import type { KnowledgeStore } from "./domain/knowledge-store.js";
import { PostgresStore } from "./adapters/postgres/postgres-store.js";

export function createDefaultStore(): KnowledgeStore {
  return new PostgresStore();
}
