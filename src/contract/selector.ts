/**
 * Contract link selectors: grammar, canonical form, and conservative symbol
 * resolution.
 *
 * A link target names a file. A selector narrows that claim to a named thing
 * inside the file — `function:analyzeContractImpact`,
 * `class:PostgresStore/method:searchSemantic`, `route:GET /health`.
 *
 * WHY THIS IS A GRAMMAR AND NOT FREE TEXT. A selector is not decoration. It is
 * rendered next to the path, it is part of an asset's identity key, and it is
 * compared with exact equality when evidence is joined. Free text therefore
 * fails in a specific and silent way: `analyzeContractImpact` and
 * `analyzeContractImpact()` become two unrelated assets that nothing can ever
 * reconcile, and `func:` versus `function:` splits a repository's vocabulary in
 * half without producing a single error. The grammar exists to make that class
 * of drift a validation failure at authoring time instead of a mystery in the
 * data later.
 *
 * TWO SEPARATE CONCERNS, DELIBERATELY SPLIT:
 *
 * 1. Shape and canonical form (`parseSelector`, `normalizeSelector`) are pure
 *    functions of the string. They do NOT consult repository configuration.
 *    This is load-bearing: the canonical form becomes part of an identity key,
 *    so it must never depend on config that differs between checkouts. Two
 *    repositories writing `Function: Foo` must produce byte-identical keys.
 *
 * 2. Kind membership (`validateSelector`) is checked against a vocabulary:
 *    a closed core plus whatever a repository declares. Validation is closed —
 *    anything outside core ∪ declared is an error — while the vocabulary itself
 *    is configurable, because an acceptance criterion maps more naturally onto a
 *    route, a CLI command, or a tool than onto a function.
 *
 * RESOLUTION IS HEURISTIC AND MUST STAY CONSERVATIVE. `resolveSelector` reads
 * the linked file and looks for a matching symbol using regexes, the same
 * approach already proven for lexical link plausibility. Regexes do not
 * understand every language or every syntax. The result is therefore
 * three-state, and the third state is the important one: `not_checked` means
 * this heuristic learned nothing, and it must never be reported or aggregated
 * as `unresolved`. Claiming a symbol is gone when the extractor simply could not
 * see it is a false accusation against a contract that may be perfectly correct.
 */
import { readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { scanSource } from "./source-scan.js";

/**
 * Kinds this module can resolve to a symbol. Closed on purpose: every member
 * here has extraction rules below, so adding one is a code change, not config.
 */
export const CORE_SELECTOR_KINDS = [
  "class",
  "const",
  "function",
  "method",
  "type",
] as const;

export type CoreSelectorKind = (typeof CORE_SELECTOR_KINDS)[number];

const CORE_KIND_SET: ReadonlySet<string> = new Set(CORE_SELECTOR_KINDS);

function isCoreSelectorKind(kind: string): kind is CoreSelectorKind {
  return CORE_KIND_SET.has(kind);
}

/** `<kind>` — a letter, then letters, digits, `_` or `-`. Case-insensitive. */
const KIND_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * A `/` begins a new segment only when a `<kind>:` prefix follows it, ignoring
 * whitespace so `class:Foo / method:bar` and `class:Foo/method:bar` agree.
 */
const SEGMENT_START_PATTERN = /^[ \t]*[A-Za-z][A-Za-z0-9_-]*:/;

/** Names of core kinds must be bare symbol names — no parentheses, no spaces. */
const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export const MAX_SELECTOR_LENGTH = 200;
export const MAX_SELECTOR_SEGMENTS = 4;
const MAX_SEGMENT_NAME_LENGTH = 160;

export const DEFAULT_MAX_SELECTOR_SOURCE_BYTES = 512_000;
const BINARY_SNIFF_BYTES = 8_000;

export class SelectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelectorError";
  }
}

export interface SelectorSegment {
  /** Lowercase. */
  kind: string;
  /** Case preserved exactly as written, whitespace collapsed. */
  name: string;
}

export interface ParsedSelector {
  segments: SelectorSegment[];
  /** `kind:name` per segment, joined by `/`. This is the identity form. */
  canonical: string;
}

export type SelectorParseResult =
  | { ok: true; selector: ParsedSelector }
  | { ok: false; error: string };

/**
 * Splits on `/` only where a `<kind>:` prefix follows, so a name may legitimately
 * contain a slash: `route:GET /health` is one segment, while
 * `class:PostgresStore/method:searchSemantic` is two. The rule is syntactic and
 * never consults the vocabulary, which keeps the canonical form config-independent.
 */
function splitSegments(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "/") continue;
    if (!SEGMENT_START_PATTERN.test(value.slice(index + 1))) continue;
    parts.push(value.slice(start, index));
    start = index + 1;
  }
  parts.push(value.slice(start));
  return parts;
}

function failure(error: string): SelectorParseResult {
  return { ok: false, error };
}

/**
 * Parses `<kind>:<name>` segments, optionally qualified with `/`.
 *
 * Canonicalization rules, in one place because downstream identity depends on
 * every one of them:
 *
 * - Unicode NFC, so visually identical names cannot become distinct keys.
 * - Surrounding whitespace removed; whitespace around `:` and `/` removed;
 *   internal runs of whitespace inside a name collapsed to one space.
 * - The kind is lowercased. Kinds are a controlled vocabulary, not user data,
 *   so `Function`, `FUNCTION` and `function` are the same kind.
 * - The name keeps its case exactly. `searchSemantic` and `SearchSemantic` are
 *   different symbols in every language this can resolve, and folding them would
 *   merge two genuinely different assets.
 * - Core-kind names must be bare identifiers, which is what rejects
 *   `function:analyzeContractImpact()` — the trailing `()` is precisely the kind
 *   of cosmetic variation that would fork an identity key.
 */
export function parseSelector(raw: unknown): SelectorParseResult {
  if (typeof raw !== "string") return failure("selector must be a string");
  const value = raw.normalize("NFC").trim();
  if (value.length === 0) return failure("selector cannot be empty");
  if (value.length > MAX_SELECTOR_LENGTH) {
    return failure(
      `selector is longer than ${MAX_SELECTOR_LENGTH} characters; name a symbol, not a description`
    );
  }
  if (CONTROL_CHARACTERS.test(value)) {
    return failure("selector cannot contain control characters");
  }

  const rawSegments = splitSegments(value);
  if (rawSegments.length > MAX_SELECTOR_SEGMENTS) {
    return failure(
      `selector '${value}' has ${rawSegments.length} qualified parts; at most ${MAX_SELECTOR_SEGMENTS} are allowed`
    );
  }

  const segments: SelectorSegment[] = [];
  for (const rawSegment of rawSegments) {
    const segment = rawSegment.trim();
    if (segment.length === 0) {
      return failure(
        `selector '${value}' has an empty part; check for a stray or doubled '/'`
      );
    }
    const colon = segment.indexOf(":");
    if (colon === -1) {
      return failure(
        `selector part '${segment}' must be written as '<kind>:<name>'`
      );
    }
    const kind = segment.slice(0, colon).trim();
    const name = segment.slice(colon + 1).trim().replace(/\s+/g, " ");
    if (kind.length === 0) {
      return failure(`selector part '${segment}' has an empty kind`);
    }
    if (!KIND_PATTERN.test(kind)) {
      return failure(
        `selector kind '${kind}' must start with a letter and contain only letters, digits, '_' or '-'`
      );
    }
    if (name.length === 0) {
      return failure(`selector kind '${kind}' has an empty name`);
    }
    if (name.length > MAX_SEGMENT_NAME_LENGTH) {
      return failure(
        `selector name for kind '${kind}' is longer than ${MAX_SEGMENT_NAME_LENGTH} characters`
      );
    }
    if (name.includes(":")) {
      return failure(
        `selector name '${name}' cannot contain ':'; use '/' to qualify a member`
      );
    }
    // Checked before the identifier rule so a stray or doubled separator is
    // reported as what it is, rather than as a confusing complaint about the
    // symbol name it accidentally became part of.
    if (name.startsWith("/") || name.endsWith("/") || name.includes("//")) {
      return failure(
        `selector '${value}' has a stray or doubled '/'; qualify a member as '<kind>:<name>/<kind>:<name>'`
      );
    }
    const normalizedKind = kind.toLowerCase();
    if (isCoreSelectorKind(normalizedKind) && !IDENTIFIER_PATTERN.test(name)) {
      return failure(
        `selector '${normalizedKind}:${name}' must name a bare symbol (letters, digits, '_' or '$'); ` +
          `drop call parentheses, arguments and spaces`
      );
    }
    segments.push({ kind: normalizedKind, name });
  }

  return {
    ok: true,
    selector: {
      segments,
      canonical: segments
        .map((segment) => `${segment.kind}:${segment.name}`)
        .join("/"),
    },
  };
}

/**
 * Canonical string form. Throws on a malformed selector rather than returning a
 * best effort, because a silently-degraded identity key is worse than a failure.
 */
export function normalizeSelector(raw: unknown): string {
  const parsed = parseSelector(raw);
  if (!parsed.ok) throw new SelectorError(parsed.error);
  return parsed.selector.canonical;
}

export interface SelectorKindDeclaration {
  name: string;
  /**
   * Whether a name of this kind should be looked for in the linked file.
   * Defaults to false: a declared kind usually addresses something the source
   * regexes cannot see (a route, a command, a tool), and claiming otherwise
   * would manufacture `unresolved` findings.
   */
  resolvable?: boolean;
  description?: string;
}

export interface SelectorKindInfo {
  name: string;
  core: boolean;
  resolvable: boolean;
  description: string | null;
}

export interface SelectorVocabulary {
  kinds: ReadonlyMap<string, SelectorKindInfo>;
  /** Sorted, for error messages and reporting. */
  names: readonly string[];
}

function vocabularyFrom(
  entries: readonly SelectorKindInfo[]
): SelectorVocabulary {
  const kinds = new Map(entries.map((entry) => [entry.name, entry]));
  return { kinds, names: [...kinds.keys()].sort() };
}

const CORE_KIND_ENTRIES: readonly SelectorKindInfo[] = CORE_SELECTOR_KINDS.map(
  (name) => ({ name, core: true, resolvable: true, description: null })
);

/** Core kinds only. Used wherever repository configuration is not in hand. */
export const CORE_SELECTOR_VOCABULARY: SelectorVocabulary =
  vocabularyFrom(CORE_KIND_ENTRIES);

/**
 * Core kinds plus the repository's declared kinds. Redeclaring a core kind is an
 * error: core is closed, and letting config shadow it would let one repository
 * turn `function` into something unresolvable while another did not.
 */
export function createSelectorVocabulary(
  declared: readonly SelectorKindDeclaration[] = []
): SelectorVocabulary {
  const entries: SelectorKindInfo[] = [...CORE_KIND_ENTRIES];
  const seen = new Set<string>(CORE_SELECTOR_KINDS);
  for (const declaration of declared) {
    const raw = typeof declaration.name === "string" ? declaration.name.trim() : "";
    if (!KIND_PATTERN.test(raw)) {
      throw new SelectorError(
        `declared selector kind '${declaration.name}' must start with a letter and contain only letters, digits, '_' or '-'`
      );
    }
    const name = raw.toLowerCase();
    if (CORE_KIND_SET.has(name)) {
      throw new SelectorError(
        `declared selector kind '${name}' is already a core kind and cannot be redeclared`
      );
    }
    if (seen.has(name)) {
      throw new SelectorError(`declared selector kind '${name}' is declared twice`);
    }
    seen.add(name);
    entries.push({
      name,
      core: false,
      resolvable: declaration.resolvable === true,
      description: declaration.description?.trim() || null,
    });
  }
  return vocabularyFrom(entries);
}

export type SelectorValidationResult =
  | { ok: true; selector: ParsedSelector }
  | { ok: false; error: string };

/**
 * Shape plus kind membership. Unknown kinds fail loudly and name the vocabulary,
 * because the failure this prevents — `func:` quietly minting a second identity
 * namespace beside `function:` — is invisible once the data exists.
 */
export function validateSelector(
  raw: unknown,
  vocabulary: SelectorVocabulary = CORE_SELECTOR_VOCABULARY
): SelectorValidationResult {
  const parsed = parseSelector(raw);
  if (!parsed.ok) return parsed;
  for (const segment of parsed.selector.segments) {
    if (vocabulary.kinds.has(segment.kind)) continue;
    return {
      ok: false,
      error:
        `unknown selector kind '${segment.kind}'. Known kinds: ${vocabulary.names.join(", ")}. ` +
        `Declare additional kinds under 'selectors.kinds' in .tieline/config.json.`,
    };
  }
  return { ok: true, selector: parsed.selector };
}

// Resolution

/**
 * Extensions the extraction regexes below actually understand. Anything else is
 * `not_checked`; guessing at another language's declaration syntax would produce
 * confident nonsense.
 */
export const RESOLVABLE_SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

export interface SymbolIndex {
  /** Names found per core kind. */
  kinds: Record<CoreSelectorKind, string[]>;
  /** Every name found under any kind, for kind-agnostic lookups. */
  all: string[];
}

const FUNCTION_PATTERNS: readonly RegExp[] = [
  /\bfunction\s*\*?\s+([A-Za-z_$][\w$]*)/g,
  // `const name = () => …`, `const name = async function …`.
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*(?:async\s+)?(?:function\b|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=>)/g,
];

const CLASS_PATTERNS: readonly RegExp[] = [/\bclass\s+([A-Za-z_$][\w$]*)/g];

const TYPE_PATTERNS: readonly RegExp[] = [
  /\b(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/g,
];

const CONST_PATTERNS: readonly RegExp[] = [
  // The optional `enum` keeps `const enum Foo` from recording `enum` as a name.
  /\bconst\s+(?:enum\s+)?([A-Za-z_$][\w$]*)/g,
];

const METHOD_PATTERNS: readonly RegExp[] = [
  // Class members, interface members and object-literal shorthand methods.
  /^[ \t]*(?:(?:export|declare|public|private|protected|static|readonly|abstract|async|override|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\s*\(/gm,
  // Arrow-function class properties.
  /^[ \t]*(?:(?:public|private|protected|static|readonly|abstract|override)\s+)*([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=\n]*)?=>/gm,
];

/**
 * Keywords the line-anchored member pattern would otherwise capture from control
 * flow (`if (`, `for (`, `return (`). `constructor` is intentionally absent: it
 * is a real method name.
 */
const NON_MEMBER_KEYWORDS: ReadonlySet<string> = new Set([
  "await",
  "catch",
  "delete",
  "do",
  "else",
  "export",
  "for",
  "function",
  "if",
  "import",
  "new",
  "require",
  "return",
  "super",
  "switch",
  "throw",
  "typeof",
  "void",
  "while",
  "with",
  "yield",
]);

function collect(
  code: string,
  patterns: readonly RegExp[],
  into: Set<string>,
  reject?: ReadonlySet<string>
): void {
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const name = match[1];
      if (!name) continue;
      if (reject?.has(name)) continue;
      into.add(name);
    }
  }
}

/**
 * Extracts declared symbol names per core kind. Heuristic and deterministic; it
 * errs toward finding extra names rather than missing real ones, because a false
 * `resolved` merely fails to raise a suggestion while a false `unresolved` would
 * accuse a correct contract of being stale.
 *
 * Works over the scan's blanked view rather than its token surface: the token
 * pipeline lowercases and splits identifiers, which would destroy the exact
 * names this module has to match, and two of the patterns are line-anchored.
 */
export function indexSourceSymbols(content: string): SymbolIndex {
  const code = scanSource(content).blankedCode;
  const sets: Record<CoreSelectorKind, Set<string>> = {
    class: new Set(),
    const: new Set(),
    function: new Set(),
    method: new Set(),
    type: new Set(),
  };
  collect(code, FUNCTION_PATTERNS, sets.function);
  collect(code, CLASS_PATTERNS, sets.class);
  collect(code, TYPE_PATTERNS, sets.type);
  collect(code, CONST_PATTERNS, sets.const);
  collect(code, METHOD_PATTERNS, sets.method, NON_MEMBER_KEYWORDS);

  const all = new Set<string>();
  for (const names of Object.values(sets)) {
    for (const name of names) all.add(name);
  }
  return {
    kinds: {
      class: [...sets.class].sort(),
      const: [...sets.const].sort(),
      function: [...sets.function].sort(),
      method: [...sets.method].sort(),
      type: [...sets.type].sort(),
    },
    all: [...all].sort(),
  };
}

export type SelectorResolutionStatus = "resolved" | "unresolved" | "not_checked";

export type SelectorNotCheckedReason =
  | "invalid_selector"
  | "kind_not_resolvable"
  | "name_not_identifier"
  | "unsupported_language"
  | "file_missing"
  | "not_a_file"
  | "unreadable"
  | "binary_content"
  | "file_too_large"
  | "no_symbols_extracted";

export interface SelectorResolution {
  /** Canonical form when the selector parsed, otherwise the raw input trimmed. */
  selector: string;
  path: string;
  status: SelectorResolutionStatus;
  /** Always null unless status is `not_checked`. */
  reason: SelectorNotCheckedReason | null;
  /** Segments whose symbol was found. */
  matched: SelectorSegment[];
  /** Segments checked but not found. Non-empty exactly when `unresolved`. */
  missing: SelectorSegment[];
  /** Segments skipped because their kind is not resolvable. */
  skipped: SelectorSegment[];
  detail: string;
}

export interface ResolveSelectorOptions {
  repositoryRoot: string;
  /** Repository-relative path of the linked file. */
  path: string;
  selector: string;
  vocabulary?: SelectorVocabulary;
  maxSourceBytes?: number;
}

function notChecked(
  selector: string,
  path: string,
  reason: SelectorNotCheckedReason,
  detail: string,
  skipped: SelectorSegment[] = []
): SelectorResolution {
  return {
    selector,
    path,
    status: "not_checked",
    reason,
    matched: [],
    missing: [],
    skipped,
    detail,
  };
}

export type SelectorSourceRead =
  | { status: "read"; content: string }
  | { status: "skipped"; reason: SelectorNotCheckedReason };

function readSource(
  absolute: string,
  maxSourceBytes: number
): SelectorSourceRead {
  let stat;
  try {
    stat = statSync(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return {
      status: "skipped",
      reason:
        code === "ENOENT" || code === "ENOTDIR"
          ? "file_missing"
          : "unreadable",
    };
  }
  if (!stat.isFile()) return { status: "skipped", reason: "not_a_file" };
  if (stat.size > maxSourceBytes) {
    return { status: "skipped", reason: "file_too_large" };
  }
  let buffer: Buffer;
  try {
    buffer = readFileSync(absolute);
  } catch {
    return { status: "skipped", reason: "unreadable" };
  }
  if (buffer.subarray(0, BINARY_SNIFF_BYTES).indexOf(0) !== -1) {
    return { status: "skipped", reason: "binary_content" };
  }
  return { status: "read", content: buffer.toString("utf8") };
}

function resolveValidatedSelectorInIndex(
  index: SymbolIndex,
  selector: ParsedSelector,
  path: string,
  vocabulary: SelectorVocabulary
): SelectorResolution {
  const canonical = selector.canonical;
  const segments = selector.segments;

  const checkable: SelectorSegment[] = [];
  const skipped: SelectorSegment[] = [];
  for (const segment of segments) {
    const info = vocabulary.kinds.get(segment.kind);
    if (info?.resolvable) checkable.push(segment);
    else skipped.push(segment);
  }
  if (checkable.length === 0) {
    return notChecked(
      canonical,
      path,
      "kind_not_resolvable",
      `No part of '${canonical}' names a kind this repository marks resolvable, so no symbol check was attempted.`,
      skipped
    );
  }
  const nonIdentifier = checkable.find(
    (segment) => !IDENTIFIER_PATTERN.test(segment.name)
  );
  if (nonIdentifier) {
    return notChecked(
      canonical,
      path,
      "name_not_identifier",
      `'${nonIdentifier.kind}:${nonIdentifier.name}' is marked resolvable but is not a bare symbol name, so it cannot be looked up.`,
      skipped
    );
  }

  if (index.all.length === 0) {
    return notChecked(
      canonical,
      path,
      "no_symbols_extracted",
      `No declarations were recognized in '${path}', so the absence of '${canonical}' proves nothing.`,
      skipped
    );
  }

  const matched: SelectorSegment[] = [];
  const missing: SelectorSegment[] = [];
  for (const segment of checkable) {
    const names = isCoreSelectorKind(segment.kind)
      ? index.kinds[segment.kind]
      : index.all;
    if (names.includes(segment.name)) matched.push(segment);
    else missing.push(segment);
  }

  if (missing.length === 0) {
    return {
      selector: canonical,
      path,
      status: "resolved",
      reason: null,
      matched,
      missing,
      skipped,
      detail: `Found ${matched
        .map((segment) => `${segment.kind} '${segment.name}'`)
        .join(" and ")} in '${path}'.`,
    };
  }

  const notes = missing.map((segment) => {
    const elsewhere = index.all.includes(segment.name)
      ? ` ('${segment.name}' is declared here, but not as a ${segment.kind})`
      : "";
    return `no ${segment.kind} named '${segment.name}'${elsewhere}`;
  });
  return {
    selector: canonical,
    path,
    status: "unresolved",
    reason: null,
    matched,
    missing,
    skipped,
    detail: `Read '${path}' and found ${index.all.length} declaration(s), but ${notes.join("; ")}.`,
  };
}

/**
 * Looks for the selector's symbols in an already-read source string.
 *
 * A qualified selector is satisfied when every resolvable segment's name appears
 * somewhere in the file. It deliberately does NOT assert containment — these
 * regexes cannot tell whether `searchSemantic` is a member of `PostgresStore` —
 * so `class:PostgresStore/method:searchSemantic` resolving means "both names are
 * declared here", which is the strongest claim the evidence supports.
 */
export function resolveSelectorInSource(
  source: string,
  selector: string,
  options: { path?: string; vocabulary?: SelectorVocabulary } = {}
): SelectorResolution {
  const path = options.path ?? "";
  const vocabulary = options.vocabulary ?? CORE_SELECTOR_VOCABULARY;
  const validated = validateSelector(selector, vocabulary);
  if (!validated.ok) {
    return notChecked(
      typeof selector === "string" ? selector.trim() : String(selector),
      path,
      "invalid_selector",
      validated.error
    );
  }
  return resolveValidatedSelectorInIndex(
    indexSourceSymbols(source),
    validated.selector,
    path,
    vocabulary
  );
}

export interface CreateCachedSelectorResolverOptions {
  readSource?: (
    absolutePath: string,
    maxSourceBytes: number
  ) => SelectorSourceRead;
  indexSource?: (content: string) => SymbolIndex;
}

/**
 * Creates a request-local resolver that reads and indexes each normalized local
 * path at most once. The cache is intentionally not global: checkout contents
 * may change between requests.
 */
export function createCachedSelectorResolver(
  options: CreateCachedSelectorResolverOptions = {}
): (input: ResolveSelectorOptions) => SelectorResolution {
  const sourceReader = options.readSource ?? readSource;
  const sourceIndexer = options.indexSource ?? indexSourceSymbols;
  const sources = new Map<
    string,
    | { status: "indexed"; index: SymbolIndex }
    | { status: "skipped"; reason: SelectorNotCheckedReason }
  >();

  return (input) => {
    const vocabulary = input.vocabulary ?? CORE_SELECTOR_VOCABULARY;
    const maxSourceBytes =
      input.maxSourceBytes ?? DEFAULT_MAX_SELECTOR_SOURCE_BYTES;
    const path = input.path;
    const validated = validateSelector(input.selector, vocabulary);
    if (!validated.ok) {
      return notChecked(
        typeof input.selector === "string"
          ? input.selector.trim()
          : String(input.selector),
        path,
        "invalid_selector",
        validated.error
      );
    }
    const canonical = validated.selector.canonical;
    const anyResolvable = validated.selector.segments.some(
      (segment) => vocabulary.kinds.get(segment.kind)?.resolvable === true
    );
    if (!anyResolvable) {
      return notChecked(
        canonical,
        path,
        "kind_not_resolvable",
        `No part of '${canonical}' names a kind this repository marks resolvable, so no symbol check was attempted.`,
        validated.selector.segments
      );
    }
    if (!RESOLVABLE_SOURCE_EXTENSIONS.has(extname(path).toLowerCase())) {
      return notChecked(
        canonical,
        path,
        "unsupported_language",
        `'${path}' is not a language these declaration patterns understand, so '${canonical}' was not checked.`
      );
    }

    const absolutePath = resolve(input.repositoryRoot, path);
    const key = `${absolutePath}\0${maxSourceBytes}`;
    let source = sources.get(key);
    if (!source) {
      const read = sourceReader(absolutePath, maxSourceBytes);
      source =
        read.status === "read"
          ? { status: "indexed", index: sourceIndexer(read.content) }
          : read;
      sources.set(key, source);
    }
    if (source.status === "skipped") {
      return notChecked(
        canonical,
        path,
        source.reason,
        `'${path}' could not be examined (${source.reason}), so '${canonical}' was not checked.`
      );
    }
    return resolveValidatedSelectorInIndex(
      source.index,
      validated.selector,
      path,
      vocabulary
    );
  };
}

/**
 * Reads the linked file and resolves the selector against it.
 *
 * Pure with respect to contract state: it takes a root, a path and a selector,
 * touches nothing else, and returns a value. Callers aggregating results must
 * preserve `not_checked` — see the module header for why it must never be
 * reported as `unresolved`.
 */
export function resolveSelector(
  options: ResolveSelectorOptions
): SelectorResolution {
  const vocabulary = options.vocabulary ?? CORE_SELECTOR_VOCABULARY;
  const maxSourceBytes =
    options.maxSourceBytes ?? DEFAULT_MAX_SELECTOR_SOURCE_BYTES;
  const path = options.path;

  const validated = validateSelector(options.selector, vocabulary);
  if (!validated.ok) {
    return notChecked(
      typeof options.selector === "string"
        ? options.selector.trim()
        : String(options.selector),
      path,
      "invalid_selector",
      validated.error
    );
  }
  const canonical = validated.selector.canonical;

  const anyResolvable = validated.selector.segments.some(
    (segment) => vocabulary.kinds.get(segment.kind)?.resolvable === true
  );
  if (!anyResolvable) {
    return notChecked(
      canonical,
      path,
      "kind_not_resolvable",
      `No part of '${canonical}' names a kind this repository marks resolvable, so no symbol check was attempted.`,
      validated.selector.segments
    );
  }

  if (!RESOLVABLE_SOURCE_EXTENSIONS.has(extname(path).toLowerCase())) {
    return notChecked(
      canonical,
      path,
      "unsupported_language",
      `'${path}' is not a language these declaration patterns understand, so '${canonical}' was not checked.`
    );
  }

  const read = readSource(resolve(options.repositoryRoot, path), maxSourceBytes);
  if (read.status === "skipped") {
    return notChecked(
      canonical,
      path,
      read.reason,
      `'${path}' could not be examined (${read.reason}), so '${canonical}' was not checked.`
    );
  }

  return resolveSelectorInSource(read.content, canonical, { path, vocabulary });
}
