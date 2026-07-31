import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runCli, type TielineCliIO } from "../src/cli.js";

const root = mkdtempSync(resolve(tmpdir(), "tieline-contract-command-"));
mkdirSync(resolve(root, ".tieline/spec"), { recursive: true });
mkdirSync(resolve(root, "src"), { recursive: true });
writeFileSync(resolve(root, "src/behavior.ts"), "export const behavior = true;\n");
for (let index = 1; index <= 7; index++) {
  writeFileSync(
    resolve(root, `src/mapped-${index}.ts`),
    `export const mapped${index} = true;\n`
  );
}
for (let index = 1; index <= 2; index++) {
  writeFileSync(
    resolve(root, `src/unmapped-${index}.ts`),
    `export const unmapped${index} = true;\n`
  );
}
writeFileSync(
  resolve(root, ".tieline/spec/behavior.yaml"),
  `version: 1
capability:
  key: BEHAVIOR
  name: Accepted behavior
  description: Accepted behavior stays usable without a database and renders <script>alert(1)</script> as text.
  stories:
    - key: BEHAVIOR-001
      title: Validate and compile accepted behavior
      actor: maintainer
      goal: use the repository contract offline
      benefit: semantic review can happen in a pull request
      lifecycle: production
      links:
${Array.from(
  { length: 7 },
  (_, index) => `        - relation: implements
          target:
            kind: code
            repository: contract-command-test
            path: src/mapped-${index + 1}.ts`
).join("\n")}
      acceptance_criteria:
        - key: BEHAVIOR-001-AC1
          criterion: Tieline must validate accepted YAML without a database.
          rationale: Reviewers should be able to understand accepted behavior without reading YAML syntax.
          scenarios:
            - name: Offline contract review
              given: a repository contains valid Tieline specifications
              when: a maintainer generates the review page
              then: the accepted stories and criteria must be readable in a browser
          links:
            - relation: implements
              target:
                kind: code
                repository: contract-command-test
                path: src/behavior.ts
            - relation: documents
              target:
                kind: help
                source: docs
                external_id: review-guide
                url: "javascript:alert(1)"
`
);

let output = "";
const io: TielineCliIO = {
  write(message) {
    output += message;
  },
  error(message) {
    throw new Error(message);
  },
  async question() {
    throw new Error("contract commands must not prompt");
  },
};

try {
  const validateExit = await runCli(
    ["contract", "validate", root, "--json"],
    io,
    {}
  );
  assert.equal(validateExit, 0);
  assert.equal(JSON.parse(output).acceptance_criteria, 1);

  output = "";
  const reviewExit = await runCli(
    ["contract", "review", root, "--json"],
    io,
    {}
  );
  assert.equal(reviewExit, 0);
  const reviewResult = JSON.parse(output);
  assert.equal(reviewResult.stories, 1);
  assert.equal(reviewResult.acceptance_criteria, 1);
  assert.equal(reviewResult.output, resolve(root, ".tieline/review.html"));
  const reviewPage = readFileSync(reviewResult.output, "utf8");
  assert.match(reviewPage, /Accepted behavior/);
  assert.match(reviewPage, /Validate and compile accepted behavior/);
  assert.match(reviewPage, /As a maintainer, I want to use the repository contract offline/);
  assert.match(reviewPage, /BEHAVIOR-001-AC1/);
  assert.match(reviewPage, /Offline contract review/);
  assert.match(reviewPage, /renders &lt;script&gt;alert\(1\)&lt;\/script&gt; as text/);
  assert.doesNotMatch(reviewPage, /renders <script>/);
  assert.match(reviewPage, /data-lifecycle="production"/);
  assert.match(reviewPage, /type="search"/);
  assert.match(reviewPage, /class="wiki-nav"/);
  assert.match(reviewPage, /id="story-content"/);
  assert.match(reviewPage, /data-story-link/);
  assert.match(reviewPage, /Acceptance criteria/);
  assert.match(reviewPage, /window\.print/);
  assert.doesNotMatch(reviewPage, /href="javascript:/);

  const manifestPath = resolve(root, ".tieline/manifest.json");
  output = "";
  const compileExit = await runCli(
    [
      "contract",
      "compile",
      root,
      "--repo",
      "contract-command-test",
      "--commit",
      "offline-proof",
      "--output",
      manifestPath,
      "--json",
    ],
    io,
    {}
  );
  assert.equal(compileExit, 0);
  const firstManifest = readFileSync(manifestPath, "utf8");
  assert.equal(JSON.parse(firstManifest).repository.commit, "offline-proof");

  output = "";
  await runCli(
    [
      "contract",
      "compile",
      root,
      "--repo=contract-command-test",
      "--commit=offline-proof",
      `--output=${manifestPath}`,
    ],
    io,
    {}
  );
  assert.equal(readFileSync(manifestPath, "utf8"), firstManifest);

  output = "";
  const coverageExit = await runCli(
    [
      "contract",
      "coverage",
      root,
      "--repo",
      "contract-command-test",
      "--commit",
      "offline-proof",
      "--json",
    ],
    io,
    {}
  );
  assert.equal(coverageExit, 0);
  assert.deepEqual(JSON.parse(output), {
    repository: { key: "contract-command-test", commit: "offline-proof" },
    stories: 1,
    acceptance_criteria: 1,
    criteria_with_direct_links: 1,
    criteria_without_direct_links: [],
    direct_links: 2,
    mapping_coverage: {
      status: "measured",
      source_roots: ["src"],
      eligible_files: 10,
      mapped_files: 8,
      unmapped_files: ["src/unmapped-1.ts", "src/unmapped-2.ts"],
      excluded_files: 0,
      percentage: 80,
    },
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("contract command tests passed");
