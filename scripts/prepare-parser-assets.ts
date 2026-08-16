import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  parserCompatibilitySet,
  readParserCompatibilityManifest,
  type ParserArtifactKey,
} from "../src/contract/code-analysis/languages.js";

const sourceRoot = resolve(process.argv[2] ?? "node_modules");
const destinationRoot = resolve("assets", "parsers", parserCompatibilitySet);
const manifest = await readParserCompatibilityManifest(destinationRoot);
const sources: Record<ParserArtifactKey, string> = {
  runtime: "web-tree-sitter/web-tree-sitter.wasm",
  javascript: "tree-sitter-javascript/tree-sitter-javascript.wasm",
  typescript: "tree-sitter-typescript/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-typescript/tree-sitter-tsx.wasm",
  python: "tree-sitter-python/tree-sitter-python.wasm",
  rust: "tree-sitter-rust/tree-sitter-rust.wasm",
  sql: "@derekstride/tree-sitter-sql/tree-sitter-sql.wasm",
};

await mkdir(destinationRoot, { recursive: true });
for (const key of Object.keys(sources) as ParserArtifactKey[]) {
  const artifact = manifest.artifacts[key];
  const source = resolve(sourceRoot, sources[key]);
  const bytes = await readFile(source);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== artifact.sha256) {
    throw new Error(`Refusing to copy ${source}: expected ${artifact.sha256}, received ${digest}`);
  }
  await copyFile(source, resolve(destinationRoot, artifact.file));
}

process.stdout.write(`Prepared ${Object.keys(sources).length} verified parser assets.\n`);
