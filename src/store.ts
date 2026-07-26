/**
 * KnowledgeStore — the persistence port the MCP tools depend on.
 *
 * Tools import `getStore()` and call methods on the interface; they never import
 * the concrete data-access module. That decoupling is what keeps the server
 * platform-agnostic: the default composition root supplies one adapter, while an
 * alternate backend—or the loud in-memory test fake—implements the same interface.
 *
 * Mirrors the getEmbedder()/setEmbedder() singleton idiom in embeddings.ts.
 */

import type { KnowledgeStore } from "./domain/knowledge-store.js";
import { createDefaultStore } from "./default-store.js";

export type { KnowledgeStore } from "./domain/knowledge-store.js";

let singleton: KnowledgeStore | null = null;

export function getStore(): KnowledgeStore {
  if (!singleton) singleton = createDefaultStore();
  return singleton;
}

/** Test seam: swap the store (e.g. an in-memory fake) before creating a server. */
export function setStore(store: KnowledgeStore): void {
  singleton = store;
}
