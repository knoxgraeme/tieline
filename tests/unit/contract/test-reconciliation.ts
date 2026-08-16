import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileContractManifest } from "../../../src/contract/manifest.js";
import type { RepositoryPathChange } from "../../../src/contract/impact.js";
import {
  analyzeContractReconciliation,
  buildContractClaimIndex,
  buildContractIntentIndex,
  type ContractReconciliation,
} from "../../../src/contract/reconciliation.js";
import { tielineConfigJson } from "../../support/fixtures.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const root = mkdtempSync(resolve(tmpdir(), "tieline-reconciliation-"));
try {
  mkdirSync(resolve(root, ".tieline/contract"), { recursive: true });
  mkdirSync(resolve(root, "src/generated"), { recursive: true });
  mkdirSync(resolve(root, "docs"), { recursive: true });
  const sourceFiles = [
    "src/claimed-direct.ts",
    "src/claimed-story.ts",
    "src/renamed-before.ts",
    "src/deleted-claimed.ts",
    "src/unclaimed.ts",
    "src/gone.ts",
    "src/generated/output.ts",
  ];
  for (const path of sourceFiles) {
    writeFileSync(resolve(root, path), `export const value = "${path}";\n`);
  }
  writeFileSync(
    resolve(root, "src/claimed-direct.ts"),
    "export function first() {}\nexport function second() {}\n"
  );
  writeFileSync(resolve(root, "docs/guide.md"), "# Guide\n");
  writeFileSync(
    resolve(root, ".tieline/config.json"),
    tielineConfigJson({
      name: "Reconciliation fixture",
      repoName: "reconciliation-fixture",
    })
  );
  writeFileSync(
    resolve(root, ".tieline/contract/reconciliation.yaml"),
    `version: 1
capability:
  key: RECONCILE
  name: Reconciliation signal
  description: Hand the author structured signal instead of prose instructions.
  stories:
    - key: US-RECONCILE-001
      title: See what the contract already claims
      actor: author
      goal: know which criteria already describe the changed files
      benefit: reconciliation starts from data instead of a fresh reading
      lifecycle: production
      links:
        - relation: implements
          provenance: authored
          target:
            kind: code
            repository: reconciliation-fixture
            path: src/claimed-story.ts
      acceptance_criteria:
        - key: AC-RECONCILE-001
          criterion: Tieline must list the acceptance criteria claiming a changed path.
          links:
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: reconciliation-fixture
                path: src/claimed-direct.ts
                selector: " function:first "
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: reconciliation-fixture
                path: src/claimed-direct.ts
                selector: function:second
            - relation: tests
              provenance: authored
              target:
                kind: test
                repository: reconciliation-fixture
                path: src/renamed-before.ts
                selector: function:value
                framework_hint: node-test
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: another-repository
                path: src/external.ts
                selector: function:external
            - relation: tests
              provenance: authored
              target:
                kind: test
                repository: another-repository
                path: test/external.test.ts
                selector: function:externalTest
                framework_hint: node-test
        - key: AC-RECONCILE-002
          criterion: Tieline must report a changed path whose evidence was removed.
          links:
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: reconciliation-fixture
                path: src/deleted-claimed.ts
`
  );

  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.test"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Tieline Test"], { cwd: root });

  const manifest = compileContractManifest({
    repositoryRoot: root,
    repositoryKey: "reconciliation-fixture",
    specDirectory: ".tieline/contract",
  });

  let capabilityWalks = 0;
  const countedManifest: typeof manifest = {
    ...manifest,
    capabilities: new Proxy(manifest.capabilities, {
      get(target, property, receiver) {
        if (property === Symbol.iterator) {
          return function* () {
            capabilityWalks += 1;
            yield* target;
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }),
  };
  const intentIndex = buildContractIntentIndex(countedManifest);
  assert.equal(capabilityWalks, 1, "both views come from one ordered contract walk");
  assert.equal(
    buildContractClaimIndex(manifest).get("src/claimed-direct.ts")?.length,
    2,
    "the compatibility path view preserves same-file selectors"
  );
  const selectorClaims =
    intentIndex.claims_by_path.get("src/claimed-direct.ts") ?? [];
  assert.deepEqual(
    selectorClaims.map((claim) => [
      claim.target_kind,
      claim.repository,
      claim.linked_path,
      claim.selector,
      claim.framework_hint,
      claim.relation,
      claim.link_scope,
    ]),
    [
      [
        "code",
        "reconciliation-fixture",
        "src/claimed-direct.ts",
        "function:first",
        null,
        "implements",
        "direct",
      ],
      [
        "code",
        "reconciliation-fixture",
        "src/claimed-direct.ts",
        "function:second",
        null,
        "implements",
        "direct",
      ],
    ]
  );
  const criterionRecord =
    intentIndex.acceptance_criteria_by_stable_id.get("AC-RECONCILE-001");
  assert.ok(criterionRecord);
  assert.equal(
    criterionRecord.claims.find(
      (claim) => claim.selector === "function:first"
    ),
    selectorClaims[0],
    "the AC and path views share the same normalized claim records"
  );
  assert.deepEqual(
    criterionRecord.claims
      .filter((claim) => claim.repository === "another-repository")
      .map((claim) => [
        claim.target_kind,
        claim.linked_path,
        claim.selector,
        claim.framework_hint,
      ]),
    [
      ["code", "src/external.ts", "function:external", null],
      [
        "test",
        "test/external.test.ts",
        "function:externalTest",
        "node-test",
      ],
    ]
  );
  assert.equal(intentIndex.claims_by_path.has("src/external.ts"), false);
  assert.equal(intentIndex.claims_by_path.has("test/external.test.ts"), false);
  assert.ok(
    criterionRecord.claims.every(
      (claim) => claim.target_kind === "code" || claim.target_kind === "test"
    )
  );
  const testClaim = criterionRecord.claims.find(
    (claim) =>
      claim.target_kind === "test" &&
      claim.repository === "reconciliation-fixture"
  );
  assert.equal(testClaim?.framework_hint, "node-test");
  assert.match(
    testClaim?.reviewed_content_hash ?? "",
    /^[a-f0-9]{64}$/,
    "the shared claim carries the reviewed hash needed by assurance inspection"
  );

  const duplicateManifest = structuredClone(manifest);
  const duplicateLinks =
    duplicateManifest.capabilities[0]!.stories[0]!.acceptance_criteria[0]!.links;
  const duplicate = duplicateLinks.find(
    (link) =>
      link.target.kind === "code" &&
      link.target.repository === "reconciliation-fixture" &&
      link.target.path === "src/claimed-direct.ts" &&
      link.target.selector === "function:first"
  );
  assert.ok(duplicate);
  duplicateLinks.push(structuredClone(duplicate));
  assert.equal(
    buildContractIntentIndex(duplicateManifest).claims_by_path.get(
      "src/claimed-direct.ts"
    )?.length,
    2,
    "identical full-locator claims deduplicate"
  );

  const changes: RepositoryPathChange[] = [
    { status: "modified", path: "src/claimed-direct.ts" },
    { status: "modified", path: "src/claimed-story.ts" },
    { status: "added", path: "src/unclaimed.ts" },
    { status: "deleted", path: "src/deleted-claimed.ts" },
    { status: "deleted", path: "src/gone.ts" },
    { status: "modified", path: "docs/guide.md" },
    { status: "modified", path: "src/generated/output.ts" },
    { status: "modified", path: ".tieline/contract/reconciliation.yaml" },
    {
      status: "renamed",
      old_path: "src/renamed-before.ts",
      path: "src/renamed-after.ts",
    },
  ];
  const analyze = (input: RepositoryPathChange[]): ContractReconciliation =>
    analyzeContractReconciliation({
      repositoryRoot: root,
      manifest,
      changes: input,
      sourceRoots: ["src"],
      ignore: [".git", ".tieline", "src/generated"],
      specDirectory: ".tieline/contract",
    });
  const report = analyze(changes);

  assert.equal(report.repository, "reconciliation-fixture");
  assert.equal(report.advisory, true);
  assert.match(report.disclaimer, /not a verdict/i);
  assert.match(report.disclaimer, /refactor/i);

  // A path claimed by a link sitting on the acceptance criterion itself.
  const direct = report.claimed_changes.find(
    (change) => change.path === "src/claimed-direct.ts"
  );
  assert.ok(direct, "a criterion-level link must claim its changed path");
  assert.equal(direct.status, "modified");
  assert.equal(direct.claimed_by.length, 2);
  assert.equal(direct.claimed_by[0].link_scope, "direct");
  assert.equal(
    direct.claimed_by[0].acceptance_criterion_stable_id,
    "AC-RECONCILE-001"
  );
  assert.equal(
    direct.claimed_by[0].acceptance_criterion,
    "Tieline must list the acceptance criteria claiming a changed path."
  );
  assert.equal(direct.claimed_by[0].relation, "implements");
  assert.equal(direct.claimed_by[0].provenance, "authored");
  assert.equal(
    direct.claimed_by[0].story_title,
    "See what the contract already claims"
  );

  // A path claimed only by a Story-level link reaches every criterion of that
  // Story as a fallback.
  const storyFallback = report.claimed_changes.find(
    (change) => change.path === "src/claimed-story.ts"
  );
  assert.ok(storyFallback, "a story-level link must claim its changed path");
  assert.deepEqual(
    storyFallback.claimed_by.map((claim) => [
      claim.acceptance_criterion_stable_id,
      claim.link_scope,
    ]),
    [
      ["AC-RECONCILE-001", "story_fallback"],
      ["AC-RECONCILE-002", "story_fallback"],
    ]
  );

  // A rename is claimed through the pre-rename path the link still names, and
  // both sides of the move travel with the finding.
  const renamed = report.claimed_changes.find(
    (change) => change.path === "src/renamed-after.ts"
  );
  assert.ok(renamed, "a renamed path must be matched through its old path");
  assert.equal(renamed.status, "renamed");
  assert.equal(renamed.old_path, "src/renamed-before.ts");
  assert.equal(renamed.claimed_by[0].linked_path, "src/renamed-before.ts");
  assert.equal(renamed.claimed_by[0].relation, "tests");

  // A deleted path a link claims stays claimed: its criterion just lost its
  // evidence, which is exactly what a human must look at.
  const deletedClaimed = report.claimed_changes.find(
    (change) => change.path === "src/deleted-claimed.ts"
  );
  assert.ok(deletedClaimed, "a deleted claimed path must stay claimed");
  assert.equal(deletedClaimed.status, "deleted");
  assert.deepEqual(
    deletedClaimed.claimed_by.map((claim) => [
      claim.acceptance_criterion_stable_id,
      claim.link_scope,
    ]),
    [["AC-RECONCILE-002", "direct"]]
  );

  // An eligible source file nothing claims is the only candidate for authoring.
  assert.deepEqual(
    report.unclaimed_changes.map((change) => [
      change.path,
      change.status,
      change.source_root,
    ]),
    [["src/unclaimed.ts", "added", "src"]]
  );

  const excluded = new Map(
    report.excluded_changes.map((change) => [change.path, change])
  );
  assert.equal(
    excluded.get("docs/guide.md")?.reason,
    "outside_source_roots"
  );
  assert.equal(excluded.get("src/generated/output.ts")?.reason, "ignored");
  assert.equal(
    excluded.get("src/generated/output.ts")?.matched_ignore_pattern,
    "src/generated"
  );
  assert.equal(
    excluded.get(".tieline/contract/reconciliation.yaml")?.reason,
    "contract_definition"
  );
  // A deleted file nothing claims is not a gap: there is nothing left to
  // describe, so it is set aside with its own reason rather than reported as a
  // candidate for a new acceptance criterion.
  assert.equal(excluded.get("src/gone.ts")?.reason, "deleted");

  assert.deepEqual(report.summary, {
    changed_paths: 9,
    claimed: 4,
    unclaimed: 1,
    excluded: 4,
    excluded_by_reason: {
      contract_definition: 1,
      outside_source_roots: 1,
      ignored: 1,
      deleted: 1,
    },
  });

  // Every changed path lands in exactly one list.
  assert.equal(
    report.claimed_changes.length +
      report.unclaimed_changes.length +
      report.excluded_changes.length,
    changes.length
  );

  // Ordering is a property of the result, not of the input order.
  const shuffled = analyze([...changes].reverse());
  assert.deepEqual(shuffled, report);
  assert.deepEqual(
    report.claimed_changes.map((change) => change.path),
    [...report.claimed_changes.map((change) => change.path)].sort()
  );
  assert.deepEqual(
    report.excluded_changes.map((change) => change.path),
    [...report.excluded_changes.map((change) => change.path)].sort()
  );
  assert.equal(
    JSON.stringify(report),
    JSON.stringify(JSON.parse(JSON.stringify(report)))
  );

  // A repository with no configured scope narrower than itself treats every
  // changed path as eligible.
  const everything = analyzeContractReconciliation({
    repositoryRoot: root,
    manifest,
    changes: [{ status: "modified", path: "docs/guide.md" }],
    sourceRoots: ["."],
    specDirectory: ".tieline/contract",
  });
  assert.deepEqual(
    everything.unclaimed_changes.map((change) => change.path),
    ["docs/guide.md"]
  );

  // The command as a real process against a real diff.
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "baseline"], {
    cwd: root,
    stdio: "ignore",
  });
  writeFileSync(
    resolve(root, "src/claimed-direct.ts"),
    'export const value = "changed";\n'
  );
  writeFileSync(
    resolve(root, "src/unclaimed.ts"),
    'export const value = "changed";\n'
  );
  writeFileSync(resolve(root, "docs/guide.md"), "# Guide\n\nMore.\n");
  const runCliProcess = (args: string[]): string =>
    execFileSync(
      process.execPath,
      ["--import", "tsx", resolve(projectRoot, "src/cli.ts"), ...args],
      { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
  const processJson = JSON.parse(
    runCliProcess([
      "contract",
      "reconcile",
      root,
      "--base",
      "HEAD",
      "--json",
    ])
  ) as ContractReconciliation & { base: string };
  assert.equal(processJson.base, "HEAD");
  assert.equal(processJson.repository, "reconciliation-fixture");
  assert.deepEqual(
    processJson.claimed_changes.map((change) => change.path),
    ["src/claimed-direct.ts"]
  );
  assert.deepEqual(
    processJson.unclaimed_changes.map((change) => change.path),
    ["src/unclaimed.ts"]
  );
  assert.deepEqual(
    processJson.excluded_changes.map((change) => [change.path, change.reason]),
    [["docs/guide.md", "outside_source_roots"]]
  );

  const processHuman = runCliProcess([
    "contract",
    "reconcile",
    root,
    "--base",
    "HEAD",
  ]);
  assert.match(processHuman, /Reconciliation against HEAD/);
  assert.match(processHuman, /src\/claimed-direct\.ts/);
  assert.match(processHuman, /src\/unclaimed\.ts/);
  assert.match(processHuman, /outside the configured source roots/);
  // Neutral wording: the human output states its own limits and never accuses.
  assert.match(processHuman, /not a verdict/i);
  assert.match(processHuman, /a refactor needs no new criterion/i);
  assert.doesNotMatch(
    processHuman,
    /\b(violation|invalid|failed|missing acceptance criterion)\b/i
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("reconciliation tests passed");
