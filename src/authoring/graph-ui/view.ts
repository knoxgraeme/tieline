/**
 * GraphUI — the section-coupling map (view one). A small dependency-free
 * force-directed layout on a <canvas>: nodes are product sections (radius ∝
 * story_count, color = lifecycle status), edges are 1/df-weighted structural
 * entanglements (width/opacity ∝ weight). Drag nodes, pan/zoom the canvas, hover
 * for the "why" (shared entity slugs / code paths), and drag the min-weight slider
 * to dissolve weak links live. Assigns window.GraphUI; the host adapter calls
 * GraphUI.render(graph) once the explore_graph tool result arrives.
 *
 * Standalone browser module (no bundle) — esbuild transpiles TS->JS and inlines it
 * as a plain <script>. Kept framework-free so the ui:// resource stays tiny.
 */

import type { CrossoverGraph, GraphEdge, GraphNode } from "./types.js";

interface SimNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  fx: number | null; // pinned position while dragged (null = free)
  fy: number | null;
  degree: number;
}

interface SimEdge {
  source: SimNode;
  target: SimNode;
  weight: number;
  raw: GraphEdge;
}

// Fixed status palette — mid-saturation so it reads on both light and dark canvas
// backgrounds. Node strokes add contrast; text/edges come from theme CSS vars.
const STATUS_COLORS: Record<string, string> = {
  production: "#2f9e5f",
  qa: "#12a5b8",
  in_progress: "#e0902f",
  in_review: "#3f7fe0",
  idea: "#8a6be0",
  feature_request: "#d05a9e",
  cancelled: "#8a93a3",
};
const DEFAULT_COLOR = "#6b7484";
const statusColor = (s: string): string => STATUS_COLORS[s] ?? DEFAULT_COLOR;

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.body).getPropertyValue(name).trim();
  return v || fallback;
}

function render(graph: CrossoverGraph): void {
  const canvas = document.getElementById("graph") as HTMLCanvasElement | null;
  const tooltip = document.getElementById("tooltip") as HTMLDivElement | null;
  const empty = document.getElementById("empty") as HTMLDivElement | null;
  const stats = document.getElementById("stats") as HTMLElement | null;
  const legend = document.getElementById("legend") as HTMLElement | null;
  const slider = document.getElementById("minWeight") as HTMLInputElement | null;
  const sliderVal = document.getElementById("minWeightVal") as HTMLElement | null;
  const refit = document.getElementById("refit") as HTMLButtonElement | null;
  if (!canvas || !tooltip) return;

  if (!graph.nodes.length) {
    if (empty) {
      empty.textContent = "No sections to show. Ingest stories, then try again.";
      empty.style.display = "block";
    }
    return;
  }
  if (empty) empty.style.display = "none";

  const ctx = canvas.getContext("2d")!;
  const maxStories = Math.max(1, ...graph.nodes.map((n) => n.story_count));
  const maxWeight = Math.max(1e-6, ...graph.edges.map((e) => e.weight));

  // --- build sim graph (initial ring layout; the sim untangles it) -----------
  const R0 = 260;
  const nodes: SimNode[] = graph.nodes.map((n, i) => {
    const a = (i / graph.nodes.length) * Math.PI * 2;
    return {
      ...n,
      x: Math.cos(a) * R0,
      y: Math.sin(a) * R0,
      vx: 0,
      vy: 0,
      // sqrt scale so area (not radius) tracks story_count.
      r: 7 + 20 * Math.sqrt(n.story_count / maxStories),
      fx: null,
      fy: null,
      degree: 0,
    };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: SimEdge[] = [];
  for (const e of graph.edges) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t) continue;
    edges.push({ source: s, target: t, weight: e.weight, raw: e });
    s.degree++;
    t.degree++;
  }

  // --- view transform + interaction state ------------------------------------
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let minWeight = 0;
  let alpha = 1; // simulation "temperature"
  let hover: { kind: "node"; node: SimNode } | { kind: "edge"; edge: SimEdge } | null = null;
  let dragNode: SimNode | null = null;
  let panning = false;
  let lastPointer = { x: 0, y: 0 };

  const visibleEdges = (): SimEdge[] => edges.filter((e) => e.weight >= minWeight);

  function updateStats(): void {
    if (stats) {
      const vis = visibleEdges().length;
      stats.textContent = `${nodes.length} sections · ${vis}/${edges.length} links`;
    }
  }

  // --- device-pixel-ratio-aware sizing ---------------------------------------
  function resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas!.clientWidth;
    const h = canvas!.clientHeight;
    canvas!.width = Math.round(w * dpr);
    canvas!.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function fit(): void {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x - n.r);
      minY = Math.min(minY, n.y - n.r);
      maxX = Math.max(maxX, n.x + n.r);
      maxY = Math.max(maxY, n.y + n.r);
    }
    const w = canvas!.clientWidth;
    const h = canvas!.clientHeight;
    const gw = Math.max(1, maxX - minX);
    const gh = Math.max(1, maxY - minY);
    scale = Math.min(w / gw, h / gh) * 0.85;
    scale = Math.max(0.05, Math.min(scale, 3));
    tx = w / 2 - ((minX + maxX) / 2) * scale;
    ty = h / 2 - ((minY + maxY) / 2) * scale;
  }

  const toWorld = (px: number, py: number) => ({ x: (px - tx) / scale, y: (py - ty) / scale });

  // --- one physics step -------------------------------------------------------
  function tick(): void {
    const center = { x: 0, y: 0 };
    // Weak gravity toward the centroid keeps disconnected components on screen.
    for (const n of nodes) {
      n.vx += (center.x - n.x) * 0.0015 * alpha;
      n.vy += (center.y - n.y) * 0.0015 * alpha;
    }
    // Repulsion (O(n²) — fine for the dozens–low-hundreds of sections here).
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1e-4) {
          dx = (i - j) * 0.5 + 0.01;
          dy = 0.01;
          d2 = dx * dx + dy * dy;
        }
        const minDist = a.r + b.r + 12;
        // Stronger, capped repulsion when overlapping so nodes don't stack.
        const f = (2600 * alpha) / d2;
        const d = Math.sqrt(d2);
        const push = d < minDist ? f + (minDist - d) * 0.5 : f;
        const ux = dx / d;
        const uy = dy / d;
        a.vx += ux * push;
        a.vy += uy * push;
        b.vx -= ux * push;
        b.vy -= uy * push;
      }
    }
    // Springs on visible edges only, so the slider reshapes the layout live.
    // Rest length shrinks with weight (tighter coupling pulls closer).
    for (const e of visibleEdges()) {
      const dx = e.target.x - e.source.x;
      const dy = e.target.y - e.source.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const w = e.weight / maxWeight;
      const rest = 150 - 90 * w;
      const stiff = (0.02 + 0.06 * w) * alpha;
      const f = (d - rest) * stiff;
      const ux = dx / d;
      const uy = dy / d;
      e.source.vx += ux * f;
      e.source.vy += uy * f;
      e.target.vx -= ux * f;
      e.target.vy -= uy * f;
    }
    // Integrate + damp.
    for (const n of nodes) {
      if (n.fx != null) {
        n.x = n.fx;
        n.y = n.fy!;
        n.vx = 0;
        n.vy = 0;
        continue;
      }
      n.vx *= 0.86;
      n.vy *= 0.86;
      n.x += n.vx;
      n.y += n.vy;
    }
    // Cool down; a floor keeps a little life so drags stay responsive.
    if (alpha > 0.04) alpha *= 0.985;
  }

  // --- draw -------------------------------------------------------------------
  function draw(): void {
    const w = canvas!.clientWidth;
    const h = canvas!.clientHeight;
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(tx, ty);
    ctx.scale(scale, scale);

    const inkEdge = cssVar("--muted", "#5b6472");
    const labelColor = cssVar("--ink", "#171b21");

    // edges
    for (const e of visibleEdges()) {
      const w01 = e.weight / maxWeight;
      const isHot =
        hover?.kind === "edge" && hover.edge === e
          ? true
          : hover?.kind === "node" && (hover.node === e.source || hover.node === e.target);
      ctx.beginPath();
      ctx.moveTo(e.source.x, e.source.y);
      ctx.lineTo(e.target.x, e.target.y);
      ctx.strokeStyle = isHot ? cssVar("--accent", "#2f6feb") : inkEdge;
      ctx.globalAlpha = isHot ? 0.9 : 0.12 + 0.5 * w01;
      ctx.lineWidth = (isHot ? 1.5 : 0.6) + 3.5 * w01;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // nodes
    for (const n of nodes) {
      const isHot =
        hover?.kind === "node" && hover.node === n
          ? true
          : hover?.kind === "edge" && (hover.edge.source === n || hover.edge.target === n);
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = statusColor(n.status);
      ctx.globalAlpha = hover && !isHot ? 0.55 : 1;
      ctx.fill();
      ctx.lineWidth = isHot ? 2.5 : 1;
      ctx.strokeStyle = isHot ? cssVar("--accent", "#2f6feb") : cssVar("--card", "#fff");
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // labels — only when they won't be a hairball (zoomed in, big nodes, or hover)
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = labelColor;
    for (const n of nodes) {
      const isHot = hover?.kind === "node" && hover.node === n;
      const show = isHot || (scale >= 0.8 && n.r * scale >= 14) || scale >= 1.4;
      if (!show) continue;
      ctx.globalAlpha = isHot ? 1 : 0.75;
      ctx.font = `${isHot ? 600 : 400} ${Math.max(9, 11 / Math.sqrt(scale))}px system-ui,sans-serif`;
      ctx.fillText(n.label, n.x, n.y + n.r + 2);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function frame(): void {
    tick();
    draw();
    requestAnimationFrame(frame);
  }

  // --- hit testing ------------------------------------------------------------
  function nodeAt(wx: number, wy: number): SimNode | null {
    // topmost (last drawn) first
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const dx = wx - n.x;
      const dy = wy - n.y;
      if (dx * dx + dy * dy <= n.r * n.r) return n;
    }
    return null;
  }

  function edgeAt(wx: number, wy: number): SimEdge | null {
    const tol = 6 / scale;
    let best: SimEdge | null = null;
    let bestD = tol;
    for (const e of visibleEdges()) {
      const d = distToSegment(wx, wy, e.source.x, e.source.y, e.target.x, e.target.y);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  // --- tooltip ----------------------------------------------------------------
  function esc(s: string): string {
    return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
  }
  function showTip(clientX: number, clientY: number): void {
    if (!hover) {
      tooltip!.style.display = "none";
      return;
    }
    let html = "";
    if (hover.kind === "node") {
      const n = hover.node;
      html =
        `<div class="tt-title">${esc(n.label)}</div>` +
        `<div class="tt-sub">${esc(n.id)}</div>` +
        `<div class="tt-row"><span class="dot" style="background:${statusColor(n.status)}"></span>` +
        `${esc(n.status)} · ${n.story_count} ${n.story_count === 1 ? "story" : "stories"} · ${n.degree} link${n.degree === 1 ? "" : "s"}</div>`;
    } else {
      const e = hover.edge.raw;
      const parts: string[] = [];
      if (e.shared_code_paths.length)
        parts.push(`<div class="tt-line"><b>paths</b> ${e.shared_code_paths.map(esc).join(", ")}</div>`);
      if (e.shared_entities.length)
        parts.push(`<div class="tt-line"><b>entities</b> ${e.shared_entities.map(esc).join(", ")}</div>`);
      html =
        `<div class="tt-title">${esc(e.source)} ↔ ${esc(e.target)}</div>` +
        `<div class="tt-sub">weight ${e.weight.toFixed(2)} · ${e.shared_count} shared signal${e.shared_count === 1 ? "" : "s"}</div>` +
        parts.join("");
    }
    tooltip!.innerHTML = html;
    tooltip!.style.display = "block";
    // keep the tip inside the viewport
    const pad = 14;
    const tw = tooltip!.offsetWidth;
    const th = tooltip!.offsetHeight;
    let left = clientX + pad;
    let top = clientY + pad;
    if (left + tw > window.innerWidth) left = clientX - tw - pad;
    if (top + th > window.innerHeight) top = clientY - th - pad;
    tooltip!.style.left = `${Math.max(4, left)}px`;
    tooltip!.style.top = `${Math.max(4, top)}px`;
  }

  // --- events -----------------------------------------------------------------
  function pointerPos(ev: MouseEvent): { x: number; y: number } {
    const rect = canvas!.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  canvas.addEventListener("mousedown", (ev) => {
    const p = pointerPos(ev);
    const wpt = toWorld(p.x, p.y);
    const n = nodeAt(wpt.x, wpt.y);
    if (n) {
      dragNode = n;
      n.fx = n.x;
      n.fy = n.y;
      alpha = Math.max(alpha, 0.5);
    } else {
      panning = true;
    }
    lastPointer = { x: ev.clientX, y: ev.clientY };
  });

  window.addEventListener("mousemove", (ev) => {
    const p = pointerPos(ev);
    if (dragNode) {
      const wpt = toWorld(p.x, p.y);
      dragNode.fx = wpt.x;
      dragNode.fy = wpt.y;
      alpha = Math.max(alpha, 0.3);
      hover = { kind: "node", node: dragNode };
      showTip(ev.clientX, ev.clientY);
      return;
    }
    if (panning) {
      tx += ev.clientX - lastPointer.x;
      ty += ev.clientY - lastPointer.y;
      lastPointer = { x: ev.clientX, y: ev.clientY };
      tooltip!.style.display = "none";
      return;
    }
    // hover detection
    const rect = canvas!.getBoundingClientRect();
    const inside =
      ev.clientX >= rect.left && ev.clientX <= rect.right && ev.clientY >= rect.top && ev.clientY <= rect.bottom;
    if (!inside) {
      hover = null;
      tooltip!.style.display = "none";
      return;
    }
    const wpt = toWorld(p.x, p.y);
    const n = nodeAt(wpt.x, wpt.y);
    hover = n ? { kind: "node", node: n } : (() => {
      const e = edgeAt(wpt.x, wpt.y);
      return e ? ({ kind: "edge", edge: e } as const) : null;
    })();
    canvas!.style.cursor = hover ? "pointer" : "grab";
    showTip(ev.clientX, ev.clientY);
  });

  window.addEventListener("mouseup", () => {
    if (dragNode) {
      dragNode.fx = null; // release so it settles into the layout
      dragNode.fy = null;
      dragNode = null;
    }
    panning = false;
  });

  canvas.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const p = pointerPos(ev);
    const before = toWorld(p.x, p.y);
    const factor = Math.exp(-ev.deltaY * 0.0015);
    scale = Math.max(0.05, Math.min(scale * factor, 6));
    // zoom around the cursor
    tx = p.x - before.x * scale;
    ty = p.y - before.y * scale;
  }, { passive: false });

  if (slider) {
    slider.min = "0";
    slider.max = maxWeight.toFixed(3);
    slider.step = (maxWeight / 100).toFixed(4);
    slider.value = "0";
    slider.addEventListener("input", () => {
      minWeight = Number(slider.value);
      if (sliderVal) sliderVal.textContent = minWeight.toFixed(2);
      alpha = Math.max(alpha, 0.4); // re-settle after edges drop
      updateStats();
    });
  }
  refit?.addEventListener("click", () => {
    alpha = 0.9;
    setTimeout(fit, 350); // let it re-spread first
  });

  // legend
  if (legend) {
    const present = [...new Set(nodes.map((n) => n.status))];
    legend.innerHTML = present
      .map(
        (s) =>
          `<span class="lg"><span class="dot" style="background:${statusColor(s)}"></span>${esc(s)}</span>`
      )
      .join("");
  }

  window.addEventListener("resize", resize);
  resize();
  fit();
  updateStats();
  requestAnimationFrame(frame);
}

window.GraphUI = { render };
