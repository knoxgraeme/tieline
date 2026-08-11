import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  Query,
  type Language,
  type Node as SyntaxNode,
  type QueryMatch,
} from "web-tree-sitter";
import type { SourceRange, SourceSnapshot } from "../source-snapshot.js";
import {
  parserCompatibilitySet,
  type SupportedCodeLanguage,
} from "./languages.js";
import { createCodeParserRuntime, defaultParserAssetRoot, type CodeParserRuntime } from "./runtime.js";
import type {
  CodeAnalysisCompatibility,
  CodeSymbolFact,
  CodeSymbolOwner,
  LanguageAnalysisResult,
  LanguageAnalyzer,
  ModuleBindingFact,
  ModuleLinkageKind,
  NormalizedSymbolKind,
  ParserDiagnostic,
  UnresolvedModuleLinkageFact,
} from "./types.js";

const queryCompatibility = "javascript-typescript-structure-v1";
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
const defaultMaximumSymbols = 20_000;
const defaultMaximumReferences = 20_000;
const defaultMaximumDiagnostics = 512;
const treeSitterMatchLimit = 65_536;
const bareSelectorName = /^[\p{ID_Start}_$][\p{ID_Continue}\u200c\u200d$]*$/u;

export interface JavaScriptAnalyzerOptions {
  runtime?: CodeParserRuntime;
  assetRoot?: string;
  maxSymbols?: number;
  maxReferences?: number;
  maxDiagnostics?: number;
}

interface Limits {
  symbols: number;
  references: number;
  diagnostics: number;
}

interface SymbolCandidate {
  node: SyntaxNode;
  nameNode: SyntaxNode | null;
  nativeKind: string;
  kind: NormalizedSymbolKind;
  name: string | null;
  ownSelectorSegment: string | null;
}

function boundedInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return resolved;
}

function range(snapshot: SourceSnapshot, node: SyntaxNode): SourceRange {
  return snapshot.coordinates.rangeFromUtf16(node.startIndex, node.endIndex);
}

function identity(prefix: string, ...parts: Array<string | number | null>): string {
  const digest = createHash("sha256")
    .update(parts.map((part) => String(part)).join("\u0000"))
    .digest("hex");
  return `${prefix}:${digest}`;
}

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

function selectorSegment(kind: NormalizedSymbolKind, name: string | null): string | null {
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

function candidateFromMatch(match: QueryMatch): SymbolCandidate | null {
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
    ownSelectorSegment: selectorSegment(kind, name),
  };
}

function candidateOrder(left: SymbolCandidate, right: SymbolCandidate): number {
  return (
    left.node.startIndex - right.node.startIndex ||
    right.node.endIndex - left.node.endIndex ||
    left.nativeKind.localeCompare(right.nativeKind) ||
    (left.name ?? "").localeCompare(right.name ?? "")
  );
}

function requiredSyntaxIsSafe(candidate: SymbolCandidate, owners: readonly SymbolCandidate[]): boolean {
  if (candidate.nameNode && (candidate.nameNode.isError || candidate.nameNode.isMissing || candidate.nameNode.hasError)) {
    return false;
  }
  return owners.every(
    (owner) =>
      owner.nameNode === null ||
      (!owner.nameNode.isError && !owner.nameNode.isMissing && !owner.nameNode.hasError)
  );
}

function ancestorCandidates(
  candidate: SymbolCandidate,
  byNodeId: ReadonlyMap<number, SymbolCandidate>
): SymbolCandidate[] {
  const owners: SymbolCandidate[] = [];
  let ancestor = candidate.node.parent;
  while (ancestor) {
    const owner = byNodeId.get(ancestor.id);
    if (owner) owners.push(owner);
    ancestor = ancestor.parent;
  }
  return owners.reverse();
}

function symbolIdentity(
  snapshot: SourceSnapshot,
  candidate: SymbolCandidate,
  owners: readonly SymbolCandidate[] = []
): string {
  return identity(
    "symbol",
    snapshot.sha256,
    owners
      .map(
        (owner) =>
          `${owner.nativeKind}:${owner.node.startIndex}:${owner.node.endIndex}:${owner.name ?? ""}`
      )
      .join("/"),
    candidate.nativeKind,
    candidate.node.startIndex,
    candidate.node.endIndex
  );
}

function ownerFact(
  snapshot: SourceSnapshot,
  owner: SymbolCandidate,
  ancestors: readonly SymbolCandidate[]
): CodeSymbolOwner {
  const selectorParts = [...ancestors.map((ancestor) => ancestor.ownSelectorSegment), owner.ownSelectorSegment];
  return Object.freeze({
    identity: symbolIdentity(snapshot, owner, ancestors),
    name: owner.name,
    nativeKind: owner.nativeKind,
    kind: owner.kind,
    selector: selectorParts.every((part): part is string => part !== null)
      ? selectorParts.join("/")
      : null,
    nameRange: owner.nameNode ? range(snapshot, owner.nameNode) : null,
    bodyRange: range(snapshot, owner.node),
  });
}

function buildSymbols(snapshot: SourceSnapshot, matches: readonly QueryMatch[]): CodeSymbolFact[] {
  const candidatesByKey = new Map<string, SymbolCandidate>();
  for (const match of matches) {
    const candidate = candidateFromMatch(match);
    if (!candidate) continue;
    const key = `${candidate.node.id}:${candidate.nativeKind}:${candidate.name ?? ""}`;
    candidatesByKey.set(key, candidate);
  }
  const candidates = [...candidatesByKey.values()].sort(candidateOrder);
  const byNodeId = new Map(candidates.map((candidate) => [candidate.node.id, candidate] as const));
  const symbols: CodeSymbolFact[] = [];
  for (const candidate of candidates) {
    const owners = ancestorCandidates(candidate, byNodeId);
    if (!requiredSyntaxIsSafe(candidate, owners)) continue;
    const ownerChain = owners.map((owner, index) =>
      ownerFact(snapshot, owner, owners.slice(0, index))
    );
    const selectorParts = [...owners.map((owner) => owner.ownSelectorSegment), candidate.ownSelectorSegment];
    const selector = selectorParts.every((part): part is string => part !== null)
      ? selectorParts.join("/")
      : null;
    symbols.push(Object.freeze({
      identity: symbolIdentity(snapshot, candidate, owners),
      name: candidate.name,
      nativeKind: candidate.nativeKind,
      kind: candidate.kind,
      selector,
      ownerChain: Object.freeze(ownerChain),
      nameRange: candidate.nameNode ? range(snapshot, candidate.nameNode) : null,
      bodyRange: range(snapshot, candidate.node),
      syntaxStatus: candidate.node.hasError ? "recovered" : "exact",
    }));
  }
  return symbols;
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

function nearestOwnerIdentity(
  snapshot: SourceSnapshot,
  node: SyntaxNode,
  symbolsByNodeId: ReadonlyMap<number, SymbolCandidate>
): string | null {
  let ancestor = node.parent;
  while (ancestor) {
    const owner = symbolsByNodeId.get(ancestor.id);
    if (owner) {
      return symbolIdentity(snapshot, owner, ancestorCandidates(owner, symbolsByNodeId));
    }
    ancestor = ancestor.parent;
  }
  return null;
}

function referenceOwnerIdentity(
  snapshot: SourceSnapshot,
  statement: SyntaxNode,
  symbolsByNodeId: ReadonlyMap<number, SymbolCandidate>,
  kind: ModuleLinkageKind
): string | null {
  if (kind === "export") {
    const exported = statement.childForFieldName("declaration") ?? statement.childForFieldName("value");
    if (exported) {
      const candidate = symbolsByNodeId.get(exported.id);
      if (candidate) {
        return symbolIdentity(
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
  symbolMatches: readonly QueryMatch[]
): UnresolvedModuleLinkageFact[] {
  const candidates = symbolMatches
    .map(candidateFromMatch)
    .filter((candidate): candidate is SymbolCandidate => candidate !== null);
  const symbolsByNodeId = new Map(candidates.map((candidate) => [candidate.node.id, candidate] as const));
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
    const key = `${kind}:${statement.startIndex}:${statement.endIndex}:${moduleSpecifier ?? ""}`;
    references.set(key, Object.freeze({
      identity: identity("reference", snapshot.sha256, key),
      kind,
      nativeKind: statement.type,
      moduleSpecifier,
      moduleSpecifierRange: sourceNode ? range(snapshot, sourceNode) : null,
      statementRange: range(snapshot, statement),
      ownerIdentity: referenceOwnerIdentity(snapshot, statement, symbolsByNodeId, kind),
      isTypeOnly: typeOnly,
      bindings: Object.freeze(extractBindings(statement, typeOnly)),
      resolution: "unresolved",
    }));
  }
  return [...references.values()].sort(
    (left, right) =>
      left.statementRange.utf16.start - right.statementRange.utf16.start ||
      left.kind.localeCompare(right.kind) ||
      (left.moduleSpecifier ?? "").localeCompare(right.moduleSpecifier ?? "")
  );
}

function buildDiagnostics(snapshot: SourceSnapshot, root: SyntaxNode): ParserDiagnostic[] {
  const diagnostics: ParserDiagnostic[] = [];
  const visit = (node: SyntaxNode): void => {
    if (node.isError || node.isMissing) {
      const kind = node.isMissing ? "missing" : "error";
      const nodeRange = range(snapshot, node);
      diagnostics.push(Object.freeze({
        identity: identity("diagnostic", snapshot.sha256, kind, node.type, node.startIndex, node.endIndex),
        kind,
        nativeKind: node.type,
        range: nodeRange,
        message:
          kind === "missing"
            ? `Parser inserted missing ${node.type}`
            : `Parser could not incorporate ${node.type} syntax`,
      }));
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return diagnostics.sort(
    (left, right) =>
      left.range.utf16.start - right.range.utf16.start ||
      left.range.utf16.end - right.range.utf16.end ||
      left.kind.localeCompare(right.kind)
  );
}

function queryFile(language: SupportedCodeLanguage): string {
  return language === "javascript" || language === "jsx"
    ? "queries/javascript-structure-v1.scm"
    : "queries/typescript-structure-v1.scm";
}

class JavaScriptAnalyzer implements LanguageAnalyzer {
  readonly languages = javascriptLanguages;
  private readonly runtime: CodeParserRuntime;
  private readonly assetRoot: string;
  private readonly limits: Limits;
  private readonly querySources = new Map<string, Promise<string>>();
  private readonly queries = new Map<SupportedCodeLanguage, Promise<Query>>();
  private disposed = false;

  constructor(options: JavaScriptAnalyzerOptions) {
    this.runtime = options.runtime ?? createCodeParserRuntime({ assetRoot: options.assetRoot });
    this.assetRoot = options.assetRoot ?? defaultParserAssetRoot();
    this.limits = {
      symbols: boundedInteger(options.maxSymbols, defaultMaximumSymbols, "maxSymbols"),
      references: boundedInteger(options.maxReferences, defaultMaximumReferences, "maxReferences"),
      diagnostics: boundedInteger(options.maxDiagnostics, defaultMaximumDiagnostics, "maxDiagnostics"),
    };
  }

  async analyze(snapshot: SourceSnapshot): Promise<LanguageAnalysisResult> {
    if (this.disposed) throw new Error("JavaScript analyzer has been disposed");
    const language = snapshot.language;
    if (language === null || !this.languages.has(language)) {
      throw new Error(`JavaScript analyzer cannot analyze ${snapshot.path} as ${String(language)}`);
    }
    const source = await this.loadQuerySource(language);
    return this.runtime.withParser(language, async (parser, grammar) => {
      const tree = parser.parse(snapshot.text);
      if (!tree) throw new Error(`Parser returned no tree for ${snapshot.path}`);
      try {
        const query = await this.compiledQuery(language, grammar, source);
        const matches = query.matches(tree.rootNode, { matchLimit: treeSitterMatchLimit });
        const symbols = buildSymbols(snapshot, matches);
        const references = buildReferences(snapshot, matches, matches);
        const diagnostics = buildDiagnostics(snapshot, tree.rootNode);
        return Object.freeze({
          compatibility: javascriptAnalysisCompatibility,
          path: snapshot.path,
          language,
          sourceHash: snapshot.sha256,
          symbols: Object.freeze(symbols.slice(0, this.limits.symbols)),
          references: Object.freeze(references.slice(0, this.limits.references)),
          diagnostics: Object.freeze(diagnostics.slice(0, this.limits.diagnostics)),
          truncated: Object.freeze({
            symbols: symbols.length > this.limits.symbols || query.didExceedMatchLimit(),
            references: references.length > this.limits.references || query.didExceedMatchLimit(),
            diagnostics: diagnostics.length > this.limits.diagnostics,
          }),
        });
      } finally {
        tree.delete();
      }
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const queries = [...this.queries.values()];
    this.queries.clear();
    for (const query of queries) (await query).delete();
  }

  private compiledQuery(
    language: SupportedCodeLanguage,
    grammar: Language,
    source: string
  ): Promise<Query> {
    if (this.disposed) throw new Error("JavaScript analyzer has been disposed");
    let query = this.queries.get(language);
    if (!query) {
      query = Promise.resolve(new Query(grammar, source));
      this.queries.set(language, query);
    }
    return query;
  }

  private loadQuerySource(language: SupportedCodeLanguage): Promise<string> {
    const file = queryFile(language);
    let source = this.querySources.get(file);
    if (!source) {
      source = readFile(resolve(this.assetRoot, file), "utf8");
      this.querySources.set(file, source);
    }
    return source;
  }
}

export function createJavaScriptAnalyzer(
  options: JavaScriptAnalyzerOptions = {}
): LanguageAnalyzer {
  return new JavaScriptAnalyzer(options);
}
