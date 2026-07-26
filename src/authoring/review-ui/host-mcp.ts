/*
 * Host adapter for the MCP app (runs inside the host's sandboxed iframe). Uses
 * @modelcontextprotocol/ext-apps: the review_stories tool's result arrives via
 * app.ontoolresult (the draft), and "Add approved -> brain" calls the
 * import_stories server tool through the host. Bundled to an IIFE by
 * scripts/build-app-ui.mjs and inlined into the ui:// resource.
 */
import { App } from "@modelcontextprotocol/ext-apps";
import type { Draft, Host, ImportResult } from "./types.js";

const app = new App({ name: "story-review", version: "0.1.0" });

// The review_stories tool returns the draft; hosts may deliver it as
// structuredContent or as a JSON text content item — accept either.
function extractDraft(params: unknown): Draft | null {
  const p = params as Record<string, any> | undefined;
  const sc = p?.structuredContent ?? p?.result?.structuredContent;
  if (sc?.draft) return sc.draft as Draft;
  if (sc?.stories) return sc as Draft;
  const content = p?.content ?? p?.result?.content ?? [];
  const text = Array.isArray(content) ? content.find((c: any) => c.type === "text")?.text : null;
  if (text) {
    try { const j = JSON.parse(text); return (j.draft ?? (j.stories ? j : null)) as Draft | null; } catch { /* ignore */ }
  }
  return null;
}

function extractImported(result: unknown): ImportResult {
  const r = result as Record<string, any> | undefined;
  const sc = r?.structuredContent;
  if (sc?.imported) return sc.imported as ImportResult;
  const text = r?.content?.find?.((c: any) => c.type === "text")?.text;
  if (text) { try { return JSON.parse(text).imported as ImportResult; } catch { /* ignore */ } }
  return { sections: 0, stories: 0 };
}

let mounted = false;
app.ontoolresult = (params: unknown) => {
  const draft = extractDraft(params);
  if (!draft || mounted) return;
  mounted = true;
  const host: Host = {
    commit: async (payload) => {
      const res: any = await app.callServerTool({ name: "import_stories", arguments: payload as unknown as Record<string, unknown> });
      if (res?.isError) throw new Error(res.content?.[0]?.text || "import failed");
      return extractImported(res);
    },
  };
  window.ReviewUI.render(draft, host);
  // The review board is a full working surface, not a glance widget — request
  // fullscreen. Hosts that don't support it reply with their actual mode
  // (inline/pip), which is harmless, so ignore any failure.
  app.requestDisplayMode({ mode: "fullscreen" }).catch(() => {});
};

app.connect().catch((e: unknown) => {
  document.getElementById("list")!.textContent = "Failed to connect to host: " + ((e as Error)?.message || e);
});
