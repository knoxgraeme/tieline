import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  createRegexSymbolVocabulary,
  extractSymbolsFromSource,
  getSymbolVocabulary,
  resetSymbolVocabularyFactory,
  setSymbolVocabularyFactory,
  stripCommentsAndLiterals,
} from "../src/contract/symbol-vocabulary.js";

const root = mkdtempSync(resolve(tmpdir(), "tieline-vocabulary-"));
try {
  mkdirSync(resolve(root, "src"), { recursive: true });
  mkdirSync(resolve(root, "migrations"), { recursive: true });
  const vocabulary = createRegexSymbolVocabulary(root);

  // Exported function, class, interface, type, enum, and const declarations are citable.
  writeFileSync(
    resolve(root, "src/declarations.ts"),
    `export interface GradeReport {
  total: number;
}

export type GradeValue = "supported" | "partial" | "unsupported";

export enum GradeChannel {
  Cli,
}

export abstract class GradeFence {
  abstract accept(): boolean;
}

export async function verifyGradeVerdicts(): Promise<void> {}

export const GRADE_DEFAULT_BASE = "origin/main";
`
  );
  const declarations = vocabulary.extract("src/declarations.ts");
  for (const symbol of [
    "GradeReport",
    "GradeValue",
    "GradeChannel",
    "GradeFence",
    "verifyGradeVerdicts",
    "GRADE_DEFAULT_BASE",
  ]) {
    assert.equal(
      declarations.has(symbol),
      true,
      `expected '${symbol}' in the vocabulary`
    );
  }

  // Non-exported declarations are legitimate citations too.
  writeFileSync(
    resolve(root, "src/private.ts"),
    `function privateHelper(): number {
  let privateCounter = 0;
  return privateCounter;
}

class PrivateFence {}

export const exposed = privateHelper;
`
  );
  const privates = vocabulary.extract("src/private.ts");
  assert.equal(privates.has("privateHelper"), true);
  assert.equal(privates.has("PrivateFence"), true);
  assert.equal(privates.has("privateCounter"), true);
  assert.equal(privates.has("exposed"), true);

  // An identifier that appears only inside a line comment is not citable.
  writeFileSync(
    resolve(root, "src/line-comment.ts"),
    `// The function commentOnlySymbol is described here but never declared.
export const realSymbol = 1;
`
  );
  const lineComment = vocabulary.extract("src/line-comment.ts");
  assert.equal(lineComment.has("realSymbol"), true);
  assert.equal(lineComment.has("commentOnlySymbol"), false);

  // An identifier that appears only inside a block comment is not citable.
  writeFileSync(
    resolve(root, "src/block-comment.ts"),
    `/**
 * Historically this held:
 *   export function blockOnlySymbol(): void {}
 */
export const survivingSymbol = 2;
`
  );
  const blockComment = vocabulary.extract("src/block-comment.ts");
  assert.equal(blockComment.has("survivingSymbol"), true);
  assert.equal(blockComment.has("blockOnlySymbol"), false);

  // An identifier that appears only inside a string or template literal is not citable.
  writeFileSync(
    resolve(root, "src/literals.ts"),
    [
      'export const quoted = "export function stringOnlySymbol() {}";',
      "export const single = 'const singleQuotedSymbol = 1;';",
      "export const templated = `export class TemplateOnlySymbol {}`;",
      "export const nested = `outer ${`inner ${\"const deeplyNestedSymbol = 3\"}`} tail`;",
      "export const afterLiterals = 4;",
      "",
    ].join("\n")
  );
  const literals = vocabulary.extract("src/literals.ts");
  assert.equal(literals.has("quoted"), true);
  assert.equal(literals.has("single"), true);
  assert.equal(literals.has("templated"), true);
  assert.equal(literals.has("nested"), true);
  assert.equal(literals.has("afterLiterals"), true);
  assert.equal(literals.has("stringOnlySymbol"), false);
  assert.equal(literals.has("singleQuotedSymbol"), false);
  assert.equal(literals.has("TemplateOnlySymbol"), false);
  assert.equal(literals.has("deeplyNestedSymbol"), false);

  // An identifier that only arrives through an import is defined elsewhere.
  writeFileSync(
    resolve(root, "src/imports.ts"),
    `import { importedSymbol } from "./declarations.js";
import type { ImportedType } from "./declarations.js";
import defaultImport from "./private.js";

export const localSymbol = importedSymbol;
`
  );
  const imports = vocabulary.extract("src/imports.ts");
  assert.equal(imports.has("localSymbol"), true);
  assert.equal(imports.has("importedSymbol"), false);
  assert.equal(imports.has("ImportedType"), false);
  assert.equal(imports.has("defaultImport"), false);

  // An empty file yields an empty set without throwing.
  writeFileSync(resolve(root, "src/empty.ts"), "");
  assert.deepEqual([...vocabulary.extract("src/empty.ts")], []);

  // Unbalanced braces degrade to best-effort results without throwing.
  writeFileSync(
    resolve(root, "src/unbalanced.ts"),
    `export function openedButNeverClosed() {
  const insideSymbol = 1;
  /* an unterminated block comment mentioning hiddenSymbol
export const afterTheDamage = "unterminated
`
  );
  const unbalanced = vocabulary.extract("src/unbalanced.ts");
  assert.equal(unbalanced.has("openedButNeverClosed"), true);
  assert.equal(unbalanced.has("insideSymbol"), true);
  assert.equal(unbalanced.has("hiddenSymbol"), false);

  // Non-TypeScript artifacts have no extractable declaration forms.
  writeFileSync(
    resolve(root, "migrations/0001_baseline.sql"),
    "create table const_table (id uuid primary key);\n"
  );
  writeFileSync(
    resolve(root, "src/config.yaml"),
    "version: 1\nfunction: notASymbol\n"
  );
  assert.deepEqual([...vocabulary.extract("migrations/0001_baseline.sql")], []);
  assert.deepEqual([...vocabulary.extract("src/config.yaml")], []);

  // A missing file yields an empty set without throwing.
  assert.deepEqual([...vocabulary.extract("src/does-not-exist.ts")], []);
  assert.deepEqual([...vocabulary.extract("src")], []);

  // Regular-expression literals never contribute citations, and division still parses.
  const regexSymbols = extractSymbolsFromSource(
    `const ratio = total / divisor;
const pattern = /export function regexOnlySymbol/g;
const trailing = 5;
`
  );
  assert.equal(regexSymbols.has("ratio"), true);
  assert.equal(regexSymbols.has("pattern"), true);
  assert.equal(regexSymbols.has("trailing"), true);
  assert.equal(regexSymbols.has("regexOnlySymbol"), false);

  // Stripping preserves offsets so neighbouring tokens cannot merge.
  const stripped = stripCommentsAndLiterals("const/* gap */alpha = 1;");
  assert.equal(stripped.length, "const/* gap */alpha = 1;".length);
  assert.equal(extractSymbolsFromSource("const/* gap */alpha = 1;").has("alpha"), true);

  // The port is swappable without the callers changing.
  setSymbolVocabularyFactory(() => ({
    extract: () => new Set(["injectedSymbol"]),
  }));
  assert.deepEqual(
    [...getSymbolVocabulary(root).extract("src/declarations.ts")],
    ["injectedSymbol"]
  );
  resetSymbolVocabularyFactory();
  assert.equal(
    getSymbolVocabulary(root).extract("src/declarations.ts").has("GradeValue"),
    true
  );

  // Callers cannot mutate the cached vocabulary.
  const firstRead = vocabulary.extract("src/declarations.ts");
  firstRead.add("fabricated");
  assert.equal(
    vocabulary.extract("src/declarations.ts").has("fabricated"),
    false
  );
} finally {
  resetSymbolVocabularyFactory();
  rmSync(root, { recursive: true, force: true });
}

console.log("symbol vocabulary tests passed");
