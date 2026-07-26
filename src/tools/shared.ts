/**
 * Shared helpers for tool responses: consistent JSON shaping, character-limit
 * truncation, and error formatting.
 */

import { config } from "../config.js";

export interface ToolResult {
  // index signature required by the SDK's CallToolResult type
  [x: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Build a successful tool result carrying both text and structured data. */
export function jsonResult(payload: Record<string, unknown>): ToolResult {
  const full = JSON.stringify(payload, null, 2);
  if (full.length <= config.characterLimit) {
    return { content: [{ type: "text", text: full }], structuredContent: payload };
  }
  // Over budget: drop elements from the heaviest top-level array until the
  // serialized result fits, keeping the JSON *valid* (a hard slice would leave
  // an unparseable string for the client). structuredContent keeps the full data.
  const text = JSON.stringify(truncateToFit(payload, config.characterLimit), null, 2);
  return { content: [{ type: "text", text }], structuredContent: payload };
}

/** Shrink the largest top-level array in `payload` until JSON.stringify fits. */
function truncateToFit(payload: Record<string, unknown>, limit: number): Record<string, unknown> {
  const arrayKeys = Object.keys(payload).filter((k) => Array.isArray(payload[k]));
  // Trim the longest array (records/results/groups) first.
  const key = arrayKeys.sort(
    (a, b) => (payload[b] as unknown[]).length - (payload[a] as unknown[]).length
  )[0];
  const note =
    "Response exceeded character limit; results were trimmed. Reduce limit or add filters.";
  if (!key) {
    // No array to trim — return just the note (still valid JSON).
    return { _truncated: true, _note: note };
  }
  const original = payload[key] as unknown[];
  let n = original.length;
  let out: Record<string, unknown> = payload;
  while (n > 0) {
    out = {
      ...payload,
      [key]: original.slice(0, n),
      _truncated: true,
      _note: note,
      _truncated_field: key,
      _returned: n,
      _total_available: original.length,
    };
    if (JSON.stringify(out, null, 2).length <= limit) return out;
    // Geometric back-off keeps this O(log n) stringify calls.
    n = Math.floor(n / 2);
  }
  return { ...payload, [key]: [], _truncated: true, _note: note, _truncated_field: key, _returned: 0, _total_available: original.length };
}

/** Build an actionable error result. */
export function errorResult(message: string): ToolResult {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    // Surface common DB misconfig hints.
    if (/match_user_stories|relation .* does not exist/.test(error.message)) {
      return `${error.message}. Did you run the migrations (0001-0009) and the ingest script?`;
    }
    return error.message;
  }
  return String(error);
}
