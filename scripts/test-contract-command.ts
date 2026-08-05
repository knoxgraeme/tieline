import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runCli, type TielineCliIO } from "../src/cli.js";
import { computeRepositoryMappingCoverage } from "../src/contract/coverage.js";
import {
  compileContractManifest,
  readContractManifest,
} from "../src/contract/manifest.js";

const root = mkdtempSync(resolve(tmpdir(), "tieline-contract-command-"));
mkdirSync(resolve(root, ".tieline/spec"), { recursive: true });
mkdirSync(resolve(root, "src"), { recursive: true });
writeFileSync(resolve(root, "src/behavior.ts"), "export const behavior = true;\n");
writeFileSync(
  resolve(root, "src/behavior.test.ts"),
  "import { behavior } from './behavior.js';\nif (!behavior) throw new Error('behavior');\n"
);
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
const behaviorYaml = `version: 1
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
          provenance: authored
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
              provenance: authored
              target:
                kind: code
                repository: contract-command-test
                path: src/behavior.ts
            - relation: tests
              provenance: authored
              target:
                kind: test
                repository: contract-command-test
                path: src/behavior.test.ts
            - relation: documents
              provenance: authored
              target:
                kind: help
                source: docs
                external_id: review-guide
                url: "javascript:alert(1)"
`;
writeFileSync(resolve(root, ".tieline/spec/behavior.yaml"), behaviorYaml);

// A second capability so link review has enough scored links to rank one
// against the others. Its criteria describe billing behaviour and link files
// that talk about nothing of the sort, which is exactly the smell the advisory
// signal exists to surface.
const reviewCriteria = [
  {
    key: "REVIEW-001-AC1",
    criterion:
      "Refund settlement must round currency amounts before the invoice is issued.",
    paths: ["src/mapped-1.ts", "src/mapped-2.ts"],
  },
  {
    key: "REVIEW-001-AC2",
    criterion:
      "Dunning retries must stop once a delinquent subscription is cancelled.",
    paths: ["src/mapped-3.ts", "src/mapped-4.ts"],
  },
  {
    key: "REVIEW-001-AC3",
    criterion:
      "Proration must credit unused seat days when a plan downgrade lands mid-cycle.",
    paths: ["src/mapped-5.ts", "src/mapped-6.ts"],
  },
  {
    key: "REVIEW-001-AC4",
    criterion:
      "Tax jurisdiction lookups must fall back to the billing postal address.",
    paths: ["src/mapped-7.ts", "src/behavior.ts"],
  },
];
writeFileSync(
  resolve(root, ".tieline/spec/review.yaml"),
  `version: 1
capability:
  key: REVIEW
  name: Billing sample
  description: A second capability whose links exist so plausibility ranking has a distribution.
  stories:
    - key: REVIEW-001
      title: Settle billing amounts
      actor: billing operator
      goal: settle amounts correctly
      benefit: customers are charged what they were quoted
      lifecycle: production
      acceptance_criteria:
${reviewCriteria
  .map(
    (entry) => `        - key: ${entry.key}
          criterion: ${entry.criterion}
          links:
${entry.paths
  .map(
    (path) => `            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: contract-command-test
                path: ${path}`
  )
  .join("\n")}`
  )
  .join("\n")}
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
  assert.equal(JSON.parse(output).acceptance_criteria, 5);

  output = "";
  const reviewExit = await runCli(
    ["contract", "review", root, "--json"],
    io,
    {}
  );
  assert.equal(reviewExit, 0);
  const reviewResult = JSON.parse(output);
  assert.equal(reviewResult.stories, 2);
  assert.equal(reviewResult.acceptance_criteria, 5);
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
  assert.match(reviewPage, /implements · authored/);
  assert.match(reviewPage, /window\.print/);
  assert.doesNotMatch(reviewPage, /href="javascript:/);

  const manifestPath = resolve(root, ".tieline/manifest");
  const manifestFiles = (): Array<[string, string]> =>
    readdirSync(manifestPath)
      .sort()
      .map((name) => [name, readFileSync(resolve(manifestPath, name), "utf8")]);
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
  const compileResult = JSON.parse(output);
  assert.deepEqual(compileResult.files, [
    "BEHAVIOR.json",
    "index.json",
    "REVIEW.json",
  ]);
  assert.deepEqual(compileResult.removed_files, []);
  // The index carries only what belongs to the repository as a whole; each
  // capability is its own file, so branches that touch different capabilities
  // have nothing in common to conflict over.
  assert.deepEqual(
    JSON.parse(readFileSync(resolve(manifestPath, "index.json"), "utf8")),
    {
      schema_version: 1,
      repository: { key: "contract-command-test", commit: "offline-proof" },
    }
  );
  const behaviorShard = JSON.parse(
    readFileSync(resolve(manifestPath, "BEHAVIOR.json"), "utf8")
  );
  assert.equal(behaviorShard.capability.stable_id, "BEHAVIOR");
  assert.equal(behaviorShard.input.path, ".tieline/spec/behavior.yaml");
  const firstManifest = manifestFiles();

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
  assert.deepEqual(manifestFiles(), firstManifest);

  // A capability removed from the specification must not survive in the
  // manifest, and removing it must leave every other file untouched.
  writeFileSync(resolve(manifestPath, "GONE.json"), "{}\n");
  output = "";
  await runCli(
    [
      "contract",
      "compile",
      root,
      "--repo=contract-command-test",
      "--commit=offline-proof",
      `--output=${manifestPath}`,
      "--json",
    ],
    io,
    {}
  );
  assert.deepEqual(JSON.parse(output).removed_files, ["GONE.json"]);
  assert.deepEqual(manifestFiles(), firstManifest);

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
  // `src/mapped-*.ts` are named by story-level links and `src/behavior*.ts` by
  // criterion-level ones. Both reach `hash_current`: the tier asks whether the
  // reviewed content is still on disk, which a link of either scope can answer.
  const mappedPaths = [
    "src/behavior.test.ts",
    "src/behavior.ts",
    ...Array.from({ length: 7 }, (_unused, index) => `src/mapped-${index + 1}.ts`),
  ];
  assert.deepEqual(JSON.parse(output), {
    repository: { key: "contract-command-test", commit: "offline-proof" },
    stories: 2,
    acceptance_criteria: 5,
    criteria_with_direct_links: 5,
    criteria_without_direct_links: [],
    direct_links: 11,
    mapping_coverage: {
      status: "measured",
      source_roots: ["src"],
      eligible_files: 11,
      mapped_files: 9,
      unmapped_files: ["src/unmapped-1.ts", "src/unmapped-2.ts"],
      excluded_files: 0,
      percentage: 81.82,
      confidence: {
        hash_comparison_available: true,
        counts: { asserted: 0, hash_current: 9 },
        percentages: {
          asserted: 0,
          hash_current: 81.82,
        },
        paths: {
          asserted: [],
          hash_current: mappedPaths,
        },
      },
    },
  });

  // Backward compatibility: with no hash comparison reachable, every mapped
  // file stays at the floor and the pre-existing fields are byte-for-byte the
  // same.
  const manifest = compileContractManifest({
    repositoryRoot: root,
    repositoryKey: "contract-command-test",
    commit: "offline-proof",
  });
  const untiered = computeRepositoryMappingCoverage(manifest, {
    repositoryRoot: root,
    sourceRoots: ["src"],
    hashes: null,
  });
  assert.deepEqual(untiered, {
    status: "measured",
    source_roots: ["src"],
    eligible_files: 11,
    mapped_files: 9,
    unmapped_files: ["src/unmapped-1.ts", "src/unmapped-2.ts"],
    excluded_files: 0,
    percentage: 81.82,
    confidence: {
      hash_comparison_available: false,
      counts: { asserted: 9, hash_current: 0 },
      percentages: {
        asserted: 81.82,
        hash_current: 0,
      },
      paths: {
        asserted: mappedPaths,
        hash_current: [],
      },
    },
  });
  const { confidence: _ignored, ...legacyFields } = untiered;
  const { confidence: _alsoIgnored, ...tieredFields } =
    computeRepositoryMappingCoverage(manifest, {
      repositoryRoot: root,
      sourceRoots: ["src"],
    });
  assert.deepEqual(legacyFields, tieredFields);

  // The `hash_current` tier tracks the reviewed manifest, so content edited
  // after review drops back to `asserted` instead of silently staying current.
  writeFileSync(
    resolve(root, "src/mapped-1.ts"),
    "export const mapped1 = true;\nexport const drifted = true;\n"
  );
  output = "";
  assert.equal(
    await runCli(
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
    ),
    0
  );
  const drifted = JSON.parse(output).mapping_coverage.confidence;
  assert.deepEqual(drifted.paths.asserted, ["src/mapped-1.ts"]);
  assert.equal(drifted.counts.hash_current, 8);
  assert.equal(drifted.counts.asserted + drifted.counts.hash_current, 9);
  writeFileSync(resolve(root, "src/mapped-1.ts"), "export const mapped1 = true;\n");

  output = "";
  assert.equal(
    await runCli(
      [
        "contract",
        "coverage",
        root,
        "--repo",
        "contract-command-test",
        "--commit",
        "offline-proof",
      ],
      io,
      {}
    ),
    0
  );
  assert.match(output, /Mapping confidence/);
  assert.match(output, /asserted\s+0 \(0% of eligible files\)/);
  assert.match(output, /hash_current\s+9 \(81\.82% of eligible files\)/);

  // contract link-review: advisory, exits zero, carries its disclaimer.
  output = "";
  assert.equal(
    await runCli(
      [
        "contract",
        "link-review",
        root,
        "--repo",
        "contract-command-test",
        "--commit",
        "offline-proof",
        "--json",
      ],
      io,
      {}
    ),
    0
  );
  const linkReview = JSON.parse(output);
  assert.equal(linkReview.advisory, true);
  assert.equal(linkReview.method, "lexical_token_overlap_v1");
  assert.match(linkReview.disclaimer, /never evidence/);
  assert.ok(Array.isArray(linkReview.review_candidates));
  assert.ok(Array.isArray(linkReview.skipped));
  assert.equal(linkReview.status, "reviewed");
  assert.equal(linkReview.scored_links, 10);
  assert.ok(
    linkReview.review_candidates.length > 0,
    "a criterion linked to files that share none of its vocabulary must surface"
  );
  for (const candidate of linkReview.review_candidates) {
    assert.ok(candidate.score < linkReview.distribution.absolute_score_floor);
    assert.match(candidate.rationale, /human review only/);
    assert.match(candidate.rationale, /does not mean the link is wrong/);
  }
  // The help link is not scorable, and its absence from the ranking is
  // reported rather than silently dropped.
  assert.ok(
    linkReview.skipped.some(
      (skip: { reason: string }) => skip.reason === "help_target"
    )
  );

  output = "";
  assert.equal(
    await runCli(
      [
        "contract",
        "link-review",
        root,
        "--repo",
        "contract-command-test",
        "--commit",
        "offline-proof",
      ],
      io,
      {}
    ),
    0
  );
  assert.match(output, /Link review \(lexical_token_overlap_v1\)/);
  assert.match(output, /candidate\(s\) for human review/);
  assert.match(output, /never evidence/);
  assert.match(output, /Suggestion for human review only/);
  assert.match(output, /distribution  min /);
  assert.doesNotMatch(output, /\b(verdict|invalid|failed)\b/i);

  // contract reconcile: authoring input over a real diff, exits zero.
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.test"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Tieline Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "baseline"], {
    cwd: root,
    stdio: "ignore",
  });
  writeFileSync(
    resolve(root, "src/behavior.ts"),
    "export const behavior = true;\nexport const reconciled = true;\n"
  );
  writeFileSync(
    resolve(root, "src/unmapped-1.ts"),
    "export const unmapped1 = false;\n"
  );
  writeFileSync(
    resolve(root, ".tieline/spec/behavior.yaml"),
    `${behaviorYaml}# reconciled\n`
  );

  output = "";
  assert.equal(
    await runCli(
      [
        "contract",
        "reconcile",
        root,
        "--repo",
        "contract-command-test",
        "--commit",
        "offline-proof",
        "--base",
        "HEAD",
        "--json",
      ],
      io,
      {}
    ),
    0
  );
  const reconcile = JSON.parse(output);
  assert.equal(reconcile.base, "HEAD");
  assert.equal(reconcile.advisory, true);
  assert.equal(reconcile.repository, "contract-command-test");
  assert.match(reconcile.disclaimer, /not a verdict/i);
  assert.deepEqual(
    reconcile.claimed_changes.map((change: { path: string }) => change.path),
    ["src/behavior.ts"]
  );
  assert.ok(
    reconcile.claimed_changes[0].claimed_by.some(
      (claim: { acceptance_criterion_stable_id: string; link_scope: string }) =>
        claim.acceptance_criterion_stable_id === "BEHAVIOR-001-AC1" &&
        claim.link_scope === "direct"
    )
  );
  assert.deepEqual(
    reconcile.unclaimed_changes.map((change: { path: string }) => change.path),
    ["src/unmapped-1.ts"]
  );
  assert.deepEqual(
    reconcile.excluded_changes.map(
      (change: { path: string; reason: string }) => [change.path, change.reason]
    ),
    [[".tieline/spec/behavior.yaml", "contract_definition"]]
  );
  assert.deepEqual(reconcile.summary, {
    changed_paths: 3,
    claimed: 1,
    unclaimed: 1,
    excluded: 1,
    excluded_by_reason: {
      contract_definition: 1,
      outside_source_roots: 0,
      ignored: 0,
      deleted: 0,
    },
  });

  output = "";
  assert.equal(
    await runCli(
      [
        "contract",
        "reconcile",
        root,
        "--repo",
        "contract-command-test",
        "--commit",
        "offline-proof",
        "--base",
        "HEAD",
      ],
      io,
      {}
    ),
    0
  );
  assert.match(output, /Reconciliation against HEAD/);
  assert.match(output, /1 already claimed by acceptance criteria/);
  assert.match(output, /BEHAVIOR-001-AC1/);
  assert.match(output, /src\/unmapped-1\.ts/);
  assert.match(output, /a refactor needs no new criterion/);
  assert.match(output, /the contract definition itself/);

  // A branch that deletes a linked file without updating its link is drift the
  // advisory commands exist to report, so neither may die trying to hash the
  // file that is gone. `contract compile` is the gate and must still refuse.
  rmSync(resolve(root, "src/mapped-7.ts"));

  output = "";
  assert.equal(
    await runCli(
      [
        "contract",
        "reconcile",
        root,
        "--repo",
        "contract-command-test",
        "--commit",
        "offline-proof",
        "--base",
        "HEAD",
        "--json",
      ],
      io,
      {}
    ),
    0
  );
  const deletedReconcile = JSON.parse(output);
  const deletedChange = deletedReconcile.claimed_changes.find(
    (change: { path: string }) => change.path === "src/mapped-7.ts"
  );
  assert.ok(
    deletedChange,
    "a deleted path a link still names is a claimed change, not an abort"
  );
  assert.equal(deletedChange.status, "deleted");
  assert.ok(
    deletedChange.claimed_by.some(
      (claim: { acceptance_criterion_stable_id: string }) =>
        claim.acceptance_criterion_stable_id === "REVIEW-001-AC4"
    ),
    "the acceptance criterion whose evidence was deleted must be named"
  );
  assert.equal(deletedReconcile.summary.excluded_by_reason.deleted, 0);

  output = "";
  assert.equal(
    await runCli(
      [
        "contract",
        "link-review",
        root,
        "--repo",
        "contract-command-test",
        "--commit",
        "offline-proof",
        "--json",
      ],
      io,
      {}
    ),
    0
  );
  const deletedLinkReview = JSON.parse(output);
  assert.ok(
    deletedLinkReview.skipped.some(
      (skip: { path?: string; reason: string }) =>
        skip.path === "src/mapped-7.ts" && skip.reason === "file_missing"
    ),
    "a link whose file is gone is reported as a skip, not as a crash"
  );
  // The remaining links are still scored, so one broken link does not silence
  // the whole report.
  assert.ok(deletedLinkReview.scored_links > 0);

  // The gate is unchanged: a manifest offered for review must not record a null
  // reviewed hash for content nobody could read.
  await assert.rejects(
    () =>
      runCli(
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
        ],
        io,
        {}
      ),
    /src\/mapped-7\.ts.*does not exist/i
  );
  // The refused compilation left the manifest exactly as the last successful
  // one wrote it, files and bytes alike.
  assert.deepEqual(manifestFiles(), firstManifest);
  // A null reviewed hash already reads as `stale` downstream, so the manifest
  // on disk must carry one only where it always could: an unresolved help
  // locator, never a code or test artifact.
  const persisted = readContractManifest(manifestPath);
  for (const capability of persisted.capabilities) {
    for (const story of capability.stories) {
      for (const link of [
        ...story.links,
        ...story.acceptance_criteria.flatMap(
          (criterion: { links: unknown[] }) => criterion.links
        ),
      ] as Array<{
        reviewed_content_hash: string | null;
        target: { kind: string };
      }>) {
        if (link.target.kind === "help") continue;
        assert.match(
          link.reviewed_content_hash ?? "",
          /^[a-f0-9]{64}$/,
          "no tolerant compilation reached the manifest on disk"
        );
      }
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("contract command tests passed");
