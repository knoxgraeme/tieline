import type { Node as SyntaxNode, QueryMatch } from "web-tree-sitter";
import { compareCodeTopologyText } from "../../domain/code-topology-ordering.js";
import type { SourceSnapshot } from "../source-snapshot.js";
import {
  parserCompatibilitySet,
  type SupportedCodeLanguage,
} from "./languages.js";
import {
  ancestorCandidates,
  candidateIdentity,
  candidateMap,
  createStructuralAnalyzer,
  nearestOwnerIdentity,
  nodeRange,
  structuralIdentity,
  type StructuralAdapter,
  type StructuralAnalyzerOptions,
  type StructuralCandidate,
} from "./structural-support.js";
import type {
  CodeAnalysisCompatibility,
  LanguageAnalyzer,
  ModuleBindingFact,
  ModuleLinkageKind,
  NormalizedSymbolKind,
  UnresolvedModuleLinkageFact,
} from "./types.js";

const queryCompatibility = "javascript-typescript-structure-v2";
export const javascriptAnalysisCompatibility: CodeAnalysisCompatibility = Object.freeze({
  parser: parserCompatibilitySet,
  query: queryCompatibility,
  identity: `${parserCompatibilitySet}:${queryCompatibility}`,
});

const javascriptLanguages = new Set<SupportedCodeLanguage>([
  "javascript",
  "jsx",
  "typescript",
  "tsx",
]);
const bareSelectorName = /^[\p{ID_Start}_$][\p{ID_Continue}\u200c\u200d$]*$/u;

export type JavaScriptAnalyzerOptions = StructuralAnalyzerOptions;

function unquoteName(node: SyntaxNode): string {
  if (node.type === "string") {
    const fragment = node.namedChildren.find((child) => child.type === "string_fragment");
    return fragment?.text ?? node.text.slice(1, -1);
  }
  return node.text;
}

function normalizedKind(node: SyntaxNode): NormalizedSymbolKind | null {
  switch (node.type) {
    case "class":
    case "class_declaration":
    case "abstract_class_declaration":
      return "class";
    case "function_declaration":
    case "generator_function_declaration":
    case "function_expression":
    case "generator_function":
    case "function_signature":
      return "function";
    case "method_definition":
    case "method_signature":
    case "abstract_method_signature":
      return "method";
    case "interface_declaration":
    case "type_alias_declaration":
    case "enum_declaration":
      return "type";
    case "internal_module":
      return "module";
    case "variable_declarator": {
      const declaration = node.parent;
      const declarationKeyword = declaration?.children.find((child) =>
        child.type === "const" || child.type === "let" || child.type === "var"
      )?.type;
      return declarationKeyword === "const" ? "const" : "variable";
    }
    default:
      return null;
  }
}

function javascriptSelectorSegment(
  kind: NormalizedSymbolKind,
  name: string | null
): string | null {
  if (name === null || !bareSelectorName.test(name)) return null;
  if (kind === "variable" || kind === "module") return null;
  return `${kind}:${name.normalize("NFC")}`;
}

function isStructuralVariable(node: SyntaxNode): boolean {
  if (node.type !== "variable_declarator") return true;
  let ancestor = node.parent?.parent ?? null;
  while (ancestor) {
    if (ancestor.type === "program" || ancestor.type === "internal_module") return true;
    if (
      ancestor.type === "function_declaration" ||
      ancestor.type === "function_expression" ||
      ancestor.type === "generator_function_declaration" ||
      ancestor.type === "generator_function" ||
      ancestor.type === "arrow_function" ||
      ancestor.type === "method_definition"
    ) {
      return false;
    }
    ancestor = ancestor.parent;
  }
  return true;
}

function candidateFromMatch(match: QueryMatch): StructuralCandidate | null {
  const declaration = match.captures.find((capture) => capture.name === "symbol.declaration")?.node;
  if (!declaration || !isStructuralVariable(declaration)) return null;
  const kind = normalizedKind(declaration);
  if (!kind) return null;
  const nameNode = match.captures.find((capture) => capture.name === "symbol.name")?.node ?? null;
  const name = nameNode ? unquoteName(nameNode).normalize("NFC") : null;
  return {
    node: declaration,
    nameNode,
    nativeKind: declaration.type,
    kind,
    name,
    selectorSegment: javascriptSelectorSegment(kind, name),
    requiredNodes: nameNode ? [nameNode] : [],
    emit: true,
  };
}

function declarations(matches: readonly QueryMatch[]): StructuralCandidate[] {
  return matches
    .map(candidateFromMatch)
    .filter((candidate): candidate is StructuralCandidate => candidate !== null);
}

function statementTypeOnly(node: SyntaxNode): boolean {
  const prefix = node.text.slice(0, Math.min(node.text.length, 32));
  return /^(?:import|export)\s+type(?:\s|\{|\*)/.test(prefix);
}

function bindingText(node: SyntaxNode | null): string | null {
  if (!node) return null;
  return unquoteName(node).normalize("NFC");
}

function extractBindings(statement: SyntaxNode, typeOnly: boolean): ModuleBindingFact[] {
  const bindings: ModuleBindingFact[] = [];
  const visit = (node: SyntaxNode): void => {
    if (node.type === "import_specifier") {
      bindings.push(Object.freeze({
        imported: bindingText(node.childForFieldName("name")),
        local: bindingText(node.childForFieldName("alias") ?? node.childForFieldName("name")),
        exported: null,
        isTypeOnly: typeOnly || /^type\s/.test(node.text),
      }));
      return;
    }
    if (node.type === "export_specifier") {
      bindings.push(Object.freeze({
        imported: bindingText(node.childForFieldName("name")),
        local: null,
        exported: bindingText(node.childForFieldName("alias") ?? node.childForFieldName("name")),
        isTypeOnly: typeOnly || /^type\s/.test(node.text),
      }));
      return;
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(statement);
  return bindings;
}

function referenceOwnerIdentity(
  snapshot: SourceSnapshot,
  statement: SyntaxNode,
  symbolsByNodeId: ReadonlyMap<number, StructuralCandidate>,
  kind: ModuleLinkageKind
): string | null {
  if (kind === "export") {
    const exported = statement.childForFieldName("declaration") ?? statement.childForFieldName("value");
    if (exported) {
      const candidate = symbolsByNodeId.get(exported.id);
      if (candidate) {
        return candidateIdentity(
          snapshot,
          candidate,
          ancestorCandidates(candidate, symbolsByNodeId)
        );
      }
    }
  }
  return nearestOwnerIdentity(snapshot, statement, symbolsByNodeId);
}

function linkageKind(match: QueryMatch): ModuleLinkageKind | null {
  if (match.captures.some((capture) => capture.name === "reference.import")) return "import";
  if (match.captures.some((capture) => capture.name === "reference.dynamic_import")) {
    return "dynamic_import";
  }
  if (match.captures.some((capture) => capture.name === "reference.reexport")) return "reexport";
  if (match.captures.some((capture) => capture.name === "reference.export")) return "export";
  return null;
}

function buildReferences(
  snapshot: SourceSnapshot,
  matches: readonly QueryMatch[],
  candidates: readonly StructuralCandidate[]
): UnresolvedModuleLinkageFact[] {
  const symbolsByNodeId = candidateMap(candidates);
  const references = new Map<string, UnresolvedModuleLinkageFact>();
  for (const match of matches) {
    const kind = linkageKind(match);
    if (!kind) continue;
    const statementCapture = match.captures.find((capture) => capture.name === `reference.${kind}`);
    const statement = statementCapture?.node;
    if (!statement) continue;
    const sourceNode = match.captures.find((capture) => capture.name === "reference.source")?.node ?? null;
    if (kind === "export" && statement.childForFieldName("source")) continue;
    const typeOnly = kind === "dynamic_import" ? false : statementTypeOnly(statement);
    const moduleSpecifier = sourceNode?.text ?? null;
    const key = `${kind}:${statement.startIndex}:${statement.endIndex}`;
    const existing = references.get(key);
    if (existing && (existing.moduleSpecifier !== null || moduleSpecifier === null)) continue;
    references.set(key, Object.freeze({
      identity: structuralIdentity("reference", snapshot.sha256, key),
      kind,
      nativeKind: statement.type,
      moduleSpecifier,
      moduleSpecifierRange: sourceNode ? nodeRange(snapshot, sourceNode) : null,
      statementRange: nodeRange(snapshot, statement),
      ownerIdentity: referenceOwnerIdentity(snapshot, statement, symbolsByNodeId, kind),
      isTypeOnly: typeOnly,
      bindings: Object.freeze(extractBindings(statement, typeOnly)),
      resolution: "unresolved",
    }));
  }
  return [...references.values()].sort(
    (left, right) =>
      left.statementRange.utf16.start - right.statementRange.utf16.start ||
      compareCodeTopologyText(left.kind, right.kind) ||
      compareCodeTopologyText(left.moduleSpecifier ?? "", right.moduleSpecifier ?? "")
  );
}

function queryFile(language: SupportedCodeLanguage): string {
  return language === "javascript" || language === "jsx"
    ? "queries/javascript-structure-v2.scm"
    : "queries/typescript-structure-v2.scm";
}


const javascriptAdapter: StructuralAdapter = {
  label: "JavaScript",
  languages: javascriptLanguages,
  compatibility: javascriptAnalysisCompatibility,
  queryFile,
  candidates: declarations,
  references: buildReferences,
};

export function createJavaScriptAnalyzer(
  options: JavaScriptAnalyzerOptions = {}
): LanguageAnalyzer {
  return createStructuralAnalyzer(javascriptAdapter, options);
}
