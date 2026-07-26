/** Checked-in relevance calibration: independent semantic and structural gates. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { scoreCandidates, toStoryHits } from "../src/ranking.js";
import type { Candidate, DocFrequencies } from "../src/types.js";

type Mode = "semantic" | "structural" | "blended";
interface Fixture {
  thresholds: { min_vector: number; min_structural: number };
  document_frequencies: { entity: Record<string, number>; path: Record<string, number> };
  cases: Array<{
    name: string;
    mode: Mode;
    query_entities: string[];
    query_paths: string[];
    candidates: Array<{ key: string; similarity: number; entities: string[]; paths: string[] }>;
    expected: string[];
  }>;
}

const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), "testdata/retrieval-eval.json"), "utf8")
) as Fixture;
const df: DocFrequencies = {
  entity: new Map(Object.entries(fixture.document_frequencies.entity)),
  path: new Map(Object.entries(fixture.document_frequencies.path)),
};
const weights: Record<Mode, { vector: number; entity: number; path: number }> = {
  semantic: { vector: 1, entity: 0, path: 0 },
  structural: { vector: 0.15, entity: 0.25, path: 0.6 },
  blended: { vector: 0.5, entity: 0.25, path: 0.25 },
};

let failed = 0;
for (const testCase of fixture.cases) {
  const candidates: Candidate[] = testCase.candidates.map((candidate, index) => ({
    id: index + 1,
    story_key: candidate.key,
    section_id: 1,
    section_key: "eval",
    section_name: "Evaluation",
    title: candidate.key,
    actor: null,
    story_text: candidate.key,
    status: "production",
    entity_slugs: candidate.entities,
    code_paths: candidate.paths,
    help_articles: [],
    help_article_count: 0,
    similarity: candidate.similarity,
  }));
  const scored = scoreCandidates({
    candidates,
    queryEntities: new Set(testCase.query_entities),
    queryPaths: new Set(testCase.query_paths),
    df,
    weights: weights[testCase.mode],
  });
  const actual = toStoryHits(
    scored,
    {
      minVector: fixture.thresholds.min_vector,
      minStructural: fixture.thresholds.min_structural,
      allowStructural: testCase.mode !== "semantic",
    },
    20
  ).map((hit) => hit.story_key);
  const ok = JSON.stringify(actual) === JSON.stringify(testCase.expected);
  console.log(`${ok ? "ok " : "FAIL"} - ${testCase.name}: [${actual.join(", ")}]`);
  if (!ok) failed += 1;
}

console.log(`\n${fixture.cases.length - failed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
