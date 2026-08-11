import type { SupportedCodeLanguage } from "./languages.js";
import type { SourceRange, SourceSnapshot } from "../source-snapshot.js";

export type NormalizedSymbolKind =
  | "class"
  | "const"
  | "function"
  | "method"
  | "module"
  | "type"
  | "variable";

export interface CodeAnalysisCompatibility {
  /** Checked-in runtime and grammar set. */
  parser: string;
  /** Adapter/query output contract version. */
  query: string;
  /** Stable cache and persistence discriminator. */
  identity: string;
}

export type SymbolSyntaxStatus = "exact" | "recovered";

export interface CodeSymbolOwner {
  identity: string;
  name: string | null;
  nativeKind: string;
  kind: NormalizedSymbolKind;
  selector: string | null;
  nameRange: SourceRange | null;
  bodyRange: SourceRange;
}

export interface CodeSymbolFact {
  /** Snapshot-local structural identity; not a user-authored locator. */
  identity: string;
  name: string | null;
  nativeKind: string;
  kind: NormalizedSymbolKind;
  /** Canonical Tieline locator when the source name can be represented honestly. */
  selector: string | null;
  ownerChain: readonly CodeSymbolOwner[];
  nameRange: SourceRange | null;
  bodyRange: SourceRange;
  syntaxStatus: SymbolSyntaxStatus;
}

export type ModuleLinkageKind = "import" | "dynamic_import" | "export" | "reexport";

export interface ModuleBindingFact {
  imported: string | null;
  local: string | null;
  exported: string | null;
  isTypeOnly: boolean;
}

export interface UnresolvedModuleLinkageFact {
  identity: string;
  kind: ModuleLinkageKind;
  nativeKind: string;
  /** Null for local exports and dynamic references without a static module name. */
  moduleSpecifier: string | null;
  moduleSpecifierRange: SourceRange | null;
  statementRange: SourceRange;
  ownerIdentity: string | null;
  isTypeOnly: boolean;
  bindings: readonly ModuleBindingFact[];
  /** Resolution is intentionally deferred to the topology phase. */
  resolution: "unresolved";
}

export type ParserDiagnosticKind = "error" | "missing";

export interface ParserDiagnostic {
  identity: string;
  kind: ParserDiagnosticKind;
  nativeKind: string;
  range: SourceRange;
  message: string;
}

export interface AnalysisTruncation {
  symbols: boolean;
  references: boolean;
  diagnostics: boolean;
}

export interface LanguageAnalysisResult {
  compatibility: CodeAnalysisCompatibility;
  path: string;
  language: SupportedCodeLanguage;
  sourceHash: string;
  symbols: readonly CodeSymbolFact[];
  references: readonly UnresolvedModuleLinkageFact[];
  diagnostics: readonly ParserDiagnostic[];
  truncated: AnalysisTruncation;
}

export interface LanguageAnalyzer {
  readonly languages: ReadonlySet<SupportedCodeLanguage>;
  analyze(snapshot: SourceSnapshot): Promise<LanguageAnalysisResult>;
  /** Releases compatibility-versioned compiled query objects. */
  dispose(): Promise<void>;
}
