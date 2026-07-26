/**
 * find_crossover — "things *entangled with* this". Structural entanglement for
 * a known section/story, ranked by rare-slug/path (1/df) weighting.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getStore } from "../store.js";
import { findCrossoverShape, findCrossoverOutputShape, type FindCrossoverInput } from "../schemas.js";
import { jsonResult, errorResult, formatError, type ToolResult } from "./shared.js";

const DESCRIPTION = `Given a section or story key you ALREADY HAVE, retrieve the OTHER product areas it is structurally entangled with — i.e. sections that touch the same code paths / entity slugs. Ranked by shared signals weighted by 1/df, so distinctive overlaps (e.g. 'tax-rate', df≈8) outrank hub tags (e.g. 'settings', df≈35).

Takes no free text — it operates on the key's existing footprint (the union of its stories' code paths + entity slugs). Answers "what else lives in the same code as X?".

Args:
  - section_key (string): e.g. 'project-sharing' — uses the union footprint of all its stories.
  - story_key (string): e.g. 'SHARING-003' — uses that one story's footprint.
  - limit (int 1-20, default 5): always optional.
  Provide EXACTLY ONE of section_key or story_key (not both, not neither). An unknown key returns an error naming the key.

Returns the matched footprint (target) and ranked entangled sections, each naming the shared code paths / entity slugs (the "why"); see the output schema for the full shape.

Notes:
  - score sums the shared signals' 1/df weights (code paths count ~1.5x); higher = more, or rarer, shared signals. You can't infer that from the raw number.
  - An empty results list (a top-level "note") means the key is structurally isolated — a valid, intentional answer, not an error. An unknown key returns an error instead.

Examples:
  - Use when: "what else touches the same files as project sharing?" -> find_crossover(section_key="project-sharing").
  - Don't use when: you have free text and no key (use find_related), or want exact attribute filters / counts (use query_stories), or want help docs (use find_help).`;

export function registerFindCrossover(server: McpServer): void {
  server.registerTool(
    "find_crossover",
    {
      title: "Find entangled areas",
      description: DESCRIPTION,
      inputSchema: findCrossoverShape,
      outputSchema: findCrossoverOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input: FindCrossoverInput): Promise<ToolResult> => {
      try {
        if (!input.section_key && !input.story_key) {
          return errorResult("Provide exactly one of section_key or story_key.");
        }
        const { found, target, hits } = await getStore().findCrossover({
          sectionKey: input.section_key,
          storyKey: input.story_key,
          limit: input.limit,
        });

        if (!found) {
          const ref = input.section_key
            ? `section_key='${input.section_key}'`
            : `story_key='${input.story_key}'`;
          return errorResult(
            `No ${ref} found. Check the key (use query_stories or schema://taxonomy to list valid keys).`
          );
        }

        const payload: Record<string, unknown> = {
          target: {
            ...(input.section_key ? { section_key: input.section_key } : {}),
            ...(input.story_key ? { story_key: input.story_key } : {}),
            entity_slugs: target?.entitySlugs ?? [],
            code_paths: target?.codePaths ?? [],
          },
          results: hits,
        };
        if (hits.length === 0) {
          payload.note =
            "No other section shares this footprint's code paths or entity slugs — the key is " +
            "structurally isolated. This empty result is intentional, not an error.";
        }
        return jsonResult(payload);
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );
}
