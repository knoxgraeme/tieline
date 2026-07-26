/*
 * Host adapter for the local review server (`tieline review`). Data is embedded
 * in #draft-data; I/O goes to the Express API. The server reads its own draft
 * file (kept current by save()), so commit/lock take no body.
 *
 * Compiled to browser JS by esbuild and inlined into the served page.
 */
import type { Draft, Host, ImportResult } from "./types.js";

(function () {
  const draft: Draft = JSON.parse(document.getElementById("draft-data")!.textContent!);
  const host: Host = {
    save: (d) =>
      fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(d),
      }).then((r) => { if (!r.ok) throw new Error(String(r.status)); }),
    commit: async () => {
      const r = await fetch("/api/import", { method: "POST" });
      const out = await r.json();
      if (!r.ok) throw new Error(out.error || String(r.status));
      return out as ImportResult;
    },
    lock: async () => {
      const r = await fetch("/api/lock", { method: "POST" });
      if (!r.ok) throw new Error(String(r.status));
    },
  };
  window.ReviewUI.render(draft, host);
})();
