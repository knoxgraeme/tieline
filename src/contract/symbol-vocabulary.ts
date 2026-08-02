/**
 * SymbolVocabulary — the closed set of citations a grade is allowed to draw on.
 *
 * `contract grade` fences host-agent verdicts: a `supported` grade must cite a
 * symbol this module extracted from the artifact itself. The test is vocabulary
 * *membership*, not substring presence, so comments and string/template
 * literals are stripped before declarations are matched. An identifier that
 * appears only inside a comment is therefore not citable.
 *
 * Port plus adapter, mirroring the getStore()/setStore() seam in src/store.ts:
 * callers depend on the `SymbolVocabulary` interface, the shipped adapter is
 * regex-based, and a real parser can replace it through
 * `setSymbolVocabularyFactory` without the fence changing at all.
 *
 * The error direction is deliberate. A declaration this adapter misses wrongly
 * downgrades a valid grade — safe and visible. The adapter cannot invent a
 * symbol that is absent from the file, which is the failure that would matter.
 */

import { readFileSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

export interface SymbolVocabulary {
  /**
   * The declarations defined by a repository-relative artifact path. Unreadable,
   * missing, empty, and non-TypeScript artifacts yield an empty set rather than
   * throwing: an empty vocabulary correctly makes `supported` unreachable.
   */
  extract(path: string): Set<string>;
}

export type SymbolVocabularyFactory = (
  repositoryRoot: string
) => SymbolVocabulary;

/** Only sources whose declaration forms this adapter understands are extracted. */
const EXTRACTABLE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

/** Tokens after which a `/` opens a regular expression rather than dividing. */
const REGEX_PERMITTING_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "case",
  "do",
  "else",
  "yield",
  "await",
  "throw",
]);

/**
 * Declaration forms only. Each `export`, `export default`, `declare`, `async`,
 * and `abstract` prefix is ignored because the keyword itself is matched, so
 * exported and non-exported declarations are equally citable — a private helper
 * is a legitimate citation.
 */
const DECLARATION_PATTERNS: readonly RegExp[] = [
  /\bfunction\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)/g,
  /\bclass\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
  /\binterface\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
  /\btype\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[<=]/g,
  /\benum\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
  /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
];

function blankAll(
  out: string[],
  source: string,
  start: number,
  end: number
): void {
  for (let index = start; index < end && index < out.length; index++) {
    out[index] = source[index] === "\n" ? "\n" : " ";
  }
}

/** Blanks a literal's contents while leaving its delimiters in place, so the
 * regex/division heuristic can still see that a literal ended here. */
function blankInterior(
  out: string[],
  source: string,
  start: number,
  end: number,
  delimiter: string
): void {
  blankAll(out, source, start + 1, end);
  if (end - 1 > start && source[end - 1] === delimiter) {
    out[end - 1] = delimiter;
  }
}

/** Index just past a `'`/`"` literal; an unterminated literal stops at the line end. */
function scanQuoted(source: string, start: number): number {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === quote) return index + 1;
    if (character === "\n") return index;
    index++;
  }
  return index;
}

/**
 * Index just past a template literal. Substitutions are consumed as part of the
 * literal — a declaration inside `${...}` is not extracted, which is the safe
 * direction — but their braces, nested templates, and quoted strings are tracked
 * so the closing backtick is located correctly.
 */
function scanTemplate(source: string, start: number): number {
  let index = start + 1;
  let expressionDepth = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (expressionDepth === 0) {
      if (character === "`") return index + 1;
      if (character === "$" && source[index + 1] === "{") {
        expressionDepth = 1;
        index += 2;
        continue;
      }
      index++;
      continue;
    }
    if (character === "{") {
      expressionDepth++;
      index++;
      continue;
    }
    if (character === "}") {
      expressionDepth--;
      index++;
      continue;
    }
    if (character === "`") {
      index = scanTemplate(source, index);
      continue;
    }
    if (character === '"' || character === "'") {
      index = scanQuoted(source, index);
      continue;
    }
    index++;
  }
  return index;
}

/**
 * Index just past a regular-expression literal. When no terminator is found on
 * the same line the `/` was a division after all, so only that character is
 * consumed and no code is swallowed.
 */
function scanRegex(source: string, start: number): number {
  let index = start + 1;
  let inCharacterClass = false;
  while (index < source.length) {
    const character = source[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "\n") return start + 1;
    if (inCharacterClass) {
      if (character === "]") inCharacterClass = false;
    } else if (character === "[") {
      inCharacterClass = true;
    } else if (character === "/") {
      return index + 1;
    }
    index++;
  }
  return start + 1;
}

function regexAllowedAt(out: string[], index: number): boolean {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(out[cursor]!)) cursor--;
  if (cursor < 0) return true;
  const character = out[cursor]!;
  if (/[A-Za-z0-9_$]/.test(character)) {
    const end = cursor + 1;
    while (cursor >= 0 && /[A-Za-z0-9_$]/.test(out[cursor]!)) cursor--;
    return REGEX_PERMITTING_KEYWORDS.has(out.slice(cursor + 1, end).join(""));
  }
  return !/[)\]}"'`]/.test(character);
}

/**
 * Replaces comments and literal contents with whitespace, preserving offsets so
 * neighbouring tokens cannot merge. Unbalanced braces, unterminated strings, and
 * unterminated comments degrade to best-effort output instead of throwing.
 */
export function stripCommentsAndLiterals(source: string): string {
  const out = source.split("");
  let index = 0;
  while (index < source.length) {
    const character = source[index]!;
    const following = source[index + 1];
    if (character === "/" && following === "/") {
      const newline = source.indexOf("\n", index);
      const stop = newline === -1 ? source.length : newline;
      blankAll(out, source, index, stop);
      index = stop;
      continue;
    }
    if (character === "/" && following === "*") {
      const close = source.indexOf("*/", index + 2);
      const stop = close === -1 ? source.length : close + 2;
      blankAll(out, source, index, stop);
      index = stop;
      continue;
    }
    if (character === '"' || character === "'") {
      const end = scanQuoted(source, index);
      blankInterior(out, source, index, end, character);
      index = end;
      continue;
    }
    if (character === "`") {
      const end = scanTemplate(source, index);
      blankInterior(out, source, index, end, "`");
      index = end;
      continue;
    }
    if (character === "/" && regexAllowedAt(out, index)) {
      const end = scanRegex(source, index);
      blankAll(out, source, index, end);
      index = end;
      continue;
    }
    index++;
  }
  return out.join("");
}

/** The declarations a source text defines, comments and literals excluded. */
export function extractSymbolsFromSource(source: string): Set<string> {
  const code = stripCommentsAndLiterals(source);
  const symbols = new Set<string>();
  for (const pattern of DECLARATION_PATTERNS) {
    const scanner = new RegExp(pattern.source, pattern.flags);
    let match = scanner.exec(code);
    while (match !== null) {
      if (match[1]) symbols.add(match[1]);
      match = scanner.exec(code);
    }
  }
  return symbols;
}

function extractArtifactSymbols(root: string, path: string): Set<string> {
  if (!EXTRACTABLE_EXTENSIONS.has(extname(path).toLowerCase())) {
    return new Set();
  }
  const target = resolve(root, path);
  const repositoryPath = relative(root, target);
  if (
    repositoryPath === ".." ||
    repositoryPath.startsWith(`..${sep}`) ||
    isAbsolute(repositoryPath)
  ) {
    return new Set();
  }
  try {
    return extractSymbolsFromSource(readFileSync(target, "utf8"));
  } catch {
    // Missing, unreadable, or non-file artifacts have no legal citations. The
    // caller reports `unsupported` for them rather than failing the run.
    return new Set();
  }
}

export function createRegexSymbolVocabulary(
  repositoryRoot: string
): SymbolVocabulary {
  const root = resolve(repositoryRoot);
  const measured = new Map<string, Set<string>>();
  return {
    extract(path) {
      const cached = measured.get(path);
      if (cached) return new Set(cached);
      const symbols = extractArtifactSymbols(root, path);
      measured.set(path, symbols);
      return new Set(symbols);
    },
  };
}

let symbolVocabularyFactory: SymbolVocabularyFactory =
  createRegexSymbolVocabulary;

export function getSymbolVocabulary(
  repositoryRoot: string
): SymbolVocabulary {
  return symbolVocabularyFactory(repositoryRoot);
}

/** Swap seam: a parser-backed resolver replaces the regex adapter here. */
export function setSymbolVocabularyFactory(
  factory: SymbolVocabularyFactory
): void {
  symbolVocabularyFactory = factory;
}

export function resetSymbolVocabularyFactory(): void {
  symbolVocabularyFactory = createRegexSymbolVocabulary;
}
