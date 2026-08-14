import { createJavaScriptAnalyzer } from "./javascript.js";
import { createPythonAnalyzer } from "./python.js";
import { createRustAnalyzer } from "./rust.js";
import { createCodeParserRuntime } from "./runtime.js";
import { CodeAnalyzerRegistry } from "./analyzer.js";
import type {
  CodeSymbolFact,
  LanguageAnalysisResult,
  ParserDiagnostic,
} from "./types.js";
import type { SourceSnapshot } from "../source-snapshot.js";
import {
  CORE_SELECTOR_VOCABULARY,
  CORE_SELECTOR_KINDS,
  type ParsedSelector,
  type SelectorNotCheckedReason,
  type SelectorResolution,
  type SelectorVocabulary,
  validateSelector,
} from "../selector.js";

export interface StructuralSelectorResolver {
  resolve(input: {
    snapshot: SourceSnapshot;
    selector: string;
    vocabulary?: SelectorVocabulary;
  }): Promise<SelectorResolution>;
  dispose(): Promise<void>;
}

function notChecked(
  snapshot: SourceSnapshot,
  selector: string,
  reason: SelectorNotCheckedReason,
  detail: string,
  analysis: LanguageAnalysisResult | null = null
): SelectorResolution {
  return {
    selector,
    path: snapshot.path,
    status: "not_checked",
    reason,
    matched: [],
    missing: [],
    skipped: [],
    matching_symbols: [],
    language: analysis?.language ?? snapshot.language,
    compatibility: analysis?.compatibility ?? null,
    diagnostics: analysis?.diagnostics ?? [],
    detail,
  };
}

function structuralResolution(
  snapshot: SourceSnapshot,
  selector: ParsedSelector,
  analysis: LanguageAnalysisResult
): SelectorResolution {
  const matches = analysis.symbols
    .filter((symbol) => symbolMatchesSelector(symbol, selector))
    .sort(
      (left, right) =>
        left.bodyRange.utf16.start - right.bodyRange.utf16.start ||
        left.bodyRange.utf16.end - right.bodyRange.utf16.end ||
        left.identity.localeCompare(right.identity)
    );
  if (matches.length === 1) {
    return resolved(snapshot, selector, analysis, matches, "resolved");
  }
  if (matches.length > 1) {
    return resolved(snapshot, selector, analysis, matches, "ambiguous");
  }
  if (analysis.truncated.symbols || analysis.truncated.diagnostics) {
    return notChecked(
      snapshot,
      selector.canonical,
      "parse_incomplete",
      `Structural analysis of '${snapshot.path}' was truncated, so absence of '${selector.canonical}' is inconclusive.`,
      analysis
    );
  }
  if (analysis.diagnostics.length > 0) {
    return notChecked(
      snapshot,
      selector.canonical,
      "parse_incomplete",
      `Localized parser recovery in '${snapshot.path}' makes absence of '${selector.canonical}' inconclusive.`,
      analysis
    );
  }
  return {
    selector: selector.canonical,
    path: snapshot.path,
    status: "unresolved",
    reason: null,
    matched: [],
    missing: [...selector.segments],
    skipped: [],
    matching_symbols: [],
    language: analysis.language,
    compatibility: analysis.compatibility,
    diagnostics: analysis.diagnostics,
    detail: `Parsed '${snapshot.path}' but found no declaration with the complete owner-aware selector '${selector.canonical}'.`,
  };
}

function symbolMatchesSelector(
  symbol: CodeSymbolFact,
  selector: ParsedSelector
): boolean {
  if (symbol.selector === selector.canonical) return true;
  const requested = selector.segments.at(-1);
  if (!requested || symbol.name !== requested.name || symbol.kind !== "const") return false;
  const compatibleKind =
    requested.kind === "function" ||
    (requested.kind === "method" && symbol.ownerChain.length > 0);
  if (!compatibleKind) return false;
  const requestedOwners = selector.segments.slice(0, -1)
    .map((segment) => `${segment.kind}:${segment.name}`)
    .join("/");
  const actualOwners = symbol.ownerChain.at(-1)?.selector ?? "";
  return requestedOwners === actualOwners;
}

function resolved(
  snapshot: SourceSnapshot,
  selector: ParsedSelector,
  analysis: LanguageAnalysisResult,
  matches: readonly CodeSymbolFact[],
  status: "resolved" | "ambiguous"
): SelectorResolution {
  return {
    selector: selector.canonical,
    path: snapshot.path,
    status,
    reason: null,
    matched: [...selector.segments],
    missing: [],
    skipped: [],
    matching_symbols: matches,
    language: analysis.language,
    compatibility: analysis.compatibility,
    diagnostics: analysis.diagnostics,
    detail:
      status === "resolved"
        ? `Found the unique structural declaration '${selector.canonical}' in '${snapshot.path}'.`
        : `Found ${matches.length} structural declarations for '${selector.canonical}' in '${snapshot.path}'; qualify or remove the ambiguous locator.`,
  };
}

/** Request-scoped parser-backed selector lookup shared by all assurance reads. */
export function createStructuralSelectorResolver(): StructuralSelectorResolver {
  const runtime = createCodeParserRuntime();
  const registry = new CodeAnalyzerRegistry([
    createJavaScriptAnalyzer({ runtime }),
    createPythonAnalyzer({ runtime }),
    createRustAnalyzer({ runtime }),
  ]);
  const analyses = new Map<string, Promise<LanguageAnalysisResult | null>>();
  let disposed = false;

  const analyze = (snapshot: SourceSnapshot): Promise<LanguageAnalysisResult | null> => {
    const key = `${snapshot.path}\0${snapshot.sha256}`;
    let pending = analyses.get(key);
    if (!pending) {
      pending = registry.analyze(snapshot).then((value) =>
        value.status === "analyzed" ? value.result : null
      );
      analyses.set(key, pending);
    }
    return pending;
  };

  return {
    async resolve(input) {
      if (disposed) throw new Error("Structural selector resolver has been disposed");
      const vocabulary = input.vocabulary ?? CORE_SELECTOR_VOCABULARY;
      const validated = validateSelector(input.selector, vocabulary);
      if (!validated.ok) {
        return notChecked(
          input.snapshot,
          input.selector.trim(),
          "invalid_selector",
          validated.error
        );
      }
      const structuralKinds: ReadonlySet<string> = new Set(CORE_SELECTOR_KINDS);
      if (
        validated.selector.segments.some(
          (segment) =>
            !vocabulary.kinds.get(segment.kind)?.resolvable ||
            !structuralKinds.has(segment.kind)
        )
      ) {
        return notChecked(
          input.snapshot,
          validated.selector.canonical,
          "kind_not_resolvable",
          `At least one part of '${validated.selector.canonical}' is not structurally resolvable.`
        );
      }
      if (input.snapshot.language === null) {
        return notChecked(
          input.snapshot,
          validated.selector.canonical,
          "unsupported_language",
          `'${input.snapshot.path}' is not a supported parser language.`
        );
      }
      const analysis = await analyze(input.snapshot);
      if (!analysis) {
        return notChecked(
          input.snapshot,
          validated.selector.canonical,
          "unsupported_language",
          `'${input.snapshot.path}' has no registered structural analyzer.`
        );
      }
      return structuralResolution(input.snapshot, validated.selector, analysis);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      analyses.clear();
      await registry.dispose();
    },
  };
}

export function localizedDiagnostics(
  diagnostics: readonly ParserDiagnostic[],
  symbol: CodeSymbolFact
): readonly ParserDiagnostic[] {
  return diagnostics.filter(
    (diagnostic) =>
      diagnostic.range.utf16.end >= symbol.bodyRange.utf16.start &&
      diagnostic.range.utf16.start <= symbol.bodyRange.utf16.end
  );
}
