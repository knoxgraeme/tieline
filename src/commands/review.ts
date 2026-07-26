import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import postgres from "postgres";
import { importStories } from "../authoring/import.js";
import { parseDraft, toImportPayload } from "../authoring/schema.js";
import { config } from "../config.js";
import { getEmbedder } from "../embeddings.js";
import {
  findTielineWorkspace,
  resolveWorkspaceRepo,
  validateWorkspaceEmbeddingProvider,
  validateWorkspaceImport,
} from "../tieline/workspace.js";

const REVIEW_TEMPLATE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../authoring/review-ui/server.html"
);

export async function runReviewCommand(args: string[]): Promise<number> {
  if (args.length > 1) throw new Error("Usage: tieline review [stories.draft.json]");
  const draftPath = resolve(process.cwd(), args[0] || "stories.draft.json");
  if (!existsSync(draftPath)) {
    throw new Error(`Draft not found: ${draftPath}. Pass a draft created by the Tieline backfill flow.`);
  }
  if (!existsSync(REVIEW_TEMPLATE)) {
    throw new Error("The compiled review UI is missing. Reinstall or rebuild Tieline.");
  }

  const workspace = findTielineWorkspace(draftPath);
  const importRepo = resolveWorkspaceRepo(workspace, config.repo);
  const lockedPath = join(
    dirname(draftPath),
    basename(draftPath).includes("draft")
      ? basename(draftPath).replace("draft", "locked")
      : "stories.locked.json"
  );
  const port = Number(process.env.REVIEW_PORT || 3117);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("REVIEW_PORT must be an integer from 1 to 65535.");
  }

  const readDraft = () => {
    const draft = parseDraft(JSON.parse(readFileSync(draftPath, "utf8")));
    if (workspace && !draft.repo) draft.repo = workspace.config.product.repo_name;
    return draft;
  };
  const renderPage = () => {
    const draftJson = JSON.stringify(readDraft())
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e")
      .replace(/&/g, "\\u0026");
    return readFileSync(REVIEW_TEMPLATE, "utf8").replace("/*__DRAFT__*/", () => draftJson);
  };

  const app = express();
  app.use(express.json({ limit: "16mb" }));
  app.get("/", (_request, response) => response.type("html").send(renderPage()));
  app.get("/api/review", (_request, response) => response.json(readDraft()));
  app.post("/api/review", (request, response) => {
    try {
      const draft = parseDraft(request.body);
      writeFileSync(draftPath, `${JSON.stringify(draft, null, 2)}\n`);
      response.json({ ok: true });
    } catch (error) {
      response.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  app.post("/api/lock", (_request, response) => {
    const payload = toImportPayload(readDraft());
    writeFileSync(lockedPath, `${JSON.stringify(payload, null, 2)}\n`);
    process.stderr.write(
      `Locked ${payload.stories.length} story(ies), ${payload.sections.length} section(s) -> ${lockedPath}\n`
    );
    response.json({
      stories: payload.stories.length,
      sections: payload.sections.length,
      path: lockedPath,
    });
  });
  app.post("/api/import", async (_request, response) => {
    if (!config.dbUrlIngest) {
      response.status(400).json({
        error:
          "No database configured. Set DATABASE_URL_INGEST to add directly, or lock the draft and run tieline import.",
      });
      return;
    }
    const payload = toImportPayload(readDraft());
    if (payload.stories.length === 0) {
      response.status(400).json({ error: "No approved stories to add." });
      return;
    }
    const sql = postgres(config.dbUrlIngest, { max: 1, prepare: false });
    try {
      if (workspace) validateWorkspaceImport(workspace, payload);
      const embedder = getEmbedder();
      validateWorkspaceEmbeddingProvider(workspace, embedder.provider);
      const result = await importStories(sql, embedder, payload, { repo: importRepo });
      process.stderr.write(
        `Added ${result.stories} story(ies), ${result.sections} section(s) to Tieline.\n`
      );
      response.json(result);
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  await new Promise<void>((resolveListening, reject) => {
    const server = app.listen(port, "127.0.0.1", () => resolveListening());
    server.once("error", reject);
  });
  process.stderr.write(
    `Story review: http://localhost:${port}/\n  draft:  ${draftPath}\n  locked: ${lockedPath}\n`
  );
  return 0;
}
