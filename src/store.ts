/**
 * KnowledgeStore — the persistence port the MCP tools depend on.
 *
 * Tools import the capability-scoped facades (getReadStore, getEvidenceWriteStore,
 * getPlanningWriteStore) and call methods on the interface; they never import
 * the concrete data-access module. That decoupling is what keeps the server
 * platform-agnostic: the default composition root supplies one adapter, while an
 * alternate backend—or the loud in-memory test fake—implements the same interface.
 *
 * Mirrors the getEmbedder()/setEmbedder() singleton idiom in embeddings.ts.
 */

import type {
  AttributionSuggestionDecisionStore,
  AttributionSuggestionReadStore,
  HelpReadStore,
  KnowledgeStore,
} from "./domain/knowledge-store.js";
import type { ContractReadStore } from "./domain/contract-read-store.js";
import type { EvidenceWriteStore } from "./domain/evidence-write-store.js";
import type { BacklogReadStore } from "./domain/evidence-write-store.js";
import type { SemanticSearchStore } from "./domain/semantic-search-store.js";
import type { PlanningContractWriteStore } from "./domain/planning-contract-write-store.js";
import { createDefaultStore } from "./default-store.js";

export type { KnowledgeStore } from "./domain/knowledge-store.js";

let singleton: KnowledgeStore | null = null;

function getStore(): KnowledgeStore {
  if (!singleton) singleton = createDefaultStore();
  return singleton;
}

export type ReadKnowledgeStore = HelpReadStore &
  ContractReadStore &
  BacklogReadStore &
  SemanticSearchStore &
  AttributionSuggestionReadStore;

/** Read tools receive only read capabilities, never planning or repository-sync writes. */
export function getReadStore(): ReadKnowledgeStore {
  return getStore();
}

export type EvidenceWriteKnowledgeStore = EvidenceWriteStore &
  AttributionSuggestionDecisionStore;

/** Evidence tools receive planning-write capabilities without repository sync or admin access. */
export function getEvidenceWriteStore(): EvidenceWriteKnowledgeStore {
  return getStore();
}

/** Planning tools cannot write repository-owned contract rows. */
export function getPlanningWriteStore(): PlanningContractWriteStore {
  return getStore();
}

/** Test seam: swap the store (e.g. an in-memory fake) before creating a server. */
export function setStore(store: KnowledgeStore): void {
  singleton = store;
}
