import type {
  CodeSymbolFact,
  LanguageAnalysisResult,
  UnresolvedModuleLinkageFact,
} from "../code-analysis/types.js";
import type { SupportedCodeLanguage } from "../code-analysis/languages.js";

export type CodeResolutionStatus = "resolved" | "ambiguous" | "unresolved" | "external";

export interface CodeResolutionSource {
  path: string;
  language: SupportedCodeLanguage;
  symbolIdentity: string | null;
  selector: string | null;
}

export interface CodeResolutionTarget {
  path: string;
  language: SupportedCodeLanguage;
  /** Null means the conservative relationship stops at the target module. */
  symbolIdentity: string | null;
  selector: string | null;
}

export interface CodeResolutionVia {
  path: string;
  rule: string;
}

export interface CodeResolutionDiagnostic {
  code: string;
  detail: string;
}

/**
 * Explainable result of resolving one parser-emitted fact. The original fact is
 * retained verbatim so resolution never upgrades derived topology into authored
 * evidence or hides an unresolved frontier.
 */
export interface CodeResolutionOutcome {
  identity: string;
  source: CodeResolutionSource;
  reference: UnresolvedModuleLinkageFact;
  status: CodeResolutionStatus;
  /** All proven targets. Multiple targets can represent a multi-binding import. */
  targets: readonly CodeResolutionTarget[];
  /** Possible targets retained only when uniqueness cannot be established. */
  candidates: readonly CodeResolutionTarget[];
  via: readonly CodeResolutionVia[];
  rule: string;
  configurationDigest: string;
  reason: string | null;
  diagnostics: readonly CodeResolutionDiagnostic[];
}

export interface CodeModuleResolver {
  readonly languages: ReadonlySet<SupportedCodeLanguage>;
  readonly compatibility: string;
  readonly configurationDigest: string;
  resolveFile(path: string): readonly CodeResolutionOutcome[];
}

export function moduleTarget(
  analysis: LanguageAnalysisResult,
  symbol: CodeSymbolFact | null = null
): CodeResolutionTarget {
  return Object.freeze({
    path: analysis.path,
    language: analysis.language,
    symbolIdentity: symbol?.identity ?? null,
    selector: symbol?.selector ?? null,
  });
}
