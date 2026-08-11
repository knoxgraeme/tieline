import type { Node as SyntaxNode, QueryMatch } from "web-tree-sitter";
import type { SourceSnapshot } from "../source-snapshot.js";
import { parserCompatibilitySet, type SupportedCodeLanguage } from "./languages.js";
import {
  ancestorCandidates,
  candidateIdentity,
  candidateMap,
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
  NormalizedSymbolKind,
  UnresolvedModuleLinkageFact,
} from "./types.js";

const queryCompatibility = "rust-structure-v1";
export const rustAnalysisCompatibility: CodeAnalysisCompatibility = Object.freeze({
  parser: parserCompatibilitySet,
  query: queryCompatibility,
  identity: `${parserCompatibilitySet}:${queryCompatibility}`,
});

const rustLanguages = new Set<SupportedCodeLanguage>(["rust"]);
const bareRustName = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export type RustAnalyzerOptions = StructuralAnalyzerOptions;

function sourceName(node: SyntaxNode): string {
  return node.text.normalize("NFC");
}

function canonicalName(node: SyntaxNode): string {
  const source = sourceName(node);
  return source.startsWith("r#") ? source.slice(2) : source;
}

function declarationKind(node: SyntaxNode): NormalizedSymbolKind | null {
  switch (node.type) {
    case "struct_item":
    case "enum_item":
    case "trait_item":
    case "type_item":
    case "associated_type":
      return "type";
    case "mod_item":
      return "module";
    case "function_item":
    case "function_signature_item":
      return "function";
    case "const_item":
      return "const";
    case "static_item":
      return "variable";
    default:
      return null;
  }
}

function implOwner(node: SyntaxNode): StructuralCandidate | null {
  const typeNode = node.childForFieldName("type");
  if (!typeNode) return null;
  const traitNode = node.childForFieldName("trait");
  const typeName = typeNode.text.replace(/\s+/g, "").normalize("NFC");
  const traitName = traitNode?.text.replace(/\s+/g, "").normalize("NFC") ?? null;
  const name = traitName ? `${traitName} for ${typeName}` : typeName;
  const selectorName = !traitName && bareRustName.test(typeName) ? typeName : null;
  return {
    node,
    nameNode: null,
    requiredNodes: traitNode ? [traitNode, typeNode] : [typeNode],
    nativeKind: node.type,
    kind: "type",
    name,
    selectorSegment: selectorName ? selectorSegment("type", selectorName) : null,
    emit: false,
  };
}

function declarations(matches: readonly QueryMatch[]): StructuralCandidate[] {
  const raw: StructuralCandidate[] = [];
  for (const match of matches) {
    const impl = match.captures.find((capture) => capture.name === "symbol.impl_owner")?.node;
    if (impl) {
      const owner = implOwner(impl);
      if (owner) raw.push(owner);
      continue;
    }
    const declaration = match.captures.find(
      (capture) => capture.name === "symbol.declaration"
    )?.node;
    const nameNode = match.captures.find((capture) => capture.name === "symbol.name")?.node;
    if (!declaration || !nameNode) continue;
    const kind = declarationKind(declaration);
    if (!kind) continue;
    const name = canonicalName(nameNode);
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

  const byNodeId = candidateMap(raw);
  return raw.map((candidate) => {
    if (candidate.kind !== "function") return candidate;
    const owners = ancestorCandidates(candidate, byNodeId);
    const nearest = owners.at(-1);
    if (nearest?.nativeKind !== "impl_item" && nearest?.nativeKind !== "trait_item") {
      return candidate;
    }
    return {
      ...candidate,
      kind: "method",
      selectorSegment: selectorSegment("method", candidate.name),
    };
  });
}

function compactPath(node: SyntaxNode): string {
  return node.text.replace(/\s+/g, "").normalize("NFC");
}

function lastPathSegment(path: string): string {
  return path.split("::").at(-1) ?? path;
}

function frozenBinding(
  imported: string | null,
  local: string | null,
  exported: string | null
): ModuleBindingFact {
  return Object.freeze({ imported, local, exported, isTypeOnly: false });
}

function groupedBindings(
  list: SyntaxNode,
  moduleSpecifier: string,
  reexport: boolean,
  importedPrefix = ""
): ModuleBindingFact[] {
  const bindings: ModuleBindingFact[] = [];
  const moduleLocal = lastPathSegment(moduleSpecifier);
  for (const child of list.namedChildren) {
    if (child.type === "self") {
      bindings.push(frozenBinding(`${importedPrefix}self`, moduleLocal, reexport ? moduleLocal : null));
      continue;
    }
    if (child.type === "use_wildcard") {
      const imported = `${importedPrefix}*`;
      bindings.push(frozenBinding(imported, "*", reexport ? "*" : null));
      continue;
    }
    if (child.type === "use_as_clause") {
      const path = child.childForFieldName("path");
      const alias = child.childForFieldName("alias");
      if (!path || !alias || path.hasError || alias.hasError) continue;
      const imported = `${importedPrefix}${compactPath(path)}`;
      const local = canonicalName(alias);
      bindings.push(frozenBinding(imported, local, reexport ? local : null));
      continue;
    }
    if (child.type === "identifier" || child.type === "type_identifier") {
      const name = canonicalName(child);
      bindings.push(frozenBinding(`${importedPrefix}${name}`, name, reexport ? name : null));
      continue;
    }
    if (child.type === "scoped_identifier") {
      const path = `${importedPrefix}${compactPath(child)}`;
      const item = canonicalName(child.childForFieldName("name") ?? child);
      bindings.push(frozenBinding(path, item, reexport ? item : null));
      continue;
    }
    if (child.type === "scoped_use_list") {
      const nestedPath = child.childForFieldName("path");
      const nestedList = child.childForFieldName("list");
      if (nestedPath && nestedList) {
        bindings.push(...groupedBindings(
          nestedList,
          `${moduleSpecifier}::${compactPath(nestedPath)}`,
          reexport,
          `${importedPrefix}${compactPath(nestedPath)}::`
        ));
      }
    }
  }
  return bindings;
}

function useDetails(argument: SyntaxNode, reexport: boolean): {
  moduleSpecifier: string;
  moduleStartIndex: number;
  moduleEndIndex: number;
  bindings: ModuleBindingFact[];
} | null {
  if (argument.type === "scoped_use_list") {
    const moduleNode = argument.childForFieldName("path");
    const list = argument.childForFieldName("list");
    if (!moduleNode || !list || moduleNode.hasError || list.isError) return null;
    const moduleSpecifier = compactPath(moduleNode);
    return {
      moduleSpecifier,
      moduleStartIndex: moduleNode.startIndex,
      moduleEndIndex: moduleNode.endIndex,
      bindings: groupedBindings(list, moduleSpecifier, reexport),
    };
  }

  if (argument.type === "use_as_clause") {
    const pathNode = argument.childForFieldName("path");
    const aliasNode = argument.childForFieldName("alias");
    if (!pathNode || !aliasNode || pathNode.hasError || aliasNode.hasError) return null;
    const path = compactPath(pathNode);
    const item = lastPathSegment(path);
    const local = canonicalName(aliasNode);
    return {
      // Rust syntax does not tell us whether the final segment is a module or
      // an item. Preserve the complete path and defer that decision.
      moduleSpecifier: path,
      moduleStartIndex: pathNode.startIndex,
      moduleEndIndex: pathNode.endIndex,
      bindings: [frozenBinding(item, local, reexport ? local : null)],
    };
  }

  if (argument.type === "scoped_identifier") {
    const path = compactPath(argument);
    const item = lastPathSegment(path);
    const local = canonicalName(argument.childForFieldName("name") ?? argument);
    return {
      moduleSpecifier: path,
      moduleStartIndex: argument.startIndex,
      moduleEndIndex: argument.endIndex,
      bindings: [frozenBinding(item, local, reexport ? local : null)],
    };
  }

  if (argument.type === "identifier" || argument.type === "crate" || argument.type === "self" || argument.type === "super") {
    const moduleSpecifier = canonicalName(argument);
    return {
      moduleSpecifier,
      moduleStartIndex: argument.startIndex,
      moduleEndIndex: argument.endIndex,
      bindings: [frozenBinding(null, moduleSpecifier, reexport ? moduleSpecifier : null)],
    };
  }
  return null;
}

function isPublic(node: SyntaxNode): boolean {
  return node.children.some((child) => child.type === "visibility_modifier");
}

function hasInlineModuleBody(node: SyntaxNode): boolean {
  return node.childForFieldName("body") !== null;
}

function referenceOrder(
  left: UnresolvedModuleLinkageFact,
  right: UnresolvedModuleLinkageFact
): number {
  return (
    left.statementRange.utf16.start - right.statementRange.utf16.start ||
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
    const statement = match.captures.find((capture) => capture.name === "reference.use")?.node;
    if (!statement || seen.has(statement.id)) continue;
    seen.add(statement.id);
    const argument = statement.childForFieldName("argument");
    if (!argument) continue;
    const reexport = isPublic(statement);
    const details = useDetails(argument, reexport);
    if (!details) continue;
    const kind = reexport ? "reexport" : "import";
    const key = `${kind}:${statement.startIndex}:${statement.endIndex}:${details.moduleSpecifier}`;
    facts.push(Object.freeze({
      identity: structuralIdentity("reference", snapshot.sha256, key),
      kind,
      nativeKind: statement.type,
      moduleSpecifier: details.moduleSpecifier,
      moduleSpecifierRange: snapshot.coordinates.rangeFromUtf16(
        details.moduleStartIndex,
        details.moduleEndIndex
      ),
      statementRange: nodeRange(snapshot, statement),
      ownerIdentity: nearestOwnerIdentity(snapshot, statement, byNodeId),
      isTypeOnly: false,
      bindings: Object.freeze(details.bindings),
      resolution: "unresolved",
    }));
  }

  for (const candidate of candidates) {
    if (
      candidate.emit &&
      candidate.nativeKind === "mod_item" &&
      candidate.nameNode &&
      !candidate.nameNode.hasError &&
      !hasInlineModuleBody(candidate.node)
    ) {
      const owners = ancestorCandidates(candidate, byNodeId);
      const key = `import:${candidate.node.startIndex}:${candidate.node.endIndex}:${candidate.name}`;
      facts.push(Object.freeze({
        identity: structuralIdentity("reference", snapshot.sha256, key),
        kind: "import",
        nativeKind: candidate.nativeKind,
        moduleSpecifier: candidate.name,
        moduleSpecifierRange: nodeRange(snapshot, candidate.nameNode),
        statementRange: nodeRange(snapshot, candidate.node),
        ownerIdentity: owners.length > 0
          ? candidateIdentity(snapshot, owners.at(-1)!, owners.slice(0, -1))
          : null,
        isTypeOnly: false,
        bindings: Object.freeze([]),
        resolution: "unresolved",
      }));
    }
    if (!candidate.emit || candidate.name === null || !isPublic(candidate.node)) continue;
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

const rustAdapter: StructuralAdapter = {
  label: "Rust",
  languages: rustLanguages,
  compatibility: rustAnalysisCompatibility,
  queryFile: () => "queries/rust-structure-v1.scm",
  candidates: declarations,
  references,
};

export function createRustAnalyzer(options: RustAnalyzerOptions = {}): LanguageAnalyzer {
  return createStructuralAnalyzer(rustAdapter, options);
}
