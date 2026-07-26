/**
 * review_app — the MCP App: an interactive story-review UI that renders inside
 * MCP-Apps hosts (Claude, ChatGPT, VS Code, Goose). It exposes:
 *   - a ui:// resource: the review page (shared view + the MCP host adapter),
 *   - a review_stories tool annotated with that resource. The agent calls it with
 *     a draft; the host renders the UI, and "Add approved" calls import_stories
 *     back through the host — no copy/paste, portable across hosts.
 *
 * Opt-in via ENABLE_REVIEW_APP. The app HTML is built by scripts/build-app-ui.mjs.
 *
 * We register the tool + resource with the BASE MCP SDK and inline the two
 * MCP-Apps conventions (the `_meta.ui.resourceUri` annotation + the
 * `text/html;profile=mcp-app` mime type) rather than importing
 * @modelcontextprotocol/ext-apps here. Its `./server` helpers are thin wrappers
 * over these same base-SDK calls, and the package is ESM-only — requiring it
 * throws ERR_REQUIRE_ESM on Node 18 / early 20 (which our engines support).
 * ext-apps is therefore a build-time-only dependency (it bundles the UI-side App
 * into the ui:// resource; see scripts/build-app-ui.mjs).
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { draftSchema } from "../authoring/schema.js";

const RESOURCE_URI = "ui://review/board.html";
// MCP Apps conventions (inlined from @modelcontextprotocol/ext-apps).
const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const RESOURCE_URI_META_KEY = "ui/resourceUri"; // legacy key some hosts still read

const HERE = dirname(fileURLToPath(import.meta.url));
// Composed at build time by scripts/build-app-ui.mjs (tsc emits this file to dist).
const APP_HTML = resolve(HERE, "../authoring/review-ui/app.html");

const DESCRIPTION = `Open an interactive review of a set of generated/backfilled user stories. Renders editable cards (title, section, actor, status, story text, entity slugs, code paths) where you approve or reject each, then adds the approved set to the knowledge base (via import_stories) — no copy/paste.

Pass the draft produced during backfill (the { version, sections, stories: [...with _review] } shape). Use in an MCP-Apps host (Claude, ChatGPT, VS Code, Goose); elsewhere use the conversational review + import_stories.`;

export function registerReviewApp(server: McpServer): void {
  server.registerResource(
    "Story review",
    RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: readFileSync(APP_HTML, "utf8") },
      ],
    })
  );

  server.registerTool(
    "review_stories",
    {
      title: "Review stories",
      description: DESCRIPTION,
      inputSchema: { draft: draftSchema },
      // MCP Apps annotation: point the tool at its UI resource (both the
      // preferred nested key and the legacy flat key, as the ext-apps helper does).
      _meta: { ui: { resourceUri: RESOURCE_URI }, [RESOURCE_URI_META_KEY]: RESOURCE_URI },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ draft }) => ({
      content: [{ type: "text", text: JSON.stringify({ draft }) }],
      structuredContent: { draft },
    })
  );
}
