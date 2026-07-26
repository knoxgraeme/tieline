/**
 * Browser-facing types for the section-coupling graph UI. Self-contained (no
 * server or zod imports) — type-checked against the DOM lib via tsconfig.ui.json,
 * transpiled/bundled by esbuild, NOT the Node `tsc` build (which excludes this
 * folder). Shapes mirror db.ts's GraphNode/GraphEdge/CrossoverGraph by hand.
 */

export interface GraphNode {
  id: string; // section_key
  label: string; // section_name
  status: string;
  story_count: number;
}

export interface GraphEdge {
  source: string; // section_key
  target: string; // section_key
  weight: number;
  shared_entities: string[];
  shared_code_paths: string[];
  shared_count: number;
}

export interface CrossoverGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

declare global {
  interface Window {
    GraphUI: { render(graph: CrossoverGraph): void };
  }
}
