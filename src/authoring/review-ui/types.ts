/**
 * Browser-facing types for the review UI. It shares the framework-free domain
 * status type and has no server/zod dependency. It is type-checked via
 * tsconfig.ui.json and compiled/bundled by esbuild, NOT the Node `tsc` build
 * (which excludes this folder). The shapes mirror src/authoring/schema.ts's draft
 * contract, kept in sync by hand.
 */

export type ReviewState = "pending" | "approved" | "rejected";

export type { StoryStatus } from "../../types.js";
import type { StoryStatus } from "../../types.js";

export interface ReviewMeta {
  id: string;
  state: ReviewState;
  comment?: string;
  confidence?: number | null;
  provenance?: string | null;
}

export interface DraftStory {
  section_key: string;
  title: string;
  story_text: string;
  actor?: string | null;
  status: StoryStatus;
  entity_slugs?: string[];
  code_paths?: string[];
  story_key?: string | null;
  _review: ReviewMeta;
}

export interface DraftSection {
  section_key: string;
  section_name: string;
  [key: string]: unknown;
}

export interface Draft {
  version?: number;
  mode?: string;
  repo?: string | null;
  sections: DraftSection[];
  stories: DraftStory[];
}

/** The approved slice sent to import_stories (the `_review` field stripped). */
export interface ImportPayload {
  sections: DraftSection[];
  stories: Array<Omit<DraftStory, "_review">>;
}

export interface ImportResult {
  sections: number;
  stories: number;
  entities?: number;
  code_paths?: number;
}

/**
 * The host adapter the view routes all I/O through, so the same view runs behind
 * the local server (`tieline review`) and inside an MCP app.
 */
export interface Host {
  /** Optional autosave of the whole draft. */
  save?(draft: Draft): Promise<void>;
  /** "Add approved → brain" — returns what was imported. */
  commit(payload: ImportPayload): Promise<ImportResult>;
  /** Optional "Lock & export" (write/download the locked file). */
  lock?(payload: ImportPayload): Promise<void>;
}

declare global {
  interface Window {
    ReviewUI: { render(draft: Draft, host: Host): void };
  }
}
