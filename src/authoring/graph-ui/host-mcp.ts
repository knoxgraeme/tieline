/*
 * Host adapter for the section-coupling MCP app (runs inside the host's sandboxed
 * iframe). Uses @modelcontextprotocol/ext-apps: the explore_graph tool's result
 * (the { nodes, edges } graph) arrives via app.ontoolresult, and we hand it to
 * window.GraphUI.render. Read-only — unlike the review app there is no callback to
 * a write tool. Bundled to an IIFE by scripts/build-app-ui.mjs and inlined into
 * the ui:// resource.
 */
import { App } from "@modelcontextprotocol/ext-apps";
import type { CrossoverGraph } from "./types.js";

const app = new App({ name: "section-graph", version: "0.1.0" });

// The explore_graph tool returns { nodes, edges }; hosts may deliver it as
// structuredContent or as a JSON text content item — accept either.
function extractGraph(params: unknown): CrossoverGraph | null {
  const p = params as Record<string, any> | undefined;
  const sc = p?.structuredContent ?? p?.result?.structuredContent;
  if (sc && Array.isArray(sc.nodes) && Array.isArray(sc.edges)) return sc as CrossoverGraph;
  const content = p?.content ?? p?.result?.content ?? [];
  const text = Array.isArray(content) ? content.find((c: any) => c.type === "text")?.text : null;
  if (text) {
    try {
      const j = JSON.parse(text);
      if (Array.isArray(j?.nodes) && Array.isArray(j?.edges)) return j as CrossoverGraph;
    } catch {
      /* ignore */
    }
  }
  return null;
}

let mounted = false;
app.ontoolresult = (params: unknown) => {
  const graph = extractGraph(params);
  if (!graph || mounted) return;
  mounted = true;
  window.GraphUI.render(graph);
  // A coupling map wants the whole screen. Hosts that don't support fullscreen
  // reply with their actual mode (inline/pip), which is harmless — ignore failure.
  app.requestDisplayMode({ mode: "fullscreen" }).catch(() => {});
};

app.connect().catch((e: unknown) => {
  const el = document.getElementById("empty");
  if (el) {
    el.textContent = "Failed to connect to host: " + ((e as Error)?.message || e);
    el.style.display = "block";
  }
});
