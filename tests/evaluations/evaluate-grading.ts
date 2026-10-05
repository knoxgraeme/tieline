import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, opendirSync, lstatSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { z } from "zod";
import { compileContractManifest } from "../../src/contract/manifest.js";
import { buildCriterionGradeScope, parseCriterionGradeVerdicts, verifyCriterionGradeVerdicts } from "../../src/contract/criterion-grade.js";
import { gradingCases, gradingCorpusVersion, type GradingEvaluationCase } from "./grading-cases.js";

const runSchema = z.object({
  schema_version: z.literal(1), prepared_at: z.string().datetime(),
  corpus_version: z.literal(gradingCorpusVersion),
  rubric_sha256: z.string().regex(/^[a-f0-9]{64}$/), cases: z.literal(gradingCases.length),
}).strict();

function boundedText(path: string): string {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.size > 1_048_576) throw new Error(`Invalid evaluation input: ${path}`);
  return readFileSync(path, "utf8");
}

function serialized(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }

function definition(testCase: GradingEvaluationCase): string {
  return stringify({ version: 1, capability: {
    key: "EVAL", name: "Evaluation fixture", description: "A small controlled product behavior.",
    stories: [{ key: "EVAL-001", title: "Product behavior", actor: "user", goal: "use the feature", benefit: "receive its promised behavior", lifecycle: "production",
      acceptance_criteria: [{ key: "AC-EVAL-001", criterion: testCase.criterion,
        links: testCase.links.map((path) => ({ relation: "implements", provenance: "authored", target: { kind: "code", repository: "evaluation", path } })),
      }],
    }],
  } });
}

function fixtureFiles(testCase: GradingEvaluationCase): Record<string, string> {
  return { ...testCase.sources, ".tieline/spec/evaluation.yaml": definition(testCase) };
}

function verifyInventory(root: string, expectedFiles: string[]): void {
  const allowed = new Set([...expectedFiles, "scope.json", "packet.json", "verdicts.json"]);
  const directories = new Set<string>();
  for (const path of allowed) {
    let parent = dirname(path);
    while (parent !== ".") { directories.add(parent); parent = dirname(parent); }
  }
  const visit = (path: string) => {
    const absolute = resolve(root, path);
    if (lstatSync(absolute).isSymbolicLink()) throw new Error("Evaluation fixture contains a symlink.");
    const directory = opendirSync(absolute);
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        const name = path ? `${path}/${entry.name}` : entry.name;
        if (entry.isDirectory() && directories.has(name)) visit(name);
        else if (!entry.isFile() || !allowed.has(name)) throw new Error(`Unexpected evaluation fixture entry: ${name}`);
      }
    } finally { directory.closeSync(); }
  };
  visit("");
}

export async function evaluationScope(directory: string, testCase: GradingEvaluationCase) {
  const root = resolve(directory, testCase.id);
  verifyInventory(root, Object.keys(fixtureFiles(testCase)));
  for (const [path, expected] of Object.entries(fixtureFiles(testCase))) {
    const file = resolve(root, path);
    if (statSync(file).size > 1_048_576 || readFileSync(file, "utf8") !== expected) {
      throw new Error(`Evaluation fixture changed: ${testCase.id}/${path}`);
    }
  }
  const manifest = compileContractManifest({ repositoryRoot: root, repositoryKey: "evaluation" });
  return buildCriterionGradeScope({ repositoryRoot: root, manifest,
    baseManifest: testCase.initial ? null : manifest, base: "fixture-base",
    changes: testCase.initial ? [] : [{ status: "modified", path: testCase.links[0]! }],
    sourceRoots: ["src"], selection: testCase.selection,
  });
}

/** No model client or provider credentials. Supply the generated packet to a
 * fresh, tool-free grader; the evaluator owns expectations and verification.
 */
export async function prepareGradingEvaluation(directory: string): Promise<void> {
  const root = resolve(directory);
  mkdirSync(root); // Refuse to overwrite an existing experiment.
  try {
    for (const testCase of gradingCases) {
      const caseRoot = resolve(root, testCase.id);
      for (const [path, content] of Object.entries(fixtureFiles(testCase))) {
        const file = resolve(caseRoot, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
      }
      const scope = await evaluationScope(root, testCase);
      writeFileSync(resolve(caseRoot, "scope.json"), serialized(scope));
      writeFileSync(resolve(caseRoot, "packet.json"), serialized({ scope, sources: testCase.sources }));
    }
    const rubric = readFileSync(new URL("../../skills/tieline/references/criterion-grading.md", import.meta.url), "utf8");
    writeFileSync(resolve(root, "grader-rubric.md"), rubric);
    writeFileSync(resolve(root, "run.json"), JSON.stringify({ schema_version: 1, corpus_version: gradingCorpusVersion, prepared_at: new Date().toISOString(), rubric_sha256: createHash("sha256").update(rubric).digest("hex"), cases: gradingCases.length }, null, 2));
    writeFileSync(resolve(root, "grader-instructions.md"), `Review each supplied packet using the included grader-rubric.md snapshot.\nUse only the provided scope and raw sources; no tools, network, credentials, author notes, or evaluator expectations.\nReturn one verdict document per case. Every selected AC needs a grade and reason.\nSupported grades need exact emitted link_id/selector citations. Record wrong or overstated links separately.\nAn empty scope receives {"verdicts":[]}; it does not certify the implementation.\nDo not edit fixtures. The host will save your documents as <case>/verdicts.json.\n`);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export async function scoreGradingEvaluation(directory: string) {
  const run = runSchema.parse(JSON.parse(boundedText(resolve(directory, "run.json"))));
  const rubric = boundedText(resolve(directory, "grader-rubric.md"));
  if (createHash("sha256").update(rubric).digest("hex") !== run.rubric_sha256) {
    throw new Error("Evaluation rubric changed since preparation.");
  }
  const results = [];
  for (const testCase of gradingCases) {
    const scope = await evaluationScope(directory, testCase);
    for (const [name, expected] of Object.entries({ "scope.json": scope, "packet.json": { scope, sources: testCase.sources } })) {
      if (boundedText(resolve(directory, testCase.id, name)) !== serialized(expected)) {
        throw new Error(`Evaluation packet changed: ${testCase.id}/${name}`);
      }
    }
    const verdictPath = resolve(directory, testCase.id, "verdicts.json");
    if (statSync(verdictPath).size > 1_048_576) throw new Error("Evaluation verdict exceeds 1 MiB.");
    const verdicts = parseCriterionGradeVerdicts(JSON.parse(readFileSync(verdictPath, "utf8")));
    const report = verifyCriterionGradeVerdicts({ scope, verdicts });
    const actual = report.entries[0];
    const foundPaths = actual?.link_findings.map((finding) =>
      actual.evidence.find((link) => link.id === finding.link_id)!.linked_path).sort() ?? [];
    const correctCardinality = report.scoped_criteria === (testCase.expectedGrades.length === 0 ? 0 : 1);
    const gradeCorrect = testCase.expectedGrades.length === 0
      ? report.scoped_criteria === 0 && verdicts.length === 0
      : actual !== undefined && actual.cause === null && testCase.expectedGrades.includes(actual.grade);
    const linksCorrect = JSON.stringify(foundPaths) === JSON.stringify([...testCase.expectedLinkFindings].sort());
    results.push({
      case: testCase.id, pass: correctCardinality && gradeCorrect && linksCorrect,
      grade: actual?.grade ?? null, expected_grades: testCase.expectedGrades,
      link_findings: foundPaths, expected_link_findings: testCase.expectedLinkFindings,
      verification_cause: actual?.cause ?? null,
      selected_criteria: report.scoped_criteria,
      false_support: actual?.grade === "supported" && !testCase.expectedGrades.includes("supported"),
      missed_link_findings: testCase.expectedLinkFindings.filter((path) => !foundPaths.includes(path)),
      spurious_link_findings: foundPaths.filter((path) => !testCase.expectedLinkFindings.includes(path)),
    });
  }
  return { run, cases: results.length, passed: results.filter((result) => result.pass).length,
    false_support: results.filter((result) => result.false_support).length,
    missed_link_findings: results.reduce((n, result) => n + result.missed_link_findings.length, 0),
    spurious_link_findings: results.reduce((n, result) => n + result.spurious_link_findings.length, 0),
    results,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, directory, ...extra] = process.argv.slice(2);
  if (!directory || extra.length || (action !== "prepare" && action !== "score")) {
    throw new Error("Usage: evaluate-grading.ts prepare|score <experiment-directory>");
  }
  if (action === "prepare") {
    await prepareGradingEvaluation(directory);
    console.log(`Prepared ${gradingCases.length} isolated grading packets in ${resolve(directory)}.`);
  } else {
    const result = await scoreGradingEvaluation(directory);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.passed === result.cases ? 0 : 1;
  }
}
