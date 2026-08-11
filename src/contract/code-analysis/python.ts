import type { Node as SyntaxNode, QueryMatch } from "web-tree-sitter";
import type { SourceSnapshot } from "../source-snapshot.js";
import { parserCompatibilitySet, type SupportedCodeLanguage } from "./languages.js";
import {
  ancestorCandidates,
  candidateIdentity,
  candidateMap,
  candidateOrder,
  createStructuralAnalyzer,
  nearestOwnerIdentity,
  nodeRange,
  selectorSegment,
  structuralIdentity,
  type StructuralAdapter,
  type StructuralAnalyzerOptions,
  type StructuralCandidate,
} from "./structural-support.js";
import type {
  CodeAnalysisCompatibility,
  LanguageAnalyzer,
  ModuleBindingFact,
  UnresolvedModuleLinkageFact,
} from "./types.js";

const queryCompatibility = "python-structure-v1";
export const pythonAnalysisCompatibility: CodeAnalysisCompatibility = Object.freeze({
  parser: parserCompatibilitySet,
  query: queryCompatibility,
  identity: `${parserCompatibilitySet}:${queryCompatibility}`,
});

const pythonLanguages = new Set<SupportedCodeLanguage>(["python"]);

export type PythonAnalyzerOptions = StructuralAnalyzerOptions;

function normalizedName(node: SyntaxNode): string {
  return node.text.normalize("NFC");
}

function declarations(matches: readonly QueryMatch[]): StructuralCandidate[] {
  const raw: StructuralCandidate[] = [];
  for (const match of matches) {
    const declaration = match.captures.find(
      (capture) => capture.name === "symbol.declaration"
    )?.node;
    const nameNode = match.captures.find((capture) => capture.name === "symbol.name")?.node;
    if (!declaration || !nameNode) continue;
    const kind = declaration.type === "class_definition" ? "class" : "function";
    const name = normalizedName(nameNode);
    raw.push({
      node: declaration,
      nameNode,
      requiredNodes: [nameNode],
      nativeKind: declaration.type,
      kind,
      name,
      selectorSegment: selectorSegment(kind, name),
      emit: true,
    });
  }

  const ordered = raw.sort(candidateOrder);
  const byNodeId = candidateMap(ordered);
  return ordered.map((candidate) => {
    if (candidate.kind !== "function") return candidate;
    const owners = ancestorCandidates(candidate, byNodeId);
    const nearest = owners.at(-1);
    if (nearest?.kind !== "class") return candidate;
    return {
      ...candidate,
      kind: "method",
      selectorSegment: selectorSegment("method", candidate.name),
    };
  });
}

function importTargets(statement: SyntaxNode): SyntaxNode[] {
  return statement.namedChildren.filter(
    (child) => child.type === "dotted_name" || child.type === "aliased_import"
  );
}

function importTarget(target: SyntaxNode): {
  sourceNode: SyntaxNode;
  moduleSpecifier: string;
  local: string;
} | null {
  const sourceNode = target.type === "aliased_import"
    ? target.childForFieldName("name")
    : target;
  if (!sourceNode) return null;
  const moduleSpecifier = sourceNode.text.normalize("NFC");
  const alias = target.type === "aliased_import" ? target.childForFieldName("alias") : null;
  return {
    sourceNode,
    moduleSpecifier,
    local: (alias?.text ?? moduleSpecifier.split(".")[0] ?? moduleSpecifier).normalize("NFC"),
  };
}

function fromModule(statement: SyntaxNode): SyntaxNode | null {
  return statement.childForFieldName("module_name") ??
    statement.namedChildren.find(
      (child) => child.type === "relative_import" || child.type === "dotted_name"
    ) ??
    null;
}

function fromBindings(statement: SyntaxNode, moduleNode: SyntaxNode | null): ModuleBindingFact[] {
  const bindings: ModuleBindingFact[] = [];
  const visit = (child: SyntaxNode): void => {
    if (child.id === moduleNode?.id) return;
    if (child.type === "wildcard_import") {
      bindings.push(Object.freeze({ imported: "*", local: "*", exported: null, isTypeOnly: false }));
      return;
    }
    if (child.type === "aliased_import") {
      const nameNode = child.childForFieldName("name");
      const aliasNode = child.childForFieldName("alias");
      if (!nameNode || !aliasNode || nameNode.hasError || aliasNode.hasError) return;
      const name = nameNode.text.normalize("NFC");
      const alias = aliasNode.text.normalize("NFC");
      bindings.push(Object.freeze({ imported: name, local: alias, exported: null, isTypeOnly: false }));
      return;
    }
    if (child.type === "dotted_name" || child.type === "identifier") {
      if (child.hasError) return;
      const name = child.text.normalize("NFC");
      bindings.push(Object.freeze({ imported: name, local: name, exported: null, isTypeOnly: false }));
      return;
    }
    for (const nested of child.namedChildren) visit(nested);
  };
  for (const child of statement.namedChildren) visit(child);
  return bindings;
}

function moduleSourceText(node: SyntaxNode): string {
  return node.text.replace(/\s+/g, "").normalize("NFC");
}

function referenceOrder(
  left: UnresolvedModuleLinkageFact,
  right: UnresolvedModuleLinkageFact
): number {
  return (
    left.statementRange.utf16.start - right.statementRange.utf16.start ||
    (left.moduleSpecifierRange?.utf16.start ?? left.statementRange.utf16.start) -
      (right.moduleSpecifierRange?.utf16.start ?? right.statementRange.utf16.start) ||
    left.kind.localeCompare(right.kind) ||
    (left.moduleSpecifier ?? "").localeCompare(right.moduleSpecifier ?? "")
  );
}

function references(
  snapshot: SourceSnapshot,
  matches: readonly QueryMatch[],
  candidates: readonly StructuralCandidate[]
): UnresolvedModuleLinkageFact[] {
  const byNodeId = candidateMap(candidates);
  const facts: UnresolvedModuleLinkageFact[] = [];
  const seen = new Set<number>();
  for (const match of matches) {
    const statement = match.captures.find(
      (capture) =>
        capture.name === "reference.import" || capture.name === "reference.import_from"
    )?.node;
    if (!statement || seen.has(statement.id)) continue;
    seen.add(statement.id);
    const ownerIdentity = nearestOwnerIdentity(snapshot, statement, byNodeId);
    if (statement.type === "import_statement") {
      for (const target of importTargets(statement)) {
        const imported = importTarget(target);
        if (!imported || imported.sourceNode.hasError) continue;
        const key = `import:${statement.startIndex}:${statement.endIndex}:${imported.sourceNode.startIndex}:${imported.moduleSpecifier}`;
        facts.push(Object.freeze({
          identity: structuralIdentity("reference", snapshot.sha256, key),
          kind: "import",
          nativeKind: statement.type,
          moduleSpecifier: imported.moduleSpecifier,
          moduleSpecifierRange: nodeRange(snapshot, imported.sourceNode),
          statementRange: nodeRange(snapshot, statement),
          ownerIdentity,
          isTypeOnly: false,
          bindings: Object.freeze([
            Object.freeze({
              imported: null,
              local: imported.local,
              exported: null,
              isTypeOnly: false,
            }),
          ]),
          resolution: "unresolved",
        }));
      }
      continue;
    }

    const isFutureImport = statement.type === "future_import_statement";
    const moduleNode = isFutureImport ? null : fromModule(statement);
    if (!isFutureImport && (!moduleNode || moduleNode.hasError)) continue;
    const moduleSpecifier = isFutureImport ? "__future__" : moduleSourceText(moduleNode!);
    const futureModuleOffset = isFutureImport ? statement.text.indexOf("__future__") : -1;
    if (isFutureImport && futureModuleOffset < 0) continue;
    const moduleSpecifierRange = isFutureImport
      ? snapshot.coordinates.rangeFromUtf16(
          statement.startIndex + futureModuleOffset,
          statement.startIndex + futureModuleOffset + "__future__".length
        )
      : nodeRange(snapshot, moduleNode!);
    const key = `import:${statement.startIndex}:${statement.endIndex}:${moduleSpecifier}`;
    facts.push(Object.freeze({
      identity: structuralIdentity("reference", snapshot.sha256, key),
      kind: "import",
      nativeKind: statement.type,
      moduleSpecifier,
      moduleSpecifierRange,
      statementRange: nodeRange(snapshot, statement),
      ownerIdentity,
      isTypeOnly: false,
      bindings: Object.freeze(fromBindings(statement, moduleNode)),
      resolution: "unresolved",
    }));
  }

  for (const candidate of candidates) {
    if (!candidate.emit || candidate.name === null || candidate.name.startsWith("_")) continue;
    const owners = ancestorCandidates(candidate, byNodeId);
    if (owners.length > 0) continue;
    const key = `export:${candidate.node.startIndex}:${candidate.node.endIndex}:${candidate.name}`;
    facts.push(Object.freeze({
      identity: structuralIdentity("reference", snapshot.sha256, key),
      kind: "export",
      nativeKind: candidate.nativeKind,
      moduleSpecifier: null,
      moduleSpecifierRange: null,
      statementRange: nodeRange(snapshot, candidate.node),
      ownerIdentity: candidateIdentity(snapshot, candidate, owners),
      isTypeOnly: false,
      bindings: Object.freeze([
        Object.freeze({
          imported: null,
          local: null,
          exported: candidate.name,
          isTypeOnly: false,
        }),
      ]),
      resolution: "unresolved",
    }));
  }
  return facts.sort(referenceOrder);
}

const pythonAdapter: StructuralAdapter = {
  label: "Python",
  languages: pythonLanguages,
  compatibility: pythonAnalysisCompatibility,
  queryFile: () => "queries/python-structure-v1.scm",
  candidates: declarations,
  references,
};

export function createPythonAnalyzer(options: PythonAnalyzerOptions = {}): LanguageAnalyzer {
  return createStructuralAnalyzer(pythonAdapter, options);
}
