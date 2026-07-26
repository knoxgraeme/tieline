/*
 * Shared, pure review view. Renders a draft into editable/approvable cards and
 * routes all I/O through a host adapter, so the SAME view runs behind the local
 * server (`tieline review`) and inside an MCP app. No I/O of its own.
 *
 * Compiled to browser JS by esbuild and inlined into the review page; typed
 * against the DOM lib via tsconfig.ui.json. Call: ReviewUI.render(draft, host).
 */
import type { Draft, DraftStory, Host, ImportPayload, ReviewState } from "./types.js";
import { STORY_STATUSES } from "../../types.js";

window.ReviewUI = (function () {
  const STATUSES: StoryStatusLike[] = [...STORY_STATUSES];
  type StoryStatusLike = DraftStory["status"];
  const byId = (id: string) => document.getElementById(id);

  type Kid = string | Node;
  const el = (t: string, props: Record<string, unknown> = {}, kids: Kid | Kid[] = []): HTMLElement => {
    const n = document.createElement(t);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") n.className = v as string;
      else if (k === "value") (n as HTMLInputElement).value = v as string;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v as EventListener);
      else n.setAttribute(k, v as string);
    }
    for (const kid of ([] as Kid[]).concat(kids)) n.append(kid);
    return n;
  };
  const toList = (v: string): string[] => v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);

  function render(draft: Draft, host: Host): void {
    const savestate = byId("savestate")!;
    const banner = (msg: string, good: boolean) => {
      const b = byId("banner")!;
      b.textContent = msg;
      b.className = "banner show " + (good ? "good" : "bad");
    };

    // --- autosave (optional) --------------------------------------------------
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    let saveOK = typeof host.save === "function";
    function scheduleSave(): void {
      if (!saveOK) return;
      savestate.textContent = "editing…";
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(doSave, 800);
    }
    async function doSave(): Promise<void> {
      if (!saveOK) return;
      savestate.textContent = "saving…";
      try { await host.save!(draft); savestate.textContent = "saved"; }
      catch { saveOK = false; savestate.textContent = "offline"; }
    }

    // --- counts ---------------------------------------------------------------
    function refreshCounts(): void {
      const total = draft.stories.length;
      const approved = draft.stories.filter((s) => s._review.state === "approved").length;
      const rejected = draft.stories.filter((s) => s._review.state === "rejected").length;
      byId("counts")!.innerHTML =
        `<b>${approved}</b> approved · <b>${rejected}</b> rejected · ${total} total`;
      const imp = byId("importBtn") as HTMLButtonElement | null; if (imp) imp.disabled = approved === 0;
      const lk = byId("lockBtn") as HTMLButtonElement | null; if (lk) lk.disabled = approved === 0;
    }

    function bind(
      obj: Record<string, unknown>,
      key: string,
      node: HTMLElement,
      xform?: (v: string) => unknown
    ): HTMLElement {
      node.addEventListener("input", () => {
        const value = (node as HTMLInputElement).value;
        obj[key] = xform ? xform(value) : value;
        scheduleSave();
      });
      return node;
    }

    function card(story: DraftStory): HTMLElement {
      const rv = story._review;
      const c = el("div", { class: "card " + rv.state, "data-id": rv.id });
      const setState = (v: ReviewState) => {
        rv.state = v; c.className = "card " + v;
        for (const b of Array.from(c.querySelectorAll<HTMLButtonElement>(".state-btns button")))
          b.className = b.dataset.v === v ? "on-" + v : "";
        refreshCounts(); scheduleSave();
      };
      const stateBtns = el("div", { class: "state-btns" },
        (["approved", "pending", "rejected"] as ReviewState[]).map((v) =>
          el("button", { class: rv.state === v ? "on-" + v : "", "data-v": v, type: "button", onclick: () => setState(v) }, v)));

      const statusSel = el("select", { "aria-label": "status" }, STATUSES.map((s) => {
        const o = el("option", { value: s }, s); if (s === story.status) o.setAttribute("selected", "selected"); return o;
      }));
      bind(story as unknown as Record<string, unknown>, "status", statusSel);

      c.append(
        el("div", { class: "row" }, [
          el("div", { class: "grow" }, [el("label", {}, "Title"), bind(story as unknown as Record<string, unknown>, "title", el("input", { value: story.title || "" }))]),
          el("div", {}, [el("label", {}, "Decision"), stateBtns]),
        ]),
        el("div", { class: "row" }, [
          el("div", {}, [el("label", {}, "Section key"), bind(story as unknown as Record<string, unknown>, "section_key", el("input", { value: story.section_key || "" }))]),
          el("div", {}, [el("label", {}, "Actor"), bind(story as unknown as Record<string, unknown>, "actor", el("input", { value: story.actor || "" }))]),
          el("div", {}, [el("label", {}, "Status"), statusSel]),
        ]),
        el("div", { class: "row" }, [el("div", { class: "grow" }, [el("label", {}, "Story text"),
          bind(story as unknown as Record<string, unknown>, "story_text", el("textarea", { rows: "3" }, story.story_text || ""))])]),
        el("div", { class: "row" }, [el("div", { class: "grow" }, [el("label", {}, "Entity slugs (comma-separated)"),
          bind(story as unknown as Record<string, unknown>, "entity_slugs", el("input", { value: (story.entity_slugs || []).join(", ") }), toList)])]),
        el("div", { class: "row mono" }, [el("div", { class: "grow" }, [el("label", {}, "Code paths (one per line)"),
          bind(story as unknown as Record<string, unknown>, "code_paths", el("textarea", { rows: "2" }, (story.code_paths || []).join("\n")), toList)])]),
        el("div", { class: "row" }, [el("div", { class: "grow" }, [el("label", {}, "Review comment"),
          bind(rv as unknown as Record<string, unknown>, "comment", el("textarea", { rows: "1" }, rv.comment || ""))])]),
        el("div", { class: "meta" },
          "id " + rv.id + (rv.confidence != null ? " · confidence " + rv.confidence : "") + (rv.provenance ? " · " + rv.provenance : "")),
      );
      return c;
    }

    function importPayload(): ImportPayload {
      const stories = draft.stories
        .filter((s) => s._review.state === "approved")
        .map(({ _review, ...r }) => r);
      const keys = new Set(stories.map((s) => s.section_key));
      const sections = (draft.sections || []).filter((s) => keys.has(s.section_key));
      return { sections, stories };
    }

    // --- buttons --------------------------------------------------------------
    const lockBtn = byId("lockBtn") as HTMLButtonElement | null;
    if (host.lock && lockBtn) {
      lockBtn.addEventListener("click", async () => {
        await doSave();
        try { await host.lock!(importPayload()); banner("Exported the approved set.", true); }
        catch (e) { banner("Export failed: " + (e as Error).message, false); }
      });
    } else if (lockBtn) {
      lockBtn.remove();
    }

    const importBtn = byId("importBtn") as HTMLButtonElement | null;
    importBtn?.addEventListener("click", async () => {
      await doSave();
      importBtn.disabled = true; importBtn.textContent = "Adding…";
      try {
        const out = await host.commit(importPayload());
        banner(`Added ${out.stories} stor${out.stories === 1 ? "y" : "ies"} to the brain (${out.sections} section${out.sections === 1 ? "" : "s"}). Searchable now.`, true);
        importBtn.textContent = "Added ✓";
      } catch (e) {
        banner("Couldn't add to the brain: " + ((e as Error).message || e), false);
        importBtn.textContent = "Add approved → brain"; importBtn.disabled = false;
      }
    });

    // --- boot -----------------------------------------------------------------
    const list = byId("list")!;
    list.textContent = "";
    for (const s of draft.stories) list.append(card(s));
    refreshCounts();
    savestate.textContent = saveOK ? "ready" : "";
  }

  return { render };
})();
