/**
 * Single-pass lexical scan over a JS/TS source file, shared by the modules
 * that read source without parsing it (`link-plausibility.ts` extracts a token
 * surface from it; `selector.ts` extracts declared symbol names).
 *
 * One left-to-right character scan separates comments, string literals, and
 * remaining code. Deliberately not a parser: template interpolations are
 * treated as opaque string bodies and regex literals stay in the code stream,
 * both acceptable for heuristics whose errors must fall on the "found
 * something extra" side.
 */

export interface ScannedSource {
  /**
   * Source with comments removed and each string collapsed to one space, so
   * name patterns cannot match inside prose or data.
   */
  code: string;
  /**
   * Source with comments and strings blanked to spaces in place. Line
   * structure is preserved, for consumers whose patterns are line-anchored.
   */
  blankedCode: string;
  comments: string[];
  strings: string[];
}

interface LiteralRead {
  literal: string;
  next: number;
}

function readTemplateInterpolation(content: string, start: number): number {
  let index = start;
  let braceDepth = 1;
  while (index < content.length) {
    const char = content[index];
    const next = content[index + 1];
    if (char === "/" && next === "/") {
      const end = content.indexOf("\n", index + 2);
      index = end === -1 ? content.length : end;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = content.indexOf("*/", index + 2);
      index = end === -1 ? content.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      index = readLiteral(content, index, char).next;
      continue;
    }
    if (char === "{") braceDepth += 1;
    if (char === "}") {
      braceDepth -= 1;
      if (braceDepth === 0) return index + 1;
    }
    index += 1;
  }
  return content.length;
}

function readTemplateLiteral(content: string, start: number): LiteralRead {
  let index = start + 1;
  let literal = "";
  while (index < content.length) {
    const char = content[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "`") return { literal, next: index + 1 };
    if (char === "$" && content[index + 1] === "{") {
      const next = readTemplateInterpolation(content, index + 2);
      literal += content.slice(index, next);
      index = next;
      continue;
    }
    literal += char;
    index += 1;
  }
  return { literal, next: content.length };
}

function readLiteral(
  content: string,
  start: number,
  quote: string
): LiteralRead {
  if (quote === "`") return readTemplateLiteral(content, start);
  let index = start + 1;
  let literal = "";
  while (index < content.length) {
    const char = content[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) return { literal, next: index + 1 };
    // An unterminated quote must not swallow the rest of the file.
    if (char === "\n") return { literal, next: index };
    literal += char;
    index += 1;
  }
  return { literal, next: content.length };
}

export function scanSource(content: string): ScannedSource {
  const comments: string[] = [];
  const strings: string[] = [];
  let code = "";
  let blanked = "";
  let index = 0;
  const blank = (slice: string): string => slice.replace(/[^\n]/g, " ");
  while (index < content.length) {
    const char = content[index];
    const next = content[index + 1];
    if (char === "/" && next === "/") {
      const end = content.indexOf("\n", index);
      const stop = end === -1 ? content.length : end;
      comments.push(content.slice(index + 2, stop));
      blanked += blank(content.slice(index, stop));
      index = stop;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = content.indexOf("*/", index + 2);
      const stop = end === -1 ? content.length : end + 2;
      comments.push(content.slice(index + 2, end === -1 ? content.length : end));
      blanked += blank(content.slice(index, stop));
      index = stop;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const literal = readLiteral(content, index, char);
      strings.push(literal.literal);
      code += " ";
      blanked += blank(content.slice(index, literal.next));
      index = literal.next;
      continue;
    }
    code += char;
    blanked += char;
    index += 1;
  }
  return { code, blankedCode: blanked, comments, strings };
}
