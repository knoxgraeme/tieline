import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  createArtifactAssuranceInspector,
  type ArtifactAssuranceInput,
} from "../src/contract/artifact-assurance.js";
import { createArtifactHashResolver } from "../src/contract/manifest.js";
import { createFilesystemSourceSnapshotReader } from "../src/contract/source-snapshot.js";
import { createStructuralSelectorResolver } from "../src/contract/code-analysis/selector-resolution.js";
import {
  createCachedSelectorResolver,
  indexSourceSymbols,
  resolveSelector,
  resolveSelectorInSource,
} from "../src/contract/selector.js";
import { report, test } from "./lib/harness.js";

const REPOSITORY = "assurance-fixture";

async function legacyAssurance(value: ReturnType<ReturnType<typeof createArtifactAssuranceInspector>["inspect"]>) {
  const { locator_matches: _matches, source_evidence: _evidence, ...legacy } = await value;
  return legacy;
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function artifact(
  path: string,
  selector: string | null,
  reviewedContentHash: string | null,
  repository = REPOSITORY
): ArtifactAssuranceInput {
  return {
    target: {
      kind: "code",
      repository,
      path,
      ...(selector ? { selector } : {}),
    },
    reviewed_content_hash: reviewedContentHash,
  };
}

await test("reports the complete local freshness and locator status matrix", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "tieline-assurance-"));
  const outsideRoot = mkdtempSync(resolve(tmpdir(), "tieline-assurance-outside-"));
  try {
    mkdirSync(resolve(root, "src"), { recursive: true });
    const source = "export function currentFeature(): void {}\n";
    writeFileSync(resolve(root, "src/current.ts"), source);
    writeFileSync(resolve(root, "src/empty.ts"), "// no declarations\n");
    writeFileSync(resolve(root, "src/fixture.rb"), "class CurrentFeature\nend\n");
    writeFileSync(resolve(root, "src/binary.ts"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(resolve(root, "src/large.ts"), "export const tooLarge = true;\n");
    writeFileSync(resolve(outsideRoot, "external.ts"), "export const external = true;\n");
    symlinkSync(resolve(outsideRoot, "external.ts"), resolve(root, "src/external.ts"));

    const inspector = createArtifactAssuranceInspector({
      repositoryRoot: root,
      repositoryKey: REPOSITORY,
    });

    assert.deepEqual(
      await legacyAssurance(inspector.inspect(
        artifact("src/current.ts", "function:currentFeature", sha256(source))
      )),
      {
        freshness: "current",
        freshness_reason: null,
        broken_cause: null,
        locator_resolution: "resolved",
        locator_reason: null,
        semantic_support: "not_assessed",
      }
    );

    assert.deepEqual(
      await legacyAssurance(inspector.inspect(
        artifact("src/current.ts", "function:currentFeature", sha256("old source\n"))
      )),
      {
        freshness: "stale",
        freshness_reason: null,
        broken_cause: null,
        locator_resolution: "resolved",
        locator_reason: null,
        semantic_support: "not_assessed",
      }
    );

    assert.deepEqual(
      await legacyAssurance(inspector.inspect(
        artifact("src/current.ts", "function:removedFeature", sha256(source))
      )),
      {
        freshness: "current",
        freshness_reason: null,
        broken_cause: null,
        locator_resolution: "unresolved",
        locator_reason: null,
        semantic_support: "not_assessed",
      }
    );

    assert.deepEqual(
      await legacyAssurance(inspector.inspect(
        artifact("src/missing.ts", "function:missingFeature", sha256(source))
      )),
      {
        freshness: "broken",
        freshness_reason: null,
        broken_cause: "missing",
        locator_resolution: "not_checked",
        locator_reason: "file_missing",
        semantic_support: "not_assessed",
      }
    );

    assert.deepEqual(await legacyAssurance(inspector.inspect(artifact("src/current.ts", null, sha256(source)))), {
      freshness: "current",
      freshness_reason: null,
      broken_cause: null,
      locator_resolution: "not_applicable",
      locator_reason: null,
      semantic_support: "not_assessed",
    });

    assert.deepEqual(
      await legacyAssurance(inspector.inspect(
        artifact("src/empty.ts", "function:missingFeature", sha256("// no declarations\n"))
      )),
      {
        freshness: "current",
        freshness_reason: null,
        broken_cause: null,
        locator_resolution: "unresolved",
        locator_reason: null,
        semantic_support: "not_assessed",
      }
    );

    assert.deepEqual(
      await legacyAssurance(inspector.inspect(
        artifact("src/fixture.rb", "class:CurrentFeature", sha256("class CurrentFeature\nend\n"))
      )),
      {
        freshness: "current",
        freshness_reason: null,
        broken_cause: null,
        locator_resolution: "not_checked",
        locator_reason: "unsupported_language",
        semantic_support: "not_assessed",
      }
    );

    assert.deepEqual(
      await legacyAssurance(inspector.inspect(artifact("src", "function:currentFeature", null))),
      {
        freshness: "broken",
        freshness_reason: null,
        broken_cause: "not_file",
        locator_resolution: "not_checked",
        locator_reason: "not_a_file",
        semantic_support: "not_assessed",
      }
    );

    assert.deepEqual(
      await legacyAssurance(inspector.inspect(
        artifact("src/external.ts", "const:external", sha256("export const external = true;\n"))
      )),
      {
        freshness: "broken",
        freshness_reason: null,
        broken_cause: "outside_repository",
        locator_resolution: "not_checked",
        locator_reason: "outside_repository",
        semantic_support: "not_assessed",
      }
    );

    assert.deepEqual(
      await legacyAssurance(inspector.inspect(
        artifact("src/binary.ts", "const:binary", sha256(Buffer.from([0, 1, 2, 3])))
      )),
      {
        freshness: "current",
        freshness_reason: null,
        broken_cause: null,
        locator_resolution: "not_checked",
        locator_reason: "binary_content",
        semantic_support: "not_assessed",
      }
    );

    const sizeLimited = createArtifactAssuranceInspector({
      repositoryRoot: root,
      repositoryKey: REPOSITORY,
      maxSourceBytes: 8,
    });
    assert.deepEqual(
      await legacyAssurance(sizeLimited.inspect(
        artifact(
          "src/large.ts",
          "const:tooLarge",
          sha256("export const tooLarge = true;\n")
        )
      )),
      {
        freshness: "current",
        freshness_reason: null,
        broken_cause: null,
        locator_resolution: "not_checked",
        locator_reason: "file_too_large",
        semantic_support: "not_assessed",
      }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

await test("emits owner-aware multi-language evidence and conservative ambiguity", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "tieline-assurance-structural-"));
  try {
    mkdirSync(resolve(root, "src"), { recursive: true });
    const typescript = [
      "export interface Service { run(): void }",
      "export class First { same(): void {} }",
      "export class Second { same(): void {} }",
      "export function duplicate(): void {}",
      "export function duplicate(): void {}",
      "",
    ].join("\n");
    const python = "class Café:\n    def exécute(self):\n        return True\n";
    const rust = "struct Worker;\nimpl Worker { fn r#match(&self) {} }\n";
    const malformed = "export function before() {}\nconst broken = ;\nexport function after() {}\n";
    const bounded = [
      "export function bounded(): void {",
      "  const café = '☕';",
      ...Array.from({ length: 50 }, (_, index) => `  consume('${index}—☕');`),
      "}",
      "",
    ].join("\r\n");
    for (const [path, source] of [
      ["src/structure.ts", typescript],
      ["src/unicode.py", python],
      ["src/raw.rs", rust],
      ["src/malformed.ts", malformed],
      ["src/bounded.ts", bounded],
    ] as const) {
      writeFileSync(resolve(root, path), source);
    }

    const inspector = createArtifactAssuranceInspector({
      repositoryRoot: root,
      repositoryKey: REPOSITORY,
      maxEvidenceBytes: 120,
      maxEvidenceLines: 3,
    });
    const first = await inspector.inspect(
      artifact("src/structure.ts", "class:First/method:same", sha256(typescript))
    );
    assert.equal(first.locator_resolution, "resolved");
    assert.equal(first.locator_matches.length, 1);
    assert.equal(first.source_evidence?.canonical_selector, "class:First/method:same");
    assert.equal(first.source_evidence?.analyzed_content_hash, sha256(typescript));
    assert.equal(first.source_evidence?.language, "typescript");
    assert.equal(first.source_evidence?.compatibility.identity.includes("web-tree-sitter"), true);

    const falseOwner = await inspector.inspect(
      artifact("src/structure.ts", "class:First/method:missing", sha256(typescript))
    );
    assert.equal(falseOwner.locator_resolution, "unresolved");
    assert.equal(falseOwner.source_evidence, null);

    const duplicate = await inspector.inspect(
      artifact("src/structure.ts", "function:duplicate", sha256(typescript))
    );
    assert.equal(duplicate.locator_resolution, "ambiguous");
    assert.equal(duplicate.locator_matches.length, 2);
    assert.equal(duplicate.source_evidence, null);
    assert.deepEqual(
      [...duplicate.locator_matches].map((match) => match.range.utf16.start),
      [...duplicate.locator_matches].map((match) => match.range.utf16.start).sort((a, b) => a - b)
    );

    for (const [path, selector, source, language] of [
      ["src/structure.ts", "type:Service", typescript, "typescript"],
      ["src/unicode.py", "class:Café/method:exécute", python, "python"],
      ["src/raw.rs", "type:Worker/method:r#match", rust, "rust"],
    ] as const) {
      const assurance = await inspector.inspect(artifact(path, selector, sha256(source)));
      assert.equal(assurance.locator_resolution, "resolved", `${language}: ${selector}`);
      assert.equal(assurance.source_evidence?.language, language);
      assert.equal(assurance.source_evidence?.canonical_selector.includes("r#"), false);
    }

    const partial = await inspector.inspect(
      artifact("src/malformed.ts", "function:absent", sha256(malformed))
    );
    assert.equal(partial.locator_resolution, "not_checked");
    assert.equal(partial.locator_reason, "parse_incomplete");
    assert.equal(partial.source_evidence, null);

    const stale = await inspector.inspect(
      artifact("src/structure.ts", "type:Service", sha256("older\n"))
    );
    assert.equal(stale.locator_resolution, "resolved");
    assert.equal(stale.freshness, "stale");
    assert.equal(stale.source_evidence, null);

    const limited = await inspector.inspect(
      artifact("src/bounded.ts", "function:bounded", sha256(bounded))
    );
    assert.ok(limited.source_evidence?.snippet.truncated);
    assert.ok(Buffer.byteLength(limited.source_evidence!.snippet.text) <= 120);
    assert.ok(limited.source_evidence!.snippet.text.split(/\r\n|\r|\n/).length <= 3);
    assert.equal(
      bounded.slice(
        limited.source_evidence!.snippet.range.utf16.start,
        limited.source_evidence!.snippet.range.utf16.end
      ),
      limited.source_evidence!.snippet.text,
      "snippet coordinates round-trip over CRLF and Unicode"
    );
    await inspector.dispose();

    const mutablePath = resolve(root, "src/mutable.ts");
    const mutable = "export function mutable(): void {}\n";
    writeFileSync(mutablePath, mutable);
    const structural = createStructuralSelectorResolver();
    const mutatingInspector = createArtifactAssuranceInspector({
      repositoryRoot: root,
      repositoryKey: REPOSITORY,
      async selectorResolver(options) {
        const resolution = await structural.resolve(options);
        writeFileSync(mutablePath, `${mutable}// changed after analysis\n`);
        return resolution;
      },
    });
    const mutated = await mutatingInspector.inspect(
      artifact("src/mutable.ts", "function:mutable", sha256(mutable))
    );
    assert.equal(mutated.locator_resolution, "resolved");
    assert.equal(mutated.source_evidence, null, "post-analysis mutation suppresses old ranges");
    await mutatingInspector.dispose();
    await structural.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("uses exact path spelling for freshness and selector assurance", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "tieline-assurance-case-"));
  try {
    mkdirSync(resolve(root, "src"), { recursive: true });
    const source = "export function currentFeature(): void {}\n";
    const secondSource = "export const secondFeature = true;\n";
    writeFileSync(resolve(root, "src/current.ts"), source);
    writeFileSync(resolve(root, "src/second.ts"), secondSource);
    let selectorInspections = 0;
    let directoryInspections = 0;
    const hashResolver = createArtifactHashResolver(root, {
      entryInspection: {
        stat: (path) => statSync(path),
        readdir: (path) => {
          directoryInspections += 1;
          return readdirSync(path).map((entry) =>
            entry === "current.ts" ? "CURRENT.ts" : entry
          );
        },
      },
    });
    const inspector = createArtifactAssuranceInspector({
      repositoryRoot: root,
      repositoryKey: REPOSITORY,
      hashResolver,
      selectorResolver(options) {
        selectorInspections += 1;
        return resolveSelector(options);
      },
    });

    assert.deepEqual(
      await legacyAssurance(inspector.inspect(
        artifact("src/current.ts", "function:currentFeature", sha256(source))
      )),
      {
        freshness: "broken",
        freshness_reason: null,
        broken_cause: "missing",
        locator_resolution: "not_checked",
        locator_reason: "file_missing",
        semantic_support: "not_assessed",
      }
    );
    assert.equal(
      selectorInspections,
      0,
      "a spelling miss must not inspect a filesystem alias"
    );
    assert.equal(
      (await inspector.inspect(artifact("src/second.ts", null, sha256(secondSource))))
        .freshness,
      "current"
    );
    assert.equal(
      directoryInspections,
      2,
      "shared parent directories are listed once per inspector"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("keeps cross-repository assurance unknown without local reads", async () => {
  let measurements = 0;
  let selectorInspections = 0;
  const inspector = createArtifactAssuranceInspector({
    repositoryRoot: "/unused",
    repositoryKey: REPOSITORY,
    hashResolver: {
      measure() {
        measurements += 1;
        throw new Error("cross-repository targets must not be measured locally");
      },
    },
    selectorResolver(options) {
      selectorInspections += 1;
      return resolveSelector(options);
    },
  });

  assert.deepEqual(
    await legacyAssurance(inspector.inspect(
      artifact(
        "src/remote.ts",
        "function:remoteFeature",
        "0".repeat(64),
        "another-repository"
      )
    )),
    {
      freshness: "unknown",
      freshness_reason: "cross_repository",
      broken_cause: null,
      locator_resolution: "not_checked",
      locator_reason: "cross_repository",
      semantic_support: "not_assessed",
    }
  );
  assert.deepEqual(
    await legacyAssurance(inspector.inspect(
      artifact("src/remote.ts", null, "0".repeat(64), "another-repository")
    )),
    {
      freshness: "unknown",
      freshness_reason: "cross_repository",
      broken_cause: null,
      locator_resolution: "not_checked",
      locator_reason: "cross_repository",
      semantic_support: "not_assessed",
    },
    "cross-repository uncertainty takes precedence over local file-level semantics"
  );
  assert.equal(measurements, 0);
  assert.equal(selectorInspections, 0);
});

await test("defers local filesystem initialization for remote-only reads", async () => {
  const inspector = createArtifactAssuranceInspector({
    repositoryRoot: "/path-that-does-not-exist",
    repositoryKey: REPOSITORY,
  });
  assert.deepEqual(
    await legacyAssurance(inspector.inspect(
      artifact(
        "src/remote.ts",
        "function:remoteFeature",
        "0".repeat(64),
        "another-repository"
      )
    )),
    {
      freshness: "unknown",
      freshness_reason: "cross_repository",
      broken_cause: null,
      locator_resolution: "not_checked",
      locator_reason: "cross_repository",
      semantic_support: "not_assessed",
    }
  );
});

await test("caches file measurement and locator inspection for one request", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "tieline-assurance-cache-"));
  try {
    mkdirSync(resolve(root, "src"), { recursive: true });
    const source = [
      "export function first(): void {}",
      "export function second(): void {}",
      "",
    ].join("\n");
    writeFileSync(resolve(root, "src/repeated.ts"), source);

    const hashes = createArtifactHashResolver(root);
    let measurements = 0;
    let selectorInspections = 0;
    const inspector = createArtifactAssuranceInspector({
      repositoryRoot: root,
      repositoryKey: REPOSITORY,
      hashResolver: {
        measure(path) {
          measurements += 1;
          return hashes.measure(path);
        },
      },
      selectorResolver(options) {
        selectorInspections += 1;
        return resolveSelector(options);
      },
    });
    const first = artifact("src/repeated.ts", "function:first", sha256(source));
    const second = artifact("src/repeated.ts", "function:second", sha256(source));

    const firstClaim = {
      provenance: "authored" as const,
      link_scope: "direct" as const,
      assurance: await inspector.inspect(first),
    };
    const repeatedClaim = {
      provenance: "inferred" as const,
      link_scope: "story_fallback" as const,
      assurance: await inspector.inspect(first),
    };
    const secondClaim = await inspector.inspect(second);

    assert.equal(firstClaim.provenance, "authored");
    assert.equal(repeatedClaim.link_scope, "story_fallback");
    assert.deepEqual(repeatedClaim.assurance, firstClaim.assurance);
    assert.equal(secondClaim.locator_resolution, "resolved");
    assert.equal(measurements, 1, "one file measurement per inspector request");
    assert.equal(selectorInspections, 2, "one selector inspection per distinct locator");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("shares one immutable source read between freshness and locator assurance", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "tieline-assurance-snapshot-"));
  try {
    mkdirSync(resolve(root, "src"), { recursive: true });
    const source = "export function sharedSnapshot(): void {}\n";
    writeFileSync(resolve(root, "src/shared.ts"), source);
    let filesystemReads = 0;
    const snapshots = createFilesystemSourceSnapshotReader({
      repositoryRoot: root,
      readBytes(path) {
        filesystemReads += 1;
        return readFileSync(path);
      },
    });
    const inspector = createArtifactAssuranceInspector({
      repositoryRoot: root,
      repositoryKey: REPOSITORY,
      sourceSnapshotReader: snapshots,
    });

    assert.equal(
      (await inspector.inspect(
        artifact("src/shared.ts", "function:sharedSnapshot", sha256(source))
      )).locator_resolution,
      "resolved"
    );
    assert.equal(filesystemReads, 1, "hashing and lookup share one filesystem read");
    assert.strictEqual(
      snapshots.read("src/shared.ts"),
      snapshots.read("./src/shared.ts"),
      "the backing reader performs only one filesystem read"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("isolates a local inspection failure from readable sibling claims", async () => {
  const source = "export function readable(): void {}\n";
  const root = mkdtempSync(resolve(tmpdir(), "tieline-assurance-isolation-"));
  mkdirSync(resolve(root, "src"), { recursive: true });
  writeFileSync(resolve(root, "src/readable.ts"), source);
  const inspector = createArtifactAssuranceInspector({
    repositoryRoot: root,
    repositoryKey: REPOSITORY,
    hashResolver: {
      measure(path) {
        if (path === "src/unreadable.ts") {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        }
        return { status: "hashed", hash: sha256(source) };
      },
    },
    selectorResolver(options) {
      return resolveSelectorInSource(source, options.selector, {
        path: options.path,
        vocabulary: options.vocabulary,
      });
    },
  });

  assert.deepEqual(
    await legacyAssurance(inspector.inspect(
      artifact("src/unreadable.ts", "function:unreadable", "0".repeat(64))
    )),
    {
      freshness: "unknown",
      freshness_reason: "unreadable",
      broken_cause: null,
      locator_resolution: "not_checked",
      locator_reason: "unreadable",
      semantic_support: "not_assessed",
    }
  );
  assert.deepEqual(
    await legacyAssurance(inspector.inspect(
      artifact("src/readable.ts", "function:readable", sha256(source))
    )),
    {
      freshness: "current",
      freshness_reason: null,
      broken_cause: null,
      locator_resolution: "resolved",
      locator_reason: null,
      semantic_support: "not_assessed",
    }
  );
  rmSync(root, { recursive: true, force: true });
});

await test("caches source reads and symbol indexes by normalized local path", () => {
  const source = [
    "export function first(): void {}",
    "export function second(): void {}",
    "",
  ].join("\n");
  let reads = 0;
  let indexes = 0;
  const resolver = createCachedSelectorResolver({
    readSource() {
      reads += 1;
      return { status: "read", content: source };
    },
    indexSource(content) {
      indexes += 1;
      return indexSourceSymbols(content);
    },
  });

  assert.equal(
    resolver({
      repositoryRoot: "/repository",
      path: "src/repeated.ts",
      selector: "function:first",
    }).status,
    "resolved"
  );
  assert.equal(
    resolver({
      repositoryRoot: "/repository",
      path: "./src/repeated.ts",
      selector: "function:second",
    }).status,
    "resolved"
  );
  assert.equal(reads, 1);
  assert.equal(indexes, 1);
});

report();
