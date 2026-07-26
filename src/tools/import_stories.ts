/**
 * import_stories — bulk-import an approved set of stories in one call. The commit
 * step of the generate -> review -> import authoring flow, and the tool the
 * review UI (MCP app / localhost server) calls on "Add approved -> brain".
 *
 * Creates any new sections, embeds each story on write, and normalizes entity
 * slugs + code paths into the graph. Writes via the owner/ingest connection, so
 * it needs DATABASE_URL_INGEST (a write-capable role); for a single ad-hoc story
 * prefer create_user_story.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getStore } from "../store.js";
import { sectionRecordSchema, storyRecordSchema } from "../authoring/schema.js";
import { jsonResult, errorResult, formatError, type ToolResult } from "./shared.js";

const importStoriesShape = {
  stories: z
    .array(storyRecordSchema)
    .min(1)
    .max(100, "The MCP import surface accepts at most 100 stories; use the CLI for larger batches.")
    .describe(
      "The stories to import. Each: {section_key, title, story_text, actor?, status? (default 'idea'), " +
        "entity_slugs?, code_paths?, story_key?}. Omit story_key to mint a new section-consistent key; " +
        "supply one to upsert that story."
    ),
  sections: z
    .array(sectionRecordSchema)
    .optional()
    .describe(
      "Definitions for any NEW sections the stories reference: {section_key, section_name, parent_area?, " +
        "actor?, definition?, routes?}. Existing sections don't need to be listed."
    ),
  import_source: z
    .string()
    .min(1)
    .optional()
    .describe("Stable source namespace for import_ref idempotency keys."),
};

const importStoriesOutputShape = {
  imported: z.object({
    sections: z.number(),
    stories: z.number(),
    entities: z.number(),
    code_paths: z.number(),
    batches: z.array(z.object({
      batch: z.number(),
      stories: z.number(),
      applied: z.number(),
      skipped: z.number(),
      status: z.literal("committed"),
    })).optional(),
  }),
  note: z.string(),
};

const DESCRIPTION = `Elevated occasional bulk import — the commit step after a human reviews generated/backfilled stories. This tool is absent unless ENABLE_IMPORT_TOOL=true; prefer the CLI for normal operation.

Creates new sections, embeds accepted rows, and normalizes entity/code links. Stable import_source + import_ref values make completed keyless records no-op on retry. Commits in bounded batches.

Args:
  - stories (required): array of story records (see the input schema).
  - sections (optional): definitions for any new sections the stories reference.

Use for a batch (the approved review set). For a single ad-hoc story, prefer create_user_story. Requires a write-capable ingest connection (DATABASE_URL_INGEST); returns counts of what was written.`;

export function registerImportStories(server: McpServer): void {
  server.registerTool(
    "import_stories",
    {
      title: "Import stories (bulk)",
      description: DESCRIPTION,
      inputSchema: importStoriesShape,
      outputSchema: importStoriesOutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input): Promise<ToolResult> => {
      try {
        const payload = {
          import_source: input.import_source ?? null,
          sections: input.sections ?? [],
          stories: input.stories,
        };
        const imported = await getStore().importStories(payload);
        return jsonResult({
          imported,
          note:
            `Imported ${imported.stories} story(ies) across ${imported.sections} section(s), ` +
            `embedded on write and searchable now via find_related / query_stories.`,
        });
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );
}
