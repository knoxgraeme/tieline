/*
 * Compose the MCP app UI resources. For each opt-in app, bundle its MCP host
 * adapter (host-mcp.js, which imports @modelcontextprotocol/ext-apps) into a
 * browser IIFE with esbuild, then inline it + the standalone view.js into the
 * shell -> dist/authoring/<app>/app.html. The tool files serve those as ui://
 * resources:
 *   - review-ui  -> review_app.ts   (review_stories, WRITE)
 *   - graph-ui   -> explore_graph.ts (explore_graph, READ-ONLY coupling map)
 *
 * Runs automatically as `postbuild` after `npm run build` (and standalone via
 * `npm run build:app`). esbuild + @modelcontextprotocol/ext-apps are devDeps used
 * ONLY here to bundle the opt-in UIs. If they aren't installed (a prod-only
 * install), this SKIPS gracefully instead of failing the build — the core server
 * is unaffected; ENABLE_REVIEW_APP / ENABLE_GRAPH_APP just have no UI to serve.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "../dist/cli.js");
if (existsSync(CLI)) chmodSync(CLI, 0o755);

// Each app: the source UI dir, the dist output dir, and the shell placeholder that
// receives the initial JSON (data actually arrives at runtime via ontoolresult, so
// this is just a valid-JSON default).
const APPS = [
  { name: "review-ui", initialData: "{}", dataPlaceholder: "/*__DRAFT__*/" },
  { name: "graph-ui", initialData: '{"nodes":[],"edges":[]}', dataPlaceholder: "/*__GRAPH__*/" },
];

let esbuild;
try {
  esbuild = await import("esbuild");
} catch {
  console.error(
    "[build:app] esbuild not installed — skipping the MCP app UI bundles " +
      "(ENABLE_REVIEW_APP / ENABLE_GRAPH_APP will have no UI to serve here). " +
      "Not an error; core build unaffected."
  );
  process.exit(0);
}

// esbuild IS installed (the import guard above handles the skip case). A failure
// past this point is a REAL bundling error (syntax error in view.ts/host-mcp.ts,
// an ext-apps API break) — let it throw so `npm run build`/Docker fail loudly
// instead of silently emitting no app.html and ENOENTing in production.
for (const app of APPS) {
  const UI = resolve(HERE, `../src/authoring/${app.name}`);
  const OUT = resolve(HERE, `../dist/authoring/${app.name}`);

  const bundled = await esbuild.build({
    entryPoints: [resolve(UI, "host-mcp.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    write: false,
  });
  const hostJs = bundled.outputFiles[0].text;

  // view.ts is a standalone browser module (assigns window.<App>UI), inlined as a
  // plain <script> — transpile TS -> JS (no bundle needed; it has only a type import).
  const viewTs = readFileSync(resolve(UI, "view.ts"), "utf8");
  const view = (await esbuild.transform(viewTs, { loader: "ts", target: "es2020" })).code;

  const shell = readFileSync(resolve(UI, "shell.html"), "utf8");
  const html = shell
    .replace(app.dataPlaceholder, () => app.initialData)
    .replace("/*__VIEW__*/", () => view)
    .replace("/*__HOST__*/", () => hostJs);

  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, "app.html"), html);
  console.error(
    `Built MCP app UI -> dist/authoring/${app.name}/app.html (${(html.length / 1024).toFixed(0)} KB)`
  );

  if (app.name === "review-ui") {
    const localHost = await esbuild.build({
      entryPoints: [resolve(UI, "host-server.ts")],
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "es2020",
      write: false,
    });
    const localHtml = shell
      .replace("/*__VIEW__*/", () => view)
      .replace("/*__HOST__*/", () => localHost.outputFiles[0].text);
    writeFileSync(resolve(OUT, "server.html"), localHtml);
    console.error(
      `Built local review UI -> dist/authoring/review-ui/server.html (${(localHtml.length / 1024).toFixed(0)} KB)`
    );
  }
}
