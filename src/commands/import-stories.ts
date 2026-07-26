import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { importStories } from "../authoring/import.js";
import {
  parseDraft,
  parseImportPayload,
  toImportPayload,
  type ImportPayload,
} from "../authoring/schema.js";
import { config } from "../config.js";
import { getEmbedder } from "../embeddings.js";
import {
  findTielineWorkspace,
  resolveWorkspaceRepo,
  validateWorkspaceEmbeddingProvider,
  validateWorkspaceImport,
} from "../tieline/workspace.js";

function looksLikeDraft(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const candidate = raw as { version?: unknown; mode?: unknown; stories?: unknown };
  return (
    "version" in candidate ||
    "mode" in candidate ||
    (Array.isArray(candidate.stories) &&
      candidate.stories.some(
        (story) => story && typeof story === "object" && "_review" in (story as object)
      ))
  );
}

export async function runImportCommand(args: string[]): Promise<number> {
  if (!config.dbUrlIngest) {
    throw new Error(
      "Set DATABASE_URL_INGEST to a role that can write; it never falls back to DATABASE_URL."
    );
  }
  const includeAll = args.includes("--all");
  const batchFlag = args.indexOf("--batch-size");
  const batchSize = batchFlag >= 0 ? Number(args[batchFlag + 1]) : 50;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 200) {
    throw new Error("--batch-size must be an integer from 1 to 200.");
  }
  const knownFlags = new Set(["--all", "--batch-size"]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    if (!knownFlags.has(arg)) throw new Error(`Unknown import option '${arg}'.`);
    if (arg === "--batch-size") index++;
  }
  const pathArg =
    args.find((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--batch-size") ??
    "stories.locked.json";
  const path = resolve(process.cwd(), pathArg);
  if (!existsSync(path)) {
    throw new Error(`Not found: ${path}. Pass a draft or locked file to tieline import.`);
  }

  const sourceBody = readFileSync(path, "utf8");
  const sourceChecksum = createHash("sha256").update(sourceBody).digest("hex");
  const raw = JSON.parse(sourceBody) as unknown;
  const workspace = findTielineWorkspace(path);
  const importRepo = resolveWorkspaceRepo(workspace, config.repo);
  let payload: ImportPayload;

  if (looksLikeDraft(raw)) {
    const draft = parseDraft(raw);
    if (workspace && !draft.repo) draft.repo = workspace.config.product.repo_name;
    const include = includeAll ? "not-rejected" : "approved";
    payload = toImportPayload(draft, { include });
    process.stderr.write(
      `Draft: importing ${payload.stories.length}/${draft.stories.length} stories (${include}${includeAll ? "" : " only"}).\n`
    );
    if (payload.stories.length === 0) {
      process.stderr.write(
        includeAll
          ? "Nothing to import (all stories are rejected).\n"
          : "Nothing approved to import. Approve stories, or pass --all to include every non-rejected story.\n"
      );
      return 0;
    }
  } else {
    payload = parseImportPayload(raw);
  }
  if (workspace) validateWorkspaceImport(workspace, payload);

  const embedder = getEmbedder();
  validateWorkspaceEmbeddingProvider(workspace, embedder.provider);
  process.stderr.write(
    `Importing ${payload.stories.length} story(ies), ${payload.sections.length} section(s) from ${path}\n` +
      `Embedding provider: ${embedder.provider} (dim ${embedder.dim})\n`
  );

  const sql = postgres(config.dbUrlIngest, { max: 1, prepare: false });
  const reportPath = `${path}.import-report.json`;
  const committed: Array<{
    batch: number;
    stories: number;
    applied: number;
    skipped: number;
    status: "committed";
  }> = [];
  try {
    const result = await importStories(sql, embedder, payload, {
      batchSize,
      repo: importRepo,
      onBatch: (batch) => {
        committed.push(batch);
        writeFileSync(
          reportPath,
          `${JSON.stringify(
            { source: path, source_checksum: sourceChecksum, status: "running", committed },
            null,
            2
          )}\n`
        );
      },
    });
    writeFileSync(
      reportPath,
      `${JSON.stringify(
        { source: path, source_checksum: sourceChecksum, status: "complete", ...result },
        null,
        2
      )}\n`
    );
    process.stderr.write(
      `Done. sections=${result.sections} stories=${result.stories} entities=${result.entities} ` +
        `code_paths=${result.code_paths}\nReport: ${reportPath}\n`
    );
    return 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
