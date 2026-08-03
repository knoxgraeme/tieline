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
import { runCheckCommand } from "../src/commands/check.js";

const root = mkdtempSync(resolve(tmpdir(), "tieline-impact-"));
const outsideRoot = mkdtempSync(resolve(tmpdir(), "tieline-outside-"));
const looseRoot = mkdtempSync(resolve(tmpdir(), "tieline-loose-"));
try {
  mkdirSync(resolve(root, ".tieline/contract"), { recursive: true });
  mkdirSync(resolve(root, "src"), { recursive: true });
  mkdirSync(resolve(root, "scripts"), { recursive: true });
  writeFileSync(resolve(root, "src/feature.ts"), "export const feature = 1;\n");
  writeFileSync(resolve(root, "src/legacy.ts"), "export const legacy = 1;\n");
  writeFileSync(resolve(root, "scripts/feature.test.ts"), "assert(feature);\n");
  writeFileSync(
    resolve(root, ".tieline/config.json"),
    `${JSON.stringify(
      {
        version: 1,
        product: { name: "Impact fixture", repo_name: "impact-fixture" },
        repository: {
          root: "..",
          source_roots: ["src"],
          ignore: [".git", ".tieline", "src/generated"],
        },
        context: { sources: [] },
        runtime: {
          default_embedding_provider: "hash",
          default_database_mode: "offline",
        },
        files: {
          spec_directory: "contract",
          manifest: "manifest",
          mcp_config: "mcp.json",
        },
        created_at: "2026-07-29T00:00:00.000Z",
        updated_at: "2026-07-29T00:00:00.000Z",
      },
      null,
      2
    )}\n`
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
      acceptance_criteria:
        - key: AC-FEATURE-001
          criterion: Tieline must report a changed implementation path.
          links:
            - relation: implements
              target:
                kind: code
                repository: impact-fixture
                path: src/feature.ts
            - relation: tests
              target:
                kind: test
                repository: impact-fixture
                path: scripts/feature.test.ts
                framework_hint: custom-script
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
    commit: "HEAD",
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

  writeFileSync(resolve(root, "src/feature.ts"), "export const feature = 2;\n");
  const changed = analyzeContractImpact({
    repositoryRoot: root,
    manifest,
    changes: [{ status: "modified", path: "src/feature.ts" }],
  });
  assert.equal(changed.length, 1);
  assert.equal(changed[0].acceptance_criterion_stable_id, "AC-FEATURE-001");
  assert.equal(changed[0].freshness, "stale");

  const renamed = analyzeContractImpact({
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

  const contractChanged = analyzeContractImpact({
    repositoryRoot: root,
    manifest,
    changes: [
      { status: "modified", path: ".tieline/contract/feature.yaml" },
    ],
    specDirectory: ".tieline/contract",
  });
  assert.equal(contractChanged.length, 1);
  assert.equal(contractChanged[0].reason, "contract_definition_changed");
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
  const brokenOutsideDiff = analyzeContractImpact({
    repositoryRoot: root,
    manifest,
    changes: [],
  });
  assert.equal(brokenOutsideDiff.length, 1);
  assert.equal(brokenOutsideDiff[0].path, "scripts/feature.test.ts");
  assert.equal(brokenOutsideDiff[0].reason, "link_target_broken");
  assert.equal(brokenOutsideDiff[0].freshness, "broken");
  assert.equal(brokenOutsideDiff[0].broken_cause, "missing");
  assert.equal(
    brokenOutsideDiff[0].acceptance_criterion,
    "Tieline must report a changed implementation path."
  );

  // The same broken link inside the diff keeps its diff-driven reason and is
  // reported once, not twice.
  const brokenInsideDiff = analyzeContractImpact({
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

  writeFileSync(resolve(root, "scripts/feature.test.ts"), "assert(feature);\n");

  // A link pointing at a directory is broken for a different, reportable reason.
  const notFile = analyzeContractImpact({
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
  const outside = analyzeContractImpact({
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

  const output: string[] = [];
  assert.equal(
    await runCheckCommand(
      { base: "HEAD", repository: root, json: true },
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
    }[];
    broken_links: unknown[];
    exit_code: number;
    exit_reason: string;
  };
  assert.equal(report.manifest_current, false);
  assert.equal(report.impacts.length, 1);
  assert.equal(report.impacts[0].freshness, "stale");
  assert.equal(
    report.impacts[0].acceptance_criterion,
    "Tieline must report a changed implementation path."
  );
  assert.equal(report.impacts[0].story_title, "Review semantic impact");
  assert.equal(report.broken_links.length, 0);
  assert.equal(report.exit_code, 0);
  assert.equal(report.exit_reason, "ok");

  const humanOutput: string[] = [];
  assert.equal(
    await runCheckCommand(
      { base: "HEAD", repository: root },
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
      { base: "HEAD", repository: root, json: true },
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
  // Unclaimed changes alone never fail the check.
  assert.equal(completenessReport.exit_code, 0);
  assert.equal(completenessReport.exit_reason, "ok");
  assert.equal(completenessReport.broken_links.length, 0);
  assert.ok(
    completenessReport.warnings.some((warning) =>
      /named by no acceptance criterion/.test(warning)
    )
  );

  // A rename is judged under its new path, and a link naming either end of the
  // rename already claims it. The vanished old path also breaks that link, so
  // this is the case where a broken link and an unclaimed change coexist.
  writeFileSync(resolve(root, "src/feature.ts"), "export const feature = 1;\n");
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
  writeFileSync(resolve(root, "src/feature.ts"), "export const feature = 2;\n");
  execFileSync(
    "git",
    ["add", "--", "src/feature.ts", "src/feature-moved.ts"],
    { cwd: root }
  );

  const completenessHumanOutput: string[] = [];
  assert.equal(
    await runCheckCommand(
      { base: "HEAD", repository: root },
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
    "export const feature = 1;\n"
  );
  writeFileSync(
    resolve(looseRoot, "scripts/feature.test.ts"),
    "assert(feature);\n"
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
  rmSync(resolve(root, ".tieline/contract/added.yaml"));

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
