import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  createArtifactAssuranceInspector,
  type ArtifactAssuranceInput,
} from "../src/contract/artifact-assurance.js";
import { createArtifactHashResolver } from "../src/contract/manifest.js";
import { resolveSelector } from "../src/contract/selector.js";
import { report, test } from "./lib/harness.js";

const REPOSITORY = "assurance-fixture";

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

await test("reports the complete local freshness and locator status matrix", () => {
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
      inspector.inspect(
        artifact("src/current.ts", "function:currentFeature", sha256(source))
      ),
      {
        freshness: "current",
        broken_cause: null,
        locator_resolution: "resolved",
        locator_reason: null,
        semantic_support: "not_assessed",
      }
    );

    assert.deepEqual(
      inspector.inspect(
        artifact("src/current.ts", "function:currentFeature", sha256("old source\n"))
      ),
      {
        freshness: "stale",
        broken_cause: null,
        locator_resolution: "resolved",
        locator_reason: null,
        semantic_support: "not_assessed",
      }
    );

    assert.deepEqual(
      inspector.inspect(
        artifact("src/current.ts", "function:removedFeature", sha256(source))
      ),
      {
        freshness: "current",
        broken_cause: null,
        locator_resolution: "unresolved",
        locator_reason: null,
        semantic_support: "not_assessed",
      }
    );

    assert.deepEqual(
      inspector.inspect(
        artifact("src/missing.ts", "function:missingFeature", sha256(source))
      ),
      {
        freshness: "broken",
        broken_cause: "missing",
        locator_resolution: "not_checked",
        locator_reason: "file_missing",
        semantic_support: "not_assessed",
      }
    );

    assert.deepEqual(inspector.inspect(artifact("src/current.ts", null, sha256(source))), {
      freshness: "current",
      broken_cause: null,
      locator_resolution: "not_applicable",
      locator_reason: null,
      semantic_support: "not_assessed",
    });

    assert.deepEqual(
      inspector.inspect(
        artifact("src/empty.ts", "function:missingFeature", sha256("// no declarations\n"))
      ),
      {
        freshness: "current",
        broken_cause: null,
        locator_resolution: "not_checked",
        locator_reason: "no_symbols_extracted",
        semantic_support: "not_assessed",
      }
    );

    assert.deepEqual(
      inspector.inspect(
        artifact("src/fixture.rb", "class:CurrentFeature", sha256("class CurrentFeature\nend\n"))
      ),
      {
        freshness: "current",
        broken_cause: null,
        locator_resolution: "not_checked",
        locator_reason: "unsupported_language",
        semantic_support: "not_assessed",
      }
    );

    assert.deepEqual(
      inspector.inspect(artifact("src", "function:currentFeature", null)),
      {
        freshness: "broken",
        broken_cause: "not_file",
        locator_resolution: "not_checked",
        locator_reason: "not_a_file",
        semantic_support: "not_assessed",
      }
    );

    assert.deepEqual(
      inspector.inspect(
        artifact("src/external.ts", "const:external", sha256("export const external = true;\n"))
      ),
      {
        freshness: "broken",
        broken_cause: "outside_repository",
        locator_resolution: "not_checked",
        locator_reason: "outside_repository",
        semantic_support: "not_assessed",
      }
    );

    assert.deepEqual(
      inspector.inspect(
        artifact("src/binary.ts", "const:binary", sha256(Buffer.from([0, 1, 2, 3])))
      ),
      {
        freshness: "current",
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
      sizeLimited.inspect(
        artifact(
          "src/large.ts",
          "const:tooLarge",
          sha256("export const tooLarge = true;\n")
        )
      ),
      {
        freshness: "current",
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

await test("keeps cross-repository assurance unknown without local reads", () => {
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
    inspector.inspect(
      artifact(
        "src/remote.ts",
        "function:remoteFeature",
        "0".repeat(64),
        "another-repository"
      )
    ),
    {
      freshness: "unknown",
      broken_cause: null,
      locator_resolution: "not_checked",
      locator_reason: "cross_repository",
      semantic_support: "not_assessed",
    }
  );
  assert.deepEqual(
    inspector.inspect(
      artifact("src/remote.ts", null, "0".repeat(64), "another-repository")
    ),
    {
      freshness: "unknown",
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

await test("caches file measurement and locator inspection for one request", () => {
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
      assurance: inspector.inspect(first),
    };
    const repeatedClaim = {
      provenance: "inferred" as const,
      link_scope: "story_fallback" as const,
      assurance: inspector.inspect(first),
    };
    const secondClaim = inspector.inspect(second);

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

report();
