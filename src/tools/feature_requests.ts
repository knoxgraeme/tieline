/**
 * Feature-request tools: record an incoming request as customer evidence and
 * link it to the product stories it maps to (one primary + N secondary). The
 * link rows are what produce primaryUserStory / secondaryUserStories.
 *
 * feature_requests is an append-only log — every individual request is recorded;
 * dedup happens at the STORY level (reuse an existing story), not here.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getStore } from "../store.js";
import {
  createFeatureRequestShape,
  createFeatureRequestOutputShape,
  linkFeatureRequestShape,
  linkFeatureRequestOutputShape,
  getFeatureRequestShape,
  getFeatureRequestOutputShape,
  setFeatureRequestLinksShape,
  setFeatureRequestLinksOutputShape,
  type CreateFeatureRequestInput,
  type LinkFeatureRequestInput,
  type GetFeatureRequestInput,
  type SetFeatureRequestLinksInput,
} from "../schemas.js";
import { jsonResult, errorResult, formatError, type ToolResult } from "./shared.js";

const CREATE_DESC = `Record an incoming customer feature request AND link it to its stories in one step. Use after you've decided the primary (and any secondary) user stories during triage.

feature_requests is an append-only evidence log — record every request, even when it maps to an existing story (dedup is at the story level, not here).

Args:
  - title (required).
  - primary_story_key (required): the canonical story this request maps to (its primaryUserStory). Find it with find_related/query_stories, or create it with create_user_story first.
  - secondary_story_keys (optional): adjacent/overlapping/dependency stories (secondaryUserStories).
  - source, source_thread_id, source_thread_url, summary, requested_change, context, priority_signal, confidence, product_area, notion_page_id, raw_thread_jsonb, link_source (all optional).

The FR row + its primary/secondary links are written in ONE transaction — an unknown story_key fails the whole call (nothing is written). Returns { feature_request_id, links }.`;

const LINK_DESC = `Add one story link to an EXISTING feature request (e.g. attach another secondary later). For the initial primary + secondaries, prefer create_feature_request which does it atomically.

Args: feature_request_id, story_key, link_type ('primary'|'secondary'). A second 'primary' for the same FR is rejected by the database.`;

const GET_DESC = `Fetch a feature request by id with its linked stories split into primary_story and secondary_stories[]. This is how you read back primaryUserStory / secondaryUserStories. An unknown id returns feature_request=null with a note (not an error).`;

const SET_LINKS_DESC = `Atomically replace an existing feature request's complete story mapping. Provide exactly one primary_story_key and the desired secondary_story_keys; omitted old links are removed. Production-sensitive mappings become human-reviewed proposals by default. Use this instead of additive link_feature_request when correcting or reclassifying a mapping.`;

export function registerFeatureRequestTools(server: McpServer): void {
  server.registerTool(
    "create_feature_request",
    {
      title: "Record feature request + links",
      description: CREATE_DESC,
      inputSchema: createFeatureRequestShape,
      outputSchema: createFeatureRequestOutputShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input: CreateFeatureRequestInput): Promise<ToolResult> => {
      try {
        const { id, link_revision, links } = await getStore().createFeatureRequest({
          fr: {
            source: input.source,
            source_thread_id: input.source_thread_id,
            source_thread_url: input.source_thread_url,
            raw_thread_jsonb: input.raw_thread_jsonb,
            title: input.title,
            summary: input.summary,
            requested_change: input.requested_change,
            context: input.context,
            priority_signal: input.priority_signal,
            confidence: input.confidence,
            product_area: input.product_area,
            notion_page_id: input.notion_page_id,
          },
          primaryStoryKey: input.primary_story_key,
          secondaryStoryKeys: input.secondary_story_keys,
          linkSource: input.link_source,
        });
        return jsonResult({ feature_request_id: id, link_revision, links });
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );

  server.registerTool(
    "link_feature_request",
    {
      title: "Link feature request to story",
      description: LINK_DESC,
      inputSchema: linkFeatureRequestShape,
      outputSchema: linkFeatureRequestOutputShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input: LinkFeatureRequestInput): Promise<ToolResult> => {
      try {
        const link = await getStore().linkFeatureRequest({
          featureRequestId: input.feature_request_id,
          storyKey: input.story_key,
          linkType: input.link_type,
          linkSource: input.link_source,
        });
        return jsonResult(link);
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );

  server.registerTool(
    "set_feature_request_story_links",
    {
      title: "Replace feature request story links",
      description: SET_LINKS_DESC,
      inputSchema: setFeatureRequestLinksShape,
      outputSchema: setFeatureRequestLinksOutputShape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input: SetFeatureRequestLinksInput): Promise<ToolResult> => {
      try {
        const result = await getStore().setFeatureRequestStoryLinks({
          featureRequestId: input.feature_request_id,
          primaryStoryKey: input.primary_story_key,
          secondaryStoryKeys: input.secondary_story_keys,
          linkSource: input.link_source,
          expectedVersion: input.expected_version,
        });
        if (result.outcome === "proposed") {
          return jsonResult({
            ...result,
            note: `Mapping change is pending human approval as proposal ${result.proposal.id}.`,
          });
        }
        if (result.outcome === "stale") {
          return jsonResult({
            ...result,
            note: `Expected feature-request link version is stale; current version is ${result.current_version}.`,
          });
        }
        if (result.outcome === "not_found") {
          return jsonResult({ ...result, note: `No feature request ${input.feature_request_id} was found.` });
        }
        return jsonResult(result);
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );

  server.registerTool(
    "get_feature_request",
    {
      title: "Get feature request + linked stories",
      description: GET_DESC,
      inputSchema: getFeatureRequestShape,
      outputSchema: getFeatureRequestOutputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input: GetFeatureRequestInput): Promise<ToolResult> => {
      try {
        const fr = await getStore().getFeatureRequest(input.feature_request_id);
        if (!fr) {
          return jsonResult({
            feature_request: null,
            note: `No feature request with id ${input.feature_request_id}.`,
          });
        }
        return jsonResult({ feature_request: fr });
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );
}
