import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  compileContractManifestWithSources,
  writeContractManifest,
  type ContractManifest,
} from "../src/contract/manifest.js";
import {
  analyzeContractImpact,
  parseNameStatus,
} from "../src/contract/impact.js";
import type { ArtifactAssuranceInspector } from "../src/contract/artifact-assurance.js";
import { runCheckCommand } from "../src/commands/check.js";
import { tielineConfigJson } from "./lib/fixtures.js";

const root = mkdtempSync(resolve(tmpdir(), "tieline-impact-"));
const outsideRoot = mkdtempSync(resolve(tmpdir(), "tieline-outside-"));
const looseRoot = mkdtempSync(resolve(tmpdir(), "tieline-loose-"));
try {
  mkdirSync(resolve(root, ".tieline/contract"), { recursive: true });
  mkdirSync(resolve(root, "src"), { recursive: true });
  mkdirSync(resolve(root, "scripts"), { recursive: true });
  writeFileSync(
    resolve(root, "src/feature.ts"),
    "export const feature = 1;\nexport const alternate = 1;\n"
  );
  writeFileSync(
    resolve(root, "src/unsupported.rb"),
    "def unsupported\n  true\nend\n"
  );
  writeFileSync(resolve(root, "src/legacy.ts"), "export const legacy = 1;\n");
  writeFileSync(
    resolve(root, "scripts/feature.test.ts"),
    "export function featureBehavior() { assert(feature); }\n"
  );
  writeFileSync(
    resolve(root, ".tieline/config.json"),
    tielineConfigJson({
      name: "Impact fixture",
      repoName: "impact-fixture",
      timestamp: "2026-07-29T00:00:00.000Z",
    })
  );
  writeFileSync(
    resolve(root, ".tieline/contract/feature.yaml"),
    `version: 1
capability:
  key: FEATURE
  name: Feature behavior
  description: Keep behavior grounded in implementation.
  stories:
    - key: US-FEATURE-001
      title: Review semantic impact
      actor: maintainer
      goal: see which behavior a code change affects
      benefit: drift is visible during review
      lifecycle: production
      links:
        - relation: implements
          provenance: authored
          target:
            kind: code
            repository: impact-fixture
            path: src/feature.ts
            selector: const:feature
      acceptance_criteria:
        - key: AC-FEATURE-001
          criterion: Tieline must report a changed implementation path.
          links:
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: impact-fixture
                path: src/feature.ts
                selector: const:feature
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: impact-fixture
                path: src/feature.ts
                selector: const:alternate
            - relation: tests
              provenance: authored
              target:
                kind: test
                repository: impact-fixture
                path: scripts/feature.test.ts
                selector: function:featureBehavior
                framework_hint: custom-script
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: impact-fixture
                path: src/unsupported.rb
                selector: function:unsupported
`
  );
  execFileSync("git", ["init"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.test"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Tieline Test"], {
    cwd: root,
  });
  const compiled = compileContractManifestWithSources({
    repositoryRoot: root,
    repositoryKey: "impact-fixture",
    specDirectory: ".tieline/contract",
  });
  const manifest = compiled.manifest;
  writeContractManifest(resolve(root, ".tieline/manifest"), compiled);
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "baseline"], { cwd: root });

  const baselineOutput: string[] = [];
  assert.equal(
    await runCheckCommand(
      { base: "HEAD", repository: root, json: true },
      { write: (message) => baselineOutput.push(message) }
    ),
    0
  );
  const baselineReport = JSON.parse(baselineOutput.join("")) as {
    manifest_current: boolean;
    impacts: unknown[];
  };
  assert.equal(baselineReport.manifest_current, true);
  assert.equal(baselineReport.impacts.length, 0);

  let freshnessInspections = 0;
  let fullInspections = 0;
  const freshnessOnlyInspector: ArtifactAssuranceInspector = {
    inspectFreshness() {
      freshnessInspections += 1;
      return {
        freshness: "current",
        freshness_reason: null,
        broken_cause: null,
      };
    },
    inspect() {
      fullInspections += 1;
      throw new Error("healthy all-links sweep must not resolve selectors");
    },
    async dispose() {},
  };
  assert.deepEqual(
    await analyzeContractImpact({
      repositoryRoot: root,
      manifest,
      changes: [],
      assuranceInspector: freshnessOnlyInspector,
    }),
    []
  );
  assert.ok(freshnessInspections > 0);
  assert.equal(fullInspections, 0);

  writeFileSync(
    resolve(root, "src/feature.ts"),
    "export const feature = 2;\nexport const alternate = 2;\n"
  );
  const changed = await analyzeContractImpact({
    repositoryRoot: root,
    manifest,
    changes: [{ status: "modified", path: "src/feature.ts" }],
  });
  assert.deepEqual(
    changed.map((impact) => [
      impact.target_kind,
      impact.repository,
      impact.path,
      impact.selector,
      impact.framework_hint,
      impact.link_scope,
      impact.freshness,
      impact.locator_resolution,
      impact.locator_reason,
    ]),
    [
      [
        "code",
        "impact-fixture",
        "src/feature.ts",
        "const:alternate",
        null,
        "direct",
        "stale",
        "resolved",
        null,
      ],
      [
        "code",
        "impact-fixture",
        "src/feature.ts",
        "const:feature",
        null,
        "direct",
        "stale",
        "resolved",
        null,
      ],
      [
        "code",
        "impact-fixture",
        "src/feature.ts",
        "const:feature",
        null,
        "story_fallback",
        "stale",
        "resolved",
        null,
      ],
    ],
    "same-file selectors and direct versus Story fallback remain distinct and ordered"
  );

  const renamed = await analyzeContractImpact({
    repositoryRoot: root,
    manifest,
    changes: [
      {
        status: "renamed",
        old_path: "scripts/feature.test.ts",
        path: "scripts/renamed.test.ts",
      },
    ],
  });
  assert.equal(renamed[0].reason, "renamed");
  assert.equal(renamed[0].freshness, "current");
  assert.equal(renamed[0].freshness_reason, null);
  assert.equal(renamed[0].target_kind, "test");
  assert.equal(renamed[0].selector, "function:featureBehavior");
  assert.equal(renamed[0].framework_hint, "custom-script");
  assert.equal(renamed[0].locator_resolution, "resolved");
  assert.equal(renamed[0].locator_reason, null);

  const contractChanged = await analyzeContractImpact({
    repositoryRoot: root,
    manifest,
    changes: [
      { status: "modified", path: ".tieline/contract/feature.yaml" },
    ],
    specDirectory: ".tieline/contract",
  });
  assert.equal(contractChanged.length, 1);
  assert.equal(contractChanged[0].reason, "contract_definition_changed");
  assert.equal(contractChanged[0].provenance, null);
  assert.equal(contractChanged[0].target_kind, null);
  assert.equal(contractChanged[0].selector, null);
  assert.equal(contractChanged[0].framework_hint, null);
  assert.equal(contractChanged[0].locator_resolution, "not_applicable");
  assert.equal(contractChanged[0].locator_reason, null);
  assert.equal(contractChanged[0].path, ".tieline/contract");
  assert.equal(
    contractChanged[0].acceptance_criterion,
    "Tieline must report a changed implementation path."
  );
  assert.equal(contractChanged[0].story_title, "Review semantic impact");

  const cloneManifest = (value: ContractManifest): ContractManifest =>
    JSON.parse(JSON.stringify(value)) as ContractManifest;
  const retarget = (
    candidate: ContractManifest,
    relation: string,
    path: string
  ): ContractManifest => {
    const link = candidate.capabilities[0].stories[0].acceptance_criteria[0].links.find(
      (entry) => entry.relation === relation
    );
    if (!link || link.target.kind === "help") {
      throw new Error(`Fixture is missing a '${relation}' link.`);
    }
    link.target.path = path;
    return candidate;
  };

  // A link can rot without the change under review touching it.
  rmSync(resolve(root, "scripts/feature.test.ts"));
  const brokenOutsideDiff = await analyzeContractImpact({
    repositoryRoot: root,
    manifest,
    changes: [],
  });
  assert.equal(brokenOutsideDiff.length, 1);
  assert.equal(brokenOutsideDiff[0].path, "scripts/feature.test.ts");
  assert.equal(brokenOutsideDiff[0].reason, "link_target_broken");
  assert.equal(brokenOutsideDiff[0].provenance, "authored");
  assert.equal(brokenOutsideDiff[0].freshness, "broken");
  assert.equal(brokenOutsideDiff[0].freshness_reason, null);
  assert.equal(brokenOutsideDiff[0].broken_cause, "missing");
  assert.equal(brokenOutsideDiff[0].target_kind, "test");
  assert.equal(brokenOutsideDiff[0].selector, "function:featureBehavior");
  assert.equal(brokenOutsideDiff[0].framework_hint, "custom-script");
  assert.equal(brokenOutsideDiff[0].locator_resolution, "not_checked");
  assert.equal(brokenOutsideDiff[0].locator_reason, "file_missing");
  assert.equal(
    brokenOutsideDiff[0].acceptance_criterion,
    "Tieline must report a changed implementation path."
  );

  // The same broken link inside the diff keeps its diff-driven reason and is
  // reported once, not twice.
  const brokenInsideDiff = await analyzeContractImpact({
    repositoryRoot: root,
    manifest,
    changes: [{ status: "deleted", path: "scripts/feature.test.ts" }],
  });
  assert.equal(brokenInsideDiff.length, 1);
  assert.equal(brokenInsideDiff[0].reason, "deleted");
  assert.equal(brokenInsideDiff[0].freshness, "broken");
  assert.equal(brokenInsideDiff[0].broken_cause, "missing");

  const brokenExitOutput: string[] = [];
  assert.equal(
    await runCheckCommand(
      { base: "HEAD", repository: root, json: true },
      { write: (message) => brokenExitOutput.push(message) }
    ),
    1
  );
  const brokenReport = JSON.parse(brokenExitOutput.join("")) as {
    broken_links: { broken_cause: string; acceptance_criterion: string }[];
    exit_code: number;
    exit_reason: string;
    errors: string[];
  };
  assert.equal(brokenReport.exit_code, 1);
  assert.equal(brokenReport.exit_reason, "broken_links");
  assert.equal(brokenReport.broken_links.length, 1);
  assert.equal(brokenReport.broken_links[0].broken_cause, "missing");
  assert.equal(brokenReport.errors.length, 1);
  assert.match(brokenReport.errors[0], /scripts\/feature\.test\.ts/);

  const warnOnlyOutput: string[] = [];
  assert.equal(
    await runCheckCommand(
      {
        base: "HEAD",
        repository: root,
        json: true,
        failOnBroken: false,
      },
      { write: (message) => warnOnlyOutput.push(message) }
    ),
    0
  );
  const warnOnlyReport = JSON.parse(warnOnlyOutput.join("")) as {
    exit_code: number;
    exit_reason: string;
    broken_links: unknown[];
  };
  assert.equal(warnOnlyReport.exit_code, 0);
  assert.equal(warnOnlyReport.exit_reason, "broken_links_warn_only");
  assert.equal(warnOnlyReport.broken_links.length, 1);

  writeFileSync(
    resolve(root, "scripts/feature.test.ts"),
    "export function featureBehavior() { assert(feature); }\n"
  );

  const unsupported = await analyzeContractImpact({
    repositoryRoot: root,
    manifest,
    changes: [{ status: "modified", path: "src/unsupported.rb" }],
  });
  assert.equal(unsupported.length, 1);
  assert.equal(unsupported[0].freshness, "current");
  assert.equal(unsupported[0].locator_resolution, "not_checked");
  assert.equal(unsupported[0].locator_reason, "unsupported_language");

  // A link pointing at a directory is broken for a different, reportable reason.
  const notFile = await analyzeContractImpact({
    repositoryRoot: root,
    manifest: retarget(cloneManifest(manifest), "tests", "src"),
    changes: [],
  });
  assert.equal(notFile.length, 1);
  assert.equal(notFile[0].freshness, "broken");
  assert.equal(notFile[0].broken_cause, "not_file");

  // A link escaping the repository through a symlink is broken too.
  writeFileSync(
    resolve(outsideRoot, "external.ts"),
    "export const external = 1;\n"
  );
  symlinkSync(
    resolve(outsideRoot, "external.ts"),
    resolve(root, "src/external.ts")
  );
  const outside = await analyzeContractImpact({
    repositoryRoot: root,
    manifest: retarget(cloneManifest(manifest), "tests", "src/external.ts"),
    changes: [],
  });
  assert.equal(outside.length, 1);
  assert.equal(outside[0].freshness, "broken");
  assert.equal(outside[0].broken_cause, "outside_repository");

  assert.deepEqual(parseNameStatus("D\tsrc/feature.ts\n"), [
    { status: "deleted", path: "src/feature.ts" },
  ]);
  assert.deepEqual(
    parseNameStatus("R100\tscripts/feature.test.ts\tscripts/new.test.ts\n"),
    [
      {
        status: "renamed",
        old_path: "scripts/feature.test.ts",
        path: "scripts/new.test.ts",
      },
    ]
  );

  // This fixture is stale by construction — `src/feature.ts` changed after the
  // manifest was compiled — so the stale gate is downgraded here to keep these
  // assertions about impact reporting. The gate itself is covered below.
  writeFileSync(resolve(root, "src/feature.ts"), "export const feature = 2;\n");
  writeFileSync(
    resolve(root, "src/unsupported.rb"),
    "def unsupported\n  false\nend\n"
  );
  const output: string[] = [];
  assert.equal(
    await runCheckCommand(
      {
        base: "HEAD",
        repository: root,
        json: true,
        failOnStaleManifest: false,
      },
      { write: (message) => output.push(message) }
    ),
    0
  );
  const report = JSON.parse(output.join("")) as {
    manifest_current: boolean;
    impacts: {
      acceptance_criterion: string;
      story_title: string;
      freshness: string;
      selector: string | null;
      link_scope: string;
      locator_resolution: string;
      locator_reason: string | null;
    }[];
    broken_links: unknown[];
    exit_code: number;
    exit_reason: string;
  };
  assert.equal(report.manifest_current, false);
  assert.equal(report.impacts.length, 4);
  const alternateImpact = report.impacts.find(
    (impact) => impact.selector === "const:alternate"
  );
  assert.ok(alternateImpact);
  assert.equal(alternateImpact.freshness, "stale");
  assert.equal(alternateImpact.locator_resolution, "unresolved");
  assert.equal(alternateImpact.locator_reason, null);
  const featureImpacts = report.impacts.filter(
    (impact) => impact.selector === "const:feature"
  );
  assert.deepEqual(
    featureImpacts.map((impact) => [
      impact.link_scope,
      impact.freshness,
      impact.locator_resolution,
    ]),
    [
      ["direct", "stale", "resolved"],
      ["story_fallback", "stale", "resolved"],
    ],
    "freshness and locator resolution remain separate assurance dimensions"
  );
  const unsupportedImpact = report.impacts.find(
    (impact) => impact.selector === "function:unsupported"
  );
  assert.ok(unsupportedImpact);
  assert.equal(unsupportedImpact.freshness, "stale");
  assert.equal(unsupportedImpact.locator_resolution, "not_checked");
  assert.equal(unsupportedImpact.locator_reason, "unsupported_language");
  assert.equal(
    report.impacts[0].acceptance_criterion,
    "Tieline must report a changed implementation path."
  );
  assert.equal(report.impacts[0].story_title, "Review semantic impact");
  assert.equal(report.broken_links.length, 0);
  assert.equal(report.exit_code, 0);
  assert.equal(report.exit_reason, "stale_manifest_warn_only");

  const humanOutput: string[] = [];
  assert.equal(
    await runCheckCommand(
      { base: "HEAD", repository: root, failOnStaleManifest: false },
      { write: (message) => humanOutput.push(message) }
    ),
    0
  );
  const human = humanOutput.join("");
  assert.match(
    human,
    /Tieline must report a changed implementation path\./
  );
  assert.match(human, /Review semantic impact/);
  assert.match(human, /Does this change still satisfy this criterion\?/);
  assert.match(human, /AC-FEATURE-001/);
  assert.match(human, /selector const:feature resolved/i);
  assert.match(
    human,
    /selector const:alternate unresolved; re-read the exact locator/i
  );
  assert.match(
    human,
    /selector function:unsupported not checked \(unsupported_language; inspection limitation\)/i
  );
  assert.doesNotMatch(
    human,
    /selector function:unsupported unresolved/i,
    "an unsupported language is a limitation, not evidence of selector drift"
  );

  // Completeness: changed source files that no acceptance criterion names.
  // Only files that survive the change and are eligible under the configured
  // source roots are surfaced, and they never move the exit code.
  mkdirSync(resolve(root, "docs"), { recursive: true });
  mkdirSync(resolve(root, "src/generated"), { recursive: true });
  writeFileSync(
    resolve(root, "src/plumbing.ts"),
    "export const plumbing = 1;\n"
  );
  writeFileSync(
    resolve(root, "src/generated/build-info.ts"),
    "export const build = 1;\n"
  );
  writeFileSync(resolve(root, "docs/notes.md"), "# notes\n");
  appendFileSync(
    resolve(root, ".tieline/contract/feature.yaml"),
    "# reviewed by a maintainer\n"
  );
  rmSync(resolve(root, "src/legacy.ts"));
  execFileSync(
    "git",
    [
      "add",
      "--",
      "src/plumbing.ts",
      "src/generated/build-info.ts",
      "src/legacy.ts",
      "docs/notes.md",
      ".tieline/contract/feature.yaml",
    ],
    { cwd: root }
  );

  const completenessOutput: string[] = [];
  assert.equal(
    await runCheckCommand(
      {
        base: "HEAD",
        repository: root,
        json: true,
        failOnStaleManifest: false,
      },
      { write: (message) => completenessOutput.push(message) }
    ),
    0
  );
  const completenessReport = JSON.parse(completenessOutput.join("")) as {
    unclaimed_changes: {
      path: string;
      status: string;
      previous_path?: string;
    }[];
    unclaimed_change_count: number;
    unclaimed_changes_status: string;
    exit_code: number;
    exit_reason: string;
    broken_links: unknown[];
    warnings: string[];
  };
  assert.equal(completenessReport.unclaimed_changes_status, "evaluated");
  // src/plumbing.ts is eligible and named by nothing; everything else changed
  // here is claimed, outside the source roots, ignored, contract YAML, or gone.
  assert.deepEqual(
    completenessReport.unclaimed_changes.map((change) => change.path),
    ["src/plumbing.ts"]
  );
  assert.equal(completenessReport.unclaimed_changes[0].status, "added");
  assert.equal(completenessReport.unclaimed_change_count, 1);
  // Unclaimed changes alone never fail the check. The reason reflects this
  // fixture's downgraded stale manifest, not anything unclaimed changes did.
  assert.equal(completenessReport.exit_code, 0);
  assert.equal(completenessReport.exit_reason, "stale_manifest_warn_only");
  assert.equal(completenessReport.broken_links.length, 0);
  assert.ok(
    completenessReport.warnings.some((warning) =>
      /named by no acceptance criterion/.test(warning)
    )
  );

  // A rename is judged under its new path, and a link naming either end of the
  // rename already claims it. The vanished old path also breaks that link, so
  // this is the case where a broken link and an unclaimed change coexist.
  writeFileSync(
    resolve(root, "src/feature.ts"),
    "export const feature = 1;\nexport const alternate = 1;\n"
  );
  renameSync(
    resolve(root, "src/feature.ts"),
    resolve(root, "src/feature-moved.ts")
  );
  execFileSync(
    "git",
    ["add", "--", "src/feature.ts", "src/feature-moved.ts"],
    { cwd: root }
  );
  const renamedOutput: string[] = [];
  assert.equal(
    await runCheckCommand(
      { base: "HEAD", repository: root, json: true },
      { write: (message) => renamedOutput.push(message) }
    ),
    1
  );
  const renamedReport = JSON.parse(renamedOutput.join("")) as {
    unclaimed_changes: { path: string }[];
    exit_code: number;
    exit_reason: string;
    broken_links: unknown[];
  };
  assert.equal(renamedReport.exit_code, 1);
  assert.equal(renamedReport.exit_reason, "broken_links");
  assert.ok(renamedReport.broken_links.length > 0);
  assert.deepEqual(
    renamedReport.unclaimed_changes.map((change) => change.path),
    ["src/plumbing.ts"]
  );
  renameSync(
    resolve(root, "src/feature-moved.ts"),
    resolve(root, "src/feature.ts")
  );
  writeFileSync(
    resolve(root, "src/feature.ts"),
    "export const feature = 2;\nexport const alternate = 2;\n"
  );
  execFileSync(
    "git",
    ["add", "--", "src/feature.ts", "src/feature-moved.ts"],
    { cwd: root }
  );

  const completenessHumanOutput: string[] = [];
  assert.equal(
    await runCheckCommand(
      { base: "HEAD", repository: root, failOnStaleManifest: false },
      { write: (message) => completenessHumanOutput.push(message) }
    ),
    0
  );
  const completenessHuman = completenessHumanOutput.join("");
  assert.match(completenessHuman, /changes to consider=1/);
  assert.match(
    completenessHuman,
    /Changes to consider \(1 changed source file\(s\) named by no acceptance criterion\)/
  );
  assert.match(
    completenessHuman,
    /refactors, renames, or internal plumbing/
  );
  assert.match(completenessHuman, /warn {2}added src\/plumbing\.ts/);
  // The invitation must stay an invitation, never an accusation.
  assert.doesNotMatch(
    completenessHuman,
    /\b(missing|gap|violation|untracked)\b/i
  );

  // Without a workspace there is no configured source root, so eligibility
  // cannot be decided; the check says so once instead of guessing.
  mkdirSync(resolve(looseRoot, ".tieline"), { recursive: true });
  mkdirSync(resolve(looseRoot, "src"), { recursive: true });
  mkdirSync(resolve(looseRoot, "scripts"), { recursive: true });
  writeContractManifest(resolve(looseRoot, ".tieline/manifest"), compiled);
  writeFileSync(
    resolve(looseRoot, "src/feature.ts"),
    "export const feature = 1;\nexport const alternate = 1;\n"
  );
  writeFileSync(
    resolve(looseRoot, "src/unsupported.rb"),
    "def unsupported\n  true\nend\n"
  );
  writeFileSync(
    resolve(looseRoot, "scripts/feature.test.ts"),
    "export function featureBehavior() { assert(feature); }\n"
  );
  execFileSync("git", ["init"], { cwd: looseRoot });
  execFileSync("git", ["config", "user.email", "test@example.test"], {
    cwd: looseRoot,
  });
  execFileSync("git", ["config", "user.name", "Tieline Test"], {
    cwd: looseRoot,
  });
  execFileSync("git", ["add", "."], { cwd: looseRoot });
  execFileSync("git", ["commit", "-m", "baseline"], { cwd: looseRoot });
  writeFileSync(resolve(looseRoot, "src/loose.ts"), "export const loose = 1;\n");
  execFileSync("git", ["add", "--", "src/loose.ts"], { cwd: looseRoot });

  const looseOutput: string[] = [];
  assert.equal(
    await runCheckCommand(
      { base: "HEAD", repository: looseRoot, json: true },
      { write: (message) => looseOutput.push(message) }
    ),
    0
  );
  const looseReport = JSON.parse(looseOutput.join("")) as {
    unclaimed_changes: unknown[];
    unclaimed_change_count: number;
    unclaimed_changes_status: string;
    warnings: string[];
    exit_code: number;
  };
  assert.equal(looseReport.unclaimed_changes_status, "not_evaluated");
  assert.equal(looseReport.unclaimed_changes.length, 0);
  assert.equal(looseReport.unclaimed_change_count, 0);
  assert.equal(looseReport.exit_code, 0);
  assert.equal(
    looseReport.warnings.filter((warning) =>
      /no Tieline workspace configuration was found/.test(warning)
    ).length,
    1
  );

  const looseHumanOutput: string[] = [];
  assert.equal(
    await runCheckCommand(
      { base: "HEAD", repository: looseRoot },
      { write: (message) => looseHumanOutput.push(message) }
    ),
    0
  );
  const looseHuman = looseHumanOutput.join("");
  assert.match(looseHuman, /no Tieline workspace configuration was found/);
  assert.doesNotMatch(looseHuman, /changes to consider=/);

  // A capability the manifest has never been compiled for has no file in the
  // manifest directory, so the check must still see the manifest as stale
  // rather than reading the capabilities that happen to be there as complete.
  writeFileSync(
    resolve(root, ".tieline/contract/added.yaml"),
    `version: 1
capability:
  key: ADDED
  name: Added behavior
  description: A capability compiled into no manifest file yet.
  stories:
    - key: US-ADDED-001
      title: Notice an uncompiled capability
      actor: maintainer
      goal: see that the committed manifest is behind the specification
      benefit: the manifest is recompiled before merge
      lifecycle: production
      acceptance_criteria:
        - key: AC-ADDED-001
          criterion: Tieline must report the manifest as stale.
          links:
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: impact-fixture
                path: src/feature.ts
`
  );
  const addedOutput: string[] = [];
  await runCheckCommand(
    { base: "HEAD", repository: root, json: true },
    { write: (message) => addedOutput.push(message) }
  );
  const addedReport = JSON.parse(addedOutput.join("")) as {
    manifest_current: boolean;
    manifest_compile_error: string | null;
  };
  assert.equal(addedReport.manifest_current, false);
  assert.equal(addedReport.manifest_compile_error, null);

  // A manifest that does not match its own recompilation gates by default: the
  // comparison is a byte diff of a deterministic function, so nothing is judged.
  const staleGateOutput: string[] = [];
  assert.equal(
    await runCheckCommand(
      { base: "HEAD", repository: root, json: true },
      { write: (message) => staleGateOutput.push(message) }
    ),
    1
  );
  const staleGateReport = JSON.parse(staleGateOutput.join("")) as {
    exit_code: number;
    exit_reason: string;
    fail_on_stale_manifest: boolean;
    errors: string[];
    warnings: string[];
  };
  assert.equal(staleGateReport.exit_code, 1);
  assert.equal(staleGateReport.exit_reason, "stale_manifest");
  assert.equal(staleGateReport.fail_on_stale_manifest, true);
  assert.ok(
    staleGateReport.errors.some((entry) => /does not match/i.test(entry)),
    "a gating stale manifest belongs in errors"
  );
  assert.ok(
    !staleGateReport.warnings.some((entry) => /does not match/i.test(entry)),
    "a gating stale manifest must not also be listed as a warning"
  );

  const staleDowngradeOutput: string[] = [];
  assert.equal(
    await runCheckCommand(
      {
        base: "HEAD",
        repository: root,
        json: true,
        failOnStaleManifest: false,
      },
      { write: (message) => staleDowngradeOutput.push(message) }
    ),
    0
  );
  const staleDowngradeReport = JSON.parse(staleDowngradeOutput.join("")) as {
    exit_code: number;
    exit_reason: string;
    errors: string[];
    warnings: string[];
  };
  assert.equal(staleDowngradeReport.exit_code, 0);
  assert.equal(staleDowngradeReport.exit_reason, "stale_manifest_warn_only");
  assert.ok(
    staleDowngradeReport.warnings.some((entry) => /does not match/i.test(entry))
  );
  assert.ok(
    !staleDowngradeReport.errors.some((entry) => /does not match/i.test(entry))
  );

  const staleTextOutput: string[] = [];
  await runCheckCommand(
    { base: "HEAD", repository: root },
    { write: (message) => staleTextOutput.push(message) }
  );
  assert.match(staleTextOutput.join(""), /--no-fail-on-stale-manifest/);
  rmSync(resolve(root, ".tieline/contract/added.yaml"));

  // A manifest that cannot be recompiled at all is one fault, reported once.
  // Counting it as staleness too would name the same problem twice and let the
  // stale gate fire for a reason the operator cannot act on as staleness.
  writeFileSync(
    resolve(root, ".tieline/contract/broken.yaml"),
    "version: 1\ncapability: [this is not a capability]\n"
  );
  const compileErrorOutput: string[] = [];
  assert.equal(
    await runCheckCommand(
      { base: "HEAD", repository: root, json: true },
      { write: (message) => compileErrorOutput.push(message) }
    ),
    0
  );
  const compileErrorReport = JSON.parse(compileErrorOutput.join("")) as {
    manifest_current: boolean;
    manifest_compile_error: string | null;
    exit_reason: string;
  };
  assert.equal(compileErrorReport.manifest_current, false);
  assert.ok(compileErrorReport.manifest_compile_error);
  assert.equal(compileErrorReport.exit_reason, "ok");
  rmSync(resolve(root, ".tieline/contract/broken.yaml"));

  await assert.rejects(
    runCheckCommand(
      { base: "HEAD", repository: `${root}-missing` },
      { write: () => undefined }
    ),
    /unreadable/i
  );
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
  rmSync(looseRoot, { recursive: true, force: true });
}

console.log("impact tests passed");
