import type { SourceSnapshot } from "../source-snapshot.js";
import type { LanguageAnalysisResult, LanguageAnalyzer } from "./types.js";

export type CodeAnalysisNotCheckedReason = "unsupported_language" | "no_analyzer";

export type CodeSnapshotAnalysis =
  | { status: "analyzed"; result: LanguageAnalysisResult }
  | { status: "not_checked"; reason: CodeAnalysisNotCheckedReason; path: string };

/** Runtime-neutral dispatch keeps language adapters independently replaceable. */
export class CodeAnalyzerRegistry {
  private readonly analyzers: readonly LanguageAnalyzer[];
  private readonly byLanguage = new Map<string, LanguageAnalyzer>();

  constructor(analyzers: readonly LanguageAnalyzer[]) {
    this.analyzers = [...analyzers];
    for (const analyzer of analyzers) {
      for (const language of analyzer.languages) {
        if (this.byLanguage.has(language)) {
          throw new Error(`Multiple code analyzers registered for ${language}`);
        }
        this.byLanguage.set(language, analyzer);
      }
    }
  }

  async analyze(snapshot: SourceSnapshot): Promise<CodeSnapshotAnalysis> {
    if (snapshot.language === null) {
      return { status: "not_checked", reason: "unsupported_language", path: snapshot.path };
    }
    const analyzer = this.byLanguage.get(snapshot.language);
    if (!analyzer) {
      return { status: "not_checked", reason: "no_analyzer", path: snapshot.path };
    }
    return { status: "analyzed", result: await analyzer.analyze(snapshot) };
  }

  async dispose(): Promise<void> {
    await Promise.all(this.analyzers.map((analyzer) => analyzer.dispose()));
  }
}
