/**
 * explore_graph — the section-crossover MCP App (VIEW ONE of the graph explorer).
 * A read-only companion to find_crossover: instead of the top-N sections entangled
 * with ONE key, it returns the whole-corpus coupling map — every section as a node
 * (sized by story_count, colored by status), every structural entanglement as a
 * weighted edge — and renders it as an interactive force-directed graph inside
 * MCP-Apps hosts (Claude, ChatGPT, VS Code, Goose).
 *
 * Registration mirrors review_app.ts exactly (a ui:// resource + a tool annotated
 * with `_meta.ui.resourceUri`); the difference is this tool is READ-ONLY, so it is
 * safe to enable on the hosted retrieval-only deploy. Opt-in via ENABLE_GRAPH_APP.
 * The app HTML is built by scripts/build-app-ui.mjs.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getStore } from "../store.js";
import { jsonResult, errorResult, formatError, type ToolResult } from "./shared.js";

const RESOURCE_URI = "ui://graph/board.html";
// MCP Apps conventions (inlined from @modelcontextprotocol/ext-apps; see review_app.ts).
const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const RESOURCE_URI_META_KEY = "ui/resourceUri"; // legacy key some hosts still read

const HERE = dirname(fileURLToPath(import.meta.url));
// Composed at build time by scripts/build-app-ui.mjs (tsc emits this file to dist).
const APP_HTML = resolve(HERE, "../authoring/graph-ui/app.html");

const inputShape = {
  status: z
    .array(z.string())
    .optional()
    .describe(
      "Optional lifecycle filter (e.g. ['production'] or ['in_progress','in_review']). Restricts the stories that contribute to both node counts and edges, so the map reflects only that slice of work."
    ),
  min_weight: z
    .number()
    .min(0)
    .optional()
    .describe("Drop edges whose summed 1/df weight is below this (default 0 — keep all)."),
  max_edges: z
    .number()
    .int()
    .min(1)
    .max(2000)
    .optional()
    .describe("Cap the number of edges returned, strongest first (default 300)."),
};

const DESCRIPTION = `Open an interactive coupling map of the whole story corpus: every product section is a node (sized by story count, colored by lifecycle status) and every structural entanglement is a weighted edge — two sections are linked when their stories touch the same code paths / entity slugs, weighted by 1/df so distinctive overlaps outrank hub tags (same scoring as find_crossover, materialized for all pairs at once).

Read-only. Use in an MCP-Apps host (Claude, ChatGPT, VS Code, Goose) to SEE the architecture-level coupling at a glance and find where work clusters; for the top-N entanglements of a single known key as data, use find_crossover instead.

Args (all optional): status (lifecycle filter), min_weight (drop weak edges), max_edges (cap, strongest first).`;

export function registerExploreGraph(server: McpServer): void {
  server.registerResource(
    "Section coupling map",
    RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: readFileSync(APP_HTML, "utf8") },
      ],
    })
  );

  server.registerTool(
    "explore_graph",
    {
      title: "Explore section coupling",
      description: DESCRIPTION,
      inputSchema: inputShape,
      // MCP Apps annotation: point the tool at its UI resource (both the preferred
      // nested key and the legacy flat key, as the ext-apps helper does).
      _meta: { ui: { resourceUri: RESOURCE_URI }, [RESOURCE_URI_META_KEY]: RESOURCE_URI },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input): Promise<ToolResult> => {
      try {
        const graph = await getStore().sectionCrossoverGraph({
          status: input.status,
          minWeight: input.min_weight,
          maxEdges: input.max_edges,
        });
        // The full graph always rides in structuredContent (what the UI reads);
        // jsonResult only trims the text mirror if it blows the character budget.
        return jsonResult({ nodes: graph.nodes, edges: graph.edges });
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );
}
