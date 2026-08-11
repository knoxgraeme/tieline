import { createHash } from "node:crypto";
import type {
  CodeResolutionTarget,
  ResolutionAnalysis,
  ResolutionSymbolFact,
} from "./types.js";

export function resolutionDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function resolutionIdentity(value: unknown): string {
  return `resolution:${resolutionDigest(value)}`;
}

export function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function uniqueResolutionTargets(
  targets: readonly CodeResolutionTarget[]
): CodeResolutionTarget[] {
  const unique = new Map<string, CodeResolutionTarget>();
  for (const target of targets) {
    unique.set(`${target.path}:${target.symbolIdentity ?? "module"}`, target);
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      (left.symbolIdentity ?? "").localeCompare(right.symbolIdentity ?? "")
  );
}

export interface ResolutionSymbolIndex {
  readonly byIdentity: ReadonlyMap<string, ResolutionSymbolFact>;
  readonly topLevel: readonly ResolutionSymbolFact[];
  readonly topLevelByName: ReadonlyMap<string, readonly ResolutionSymbolFact[]>;
}

export function indexResolutionSymbols(
  analysis: ResolutionAnalysis
): ResolutionSymbolIndex {
  const topLevel = analysis.symbols.filter(
    (symbol) => symbol.ownerChain.length === 0
  );
  const topLevelByName = new Map<string, ResolutionSymbolFact[]>();
  for (const symbol of topLevel) {
    if (symbol.name === null) continue;
    const existing = topLevelByName.get(symbol.name);
    if (existing) existing.push(symbol);
    else topLevelByName.set(symbol.name, [symbol]);
  }
  return {
    byIdentity: new Map(
      analysis.symbols.map((symbol) => [symbol.identity, symbol])
    ),
    topLevel,
    topLevelByName,
  };
}
