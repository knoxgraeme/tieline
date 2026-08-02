import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  compileContractManifest,
  serializeContractManifest,
  type ContractManifest,
} from "../src/contract/manifest.js";
import type { RepositoryPathChange } from "../src/contract/impact.js";
import {
  buildGradeScope,
  GradeVerdictError,
  parseGradeVerdicts,
  verifyGradeVerdicts,
  type GradeScope,
} from "../src/contract/grade.js";
import { runContractCommand } from "../src/commands/contract.js";

const REPOSITORY = "grade-fixture";
const FEATURE_SOURCE = `// The helper commentOnlyFeature is described here but never declared.
export function computeFeature(): number {
  const featureLocal = 1;
  return featureLocal;
}
`;

const root = mkdtempSync(resolve(tmpdir(), "tieline-grade-"));
try {
  mkdirSync(resolve(root, ".tieline/spec"), { recursive: true });
  mkdirSync(resolve(root, "src"), { recursive: true });
  mkdirSync(resolve(root, "scripts"), { recursive: true });
  writeFileSync(resolve(root, "src/feature.ts"), FEATURE_SOURCE);
  writeFileSync(
    resolve(root, "src/shared.ts"),
    "export const sharedHelper = 1;\n"
  );
  writeFileSync(
    resolve(root, "src/deleted.ts"),
    "export const doomedHelper = 1;\n"
  );
  writeFileSync(
    resolve(root, "src/renamed.ts"),
    "export function renamedFeature(): number {\n  return 2;\n}\n"
  );
  writeFileSync(
    resolve(root, "src/unlinked.ts"),
    "export const unlinkedHelper = 1;\n"
  );
  writeFileSync(
    resolve(root, "scripts/feature.test.ts"),
    "export function assertFeature(): void {}\n"
  );
  writeFileSync(
    resolve(root, ".tieline/config.json"),
    `${JSON.stringify(
      {
        version: 1,
        product: { name: "Grade fixture", repo_name: REPOSITORY },
        repository: {
          root: "..",
          source_roots: ["src"],
          ignore: [".git", ".tieline"],
        },
        context: { sources: [] },
        runtime: {
          default_embedding_provider: "hash",
          default_database_mode: "offline",
        },
        files: {
          spec_directory: "spec",
          manifest: "manifest.json",
          mcp_config: "mcp.json",
        },
        created_at: "2026-08-02T00:00:00.000Z",
        updated_at: "2026-08-02T00:00:00.000Z",
      },
      null,
      2
    )}\n`
  );
  writeFileSync(
    resolve(root, ".tieline/spec/feature.yaml"),
    `version: 1
capability:
  key: FEATURE
  name: Feature behavior
  description: Keep behavior grounded in implementation.
  stories:
    - key: FEATURE-001
      title: Grade linked behavior
      actor: maintainer
      goal: judge whether a linked artifact serves its criterion
      benefit: link claims become falsifiable
      lifecycle: production
      links:
        - relation: implements
          target:
            kind: code
            repository: ${REPOSITORY}
            path: src/shared.ts
      acceptance_criteria:
        - key: FEATURE-001-AC1
          criterion: Tieline must report a changed implementation path.
          links:
            - relation: implements
              target:
                kind: code
                repository: ${REPOSITORY}
                path: src/feature.ts
            - relation: tests
              target:
                kind: test
                repository: ${REPOSITORY}
                path: scripts/feature.test.ts
                framework_hint: custom-script
            - relation: documents
              target:
                kind: help
                source: helpcenter
                external_id: article-grade-1
        - key: FEATURE-001-AC2
          criterion: Tieline must report a deleted implementation path.
          links:
            - relation: implements
              target:
                kind: code
                repository: ${REPOSITORY}
                path: src/deleted.ts
`
  );

  execFileSync("git", ["init"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.test"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Tieline Test"], { cwd: root });

  const manifest: ContractManifest = compileContractManifest({
    repositoryRoot: root,
    repositoryKey: REPOSITORY,
    commit: "HEAD",
    specDirectory: ".tieline/spec",
  });
  writeFileSync(
    resolve(root, ".tieline/manifest.json"),
    serializeContractManifest(manifest)
  );
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "baseline"], { cwd: root });

  const scopeFor = (changes: RepositoryPathChange[]): GradeScope =>
    buildGradeScope({
      repositoryRoot: root,
      base: "HEAD",
      manifest,
      changes,
      specDirectory: ".tieline/spec",
    });

  // U2-1. A diff touching a linked artifact emits exactly that (AC, path) pair.
  const touched = scopeFor([{ status: "modified", path: "src/feature.ts" }]);
  assert.equal(touched.scoped_links, 1);
  assert.equal(touched.entries.length, 1);
  assert.equal(
    touched.entries[0]!.acceptance_criterion_stable_id,
    "FEATURE-001-AC1"
  );
  assert.equal(touched.entries[0]!.path, "src/feature.ts");

  // U2-2. A diff touching an unlinked file emits nothing.
  assert.equal(
    scopeFor([{ status: "modified", path: "src/unlinked.ts" }]).scoped_links,
    0
  );

  // U2-3. A renamed linked artifact is emitted, keyed to its new path.
  const renamed = scopeFor([
    {
      status: "renamed",
      old_path: "src/feature.ts",
      path: "src/renamed.ts",
    },
  ]);
  assert.equal(renamed.entries.length, 1);
  assert.equal(renamed.entries[0]!.path, "src/renamed.ts");
  assert.equal(renamed.entries[0]!.previous_path, "src/feature.ts");
  assert.equal(renamed.entries[0]!.reason, "renamed");
  assert.deepEqual(renamed.entries[0]!.vocabulary, ["renamedFeature"]);

  // U2-4. A deleted linked artifact is emitted with an empty vocabulary.
  unlinkSync(resolve(root, "src/deleted.ts"));
  const deleted = scopeFor([{ status: "deleted", path: "src/deleted.ts" }]);
  assert.equal(deleted.entries.length, 1);
  assert.equal(deleted.entries[0]!.acceptance_criterion_stable_id, "FEATURE-001-AC2");
  assert.equal(deleted.entries[0]!.reason, "deleted");
  assert.deepEqual(deleted.entries[0]!.vocabulary, []);
  writeFileSync(
    resolve(root, "src/deleted.ts"),
    "export const doomedHelper = 1;\n"
  );

  // U2-5. An empty diff emits an empty scope.
  assert.deepEqual(scopeFor([]).entries, []);
  assert.equal(scopeFor([]).scoped_links, 0);

  // U2-6. Emitted entries carry AC criterion text, relation, path, and vocabulary.
  const detailed = touched.entries[0]!;
  assert.equal(
    detailed.criterion,
    "Tieline must report a changed implementation path."
  );
  assert.equal(detailed.relation, "implements");
  assert.equal(detailed.kind, "code");
  assert.equal(detailed.story_stable_id, "FEATURE-001");
  assert.equal(detailed.link_scope, "direct");
  assert.deepEqual(detailed.vocabulary, ["computeFeature", "featureLocal"]);
  assert.equal(detailed.vocabulary.includes("commentOnlyFeature"), false);

  // U2-7. `help`-kind links never appear in scope.
  const everything = scopeFor([
    { status: "modified", path: "src/feature.ts" },
    { status: "modified", path: "scripts/feature.test.ts" },
    { status: "modified", path: "src/shared.ts" },
    { status: "modified", path: "src/deleted.ts" },
    { status: "modified", path: "src/unlinked.ts" },
    { status: "modified", path: "article-grade-1" },
  ]);
  assert.deepEqual(
    [...new Set(everything.entries.map((entry) => entry.kind))].sort(),
    ["code", "test"]
  );
  assert.equal(
    everything.entries.every((entry) => entry.path !== "article-grade-1"),
    true
  );
  assert.equal(everything.scoped_links, 5);

  // U2-8. `link_scope: "contract"` impacts never appear in scope.
  assert.deepEqual(
    scopeFor([{ status: "modified", path: ".tieline/spec/feature.yaml" }])
      .entries,
    []
  );

  // U2-9. Story-level fallback links appear, attributed to each AC under that story.
  const fallback = scopeFor([{ status: "modified", path: "src/shared.ts" }]);
  assert.equal(fallback.entries.length, 2);
  assert.deepEqual(
    fallback.entries.map((entry) => entry.acceptance_criterion_stable_id),
    ["FEATURE-001-AC1", "FEATURE-001-AC2"]
  );
  assert.equal(
    fallback.entries.every(
      (entry) =>
        entry.path === "src/shared.ts" && entry.link_scope === "story_fallback"
    ),
    true
  );

  // U2-10. `--emit-scope` and `--verify` are mutually exclusive.
  await assert.rejects(
    runContractCommand(
      "grade",
      {
        repository: root,
        base: "HEAD",
        emitScope: true,
        verify: "verdicts.json",
      },
      { write: () => undefined }
    ),
    /mutually exclusive/
  );
  await assert.rejects(
    runContractCommand(
      "grade",
      { repository: root, base: "HEAD" },
      { write: () => undefined }
    ),
    /requires either --emit-scope or --verify/
  );
  await assert.rejects(
    runContractCommand(
      "grade",
      { repository: root, emitScope: true },
      { write: () => undefined }
    ),
    /requires --base/
  );

  const identity = {
    acceptance_criterion_stable_id: "FEATURE-001-AC1",
    path: "src/feature.ts",
  };
  const verify = (verdicts: unknown, strict = false) =>
    verifyGradeVerdicts({
      scope: touched,
      verdicts: parseGradeVerdicts(verdicts),
      strict,
    });

  // U3-1. `supported` citing a vocabulary member is retained.
  const supported = verify([
    { ...identity, grade: "supported", symbol: "computeFeature" },
  ]);
  assert.equal(supported.counts.supported, 1);
  assert.equal(supported.entries[0]!.grade, "supported");
  assert.equal(supported.entries[0]!.downgraded, false);
  assert.deepEqual(supported.proposed_selectors, [
    {
      acceptance_criterion_stable_id: "FEATURE-001-AC1",
      path: "src/feature.ts",
      selector: "computeFeature",
    },
  ]);

  // U3-2. `supported` citing a symbol absent from the vocabulary is downgraded and reported.
  const fabricated = verify([
    { ...identity, grade: "supported", symbol: "totallyInventedSymbol" },
  ]);
  assert.equal(fabricated.counts.supported, 0);
  assert.equal(fabricated.counts.unsupported, 1);
  assert.equal(fabricated.entries[0]!.grade, "unsupported");
  assert.equal(fabricated.entries[0]!.submitted_grade, "supported");
  assert.equal(fabricated.entries[0]!.downgraded, true);
  assert.equal(fabricated.entries[0]!.downgrade_reason, "fabricated_citation");
  assert.equal(fabricated.downgrades.length, 1);
  assert.match(fabricated.entries[0]!.reason, /totallyInventedSymbol/);
  assert.deepEqual(fabricated.proposed_selectors, []);

  // U3-3. `supported` citing an identifier that exists only in a comment is downgraded.
  const commentCitation = verify([
    { ...identity, grade: "supported", symbol: "commentOnlyFeature" },
  ]);
  assert.equal(commentCitation.entries[0]!.grade, "unsupported");
  assert.equal(commentCitation.entries[0]!.downgraded, true);
  assert.equal(
    commentCitation.entries[0]!.downgrade_reason,
    "fabricated_citation"
  );

  // U3-4. `supported` with no `symbol` field is rejected as malformed.
  assert.throws(
    () => parseGradeVerdicts([{ ...identity, grade: "supported" }]),
    GradeVerdictError
  );

  // U3-5. `partial` with a reason is retained; `partial` carrying a `symbol` is rejected.
  const partial = verify([
    {
      ...identity,
      grade: "partial",
      reason: "The module participates but no single symbol carries the AC.",
    },
  ]);
  assert.equal(partial.counts.partial, 1);
  assert.equal(partial.entries[0]!.grade, "partial");
  assert.equal(partial.entries[0]!.symbol, null);
  assert.equal(partial.findings.length, 1);
  assert.throws(
    () =>
      parseGradeVerdicts([
        {
          ...identity,
          grade: "partial",
          reason: "Participates.",
          symbol: "computeFeature",
        },
      ]),
    GradeVerdictError
  );
  assert.throws(
    () => parseGradeVerdicts([{ ...identity, grade: "partial" }]),
    GradeVerdictError
  );

  // U3-6. `unsupported` is retained and appears in the report.
  const unsupported = verify([
    {
      ...identity,
      grade: "unsupported",
      reason: "Nothing in this module serves the criterion.",
    },
  ]);
  assert.equal(unsupported.counts.unsupported, 1);
  assert.equal(unsupported.findings.length, 1);
  assert.equal(unsupported.entries[0]!.downgraded, false);
  assert.equal(unsupported.entries[0]!.missing_verdict, false);
  assert.equal(
    unsupported.entries[0]!.reason,
    "Nothing in this module serves the criterion."
  );

  // U3-7. A scoped pair with no submitted verdict is reported as `unsupported`.
  const missing = verify([]);
  assert.equal(missing.scoped_links, 1);
  assert.equal(missing.entries.length, 1);
  assert.equal(missing.counts.unsupported, 1);
  assert.equal(missing.entries[0]!.grade, "unsupported");
  assert.equal(missing.entries[0]!.submitted_grade, null);
  assert.equal(missing.entries[0]!.missing_verdict, true);
  assert.equal(missing.missing_verdicts.length, 1);

  // U3-8. A verdict referencing an (AC, path) pair absent from scope is rejected.
  assert.throws(
    () =>
      verify([
        {
          acceptance_criterion_stable_id: "FEATURE-001-AC2",
          path: "src/deleted.ts",
          grade: "unsupported",
          reason: "Out of scope.",
        },
      ]),
    /outside the derived grading scope/
  );
  assert.throws(
    () =>
      verify([
        { ...identity, path: "src/unlinked.ts", grade: "supported", symbol: "x" },
      ]),
    GradeVerdictError
  );

  // U3-9. Duplicate verdicts for one pair are rejected rather than last-write-wins.
  assert.throws(
    () =>
      verify([
        { ...identity, grade: "supported", symbol: "computeFeature" },
        { ...identity, grade: "unsupported", reason: "Second opinion." },
      ]),
    /Duplicate verdict/
  );

  // The object-wrapped document form is accepted alongside a bare array.
  assert.equal(
    parseGradeVerdicts({
      base: "HEAD",
      repository: REPOSITORY,
      verdicts: [{ ...identity, grade: "supported", symbol: "computeFeature" }],
    }).length,
    1
  );
  assert.throws(
    () => parseGradeVerdicts({ verdicts: [{ ...identity, grade: "unknown" }] }),
    GradeVerdictError
  );

  // Strict is a pure function of the counts, independent of the CLI.
  assert.equal(
    verify([{ ...identity, grade: "unsupported", reason: "None." }], true)
      .strict_failure,
    true
  );
  assert.equal(
    verify([{ ...identity, grade: "partial", reason: "Some." }], true)
      .strict_failure,
    false
  );

  // CLI modes: a working-tree change produces the same scope the fence consumes.
  writeFileSync(
    resolve(root, "src/feature.ts"),
    `${FEATURE_SOURCE}export const extraFeature = 3;\n`
  );
  const emitted: string[] = [];
  assert.equal(
    await runContractCommand(
      "grade",
      { repository: root, base: "HEAD", emitScope: true, json: true },
      { write: (message) => emitted.push(message) }
    ),
    0
  );
  const cliScope = JSON.parse(emitted.join("")) as GradeScope;
  assert.equal(cliScope.base, "HEAD");
  assert.equal(cliScope.repository, REPOSITORY);
  assert.equal(cliScope.scoped_links, 1);
  assert.equal(cliScope.entries[0]!.path, "src/feature.ts");
  assert.deepEqual(cliScope.entries[0]!.vocabulary, [
    "computeFeature",
    "extraFeature",
    "featureLocal",
  ]);

  const verdictsPath = resolve(root, "verdicts.json");
  const writeVerdicts = (verdicts: unknown): void => {
    writeFileSync(verdictsPath, `${JSON.stringify({ verdicts }, null, 2)}\n`);
  };

  // U3-10. `--strict` exits non-zero when any `unsupported` remains.
  writeVerdicts([
    { ...identity, grade: "supported", symbol: "neverDeclaredAnywhere" },
  ]);
  const strictFailOutput: string[] = [];
  assert.equal(
    await runContractCommand(
      "grade",
      {
        repository: root,
        base: "HEAD",
        verify: verdictsPath,
        strict: true,
        json: true,
      },
      { write: (message) => strictFailOutput.push(message) }
    ),
    1
  );
  const strictFailReport = JSON.parse(strictFailOutput.join("")) as {
    counts: Record<string, number>;
    strict_failure: boolean;
    downgrades: Array<{ downgrade_reason: string }>;
  };
  assert.equal(strictFailReport.strict_failure, true);
  assert.equal(strictFailReport.counts.unsupported, 1);
  assert.equal(
    strictFailReport.downgrades[0]!.downgrade_reason,
    "fabricated_citation"
  );

  // U3-11. `--strict` exits 0 when all grades are `supported` or `partial`.
  writeVerdicts([
    { ...identity, grade: "supported", symbol: "extraFeature" },
  ]);
  const strictPassOutput: string[] = [];
  assert.equal(
    await runContractCommand(
      "grade",
      {
        repository: root,
        base: "HEAD",
        verify: verdictsPath,
        strict: true,
      },
      { write: (message) => strictPassOutput.push(message) }
    ),
    0
  );
  assert.match(strictPassOutput.join(""), /supported=1/);
  assert.match(strictPassOutput.join(""), /proposes selector 'extraFeature'/);

  // U3-12. Without `--strict`, `unsupported` entries still print and the command exits 0.
  writeVerdicts([
    {
      ...identity,
      grade: "unsupported",
      reason: "The added export does not serve this criterion.",
    },
  ]);
  const advisoryOutput: string[] = [];
  assert.equal(
    await runContractCommand(
      "grade",
      { repository: root, base: "HEAD", verify: verdictsPath },
      { write: (message) => advisoryOutput.push(message) }
    ),
    0
  );
  assert.match(advisoryOutput.join(""), /unsupported=1/);
  assert.match(
    advisoryOutput.join(""),
    /The added export does not serve this criterion\./
  );
  assert.equal(/error {2}Strict mode/.test(advisoryOutput.join("")), false);

  // A missing verdicts file is an input error, not a grade.
  await assert.rejects(
    runContractCommand(
      "grade",
      { repository: root, base: "HEAD", verify: resolve(root, "absent.json") },
      { write: () => undefined }
    ),
    /Cannot read grade verdicts/
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("grade tests passed");
