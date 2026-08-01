import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { compileContractManifest } from "../src/contract/manifest.js";
import {
  analyzeExecutionCorroboration,
  CoverageParseError,
  detectCoverageFormat,
  parseCoverageReport,
  readCoverageReport,
  type CorroborationFinding,
  type CorroborationFindingKind,
  type NormalizedCoverage,
} from "../src/contract/corroboration.js";

const root = mkdtempSync(resolve(tmpdir(), "tieline-corroboration-"));

function findings(
  all: CorroborationFinding[],
  criterion: string,
  kind?: CorroborationFindingKind
): CorroborationFinding[] {
  return all.filter(
    (finding) =>
      finding.acceptance_criterion_stable_id === criterion &&
      (kind === undefined || finding.kind === kind)
  );
}

try {
  mkdirSync(resolve(root, ".tieline/contract"), { recursive: true });
  mkdirSync(resolve(root, "src"), { recursive: true });
  mkdirSync(resolve(root, "scripts"), { recursive: true });
  writeFileSync(resolve(root, "src/feature.ts"), "export const feature = 1;\n");
  writeFileSync(resolve(root, "src/helper.ts"), "export const helper = 1;\n");
  writeFileSync(resolve(root, "src/unused.ts"), "export const unused = 1;\n");
  writeFileSync(resolve(root, "scripts/feature.test.ts"), "assert(feature);\n");
  writeFileSync(resolve(root, "scripts/absent.test.ts"), "assert(unused);\n");
  writeFileSync(
    resolve(root, ".tieline/contract/feature.yaml"),
    `version: 1
capability:
  key: COV
  name: Execution corroboration
  description: Hold contract links against observed execution.
  stories:
    - key: US-COV-001
      title: Corroborate contract links
      actor: maintainer
      goal: see which claimed links execution actually supports
      benefit: unsupported claims surface during review
      lifecycle: production
      acceptance_criteria:
        - key: AC-COV-001
          criterion: Tieline must corroborate an executed implementation link.
          links:
            - relation: implements
              target:
                kind: code
                repository: corroboration-fixture
                path: src/feature.ts
            - relation: tests
              target:
                kind: test
                repository: corroboration-fixture
                path: scripts/feature.test.ts
                framework_hint: custom-script
        - key: AC-COV-002
          criterion: Tieline must report an implementation link the run never entered.
          links:
            - relation: enforces
              target:
                kind: code
                repository: corroboration-fixture
                path: src/unused.ts
            - relation: tests
              target:
                kind: test
                repository: corroboration-fixture
                path: scripts/feature.test.ts
                framework_hint: custom-script
        - key: AC-COV-003
          criterion: Tieline must report that an unlinked-test criterion has no evidence.
          links:
            - relation: implements
              target:
                kind: code
                repository: corroboration-fixture
                path: src/feature.ts
        - key: AC-COV-004
          criterion: Tieline must suppress conclusions when the linked tests did not run.
          links:
            - relation: implements
              target:
                kind: code
                repository: corroboration-fixture
                path: src/unused.ts
            - relation: tests
              target:
                kind: test
                repository: corroboration-fixture
                path: scripts/absent.test.ts
                framework_hint: custom-script
`
  );

  const manifest = compileContractManifest({
    repositoryRoot: root,
    repositoryKey: "corroboration-fixture",
    commit: "HEAD",
    specDirectory: ".tieline/contract",
  });

  // LCOV parsing, including records whose paths escape the repository.
  const lcovPath = resolve(root, "coverage.info");
  writeFileSync(
    lcovPath,
    `TN:
SF:src/feature.ts
DA:1,3
DA:2,3
DA:7,0
LF:3
LH:2
end_of_record
TN:
SF:scripts/feature.test.ts
DA:1,1
DA:2,1
end_of_record
TN:
SF:src/unused.ts
DA:1,0
DA:2,0
end_of_record
TN:
SF:/outside/repository/vendor/lib.js
DA:1,9
end_of_record
TN:
SF:../sibling/escape.ts
DA:1,9
end_of_record
`
  );

  assert.equal(detectCoverageFormat("SF:src/feature.ts\n"), "lcov");
  assert.equal(detectCoverageFormat("{}"), "istanbul_json");
  assert.equal(detectCoverageFormat("   "), null);

  const coverage = readCoverageReport({ path: lcovPath, repositoryRoot: root });
  assert.equal(coverage.format, "lcov");
  assert.deepEqual(
    coverage.files.map((file) => file.path),
    ["scripts/feature.test.ts", "src/feature.ts", "src/unused.ts"]
  );
  assert.deepEqual(coverage.dropped_paths, [
    "../sibling/escape.ts",
    "/outside/repository/vendor/lib.js",
  ]);
  const feature = coverage.files.find((file) => file.path === "src/feature.ts");
  assert.ok(feature);
  assert.equal(feature.executed, true);
  assert.equal(feature.executed_line_count, 2);
  assert.deepEqual(feature.executed_line_ranges, [{ start: 1, end: 2 }]);
  const unused = coverage.files.find((file) => file.path === "src/unused.ts");
  assert.ok(unused);
  assert.equal(unused.executed, false);
  assert.deepEqual(unused.executed_line_ranges, []);

  // Istanbul JSON detail form, keyed by absolute path.
  const istanbulDetail = parseCoverageReport({
    repositoryRoot: root,
    content: JSON.stringify({
      [resolve(root, "src/feature.ts")]: {
        path: resolve(root, "src/feature.ts"),
        statementMap: {
          "0": { start: { line: 1, column: 0 }, end: { line: 2, column: 12 } },
          "1": { start: { line: 9, column: 0 }, end: { line: 9, column: 4 } },
        },
        s: { "0": 4, "1": 0 },
        fnMap: {},
        f: {},
        branchMap: {},
        b: {},
      },
      "/outside/repository/vendor/lib.js": {
        path: "/outside/repository/vendor/lib.js",
        statementMap: {
          "0": { start: { line: 1, column: 0 }, end: { line: 1, column: 4 } },
        },
        s: { "0": 12 },
        fnMap: {},
        f: {},
        branchMap: {},
        b: {},
      },
    }),
  });
  assert.equal(istanbulDetail.format, "istanbul_json");
  assert.deepEqual(
    istanbulDetail.files.map((file) => file.path),
    ["src/feature.ts"]
  );
  assert.deepEqual(istanbulDetail.files[0].executed_line_ranges, [
    { start: 1, end: 2 },
  ]);
  assert.deepEqual(istanbulDetail.dropped_paths, [
    "/outside/repository/vendor/lib.js",
  ]);

  // Istanbul JSON summary form has no line detail, only totals.
  const istanbulSummary = parseCoverageReport({
    repositoryRoot: root,
    content: JSON.stringify({
      total: { lines: { total: 9, covered: 5, skipped: 0, pct: 55.5 } },
      [resolve(root, "src/feature.ts")]: {
        lines: { total: 5, covered: 5, skipped: 0, pct: 100 },
        statements: { total: 5, covered: 5, skipped: 0, pct: 100 },
      },
      [resolve(root, "src/unused.ts")]: {
        lines: { total: 4, covered: 0, skipped: 0, pct: 0 },
        statements: { total: 4, covered: 0, skipped: 0, pct: 0 },
      },
    }),
  });
  assert.equal(istanbulSummary.format, "istanbul_json_summary");
  assert.deepEqual(
    istanbulSummary.files.map((file) => [file.path, file.executed]),
    [
      ["src/feature.ts", true],
      ["src/unused.ts", false],
    ]
  );
  assert.equal(istanbulSummary.files[0].executed_line_ranges, null);

  // Unrecognized and malformed input must fail loudly, never yield emptiness.
  assert.throws(
    () => parseCoverageReport({ content: "hello world\n", repositoryRoot: root }),
    (error: unknown) =>
      error instanceof CoverageParseError &&
      /not a recognized coverage report/i.test(error.message)
  );
  assert.throws(
    () => parseCoverageReport({ content: "   ", repositoryRoot: root }),
    CoverageParseError
  );
  assert.throws(
    () => parseCoverageReport({ content: "{ oops", repositoryRoot: root }),
    (error: unknown) =>
      error instanceof CoverageParseError && /not valid JSON/i.test(error.message)
  );
  assert.throws(
    () => parseCoverageReport({ content: "{}", repositoryRoot: root }),
    (error: unknown) =>
      error instanceof CoverageParseError && /no file entries/i.test(error.message)
  );
  assert.throws(
    () =>
      parseCoverageReport({
        repositoryRoot: root,
        content: JSON.stringify({ "src/feature.ts": { totally: "unknown" } }),
      }),
    (error: unknown) =>
      error instanceof CoverageParseError &&
      /matches no supported coverage shape/i.test(error.message)
  );
  assert.throws(
    () =>
      parseCoverageReport({
        repositoryRoot: root,
        content: "SF:src/feature.ts\nDA:abc\nend_of_record\n",
      }),
    (error: unknown) =>
      error instanceof CoverageParseError &&
      /Unreadable LCOV 'DA:' entry/.test(error.message)
  );
  assert.throws(
    () =>
      parseCoverageReport({
        repositoryRoot: root,
        content: "SF:src/feature.ts\nend_of_record\nDA:1,1\n",
      }),
    (error: unknown) =>
      error instanceof CoverageParseError &&
      /before any 'SF:' record/.test(error.message)
  );
  assert.throws(
    () => readCoverageReport({ path: resolve(root, "missing.info"), repositoryRoot: root }),
    (error: unknown) =>
      error instanceof CoverageParseError &&
      /Cannot read coverage report/.test(error.message)
  );

  // Per-test attribution used only to suggest candidate links.
  const attribution: NormalizedCoverage = parseCoverageReport({
    repositoryRoot: root,
    sourceLabel: "scripts/feature.test.ts run",
    content: `TN:feature
SF:scripts/feature.test.ts
DA:1,1
DA:2,1
end_of_record
TN:feature
SF:src/feature.ts
DA:1,3
DA:2,3
end_of_record
TN:feature
SF:src/helper.ts
DA:1,1
DA:2,1
DA:3,1
DA:4,1
DA:5,1
DA:6,1
end_of_record
`,
  });

  const report = analyzeExecutionCorroboration({
    manifest,
    coverage,
    attributions: [
      { test_path: "scripts/feature.test.ts", coverage: attribution },
    ],
  });

  assert.equal(report.summary.coverage_format, "lcov");
  assert.equal(report.summary.coverage_usable, true);
  assert.equal(report.summary.reported_files, 3);
  assert.equal(report.summary.executed_files, 2);
  assert.equal(report.summary.dropped_paths_outside_repository, 2);
  assert.equal(report.summary.attributed_test_runs, 1);
  assert.equal(report.summary.candidate_links_evaluated, true);
  assert.equal(report.summary.acceptance_criteria_examined, 4);
  assert.equal(report.summary.acceptance_criteria_with_test_evidence, 2);

  // An acceptance criterion whose tests ran but whose implementation link was
  // never executed has evidence against it, so it must not also be counted as
  // corroborated. Corroborated is a strict subset of with_test_evidence.
  assert.ok(
    report.summary.acceptance_criteria_corroborated_by_execution <=
      report.summary.acceptance_criteria_with_test_evidence
  );
  const unsupportedCriteria = new Set(
    report.findings
      .filter((finding) => finding.kind === "unsupported_implementation")
      .map((finding) => finding.acceptance_criterion_stable_id)
  );
  assert.equal(
    report.summary.acceptance_criteria_corroborated_by_execution,
    report.summary.acceptance_criteria_with_test_evidence -
      unsupportedCriteria.size
  );

  // Stable sort order, by acceptance criterion then kind then path.
  assert.deepEqual(
    report.findings.map((finding) => [
      finding.acceptance_criterion_stable_id,
      finding.kind,
      finding.path,
      finding.reason,
    ]),
    [...report.findings]
      .sort(
        (left, right) =>
          left.acceptance_criterion_stable_id.localeCompare(
            right.acceptance_criterion_stable_id
          ) ||
          left.kind.localeCompare(right.kind) ||
          (left.path ?? "").localeCompare(right.path ?? "")
      )
      .map((finding) => [
        finding.acceptance_criterion_stable_id,
        finding.kind,
        finding.path,
        finding.reason,
      ])
  );

  // AC-COV-001: executed implementation, executed linked test. No complaint.
  assert.deepEqual(findings(report.findings, "AC-COV-001", "unsupported_implementation"), []);
  assert.deepEqual(findings(report.findings, "AC-COV-001", "uncovered_by_linked_tests"), []);

  // Candidate link: executed by the linked test, not linked by the criterion.
  const candidates = findings(report.findings, "AC-COV-001", "candidate_link");
  assert.deepEqual(
    candidates.map((finding) => finding.path),
    ["src/helper.ts"]
  );
  assert.equal(candidates[0].relation, "unlinked");
  assert.equal(candidates[0].reason, "executed_by_linked_tests_but_unlinked");
  assert.equal(candidates[0].executed_line_count, 6);
  assert.deepEqual(candidates[0].executed_line_ranges, [{ start: 1, end: 6 }]);

  // AC-COV-002: linked test ran, linked code never entered. Evidence against.
  const unsupported = findings(report.findings, "AC-COV-002", "unsupported_implementation");
  assert.equal(unsupported.length, 1);
  assert.equal(unsupported[0].path, "src/unused.ts");
  assert.equal(unsupported[0].relation, "enforces");
  assert.equal(unsupported[0].reason, "linked_code_present_but_not_executed");
  assert.equal(unsupported[0].executed_line_count, 0);
  assert.deepEqual(findings(report.findings, "AC-COV-002", "uncovered_by_linked_tests"), []);

  // AC-COV-003: no linked tests at all. No evidence either way, and no verdict
  // on its implementation link even though that file did execute.
  const noTests = findings(report.findings, "AC-COV-003", "uncovered_by_linked_tests");
  assert.equal(noTests.length, 1);
  assert.equal(noTests[0].path, null);
  assert.equal(noTests[0].reason, "no_linked_tests");
  assert.deepEqual(findings(report.findings, "AC-COV-003", "unsupported_implementation"), []);
  assert.deepEqual(findings(report.findings, "AC-COV-003", "candidate_link"), []);

  // AC-COV-004: precedence. Its linked test is absent from the run, so the
  // unexecuted implementation link must NOT be reported as unsupported.
  const suppressed = findings(report.findings, "AC-COV-004", "uncovered_by_linked_tests");
  assert.equal(suppressed.length, 1);
  assert.equal(suppressed[0].path, "scripts/absent.test.ts");
  assert.equal(suppressed[0].reason, "linked_test_absent_from_run");
  assert.deepEqual(findings(report.findings, "AC-COV-004", "unsupported_implementation"), []);

  // The two kinds never coexist for one acceptance criterion.
  for (const criterion of ["AC-COV-001", "AC-COV-002", "AC-COV-003", "AC-COV-004"]) {
    const kinds = new Set(findings(report.findings, criterion).map((finding) => finding.kind));
    assert.equal(
      kinds.has("unsupported_implementation") && kinds.has("uncovered_by_linked_tests"),
      false,
      `${criterion} must not mix evidence-against with no-evidence-either-way`
    );
  }

  assert.deepEqual(report.summary.findings_by_kind, {
    candidate_link: 2,
    uncovered_by_linked_tests: 2,
    unsupported_implementation: 1,
  });

  // A test file present in the run but never entered is distinct from absent.
  const idleTests = analyzeExecutionCorroboration({
    manifest,
    coverage: parseCoverageReport({
      repositoryRoot: root,
      content: `SF:scripts/feature.test.ts
DA:1,0
end_of_record
SF:src/feature.ts
DA:1,0
end_of_record
`,
    }),
  });
  assert.equal(idleTests.summary.coverage_usable, false);
  assert.equal(idleTests.summary.acceptance_criteria_with_test_evidence, 0);
  assert.equal(idleTests.summary.acceptance_criteria_corroborated_by_execution, 0);
  assert.equal(idleTests.summary.findings_by_kind.unsupported_implementation, 0);
  assert.equal(
    findings(idleTests.findings, "AC-COV-001", "uncovered_by_linked_tests")[0].reason,
    "linked_test_present_but_not_executed"
  );

  // Without attributions no candidate link is ever suggested.
  const withoutAttributions = analyzeExecutionCorroboration({ manifest, coverage });
  assert.equal(withoutAttributions.summary.candidate_links_evaluated, false);
  assert.equal(withoutAttributions.summary.findings_by_kind.candidate_link, 0);

  // The suggestion threshold is honoured.
  const strict = analyzeExecutionCorroboration({
    manifest,
    coverage,
    attributions: [{ test_path: "scripts/feature.test.ts", coverage: attribution }],
    candidateLinkMinimumExecutedLines: 7,
  });
  assert.equal(strict.summary.findings_by_kind.candidate_link, 0);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("corroboration tests passed");
