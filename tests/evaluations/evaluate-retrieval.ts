import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { rankSemanticDocuments } from "../../src/ranking.js";

interface Fixture {
  cases: Array<{
    name: string;
    expected_top: string;
    candidates: Array<{
      id: string;
      kind:
        | "story"
        | "acceptance_criterion"
        | "scenario"
        | "backlog_item"
        | "observation";
      vector: number;
      lexical: number;
      applicable?: boolean;
    }>;
  }>;
}

const fixture = JSON.parse(
  readFileSync(
    resolve(process.cwd(), "testdata/semantic-retrieval-eval.json"),
    "utf8"
  )
) as Fixture;

let failed = 0;
for (const testCase of fixture.cases) {
  const actual = rankSemanticDocuments(
    testCase.candidates.map((candidate) => ({
      document_id: candidate.id,
      entity_kind: candidate.kind,
      entity_id: candidate.id,
      canonical_text: candidate.id,
      matched_level: candidate.kind,
      vector_score: candidate.vector,
      lexical_score: candidate.lexical,
      applicable: candidate.applicable,
      metadata: {},
    }))
  )[0]?.document_id;
  const passed = actual === testCase.expected_top;
  console.log(`${passed ? "ok " : "FAIL"} - ${testCase.name}: ${actual}`);
  if (!passed) failed += 1;
}

console.log(`\n${fixture.cases.length - failed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
