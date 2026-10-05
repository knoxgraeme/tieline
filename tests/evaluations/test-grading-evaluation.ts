import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { prepareGradingEvaluation, evaluationScope, scoreGradingEvaluation } from "./evaluate-grading.js";
import { gradingCases } from "./grading-cases.js";

const root = mkdtempSync(resolve(tmpdir(), "tieline-eval-harness-test-"));
const experiment = resolve(root, "experiment");
try {
  await prepareGradingEvaluation(experiment);
  await assert.rejects(prepareGradingEvaluation(experiment), /EEXIST/);
  const writeAnswers = async (forceSupported = false) => {
    for (const testCase of gradingCases) {
      const scope = await evaluationScope(experiment, testCase);
      const entry = scope.entries[0];
      const grade = forceSupported ? "supported" : testCase.expectedGrades[0];
      const verdicts = entry ? [{ id: entry.id, grade, reason: "Harness transport fixture; not an agent judgment.",
        ...(grade === "supported" ? { citations: entry.evidence.flatMap((link) => link.symbols.slice(0, 1).map((selector) => ({ link_id: link.id, selector }))) } : {}),
        link_findings: forceSupported ? [] : testCase.expectedLinkFindings.map((path) => ({ link_id: entry.evidence.find((link) => link.linked_path === path)!.id, reason: "Expected fixture link finding." })),
      }] : [];
      writeFileSync(resolve(experiment, testCase.id, "verdicts.json"), JSON.stringify({ verdicts }));
    }
  };
  await writeAnswers();
  assert.equal((await scoreGradingEvaluation(experiment)).passed, gradingCases.length);
  await writeAnswers(true);
  const falseSupport = await scoreGradingEvaluation(experiment);
  assert.ok(falseSupport.false_support >= 2);
  assert.ok(falseSupport.missed_link_findings >= 2);
  assert.ok(falseSupport.passed < falseSupport.cases, "uniform positive grades cannot pass the corpus");
  await writeAnswers();
  const first = gradingCases[0]!;
  for (const path of ["grader-rubric.md", `${first.id}/packet.json`, `${first.id}/scope.json`]) {
    const file = resolve(experiment, path);
    const original = readFileSync(file, "utf8");
    writeFileSync(file, "tampered");
    await assert.rejects(scoreGradingEvaluation(experiment), /Evaluation (rubric|packet) changed/);
    writeFileSync(file, original);
  }
  const receiptPath = resolve(experiment, "run.json");
  const receipt = readFileSync(receiptPath, "utf8");
  writeFileSync(receiptPath, JSON.stringify({ ...JSON.parse(receipt), rubric_sha256: "0".repeat(64) }));
  await assert.rejects(scoreGradingEvaluation(experiment), /Evaluation rubric changed/);
  writeFileSync(receiptPath, receipt);
  const extra = resolve(experiment, first.id, ".tieline/spec/extra.yaml");
  writeFileSync(extra, "version: 1\n");
  await assert.rejects(scoreGradingEvaluation(experiment), /Unexpected evaluation fixture entry/);
  rmSync(extra);

  writeFileSync(resolve(experiment, first.id, "verdicts.json"), '{"verdicts":[]}');
  assert.equal((await scoreGradingEvaluation(experiment)).results[0]!.verification_cause, "missing_verdict");
  writeFileSync(resolve(experiment, first.id, first.links[0]!), "tampered");
  await assert.rejects(scoreGradingEvaluation(experiment), /fixture changed/);
  console.log("grading evaluation harness tests passed (no model invoked)");
} finally { rmSync(root, { recursive: true, force: true }); }
