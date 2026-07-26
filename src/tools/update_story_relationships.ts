/** Typed relationship parity over normalized entity/code/help joins. */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getStore } from "../store.js";
import { jsonResult, errorResult, formatError, type ToolResult } from "./shared.js";

const entity = z.object({
  entity_slug: z.string().min(1),
  entity_name: z.string().nullable().optional(),
  relationship_type: z.string().min(1).optional(),
});
const codeAsset = z.object({
  repo: z.string().min(1),
  path: z.string().min(1),
  asset_type: z.string().nullable().optional(),
  symbol_name: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  link_type: z.string().min(1).optional(),
  provenance: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  confidence_reason: z.string().nullable().optional(),
  sort_order: z.number().int().min(0).optional(),
  last_verified_at: z.string().datetime().nullable().optional(),
});
const helpArticle = z.object({
  article_slug: z.string().min(1),
  relationship_type: z.enum(["primary", "supporting", "reference", "troubleshooting"]).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

function family<T extends z.ZodTypeAny, R extends z.ZodTypeAny>(item: T, remove: R) {
  return z
    .object({ add: z.array(item).optional(), remove: z.array(remove).optional(), replace: z.array(item).optional() })
    .refine((v) => Boolean(v.add?.length || v.remove?.length || v.replace), {
      message: "Provide add, remove, or replace for this relationship family.",
    })
    .refine((v) => !(v.replace && (v.add || v.remove)), {
      message: "replace cannot be combined with add/remove for the same relationship family.",
    });
}

const inputObject = z.object({
    story_key: z.string().min(1),
    expected_revision: z.number().int().positive().optional(),
    entities: family(entity, z.string().min(1)).optional(),
    code_assets: family(codeAsset, z.object({ repo: z.string().min(1), path: z.string().min(1) })).optional(),
    help_articles: family(helpArticle, z.string().min(1)).optional(),
    reason: z.string().optional(),
    source: z.string().optional(),
    proposed_by: z.string().optional(),
  });
const inputSchema = inputObject.refine((v) => Boolean(v.entities || v.code_assets || v.help_articles), {
    message: "Provide at least one relationship family to update.",
  });

const outputShape = {
  outcome: z.enum(["applied", "proposed", "stale", "not_found", "no_fields"]),
  revision_number: z.number().int().optional(),
  current_revision_number: z.number().int().optional(),
  proposal: z
    .object({
      id: z.number(),
      operation: z.enum(["create", "update", "relationships"]),
      status: z.enum(["pending", "approved", "rejected", "stale"]),
      story_key: z.string().nullable(),
      base_revision_number: z.number().int().nullable(),
      reason: z.string().nullable(),
      source: z.string(),
      created_at: z.string(),
    })
    .optional(),
  note: z.string(),
};

export function registerUpdateStoryRelationships(server: McpServer): void {
  server.registerTool(
    "update_story_relationships",
    {
      title: "Update story relationships",
      description:
        "Add, remove, or replace a story's typed entity, code-asset, and help-article relationships atomically. " +
        "Storage remains normalized. Production-story relationship changes become human-reviewed proposals by default.",
      inputSchema: inputObject.shape,
      outputSchema: outputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input): Promise<ToolResult> => {
      try {
        const parsed = inputSchema.parse(input);
        const result = await getStore().updateStoryRelationships({
          storyKey: parsed.story_key,
          patch: {
            ...(parsed.entities ? { entities: parsed.entities } : {}),
            ...(parsed.code_assets ? { code_assets: parsed.code_assets } : {}),
            ...(parsed.help_articles ? { help_articles: parsed.help_articles } : {}),
          },
          expectedRevision: parsed.expected_revision,
          reason: parsed.reason ?? null,
          source: parsed.source,
          proposedBy: parsed.proposed_by ?? null,
        });
        if (result.outcome === "applied") {
          return jsonResult({
            outcome: result.outcome,
            revision_number: result.revision_number,
            note: "Relationship state updated and an immutable relationship event was appended.",
          });
        }
        if (result.outcome === "proposed") {
          return jsonResult({
            outcome: result.outcome,
            proposal: result.proposal,
            note: `Relationship change is pending human approval as proposal ${result.proposal.id}.`,
          });
        }
        if (result.outcome === "stale") {
          return jsonResult({
            outcome: result.outcome,
            current_revision_number: result.current_revision_number,
            note: `Expected revision is stale; current revision is ${result.current_revision_number}.`,
          });
        }
        return jsonResult({ outcome: result.outcome, note: `Relationship update returned ${result.outcome}.` });
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );
}
