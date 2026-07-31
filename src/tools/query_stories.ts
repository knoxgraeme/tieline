/**
 * query_stories — deterministic lookup over the accepted/planning contract.
 * Stories remain the familiar container; acceptance criteria are the primary
 * evidence and graph anchor returned inside every record.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  queryContractStoriesOutputShape,
  queryContractStoriesShape,
  type QueryContractStoriesInput,
} from "../schemas.js";
import { getReadStore } from "../store.js";
import {
  errorResult,
  formatError,
  jsonResult,
  type ToolResult,
} from "./shared.js";

const DESCRIPTION = `Exact, read-only lookup over Tieline's Story and acceptance-criteria contract.

Use this when you know an attribute or stable key. Filters are AND-combined:
repository, capability, story_key, actor, lifecycle, authority, code_path,
help_source, help_external_id, and has_direct_ac_links. Set
include_inactive_criteria=true when investigating retired/superseded AC history.

Every Story returns structured actor/goal/benefit plus a rendered Agile sentence,
ordered ACs, effective applicability, aliases, direct AC links, coarse Story
fallback links, implementation/test/help coverage, freshness, authority, and
lifecycle. Only direct AC links count toward coverage; a Story fallback is visible
but never presented as AC-level traceability.

group_by supports repository, capability, lifecycle, authority, or actor.`;

export function registerQueryStories(server: McpServer): void {
  server.registerTool(
    "query_stories",
    {
      title: "Query Stories and acceptance criteria",
      description: DESCRIPTION,
      inputSchema: queryContractStoriesShape,
      outputSchema: queryContractStoriesOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input: QueryContractStoriesInput): Promise<ToolResult> => {
      try {
        const filters = {
          repositories: input.repository,
          capabilities: input.capability,
          story_keys: input.story_key,
          actors: input.actor,
          lifecycles: input.lifecycle,
          authorities: input.authority,
          code_path: input.code_path,
          help_source: input.help_source,
          help_external_id: input.help_external_id,
          has_direct_ac_links: input.has_direct_ac_links,
          include_inactive_criteria: input.include_inactive_criteria,
        };
        const appliedFilters = Object.fromEntries(
          Object.entries({
            repository: filters.repositories,
            capability: filters.capabilities,
            story_key: filters.story_keys,
            actor: filters.actors,
            lifecycle: filters.lifecycles,
            authority: filters.authorities,
            code_path: filters.code_path,
            help_source: filters.help_source,
            help_external_id: filters.help_external_id,
            has_direct_ac_links: filters.has_direct_ac_links,
            include_inactive_criteria: filters.include_inactive_criteria,
          }).filter(([, value]) => value !== undefined)
        );
        const result = await getReadStore().queryContractStories({
          filters,
          groupBy: input.group_by ?? null,
          limit: input.limit,
        });

        if (result.mode === "grouped") {
          return jsonResult({
            mode: "grouped",
            group_by: input.group_by,
            applied_filters: appliedFilters,
            groups: result.groups,
            ...(result.groups.length === 0
              ? {
                  note: "No Stories matched these filters, so there is nothing to group.",
                }
              : {}),
          });
        }

        return jsonResult({
          mode: "records",
          group_by: null,
          applied_filters: appliedFilters,
          total: result.total,
          count: result.records.length,
          truncated: result.total > result.records.length,
          records: result.records,
          ...(result.total === 0
            ? {
                note: "No Stories matched these exact contract filters. This is a complete empty result.",
              }
            : {}),
        });
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );
}
