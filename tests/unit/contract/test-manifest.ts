import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  attachCurrentArtifactHashes,
  compileContractManifest,
  compileContractManifestWithSources,
  ContractManifestError,
  manifestDigest,
  readContractManifest,
  serializeContractManifest,
  writeContractManifest,
  type CompiledContractManifest,
} from "../../../src/contract/manifest.js";
import { report, test } from "../../support/harness.js";

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
          provenance: authored
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
              provenance: authored
              target:
                kind: test
                repository: tieline
                path: scripts/contract.test.ts
                framework_hint: custom
            - relation: documents
              provenance: authored
              target:
                kind: help
                source: intercom
                external_id: article-not-fetched
`
  );
  return root;
}

/**
 * A second capability in its own spec file, which is the only way a capability
 * is ever declared. Sharding is per capability, so most of these tests need
 * more than one.
 */
function addSearchCapability(root: string): void {
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
}

function compile(root: string): CompiledContractManifest {
  return compileContractManifestWithSources({
    repositoryRoot: root,
    repositoryKey: "tieline",
  });
}

function manifestDirectory(root: string): string {
  return resolve(root, ".tieline/manifest");
}

console.log("deterministic contract manifest");

await test("compiles byte-identical JSON with source, origin, relation, and artifact hashes", () => {
  const root = fixture();
  try {
    const options = {
      repositoryRoot: root,
      repositoryKey: "tieline",
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
    assert.equal(story.links[0]!.provenance, "authored");
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

await test("keeps the shared manifest index free of runtime revisions", () => {
  const root = fixture();
  try {
    const directory = resolve(root, ".tieline/manifest");
    writeContractManifest(directory, compile(root));
    assert.deepEqual(
      JSON.parse(readFileSync(resolve(directory, "index.json"), "utf8")),
      { schema_version: 2, repository: { key: "tieline" } }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("changes contract semantics when only link provenance changes", () => {
  const root = fixture();
  try {
    const before = compileContractManifest({
      repositoryRoot: root,
      repositoryKey: "tieline",
    });
    const specPath = resolve(root, ".tieline/spec/contract.yaml");
    const authored = readFileSync(specPath, "utf8");
    writeFileSync(
      specPath,
      authored.replace(
        "            - relation: tests\n              provenance: authored",
        "            - relation: tests\n              provenance: inferred"
      )
    );
    const after = compileContractManifest({
      repositoryRoot: root,
      repositoryKey: "tieline",
    });
    const beforeStory = before.capabilities[0]!.stories[0]!;
    const afterStory = after.capabilities[0]!.stories[0]!;
    const beforeCriterion = beforeStory.acceptance_criteria[0]!;
    const afterCriterion = afterStory.acceptance_criteria[0]!;

    assert.equal(beforeStory.contract_hash, afterStory.contract_hash);
    assert.notEqual(beforeCriterion.contract_hash, afterCriterion.contract_hash);
    assert.equal(
      afterCriterion.links.find((link) => link.relation === "tests")!.provenance,
      "inferred"
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
    assert.notEqual(
      manifestDigest(before),
      manifestDigest(after),
      "the assembled manifest digest changes with reviewed content"
    );
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
    assert.equal(
      manifestDigest(measured),
      manifestDigest(reviewed),
      "runtime-only current hashes do not change reviewed manifest identity"
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
    const compiled = compile(root);
    compiled.manifest.capabilities[0]!.stories[0]!.acceptance_criteria[0]!
      .links[0]!.reviewed_content_hash = "not-a-content-hash";
    const directory = manifestDirectory(root);
    writeContractManifest(directory, compiled);
    assert.throws(
      () => readContractManifest(directory),
      (error: unknown) => {
        assert.ok(error instanceof ContractManifestError);
        assert.match(error.message, /reviewed_content_hash/i);
        assert.match(error.message, /CONTRACT\.json/);
        return true;
      }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("rejects a reviewed manifest link with no provenance", () => {
  const root = fixture();
  try {
    const compiled = compile(root);
    const link = compiled.manifest.capabilities[0]!.stories[0]!
      .acceptance_criteria[0]!.links[0]! as unknown as Record<string, unknown>;
    delete link.provenance;
    const directory = manifestDirectory(root);
    writeContractManifest(directory, compiled);
    assert.throws(
      () => readContractManifest(directory),
      (error: unknown) => {
        assert.ok(error instanceof ContractManifestError);
        assert.match(error.message, /provenance/i);
        assert.match(error.message, /CONTRACT\.json/);
        return true;
      }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("round-trips a compiled manifest through the directory it writes", () => {
  const root = fixture();
  try {
    addSearchCapability(root);
    const compiled = compile(root);
    const directory = manifestDirectory(root);
    const written = writeContractManifest(directory, compiled);

    assert.deepEqual(written.files, [
      "CONTRACT.json",
      "index.json",
      "SEARCH.json",
    ]);
    assert.deepEqual(written.removed, []);

    // Reading reassembles the same in-memory object, so everything downstream
    // of the manifest — impact, coverage, sync — cannot tell it was sharded.
    const read = readContractManifest(directory);
    assert.deepEqual(read, compiled.manifest);
    assert.equal(
      serializeContractManifest(read),
      serializeContractManifest(compiled.manifest),
      "sharding does not change what `manifest_current` compares"
    );

    // The index holds only what belongs to the repository as a whole.
    assert.deepEqual(
      JSON.parse(readFileSync(resolve(directory, "index.json"), "utf8")),
      {
        schema_version: 2,
        repository: { key: "tieline" },
      }
    );

    // Provenance travels with the capability instead of a central input list.
    const shard = JSON.parse(
      readFileSync(resolve(directory, "SEARCH.json"), "utf8")
    );
    assert.deepEqual(Object.keys(shard).sort(), ["capability", "input"]);
    assert.equal(shard.input.path, ".tieline/spec/another.yaml");
    assert.match(shard.input.sha256, /^[a-f0-9]{64}$/);
    assert.equal(shard.capability.stable_id, "SEARCH");
    assert.deepEqual(
      read.inputs.map((input) => input.path),
      [".tieline/spec/another.yaml", ".tieline/spec/contract.yaml"],
      "inputs are reassembled from the shards in a stable order"
    );

    // Writing again produces byte-identical files, which is the property CI
    // asserts on a branch that changed nothing.
    const before = readdirSync(directory).map((name) => [
      name,
      readFileSync(resolve(directory, name), "utf8"),
    ]);
    writeContractManifest(directory, compile(root));
    assert.deepEqual(
      readdirSync(directory).map((name) => [
        name,
        readFileSync(resolve(directory, name), "utf8"),
      ]),
      before
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("removes the file of a capability the contract no longer declares", () => {
  const root = fixture();
  try {
    addSearchCapability(root);
    const directory = manifestDirectory(root);
    writeContractManifest(directory, compile(root));

    // Nothing else in the directory is the manifest's to delete.
    writeFileSync(resolve(directory, "notes.txt"), "kept\n");
    mkdirSync(resolve(directory, "nested"), { recursive: true });
    writeFileSync(resolve(directory, "nested/SEARCH.json"), "{}\n");

    rmSync(resolve(root, ".tieline/spec/another.yaml"));
    const rewritten = writeContractManifest(directory, compile(root));

    assert.deepEqual(rewritten.removed, ["SEARCH.json"]);
    assert.deepEqual(readdirSync(directory).sort(), [
      "CONTRACT.json",
      "index.json",
      "nested",
      "notes.txt",
    ]);
    assert.ok(existsSync(resolve(directory, "nested/SEARCH.json")));
    assert.deepEqual(
      readContractManifest(directory).capabilities.map(
        (capability) => capability.stable_id
      ),
      ["CONTRACT"],
      "a deleted capability leaves nothing behind to read"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("reports a missing manifest directory or index instead of reading a partial contract", () => {
  const root = fixture();
  try {
    const directory = manifestDirectory(root);
    assert.throws(
      () => readContractManifest(directory),
      (error: unknown) => {
        assert.ok(error instanceof ContractManifestError);
        assert.match(error.message, /manifest directory does not exist/);
        assert.match(error.message, /contract compile/);
        return true;
      }
    );

    writeContractManifest(directory, compile(root));
    rmSync(resolve(directory, "index.json"));
    assert.throws(
      () => readContractManifest(directory),
      (error: unknown) => {
        assert.ok(error instanceof ContractManifestError);
        assert.match(error.message, /index\.json' does not exist/);
        assert.match(error.message, /contract compile/);
        return true;
      }
    );

    // An index with nothing beside it is a half-deleted directory, never an
    // empty contract: a spec directory with no YAML cannot compile at all.
    writeContractManifest(directory, compile(root));
    rmSync(resolve(directory, "CONTRACT.json"));
    assert.throws(
      () => readContractManifest(directory),
      (error: unknown) => {
        assert.ok(error instanceof ContractManifestError);
        assert.match(error.message, /index but no capabilities/);
        return true;
      }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("rejects the legacy manifest index shape", () => {
  const root = fixture();
  try {
    const directory = manifestDirectory(root);
    writeContractManifest(directory, compile(root));
    writeFileSync(
      resolve(directory, "index.json"),
      `${JSON.stringify(
        {
          schema_version: 1,
          repository: { key: "tieline", commit: "legacy-commit" },
        },
        null,
        2
      )}\n`
    );
    assert.throws(
      () => readContractManifest(directory),
      (error: unknown) => {
        assert.ok(error instanceof ContractManifestError);
        assert.match(error.message, /schema_version/);
        return true;
      }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("rejects a manifest file whose name disagrees with the capability it holds", () => {
  const root = fixture();
  try {
    const directory = manifestDirectory(root);
    writeContractManifest(directory, compile(root));
    renameSync(
      resolve(directory, "CONTRACT.json"),
      resolve(directory, "RENAMED.json")
    );
    assert.throws(
      () => readContractManifest(directory),
      (error: unknown) => {
        assert.ok(error instanceof ContractManifestError);
        assert.match(error.message, /RENAMED\.json/);
        assert.match(error.message, /'CONTRACT'/);
        assert.match(error.message, /CONTRACT\.json/);
        return true;
      }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("rejects duplicate stable IDs across kinds and manifest shards", () => {
  type MutableShard = {
    capability: {
      stable_id: string;
      stories: Array<{
        stable_id: string;
        acceptance_criteria: Array<{
          stable_id: string;
          scenarios: Array<{ stable_id: string }>;
        }>;
      }>;
    };
  };
  const cases: Array<{
    name: string;
    mutate(contract: MutableShard, search: MutableShard): string;
    locations: RegExp;
  }> = [
    {
      name: "story across shards",
      mutate: (contract, search) => {
        const duplicateId = contract.capability.stories[0]!.stable_id;
        search.capability.stories[0]!.stable_id = duplicateId;
        return duplicateId;
      },
      locations: /CONTRACT\.json.*SEARCH\.json/,
    },
    {
      name: "acceptance criterion across shards",
      mutate: (contract, search) => {
        const duplicateId =
          contract.capability.stories[0]!.acceptance_criteria[0]!.stable_id;
        search.capability.stories[0]!.acceptance_criteria[0]!.stable_id =
          duplicateId;
        return duplicateId;
      },
      locations: /CONTRACT\.json.*SEARCH\.json/,
    },
    {
      name: "scenario across shards",
      mutate: (contract, search) => {
        const duplicateId =
          contract.capability.stories[0]!.acceptance_criteria[0]!.scenarios[0]!
            .stable_id;
        search.capability.stories[0]!.acceptance_criteria[0]!.scenarios[0]!
          .stable_id = duplicateId;
        return duplicateId;
      },
      locations: /CONTRACT\.json.*SEARCH\.json/,
    },
    {
      name: "capability and story in one shard",
      mutate: (contract) => {
        const duplicateId = contract.capability.stable_id;
        contract.capability.stories[0]!.stable_id = duplicateId;
        return duplicateId;
      },
      locations: /CONTRACT\.json.*CONTRACT\.json/,
    },
  ];

  for (const testCase of cases) {
    const root = fixture();
    try {
      addSearchCapability(root);
      const directory = manifestDirectory(root);
      writeContractManifest(directory, compile(root));
      const contractPath = resolve(directory, "CONTRACT.json");
      const searchPath = resolve(directory, "SEARCH.json");
      const contract = JSON.parse(
        readFileSync(contractPath, "utf8")
      ) as MutableShard;
      const search = JSON.parse(
        readFileSync(searchPath, "utf8")
      ) as MutableShard;
      const duplicateId = testCase.mutate(contract, search);
      writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
      writeFileSync(searchPath, `${JSON.stringify(search, null, 2)}\n`);

      assert.throws(
        () => readContractManifest(directory),
        (error: unknown) => {
          assert.ok(error instanceof ContractManifestError);
          assert.match(error.message, /duplicate stable ID/i, testCase.name);
          assert.match(error.message, new RegExp(duplicateId), testCase.name);
          assert.match(error.message, testCase.locations, testCase.name);
          return true;
        },
        testCase.name
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

await test("rejects authored stable IDs that collide with generated scenario IDs", () => {
  const root = fixture();
  try {
    const original = readFileSync(
      resolve(root, ".tieline/spec/contract.yaml"),
      "utf8"
    );
    writeFileSync(
      resolve(root, ".tieline/spec/scenario-collision.yaml"),
      original
        .replace("key: CONTRACT\n", "key: CONTRACT-001-AC1-S1\n")
        .replace("key: CONTRACT-001\n", "key: COLLISION-STORY\n")
        .replace("key: CONTRACT-001-AC1\n", "key: COLLISION-AC\n")
        .replace(
          `      planning_origin:
        record_id: 00000000-0000-4000-8000-000000000001
        revision: 2
`,
          ""
        )
    );

    assert.throws(
      () => compile(root),
      (error: unknown) => {
        assert.ok(error instanceof ContractManifestError);
        assert.match(error.message, /duplicate stable ID/i);
        assert.match(error.message, /CONTRACT-001-AC1-S1/);
        assert.match(error.message, /contract\.yaml/);
        assert.match(error.message, /scenario-collision\.yaml/);
        return true;
      }
    );
    assert.equal(
      existsSync(manifestDirectory(root)),
      false,
      "compilation fails before an unreadable manifest can be written"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("refuses to build a manifest file name that escapes the manifest directory", () => {
  const root = fixture();
  try {
    // The document schema already restricts stable IDs to characters that name
    // a file safely. This is the second lock: a manifest handed a stable ID
    // that would escape must fail rather than write outside the directory.
    const compiled = compile(root);
    const capability = compiled.manifest.capabilities[0]!;
    const escaping: CompiledContractManifest = {
      manifest: {
        ...compiled.manifest,
        capabilities: [{ ...capability, stable_id: "../escaped" }],
      },
      sources: new Map([
        ["../escaped", compiled.sources.get(capability.stable_id)!],
      ]),
    };
    const directory = manifestDirectory(root);
    assert.throws(
      () => writeContractManifest(directory, escaping),
      (error: unknown) => {
        assert.ok(error instanceof ContractManifestError);
        assert.match(error.message, /cannot name a manifest file/);
        return true;
      }
    );
    assert.equal(existsSync(resolve(root, ".tieline/escaped.json")), false);
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
    addSearchCapability(root);
    const manifest = compileContractManifest({
      repositoryRoot: root,
      repositoryKey: "tieline",
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

report();
