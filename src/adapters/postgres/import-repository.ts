import { importStories as runImport } from "../../authoring/import.js";
import { getEmbedder } from "../../embeddings.js";
import type { ImportPayload } from "../../authoring/schema.js";
import type { StoryImportResult } from "../../domain/knowledge-store.js";
import { getIngestSql } from "./connections.js";

export function importStories(payload: ImportPayload): Promise<StoryImportResult> {
  return runImport(getIngestSql(), getEmbedder(), payload);
}
