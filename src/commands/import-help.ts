import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  helpArticleImportPayloadSchema,
  helpArticleImportSchema,
} from "../authoring/help-schema.js";
import { importHelpArticles } from "../adapters/postgres/help-repository.js";
import { closeConnections } from "../adapters/postgres/connections.js";

function parseInput(path: string): ReturnType<typeof helpArticleImportPayloadSchema.parse> {
  const body = readFileSync(path, "utf8");
  if (path.endsWith(".jsonl")) {
    return body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => {
        try {
          return helpArticleImportSchema.parse(JSON.parse(line));
        } catch (error) {
          throw new Error(`Invalid JSONL record at line ${index + 1}: ${String(error)}`);
        }
      });
  }
  return helpArticleImportPayloadSchema.parse(JSON.parse(body));
}

export async function runImportHelpCommand(
  input: string,
  options: { batchSize: number }
): Promise<number> {
  const batchSize = options.batchSize;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 200) {
    throw new Error("--batch-size must be an integer from 1 to 200.");
  }
  const path = resolve(process.cwd(), input);
  if (!existsSync(path)) throw new Error(`Not found: ${path}`);

  const articles = parseInput(path);
  try {
    const result = await importHelpArticles(articles, { batchSize });
    const reportPath = `${path}.import-report.json`;
    writeFileSync(
      reportPath,
      `${JSON.stringify({ source: path, status: "complete", ...result }, null, 2)}\n`
    );
    process.stderr.write(
      `Imported ${result.articles} help article(s) in ${result.batches.length} batch(es).\n` +
        `Report: ${reportPath}\n`
    );
    return 0;
  } finally {
    await closeConnections();
  }
}
