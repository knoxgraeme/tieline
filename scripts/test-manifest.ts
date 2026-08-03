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
import {
  attachCurrentArtifactHashes,
  compileContractManifest,
  ContractManifestError,
  readContractManifest,
  serializeContractManifest,
} from "../src/contract/manifest.js";

let passed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (error) {
    console.error(`  not ok - ${name}`);
    throw error;
  }
}

function fixture(): string {
  const root = mkdtempSync(resolve(tmpdir(), "tieline-manifest-"));
  mkdirSync(resolve(root, ".tieline/spec"), { recursive: true });
  mkdirSync(resolve(root, "src"), { recursive: true });
  mkdirSync(resolve(root, "scripts"), { recursive: true });
  writeFileSync(resolve(root, "src/contract.ts"), "export const contract = true;\n");
  writeFileSync(resolve(root, "scripts/contract.test.ts"), "assert(contract);\n");
  writeFileSync(
    resolve(root, ".tieline/spec/contract.yaml"),
    `version: 1
capability:
  key: CONTRACT
  name: Living contract
  description: Maintainers keep accepted intent beside code.
  stories:
    - key: CONTRACT-001
      title: Compile accepted intent
      actor: maintainer
      goal: compile accepted YAML without a database
      benefit: pull requests can review semantic changes
      lifecycle: production
      planning_origin:
        record_id: 00000000-0000-4000-8000-000000000001
        revision: 2
      links:
        - relation: implements
          target:
            kind: code
            repository: tieline
            path: src/contract.ts
      acceptance_criteria:
        - key: CONTRACT-001-AC1
          criterion: Tieline must compile the same manifest bytes for unchanged inputs.
          scenarios:
            - given: accepted YAML and unchanged repository content
              when: the contract is compiled twice
              then: both manifest files are byte-identical
          links:
            - relation: tests
              target:
                kind: test
                repository: tieline
                path: scripts/contract.test.ts
                framework_hint: custom
            - relation: documents
              target:
                kind: help
                source: intercom
                external_id: article-not-fetched
`
  );
  return root;
}

console.log("deterministic contract manifest");

await test("compiles byte-identical JSON with source, origin, relation, and artifact hashes", () => {
  const root = fixture();
  try {
    const options = {
      repositoryRoot: root,
      repositoryKey: "tieline",
      commit: "abc123",
    };
    const first = compileContractManifest(options);
    const second = compileContractManifest(options);
    assert.equal(serializeContractManifest(first), serializeContractManifest(second));
    assert.match(first.inputs[0]!.sha256, /^[a-f0-9]{64}$/);

    const story = first.capabilities[0]!.stories[0]!;
    assert.deepEqual(story.planning_origin, {
      record_id: "00000000-0000-4000-8000-000000000001",
      revision: 2,
    });
    assert.match(story.links[0]!.reviewed_content_hash!, /^[a-f0-9]{64}$/);
    const testLink = story.acceptance_criteria[0]!.links.find(
      (link) => link.target.kind === "test"
    );
    const helpLink = story.acceptance_criteria[0]!.links.find(
      (link) => link.target.kind === "help"
    );
    assert.match(testLink!.reviewed_content_hash!, /^[a-f0-9]{64}$/);
    assert.equal(
      helpLink!.reviewed_content_hash,
      null,
      "unresolved help locators stay in the manifest without inventing content"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("changes only the linked artifact basis when repository content changes", () => {
  const root = fixture();
  try {
    const options = {
      repositoryRoot: root,
      repositoryKey: "tieline",
      commit: "abc123",
    };
    const before = compileContractManifest(options);
    writeFileSync(resolve(root, "scripts/contract.test.ts"), "assert(contract && current);\n");
    const after = compileContractManifest(options);

    const beforeCriterion = before.capabilities[0]!.stories[0]!.acceptance_criteria[0]!;
    const afterCriterion = after.capabilities[0]!.stories[0]!.acceptance_criteria[0]!;
    assert.equal(beforeCriterion.contract_hash, afterCriterion.contract_hash);
    const beforeTestLink = beforeCriterion.links.find(
      (link) => link.target.kind === "test"
    );
    const afterTestLink = afterCriterion.links.find(
      (link) => link.target.kind === "test"
    );
    assert.notEqual(beforeTestLink!.reviewed_content_hash, afterTestLink!.reviewed_content_hash);
    assert.deepEqual(
      beforeCriterion.links.map((link) => [link.relation, link.target]),
      afterCriterion.links.map((link) => [link.relation, link.target]),
      "content hash changes do not reorder semantic link locators"
    );
    assert.deepEqual(before.inputs, after.inputs);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("keeps reviewed hashes while measuring current artifact content for sync", () => {
  const root = fixture();
  try {
    const reviewed = compileContractManifest({
      repositoryRoot: root,
      repositoryKey: "tieline",
      commit: "reviewed-commit",
    });
    const criterion =
      reviewed.capabilities[0]!.stories[0]!.acceptance_criteria[0]!;
    const reviewedTestLink = criterion.links.find(
      (link) => link.target.kind === "test"
    )!;
    const reviewedHash = reviewedTestLink.reviewed_content_hash;

    writeFileSync(
      resolve(root, "scripts/contract.test.ts"),
      "assert(contract && changedAfterReview);\n"
    );
    const measured = attachCurrentArtifactHashes(reviewed, root);
    const measuredTestLink =
      measured.capabilities[0]!.stories[0]!.acceptance_criteria[0]!.links.find(
        (link) => link.target.kind === "test"
      )!;

    assert.equal(measuredTestLink.reviewed_content_hash, reviewedHash);
    assert.notEqual(measuredTestLink.current_content_hash, reviewedHash);
    assert.doesNotMatch(
      serializeContractManifest(measured),
      /current_content_hash/,
      "runtime freshness measurements do not alter the reviewed manifest"
    );

    rmSync(resolve(root, "scripts/contract.test.ts"));
    const missing = attachCurrentArtifactHashes(reviewed, root);
    const missingTestLink =
      missing.capabilities[0]!.stories[0]!.acceptance_criteria[0]!.links.find(
        (link) => link.target.kind === "test"
      )!;
    assert.equal(missingTestLink.current_content_hash, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("rejects malformed nested content in a reviewed manifest", () => {
  const root = fixture();
  try {
    const manifest = compileContractManifest({
      repositoryRoot: root,
      repositoryKey: "tieline",
      commit: "reviewed-commit",
    });
    manifest.capabilities[0]!.stories[0]!.acceptance_criteria[0]!.links[0]!
      .reviewed_content_hash = "not-a-content-hash";
    const path = resolve(root, ".tieline/manifest.json");
    writeFileSync(path, serializeContractManifest(manifest));
    assert.throws(
      () => readContractManifest(path),
      (error: unknown) => {
        assert.ok(error instanceof ContractManifestError);
        assert.match(error.message, /reviewed_content_hash|invalid_string/i);
        return true;
      }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("rejects a missing artifact in the repository being compiled", () => {
  const root = fixture();
  try {
    rmSync(resolve(root, "src/contract.ts"));
    assert.throws(
      () =>
        compileContractManifest({
          repositoryRoot: root,
          repositoryKey: "tieline",
          commit: "abc123",
        }),
      (error: unknown) => {
        assert.ok(error instanceof ContractManifestError);
        assert.match(error.message, /src\/contract\.ts.*does not exist/i);
        return true;
      }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("omits the reviewed hash of an unhashable artifact when asked to tolerate one", () => {
  const root = fixture();
  try {
    rmSync(resolve(root, "src/contract.ts"));
    const manifest = compileContractManifest({
      repositoryRoot: root,
      repositoryKey: "tieline",
      commit: "abc123",
      onUnhashableArtifact: "omit_hash",
    });

    const story = manifest.capabilities[0]!.stories[0]!;
    assert.equal(
      story.links[0]!.reviewed_content_hash,
      null,
      "a link whose artifact is gone keeps its locator and records no content"
    );
    assert.deepEqual(
      story.links[0]!.target,
      { kind: "code", repository: "tieline", path: "src/contract.ts" },
      "tolerating an unhashable artifact drops the hash, never the link"
    );

    // Tolerance is per link: everything still on disk is measured as usual, so
    // the report distinguishes the one broken link from the rest.
    const testLink = story.acceptance_criteria[0]!.links.find(
      (link) => link.target.kind === "test"
    )!;
    assert.match(testLink.reviewed_content_hash!, /^[a-f0-9]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("tolerates an artifact that is a directory rather than a file", () => {
  const root = fixture();
  try {
    // `not_file` and `outside_repository` reach the same branch as `missing`,
    // so the tolerant mode must not turn either into a thrown error either.
    rmSync(resolve(root, "src/contract.ts"));
    mkdirSync(resolve(root, "src/contract.ts"), { recursive: true });
    const manifest = compileContractManifest({
      repositoryRoot: root,
      repositoryKey: "tieline",
      commit: "abc123",
      onUnhashableArtifact: "omit_hash",
    });
    assert.equal(
      manifest.capabilities[0]!.stories[0]!.links[0]!.reviewed_content_hash,
      null
    );
    assert.throws(
      () =>
        compileContractManifest({
          repositoryRoot: root,
          repositoryKey: "tieline",
          commit: "abc123",
        }),
      (error: unknown) => {
        assert.ok(error instanceof ContractManifestError);
        assert.match(error.message, /src\/contract\.ts.*is not a file/i);
        return true;
      }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("emits stable ordering independent of YAML file discovery order", () => {
  const root = fixture();
  try {
    const original = readFileSync(resolve(root, ".tieline/spec/contract.yaml"), "utf8");
    writeFileSync(
      resolve(root, ".tieline/spec/another.yaml"),
      original
        .replace("key: CONTRACT\n", "key: SEARCH\n")
        .replace("key: CONTRACT-001\n", "key: SEARCH-001\n")
        .replace("key: CONTRACT-001-AC1\n", "key: SEARCH-001-AC1\n")
        .replace(
          `      planning_origin:
        record_id: 00000000-0000-4000-8000-000000000001
        revision: 2
`,
          ""
        )
    );
    const manifest = compileContractManifest({
      repositoryRoot: root,
      repositoryKey: "tieline",
      commit: "abc123",
    });
    assert.deepEqual(
      manifest.capabilities.map((capability) => capability.stable_id),
      ["CONTRACT", "SEARCH"]
    );
    assert.ok(serializeContractManifest(manifest).endsWith("\n"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, 0 failed`);
