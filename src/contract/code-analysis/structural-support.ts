import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Query, type Language, type Node as SyntaxNode, type QueryMatch } from "web-tree-sitter";
import type { SourceRange, SourceSnapshot } from "../source-snapshot.js";
import type { SupportedCodeLanguage } from "./languages.js";
import { createCodeParserRuntime, defaultParserAssetRoot, type CodeParserRuntime } from "./runtime.js";
import type {
  CodeAnalysisCompatibility,
  CodeSymbolFact,
  CodeSymbolOwner,
  LanguageAnalysisResult,
  LanguageAnalyzer,
  NormalizedSymbolKind,
  ParserDiagnostic,
  UnresolvedModuleLinkageFact,
} from "./types.js";

const defaultMaximumSymbols = 20_000;
const defaultMaximumReferences = 20_000;
const defaultMaximumDiagnostics = 512;
const treeSitterMatchLimit = 65_536;
const coreSelectorName = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export interface StructuralAnalyzerOptions {
  runtime?: CodeParserRuntime;
  assetRoot?: string;
  maxSymbols?: number;
  maxReferences?: number;
  maxDiagnostics?: number;
}

export interface StructuralCandidate {
  node: SyntaxNode;
  nameNode: SyntaxNode | null;
  /** Nodes whose recovery state is required to identify this declaration safely. */
  requiredNodes: readonly SyntaxNode[];
  nativeKind: string;
  kind: NormalizedSymbolKind;
  name: string | null;
  selectorSegment: string | null;
  /** Structural owners such as Rust impl blocks participate without becoming symbols. */
  emit: boolean;
}

interface Limits {
  symbols: number;
  references: number;
  diagnostics: number;
}

export interface StructuralAdapter {
  label: string;
  languages: ReadonlySet<SupportedCodeLanguage>;
  compatibility: CodeAnalysisCompatibility;
  queryFile(language: SupportedCodeLanguage): string;
  candidates(matches: readonly QueryMatch[]): readonly StructuralCandidate[];
  references(
    snapshot: SourceSnapshot,
    matches: readonly QueryMatch[],
    candidates: readonly StructuralCandidate[]
  ): readonly UnresolvedModuleLinkageFact[];
}

export function boundedInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return resolved;
}

export function nodeRange(snapshot: SourceSnapshot, node: SyntaxNode): SourceRange {
  return snapshot.coordinates.rangeFromUtf16(node.startIndex, node.endIndex);
}

export function structuralIdentity(
  prefix: string,
  ...parts: Array<string | number | null>
): string {
  const digest = createHash("sha256")
    .update(parts.map((part) => String(part)).join("\u0000"))
    .digest("hex");
  return `${prefix}:${digest}`;
}

export function selectorSegment(kind: NormalizedSymbolKind, name: string | null): string | null {
  if (name === null || !coreSelectorName.test(name)) return null;
  if (kind === "variable" || kind === "module") return null;
  return `${kind}:${name}`;
}

export function candidateOrder(left: StructuralCandidate, right: StructuralCandidate): number {
  return (
    left.node.startIndex - right.node.startIndex ||
    right.node.endIndex - left.node.endIndex ||
    left.nativeKind.localeCompare(right.nativeKind) ||
    (left.name ?? "").localeCompare(right.name ?? "")
  );
}

export function candidateMap(
  candidates: readonly StructuralCandidate[]
): ReadonlyMap<number, StructuralCandidate> {
  return new Map(candidates.map((candidate) => [candidate.node.id, candidate] as const));
}

export function ancestorCandidates(
  candidate: StructuralCandidate,
  byNodeId: ReadonlyMap<number, StructuralCandidate>
): StructuralCandidate[] {
  const owners: StructuralCandidate[] = [];
  let ancestor = candidate.node.parent;
  while (ancestor) {
    const owner = byNodeId.get(ancestor.id);
    if (owner) owners.push(owner);
    ancestor = ancestor.parent;
  }
  return owners.reverse();
}

function requiredSyntaxIsSafe(
  candidate: StructuralCandidate,
  owners: readonly StructuralCandidate[]
): boolean {
  return [candidate, ...owners].every((item) =>
    item.requiredNodes.every((node) => !node.isError && !node.isMissing && !node.hasError)
  );
}

export function candidateIdentity(
  snapshot: SourceSnapshot,
  candidate: StructuralCandidate,
  owners: readonly StructuralCandidate[] = []
): string {
  return structuralIdentity(
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
  owner: StructuralCandidate,
  ancestors: readonly StructuralCandidate[]
): CodeSymbolOwner {
  const selectorParts = [
    ...ancestors.map((ancestor) => ancestor.selectorSegment),
    owner.selectorSegment,
  ];
  return Object.freeze({
    identity: candidateIdentity(snapshot, owner, ancestors),
    name: owner.name,
    nativeKind: owner.nativeKind,
    kind: owner.kind,
    selector: selectorParts.every((part): part is string => part !== null)
      ? selectorParts.join("/")
      : null,
    nameRange: owner.nameNode ? nodeRange(snapshot, owner.nameNode) : null,
    bodyRange: nodeRange(snapshot, owner.node),
  });
}

export function buildSymbolFacts(
  snapshot: SourceSnapshot,
  candidates: readonly StructuralCandidate[]
): CodeSymbolFact[] {
  const unique = new Map<string, StructuralCandidate>();
  for (const candidate of candidates) {
    unique.set(`${candidate.node.id}:${candidate.nativeKind}:${candidate.name ?? ""}`, candidate);
  }
  const ordered = [...unique.values()].sort(candidateOrder);
  const byNodeId = candidateMap(ordered);
  const symbols: CodeSymbolFact[] = [];
  for (const candidate of ordered) {
    if (!candidate.emit) continue;
    const owners = ancestorCandidates(candidate, byNodeId);
    if (!requiredSyntaxIsSafe(candidate, owners)) continue;
    const ownerChain = owners.map((owner, index) =>
      ownerFact(snapshot, owner, owners.slice(0, index))
    );
    const selectorParts = [
      ...owners.map((owner) => owner.selectorSegment),
      candidate.selectorSegment,
    ];
    symbols.push(Object.freeze({
      identity: candidateIdentity(snapshot, candidate, owners),
      name: candidate.name,
      nativeKind: candidate.nativeKind,
      kind: candidate.kind,
      selector: selectorParts.every((part): part is string => part !== null)
        ? selectorParts.join("/")
        : null,
      ownerChain: Object.freeze(ownerChain),
      nameRange: candidate.nameNode ? nodeRange(snapshot, candidate.nameNode) : null,
      bodyRange: nodeRange(snapshot, candidate.node),
      syntaxStatus: candidate.node.hasError ? "recovered" : "exact",
    }));
  }
  return symbols;
}

export function nearestOwnerIdentity(
  snapshot: SourceSnapshot,
  node: SyntaxNode,
  byNodeId: ReadonlyMap<number, StructuralCandidate>
): string | null {
  let ancestor = node.parent;
  while (ancestor) {
    const owner = byNodeId.get(ancestor.id);
    if (owner) return candidateIdentity(snapshot, owner, ancestorCandidates(owner, byNodeId));
    ancestor = ancestor.parent;
  }
  return null;
}

function buildDiagnostics(snapshot: SourceSnapshot, root: SyntaxNode): ParserDiagnostic[] {
  const diagnostics: ParserDiagnostic[] = [];
  const visit = (node: SyntaxNode): void => {
    if (node.isError || node.isMissing) {
      const kind = node.isMissing ? "missing" : "error";
      diagnostics.push(Object.freeze({
        identity: structuralIdentity(
          "diagnostic",
          snapshot.sha256,
          kind,
          node.type,
          node.startIndex,
          node.endIndex
        ),
        kind,
        nativeKind: node.type,
        range: nodeRange(snapshot, node),
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

class StructuralLanguageAnalyzer implements LanguageAnalyzer {
  readonly languages: ReadonlySet<SupportedCodeLanguage>;
  private readonly runtime: CodeParserRuntime;
  private readonly assetRoot: string;
  private readonly limits: Limits;
  private readonly querySources = new Map<string, Promise<string>>();
  private readonly queries = new Map<SupportedCodeLanguage, Promise<Query>>();
  private disposed = false;

  constructor(private readonly adapter: StructuralAdapter, options: StructuralAnalyzerOptions) {
    this.languages = adapter.languages;
    this.runtime = options.runtime ?? createCodeParserRuntime({ assetRoot: options.assetRoot });
    this.assetRoot = options.assetRoot ?? defaultParserAssetRoot();
    this.limits = {
      symbols: boundedInteger(options.maxSymbols, defaultMaximumSymbols, "maxSymbols"),
      references: boundedInteger(options.maxReferences, defaultMaximumReferences, "maxReferences"),
      diagnostics: boundedInteger(options.maxDiagnostics, defaultMaximumDiagnostics, "maxDiagnostics"),
    };
  }

  async analyze(snapshot: SourceSnapshot): Promise<LanguageAnalysisResult> {
    if (this.disposed) throw new Error(`${this.adapter.label} analyzer has been disposed`);
    const language = snapshot.language;
    if (language === null || !this.languages.has(language)) {
      throw new Error(
        `${this.adapter.label} analyzer cannot analyze ${snapshot.path} as ${String(language)}`
      );
    }
    const querySource = await this.loadQuerySource(language);
    return this.runtime.withParser(language, async (parser, grammar) => {
      const tree = parser.parse(snapshot.text);
      if (!tree) throw new Error(`Parser returned no tree for ${snapshot.path}`);
      try {
        const query = await this.compiledQuery(language, grammar, querySource);
        const matches = query.matches(tree.rootNode, { matchLimit: treeSitterMatchLimit });
        const candidates = this.adapter.candidates(matches);
        const symbols = buildSymbolFacts(snapshot, candidates);
        const references = [...this.adapter.references(snapshot, matches, candidates)];
        const diagnostics = buildDiagnostics(snapshot, tree.rootNode);
        return Object.freeze({
          compatibility: this.adapter.compatibility,
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
    if (this.disposed) throw new Error(`${this.adapter.label} analyzer has been disposed`);
    let query = this.queries.get(language);
    if (!query) {
      query = Promise.resolve(new Query(grammar, source));
      this.queries.set(language, query);
    }
    return query;
  }

  private loadQuerySource(language: SupportedCodeLanguage): Promise<string> {
    const file = this.adapter.queryFile(language);
    let source = this.querySources.get(file);
    if (!source) {
      source = readFile(resolve(this.assetRoot, file), "utf8");
      this.querySources.set(file, source);
    }
    return source;
  }
}

export function createStructuralAnalyzer(
  adapter: StructuralAdapter,
  options: StructuralAnalyzerOptions = {}
): LanguageAnalyzer {
  return new StructuralLanguageAnalyzer(adapter, options);
}
