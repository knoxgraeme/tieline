/** Localhost-only human review board for story change proposals. */

import "../src/loadEnv.js";
import { randomBytes } from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { getStore } from "../src/store.js";
import { approveStoryChange, rejectStoryChange } from "../src/db.js";

const host = "127.0.0.1";
const port = Number(process.env.REVIEW_CHANGES_PORT || 3118);
const token = randomBytes(32).toString("hex");
const allowedOrigins = new Set([`http://${host}:${port}`, `http://localhost:${port}`]);
const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));
app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

function protectMutation(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.has(origin)) {
    res.status(403).json({ error: "Invalid Origin." });
    return;
  }
  if (req.header("x-review-token") !== token) {
    res.status(403).json({ error: "Invalid review token." });
    return;
  }
  next();
}

app.get("/", (_req, res) => {
  const nonce = randomBytes(18).toString("base64");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`
  );
  res.type("html").send(renderPage(nonce));
});

app.get("/api/proposals", async (_req, res) => {
  try {
    const proposals = await getStore().listStoryChangeProposals({ status: ["pending"], limit: 200 });
    res.json({ proposals });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/proposals/:id/approve", protectMutation, async (req, res) => {
  try {
    const result = await approveStoryChange({
      proposalId: Number(req.params.id),
      decidedBy: String(req.body?.decided_by || "local-review"),
      note: req.body?.note == null ? null : String(req.body.note),
    });
    res.status(result.outcome === "approved" ? 200 : 409).json(result);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/proposals/:id/reject", protectMutation, async (req, res) => {
  try {
    const outcome = await rejectStoryChange({
      proposalId: Number(req.params.id),
      decidedBy: String(req.body?.decided_by || "local-review"),
      note: req.body?.note == null ? null : String(req.body.note),
    });
    res.status(outcome === "rejected" ? 200 : 409).json({ outcome });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

const server = app.listen(port, host, () => {
  console.error(`Story change review: http://${host}:${port}/`);
  console.error("Loopback-only; approval mutations require the per-process review token.");
});

async function shutdown(): Promise<void> {
  server.close();
  await getStore().close();
}
process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

function renderPage(nonce: string): string {
  const safeToken = JSON.stringify(token).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Story change review</title>
<style nonce="${nonce}">
:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0;background:#11151b;color:#e8edf4}header{position:sticky;top:0;background:#171d26;border-bottom:1px solid #2c3644;padding:16px 22px;display:flex;gap:14px;align-items:center}h1{font-size:17px;margin:0}.muted{color:#9da9b8}main{max-width:980px;margin:auto;padding:20px}.card{background:#171d26;border:1px solid #2c3644;border-radius:12px;margin:0 0 14px;padding:17px}.head{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.pill{background:#273244;border-radius:99px;padding:3px 8px;font-size:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#0d1117;border-radius:8px;padding:12px;color:#c9d5e6}button{border:1px solid #425066;border-radius:8px;background:#222c3a;color:#e8edf4;padding:8px 12px;cursor:pointer}.approve{background:#176b45}.reject{background:#7b2d2d}.actions{display:flex;gap:8px}.empty{padding:50px;text-align:center;color:#9da9b8}.error{color:#ff8e86}
</style></head><body><header><h1>Pending story changes</h1><span class="muted" id="count"></span><button id="reload">Reload</button></header><main id="app"></main>
<script nonce="${nonce}">
const token=${safeToken};const app=document.getElementById('app');const count=document.getElementById('count');
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function load(){app.innerHTML='<div class="empty">Loading…</div>';const r=await fetch('/api/proposals');const j=await r.json();if(!r.ok){app.innerHTML='<p class="error">'+esc(j.error)+'</p>';return}count.textContent=j.proposals.length+' pending';app.innerHTML=j.proposals.length?'':'<div class="empty">No pending proposals.</div>';for(const p of j.proposals){const el=document.createElement('section');el.className='card';el.innerHTML='<div class="head"><strong>#'+p.id+' '+esc(p.story_key||'(new story)')+'</strong><span class="pill">'+esc(p.operation)+'</span><span class="pill">base '+esc(p.base_revision_number??'new')+'</span><span class="muted">'+esc(p.source)+' · '+esc(p.created_at)+'</span></div><p>'+esc(p.reason||'No reason supplied')+'</p><pre>'+esc(JSON.stringify(p.patch,null,2))+'</pre><div class="actions"><button class="approve">Approve</button><button class="reject">Reject</button></div>';el.querySelector('.approve').onclick=()=>decide(p.id,'approve');el.querySelector('.reject').onclick=()=>decide(p.id,'reject');app.appendChild(el)}}
async function decide(id,action){const by=prompt('Decision by:','local-review');if(!by)return;const note=prompt('Decision note (optional):','')||null;const r=await fetch('/api/proposals/'+id+'/'+action,{method:'POST',headers:{'content-type':'application/json','x-review-token':token},body:JSON.stringify({decided_by:by,note})});const j=await r.json();if(!r.ok)alert(j.error||j.outcome||'Decision failed');await load()}
document.getElementById('reload').onclick=load;load();
</script></body></html>`;
}
