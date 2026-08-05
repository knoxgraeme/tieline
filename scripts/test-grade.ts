import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runCli, type TielineCliIO } from "../src/cli.js";
import type { RepositoryPathChange } from "../src/contract/impact.js";
import {
  buildGradeScope,
  GradeVerdictError,
  parseGradeVerdicts,
  verifyGradeVerdicts,
  type GradeScope,
} from "../src/contract/grade.js";
import {
  compileContractManifest,
  compileContractManifestWithSources,
  writeContractManifest,
} from "../src/contract/manifest.js";

const REPOSITORY = "grade-fixture";
const root = mkdtempSync(resolve(tmpdir(), "tieline-grade-"));

try {
  mkdirSync(resolve(root, ".tieline/spec"), { recursive: true });
  mkdirSync(resolve(root, "src"), { recursive: true });
  writeFileSync(
    resolve(root, "src/feature.ts"),
    `// commentOnlyFeature is prose, not a legal citation.
export function computeFeature(): number {
  const featureLocal = 1;
  return featureLocal;
}
`
  );
  writeFileSync(
    resolve(root, "src/shared.ts"),
    "export const unrelatedSharedImplementation = true;\n"
  );
  writeFileSync(
    resolve(root, "src/deleted.ts"),
    "export const deletedFeature = true;\n"
  );
  writeFileSync(resolve(root, "src/notes.md"), "# Implementation notes\n");
  writeFileSync(
    resolve(root, "src/unlinked.ts"),
    "export const unlinkedFeature = true;\n"
  );
  writeFileSync(
    resolve(root, ".tieline/spec/feature.yaml"),
    `version: 1
capability:
  key: FEATURE
  name: Grade evidence
  description: Changed contract links can be judged against their acceptance criteria.
  stories:
    - key: FEATURE-001
      title: Grade changed evidence
      actor: reviewing agent
      goal: judge every changed contract link
      benefit: unsupported evidence remains visible
      lifecycle: production
      links:
        - relation: implements
          target:
            kind: code
            repository: ${REPOSITORY}
            path: src/shared.ts
      acceptance_criteria:
        - key: FEATURE-001-AC1
          criterion: Tieline must emit every changed link without relevance filtering.
          links:
            - relation: implements
              target:
                kind: code
                repository: ${REPOSITORY}
                path: src/feature.ts
            - relation: implements
              target:
                kind: code
                repository: ${REPOSITORY}
                path: src/shared.ts
            - relation: implements
              target:
                kind: code
                repository: another-repository
                path: src/feature.ts
        - key: FEATURE-001-AC2
          criterion: Tieline must retain changed evidence that has no readable symbols.
          links:
            - relation: implements
              target:
                kind: code
                repository: ${REPOSITORY}
                path: src/deleted.ts
            - relation: implements
              target:
                kind: code
                repository: ${REPOSITORY}
                path: src/notes.md
`
  );

  const manifest = compileContractManifest({
    repositoryRoot: root,
    repositoryKey: REPOSITORY,
    commit: "grade-fixture",
    specDirectory: ".tieline/spec",
  });
  const scopeFor = (changes: RepositoryPathChange[]) =>
    buildGradeScope({
      repositoryRoot: root,
      base: "HEAD",
      manifest,
      changes,
      sourceRoots: ["src"],
      ignore: [".git", ".tieline"],
      specDirectory: ".tieline/spec",
    });

  const feature = scopeFor([
    { status: "modified", path: "src/feature.ts" },
  ]);
  assert.equal(feature.base, "HEAD");
  assert.equal(feature.repository, REPOSITORY);
  assert.equal(feature.scoped_links, 1);
  assert.equal(feature.entries[0]?.acceptance_criterion_stable_id, "FEATURE-001-AC1");
  assert.equal(feature.entries[0]?.acceptance_criterion, "Tieline must emit every changed link without relevance filtering.");
  assert.equal(feature.entries[0]?.relation, "implements");
  assert.equal(feature.entries[0]?.link_scope, "direct");
  assert.equal(feature.entries[0]?.path, "src/feature.ts");
  assert.equal(feature.entries[0]?.previous_path, null);
  assert.equal(feature.entries[0]?.reason, "modified");
  assert.deepEqual(feature.entries[0]?.symbols, [
    "const:featureLocal",
    "function:computeFeature",
  ]);
  assert.equal(feature.entries[0]?.symbols.includes("function:commentOnlyFeature"), false);
  assert.match(feature.entries[0]?.id ?? "", /^grade:[a-f0-9]{64}$/);
  assert.deepEqual(scopeFor([{ status: "modified", path: "src/feature.ts" }]), feature);

  // Direct and Story-fallback claims are different assertions and both remain
  // in scope. The deliberately unrelated identifier proves grading does not
  // inherit link-plausibility filtering.
  const shared = scopeFor([
    { status: "modified", path: "src/shared.ts" },
  ]);
  assert.equal(shared.scoped_links, 3);
  assert.deepEqual(
    shared.entries.map((entry) => [
      entry.acceptance_criterion_stable_id,
      entry.link_scope,
      entry.path,
    ]),
    [
      ["FEATURE-001-AC1", "direct", "src/shared.ts"],
      ["FEATURE-001-AC1", "story_fallback", "src/shared.ts"],
      ["FEATURE-001-AC2", "story_fallback", "src/shared.ts"],
    ]
  );
  assert.equal(new Set(shared.entries.map((entry) => entry.id)).size, 3);
  assert.deepEqual(shared.entries[0]?.symbols, [
    "const:unrelatedSharedImplementation",
  ]);

  // Links in another repository and unlinked changes are not local grading
  // work, even if their path string happens to match a local file.
  assert.equal(feature.scoped_links, 1);
  assert.deepEqual(
    scopeFor([{ status: "modified", path: "src/unlinked.ts" }]).entries,
    []
  );

  unlinkSync(resolve(root, "src/deleted.ts"));
  const deleted = scopeFor([
    { status: "deleted", path: "src/deleted.ts" },
  ]);
  assert.equal(deleted.entries[0]?.reason, "deleted");
  assert.deepEqual(deleted.entries[0]?.symbols, []);

  const unsupportedLanguage = scopeFor([
    { status: "modified", path: "src/notes.md" },
  ]);
  assert.deepEqual(unsupportedLanguage.entries[0]?.symbols, []);

  renameSync(resolve(root, "src/feature.ts"), resolve(root, "src/renamed.ts"));
  const renamed = scopeFor([
    {
      status: "renamed",
      old_path: "src/feature.ts",
      path: "src/renamed.ts",
    },
  ]);
  assert.equal(renamed.entries[0]?.path, "src/renamed.ts");
  assert.equal(renamed.entries[0]?.previous_path, "src/feature.ts");
  assert.equal(renamed.entries[0]?.reason, "renamed");
  assert.deepEqual(renamed.entries[0]?.symbols, [
    "const:featureLocal",
    "function:computeFeature",
  ]);

  assert.deepEqual(scopeFor([]).entries, []);
  assert.deepEqual(
    scopeFor([
      { status: "modified", path: ".tieline/spec/feature.yaml" },
    ]).entries,
    []
  );

  // Exercise the complete CLI chain over an actual Git diff and sharded
  // manifest. Restore files changed by the focused domain scenarios first.
  renameSync(resolve(root, "src/renamed.ts"), resolve(root, "src/feature.ts"));
  writeFileSync(
    resolve(root, "src/deleted.ts"),
    "export const deletedFeature = true;\n"
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
          manifest: "manifest",
          mcp_config: "mcp.json",
        },
        created_at: "2026-08-04T00:00:00.000Z",
        updated_at: "2026-08-04T00:00:00.000Z",
      },
      null,
      2
    )}\n`
  );
  writeContractManifest(
    resolve(root, ".tieline/manifest"),
    compileContractManifestWithSources({
      repositoryRoot: root,
      repositoryKey: REPOSITORY,
      commit: "HEAD",
      specDirectory: ".tieline/spec",
    })
  );
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.test"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Tieline Test"], {
    cwd: root,
  });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "baseline"], {
    cwd: root,
    stdio: "ignore",
  });

  let output = "";
  const io: TielineCliIO = {
    write(message) {
      output += message;
    },
    error(message) {
      throw new Error(message);
    },
    async question() {
      throw new Error("contract grade must not prompt");
    },
  };

  // An empty diff is an explicit successful scope, not an error or omission.
  assert.equal(
    await runCli(
      ["contract", "grade", root, "--base", "HEAD", "--emit-scope", "--json"],
      io,
      {}
    ),
    0
  );
  assert.deepEqual(JSON.parse(output).entries, []);
  assert.equal(JSON.parse(output).scoped_links, 0);

  writeFileSync(
    resolve(root, "src/feature.ts"),
    `${readFeatureSource()}export const changedFeature = true;\n`
  );

  output = "";
  assert.equal(
    await runCli(
      ["contract", "grade", root, "--base", "HEAD", "--emit-scope", "--json"],
      io,
      {}
    ),
    0
  );
  const emitted = JSON.parse(output) as GradeScope;
  assert.equal(emitted.base, "HEAD");
  assert.equal(emitted.repository, REPOSITORY);
  assert.equal(emitted.scoped_links, 1);
  assert.equal(emitted.entries[0].path, "src/feature.ts");
  assert.deepEqual(emitted.entries[0].symbols, [
    "const:changedFeature",
    "const:featureLocal",
    "function:computeFeature",
  ]);

  output = "";
  assert.equal(
    await runCli(
      ["contract", "grade", root, "--base", "HEAD", "--emit-scope"],
      io,
      {}
    ),
    0
  );
  assert.match(output, /Grading scope: 1 changed contract link/);
  assert.match(output, /FEATURE-001-AC1/);
  assert.match(output, /src\/feature\.ts/);
  assert.match(output, /function:computeFeature/);

  const scopeEntry = emitted.entries[0]!;
  const verify = (document: unknown, strict = false) =>
    verifyGradeVerdicts({
      scope: emitted,
      verdicts: parseGradeVerdicts(document),
      strict,
    });

  const supported = verify({
    verdicts: [
      {
        id: scopeEntry.id,
        grade: "supported",
        citation: "function:computeFeature",
      },
    ],
  });
  assert.deepEqual(supported.counts, {
    supported: 1,
    partial: 0,
    unsupported: 0,
  });
  assert.equal(supported.entries[0]?.grade, "supported");
  assert.equal(supported.entries[0]?.cause, null);
  assert.deepEqual(supported.proposed_selectors, [
    {
      acceptance_criterion_stable_id: "FEATURE-001-AC1",
      path: "src/feature.ts",
      selector: "function:computeFeature",
    },
  ]);

  const partial = verify(
    {
      verdicts: [
        {
          id: scopeEntry.id,
          grade: "partial",
          reason: "The symbol contributes, but does not establish the whole outcome.",
        },
      ],
    },
    true
  );
  assert.equal(partial.entries[0]?.grade, "partial");
  assert.equal(partial.strict_failure, false);
  assert.equal(partial.findings.length, 1);

  const unsupported = verify({
    verdicts: [
      {
        id: scopeEntry.id,
        grade: "unsupported",
        reason: "This file no longer implements the accepted outcome.",
      },
    ],
  });
  assert.equal(unsupported.entries[0]?.grade, "unsupported");
  assert.equal(unsupported.entries[0]?.submitted_grade, "unsupported");

  const missing = verify({ verdicts: [] });
  assert.equal(missing.entries[0]?.grade, "unsupported");
  assert.equal(missing.entries[0]?.submitted_grade, null);
  assert.equal(missing.entries[0]?.cause, "missing_verdict");
  assert.equal(missing.missing_verdicts.length, 1);

  for (const citation of ["function:inventedFeature", undefined]) {
    const fabricated = verify({
      verdicts: [
        {
          id: scopeEntry.id,
          grade: "supported",
          ...(citation ? { citation } : {}),
        },
      ],
    });
    assert.equal(fabricated.entries[0]?.grade, "unsupported");
    assert.equal(fabricated.entries[0]?.submitted_grade, "supported");
    assert.equal(fabricated.entries[0]?.cause, "fabricated_citation");
    assert.equal(fabricated.downgrades.length, 1);
  }

  assert.throws(
    () =>
      verify({
        verdicts: [
          {
            id: scopeEntry.id,
            grade: "partial",
            reason: "Some support.",
            citation: "function:computeFeature",
          },
        ],
      }),
    GradeVerdictError
  );
  assert.throws(
    () =>
      verify({
        verdicts: [{ id: scopeEntry.id, grade: "unsupported" }],
      }),
    GradeVerdictError
  );
  assert.throws(
    () =>
      verify({
        verdicts: [
          {
            id: "grade:0000000000000000000000000000000000000000000000000000000000000000",
            grade: "unsupported",
            reason: "Not current scope.",
          },
        ],
      }),
    /outside the derived grading scope/
  );
  assert.throws(
    () =>
      verify({
        verdicts: [
          {
            id: scopeEntry.id,
            grade: "unsupported",
            reason: "First.",
          },
          {
            id: scopeEntry.id,
            grade: "unsupported",
            reason: "Second.",
          },
        ],
      }),
    /Duplicate verdict/
  );
  assert.throws(
    () => parseGradeVerdicts([{ id: scopeEntry.id, grade: "supported" }]),
    GradeVerdictError
  );

  const verdictsPath = resolve(root, "verdicts.json");
  const writeVerdicts = (document: unknown): void => {
    writeFileSync(verdictsPath, `${JSON.stringify(document, null, 2)}\n`);
  };

  writeVerdicts({
    verdicts: [
      {
        id: scopeEntry.id,
        grade: "supported",
        citation: "const:changedFeature",
      },
    ],
  });
  output = "";
  assert.equal(
    await runCli(
      [
        "contract",
        "grade",
        root,
        "--base",
        "HEAD",
        "--verify",
        verdictsPath,
        "--strict",
        "--json",
      ],
      io,
      {}
    ),
    0
  );
  assert.equal(JSON.parse(output).counts.supported, 1);

  writeVerdicts({
    verdicts: [
      {
        id: scopeEntry.id,
        grade: "supported",
        citation: "function:notReal",
      },
    ],
  });
  output = "";
  assert.equal(
    await runCli(
      ["contract", "grade", root, "--base", "HEAD", "--verify", verdictsPath],
      io,
      {}
    ),
    0
  );
  assert.match(output, /unsupported=1/);
  assert.match(output, /fabricated_citation/);

  output = "";
  assert.equal(
    await runCli(
      [
        "contract",
        "grade",
        root,
        "--base",
        "HEAD",
        "--verify",
        verdictsPath,
        "--strict",
      ],
      io,
      {}
    ),
    1
  );
  assert.match(output, /Strict mode/);

  await assert.rejects(
    runCli(
      [
        "contract",
        "grade",
        root,
        "--base",
        "HEAD",
        "--verify",
        "missing-verdicts.json",
      ],
      io,
      {}
    ),
    /Cannot read grade verdicts/
  );

  await assert.rejects(
    runCli(["contract", "grade", root, "--base", "HEAD"], io, {}),
    /requires exactly one of --emit-scope or --verify/
  );
  await assert.rejects(
    runCli(
      [
        "contract",
        "grade",
        root,
        "--base",
        "HEAD",
        "--emit-scope",
        "--verify",
        "verdicts.json",
      ],
      io,
      {}
    ),
    /cannot be used with option '--verify(?: <verdicts\.json>)?'/
  );

  rmSync(resolve(root, ".tieline/manifest"), {
    recursive: true,
    force: true,
  });
  await assert.rejects(
    runCli(
      ["contract", "grade", root, "--base", "HEAD", "--emit-scope"],
      io,
      {}
    ),
    /Cannot derive grading scope.*contract compile/s
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("grade tests passed");

function readFeatureSource(): string {
  return `// commentOnlyFeature is prose, not a legal citation.
export function computeFeature(): number {
  const featureLocal = 1;
  return featureLocal;
}
`;
}
