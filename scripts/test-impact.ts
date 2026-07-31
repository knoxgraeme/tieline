import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  compileContractManifest,
  serializeContractManifest,
} from "../src/contract/manifest.js";
import {
  analyzeContractImpact,
  parseNameStatus,
} from "../src/contract/impact.js";
import { runCheckCommand } from "../src/commands/check.js";

const root = mkdtempSync(resolve(tmpdir(), "tieline-impact-"));
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
    impacts: unknown[];
  };
  assert.equal(report.manifest_current, false);
  assert.equal(report.impacts.length, 1);

  await assert.rejects(
    runCheckCommand(
      { base: "HEAD", repository: `${root}-missing` },
      { write: () => undefined }
    ),
    /unreadable/i
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("impact tests passed");
