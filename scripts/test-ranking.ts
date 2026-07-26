/**
 * Offline unit tests for the pure ranking logic (no DB, no model).
 * Run: npm run test:ranking
 */

import {
  minMax,
  saturate,
  clamp01,
  weightedOverlap,
  detectCode,
  extractQueryPaths,
  extractQueryEntities,
  scoreCandidates,
  toAreaHits,
  toStoryHits,
} from "../src/ranking.js";
import type { Candidate, DocFrequencies } from "../src/types.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    passed++;
    console.log(`  ok  - ${name}`);
  } else {
    failed++;
    console.error(`  FAIL- ${name}`);
  }
}
function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps;
}

// --- numeric helpers --------------------------------------------------------
console.log("numeric helpers");
check("clamp01 clamps", clamp01(1.5) === 1 && clamp01(-0.2) === 0 && clamp01(0.4) === 0.4);
check("saturate 0->0, monotonic", saturate(0) === 0 && saturate(1) === 0.5 && saturate(3) === 0.75);
{
  const n = minMax([1, 3, 5]);
  check("minMax scales to 0..1", approx(n[0], 0) && approx(n[1], 0.5) && approx(n[2], 1));
  const flat = minMax([0.2, 0.2]);
  check("minMax equal-values keeps absolute", approx(flat[0], 0.2) && approx(flat[1], 0.2));
}

// --- weighted overlap (1/df) ------------------------------------------------
console.log("weighted overlap");
{
  const df = new Map([
    ["settings", 35],
    ["tax-rate", 5],
  ]);
  const o = weightedOverlap(new Set(["settings", "tax-rate"]), ["settings", "tax-rate", "other"], df);
  check("shared captured", o.shared.length === 2);
  check("rare slug outweighs hub", o.weights[0].key === "tax-rate");
  check("score = 1/5 + 1/35", approx(o.score, 1 / 5 + 1 / 35));
}

// --- code detection + extraction -------------------------------------------
console.log("code detection / extraction");
check("detects vue/ts code", detectCode(`import x from './a.ts';\nexport const f = () => { return 1; }`));
check("prose is not code", !detectCode("invite a teammate to a project"));
{
  const paths = extractQueryPaths(
    "diff --git a/src/projects/InviteMember.ts b/src/projects/projectAccess.ts"
  );
  check("extracts first path", paths.includes("src/projects/InviteMember.ts"));
  check("extracts second path + strips a/", paths.includes("src/projects/projectAccess.ts"));
}
{
  const ents = extractQueryEntities("invite a teammate with project access control", [
    "project",
    "access-control",
    "tax-rate",
  ]);
  check("matches single-word slug", ents.includes("project"));
  check("matches multiword slug as phrase", ents.includes("access-control"));
  check("no false positive", !ents.includes("tax-rate"));
}

// --- scoring + shaping ------------------------------------------------------
console.log("scoring + area/story shaping");
const df: DocFrequencies = {
  entity: new Map([
    ["project", 98],
    ["tax-rate", 5],
    ["invitation", 3],
  ]),
  path: new Map([["src/a/Reorder.vue", 2]]),
};
function cand(p: Partial<Candidate>): Candidate {
  return {
    id: 0,
    story_key: "K",
    section_id: 1,
    section_key: "sec",
    section_name: "Sec",
    title: "t",
    actor: "member",
    story_text: "txt",
    status: "production",
    entity_slugs: [],
    code_paths: [],
    similarity: 0.5,
    ...p,
  };
}

{
  const candidates: Candidate[] = [
    cand({ id: 1, story_key: "A", section_key: "alpha", section_name: "Alpha", similarity: 0.9, entity_slugs: ["tax-rate", "invitation"] }),
    cand({ id: 2, story_key: "B", section_key: "beta", section_name: "Beta", similarity: 0.6, entity_slugs: ["project"] }),
    cand({ id: 3, story_key: "C", section_key: "beta", section_name: "Beta", similarity: 0.2, entity_slugs: [] }),
  ];
  const scored = scoreCandidates({
    candidates,
    queryEntities: new Set(["tax-rate", "invitation", "project"]),
    queryPaths: new Set(),
    df,
    weights: { vector: 0.5, entity: 0.25, path: 0.25 },
  });
  check("scored every candidate", scored.length === 3);
  const areas = toAreaHits(scored, { minVector: 0, minStructural: 0, allowStructural: true }, 5);
  check("areas grouped by section (2)", areas.length === 2);
  check("top area is alpha (high sim + rare slugs)", areas[0].section_key === "alpha");
  check("why carries shared entities", areas[0].why.shared_entities.includes("tax-rate"));

  const stories = toStoryHits(scored, { minVector: 0, minStructural: 0, allowStructural: true }, 5);
  check("story hits ranked, A first", stories[0].story_key === "A");
}

// --- empty-result correctness ----------------------------------------------
console.log("empty-result gate");
{
  const weak: Candidate[] = [cand({ id: 9, similarity: 0.05, entity_slugs: [] })];
  const scored = scoreCandidates({
    candidates: weak,
    queryEntities: new Set(),
    queryPaths: new Set(),
    df,
    weights: { vector: 1, entity: 0, path: 0 },
  });
  const areas = toAreaHits(
    scored,
    { minVector: 0.99, minStructural: 0.99, allowStructural: true },
    5
  );
  check("below min_score -> empty (not forced)", areas.length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
