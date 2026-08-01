import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  compileContractManifest,
  serializeContractManifest,
  type ContractManifest,
} from "../src/contract/manifest.js";
import {
  analyzeContractImpact,
  parseNameStatus,
} from "../src/contract/impact.js";
import { runCheckCommand } from "../src/commands/check.js";

const root = mkdtempSync(resolve(tmpdir(), "tieline-impact-"));
const outsideRoot = mkdtempSync(resolve(tmpdir(), "tieline-outside-"));
try {
  mkdirSync(resolve(root, ".tieline/contract"), { recursive: true });
  mkdirSync(resolve(root, "src"), { recursive: true });
  mkdirSync(resolve(root, "scripts"), { recursive: true });
  writeFileSync(resolve(root, "src/feature.ts"), "export const feature = 1;\n");
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
          ignore: [".git", ".tieline"],
        },
        context: { sources: [] },
        runtime: {
          default_embedding_provider: "hash",
          default_database_mode: "offline",
        },
        files: {
          spec_directory: "contract",
          manifest: "manifest.json",
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
  const manifest = compileContractManifest({
    repositoryRoot: root,
    repositoryKey: "impact-fixture",
    commit: "HEAD",
    specDirectory: ".tieline/contract",
  });
  writeFileSync(
    resolve(root, ".tieline/manifest.json"),
    serializeContractManifest(manifest)
  );
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
}

console.log("impact tests passed");
