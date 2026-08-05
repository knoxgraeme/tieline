import assert from "node:assert/strict";
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
import type { RepositoryPathChange } from "../src/contract/impact.js";
import { buildGradeScope } from "../src/contract/grade.js";
import { compileContractManifest } from "../src/contract/manifest.js";

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
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("grade tests passed");
