import type { Node as SyntaxNode, QueryMatch } from "web-tree-sitter";
import { parserCompatibilitySet, type SupportedCodeLanguage } from "./languages.js";
import {
  createStructuralAnalyzer,
  selectorSegment,
  type StructuralAdapter,
  type StructuralAnalyzerOptions,
  type StructuralCandidate,
} from "./structural-support.js";
import type {
  CodeAnalysisCompatibility,
  LanguageAnalyzer,
  NormalizedSymbolKind,
} from "./types.js";

const queryCompatibility = "sql-structure-v1";
export const sqlAnalysisCompatibility: CodeAnalysisCompatibility = Object.freeze({
  parser: parserCompatibilitySet,
  query: queryCompatibility,
  identity: `${parserCompatibilitySet}:${queryCompatibility}`,
});

const sqlLanguages = new Set<SupportedCodeLanguage>(["sql"]);

export type SqlAnalyzerOptions = StructuralAnalyzerOptions;

function capture(match: QueryMatch, name: string): SyntaxNode | null {
  return match.captures.find((candidate) => candidate.name === name)?.node ?? null;
}

function objectReference(nameNode: SyntaxNode): SyntaxNode | null {
  const parent = nameNode.parent;
  return parent?.type === "object_reference" ? parent : null;
}

function unqualified(reference: SyntaxNode): boolean {
  return (
    reference.childForFieldName("database") === null &&
    reference.childForFieldName("schema") === null
  );
}

function functionIsSimple(declaration: SyntaxNode): boolean {
  const argumentsNode = declaration.namedChildren.find(
    (child) => child.type === "function_arguments"
  );
  return argumentsNode !== undefined && argumentsNode.namedChildren.length === 0;
}

function declarationKind(declaration: SyntaxNode): NormalizedSymbolKind | null {
  switch (declaration.type) {
    case "create_table":
    case "create_view":
      return "type";
    case "create_function":
      return "function";
    default:
      return null;
  }
}

function declarations(matches: readonly QueryMatch[]): StructuralCandidate[] {
  const candidates: StructuralCandidate[] = [];
  for (const match of matches) {
    const declaration = capture(match, "symbol.declaration");
    const nameNode = capture(match, "symbol.name");
    if (!declaration || !nameNode) continue;
    const reference = objectReference(nameNode);
    const kind = declarationKind(declaration);
    if (!reference || !kind) continue;

    const name = nameNode.text.normalize("NFC");
    const safelySelectable =
      unqualified(reference) &&
      !declaration.hasError &&
      (kind !== "function" || functionIsSimple(declaration));
    candidates.push({
      node: declaration,
      nameNode,
      requiredNodes: [reference, nameNode],
      nativeKind: declaration.type,
      kind,
      name,
      selectorSegment: safelySelectable ? selectorSegment(kind, name) : null,
      emit: true,
    });
  }
  return candidates;
}

const sqlAdapter: StructuralAdapter = {
  label: "SQL",
  languages: sqlLanguages,
  compatibility: sqlAnalysisCompatibility,
  queryFile: () => "queries/sql-structure-v1.scm",
  candidates: declarations,
  references: () => [],
};

export function createSqlAnalyzer(options: SqlAnalyzerOptions = {}): LanguageAnalyzer {
  return createStructuralAnalyzer(sqlAdapter, options);
}
