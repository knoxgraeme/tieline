import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runCli, type TielineCliIO } from "../../../src/cli.js";
import type { RepositoryPathChange } from "../../../src/contract/impact.js";
import { createJavaScriptAnalyzer } from "../../../src/contract/code-analysis/javascript.js";
import {
  buildGradeScope,
  GradeVerdictError,
  parseGradeVerdicts,
  verifyGradeVerdicts,
  type GradeCodeAnalysisSession,
  type GradeScope,
} from "../../../src/contract/grade.js";
import {
  compileContractManifest,
  compileContractManifestWithSources,
  parseContractManifestSnapshot,
  writeContractManifest,
  type ContractManifest,
} from "../../../src/contract/manifest.js";
import { createFilesystemSourceSnapshotReader } from "../../../src/contract/source-snapshot.js";

const REPOSITORY = "grade-fixture";
const root = mkdtempSync(resolve(tmpdir(), "tieline-grade-"));
const OVERSIZED_SOURCE_BYTES = 512_001;

function oversizedSource(marker: "a" | "b"): string {
  const declaration = "export const oversizedValue = true;\n";
  const mutationOffset = 128 * 1024;
  return (
    declaration +
    " ".repeat(mutationOffset - declaration.length) +
    marker +
    " ".repeat(OVERSIZED_SOURCE_BYTES - mutationOffset - 1)
  );
}

try {
  mkdirSync(resolve(root, ".tieline/spec"), { recursive: true });
  mkdirSync(resolve(root, "src"), { recursive: true });
  writeFileSync(
    resolve(root, "src/feature.ts"),
    `// commentOnlyFeature is prose, not a legal citation.
export function computeFeature(): number {
  const featureLocal = 1;
  return featureLocal;
}
`
  );
  writeFileSync(
    resolve(root, "src/shared.ts"),
    "export const unrelatedSharedImplementation = true;\n"
  );
  writeFileSync(
    resolve(root, "src/renamed.ts"),
    "export const futureRenameTarget = true;\n"
  );
  writeFileSync(
    resolve(root, "src/deleted.ts"),
    "export const deletedFeature = true;\n"
  );
  writeFileSync(resolve(root, "src/notes.md"), "# Implementation notes\n");
  writeFileSync(
    resolve(root, "src/unlinked.ts"),
    "export const unlinkedFeature = true;\n"
  );
  writeFileSync(
    resolve(root, "src/feature.py"),
    `class Worker:
    def run(self):
        local_only = "python"
        return local_only

    def stop(self):
        return True
`
  );
  writeFileSync(
    resolve(root, "src/feature.rs"),
    `pub struct Worker;

impl Worker {
    pub fn run(&self) -> bool {
        let local_only = true;
        local_only
    }
}
`
  );
  writeFileSync(
    resolve(root, "src/incomplete.ts"),
    "export function before(): boolean { return true; }\nexport function broken( {\n"
  );
  writeFileSync(
    resolve(root, "src/selectors.ts"),
    "export const plainValue = true;\nexport const callableValue = () => true;\n"
  );
  writeFileSync(
    resolve(root, "src/damaged.ts"),
    "export function intact(): boolean { return true; }\nexport function broken( {\n"
  );
  writeFileSync(
    resolve(root, "src/importing.ts"),
    "import { dependency } from './dependency.js';\nexport function importing(): boolean { return dependency; }\n"
  );
  writeFileSync(resolve(root, "src/oversized.ts"), oversizedSource("a"));
  writeFileSync(
    resolve(root, ".tieline/spec/feature.yaml"),
    `version: 1
capability:
  key: FEATURE
  name: Grade evidence
  description: Changed contract links can be judged against their acceptance criteria.
  stories:
    - key: FEATURE-001
      title: Grade changed evidence
      actor: reviewing agent
      goal: judge every changed contract link
      benefit: unsupported evidence remains visible
      lifecycle: production
      links:
        - relation: implements
          provenance: authored
          target:
            kind: code
            repository: ${REPOSITORY}
            path: src/shared.ts
      acceptance_criteria:
        - key: FEATURE-001-AC1
          criterion: Tieline must emit every changed link without relevance filtering.
          links:
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: ${REPOSITORY}
                path: src/feature.ts
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: ${REPOSITORY}
                path: src/renamed.ts
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: ${REPOSITORY}
                path: src/shared.ts
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: another-repository
                path: src/feature.ts
        - key: FEATURE-001-AC2
          criterion: Tieline must retain changed evidence that has no readable symbols.
          links:
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: ${REPOSITORY}
                path: src/deleted.ts
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: ${REPOSITORY}
                path: src/notes.md
`
  );

  const manifest = compileContractManifest({
    repositoryRoot: root,
    repositoryKey: REPOSITORY,
    specDirectory: ".tieline/spec",
  });
  const scopeFor = async (
    changes: RepositoryPathChange[],
    baseManifest: ContractManifest | null = manifest
  ) =>
    buildGradeScope({
      repositoryRoot: root,
      base: "HEAD",
      manifest,
      baseManifest,
      changes,
      sourceRoots: ["src"],
      ignore: [".git", ".tieline"],
      specDirectory: ".tieline/spec",
    });
  const instrumentedAnalysisSession = (
    options: {
      maxSymbols?: number;
      maxReferences?: number;
      maxDiagnostics?: number;
    } = {}
  ) => {
    const reader = createFilesystemSourceSnapshotReader({ repositoryRoot: root });
    const analyzer = createJavaScriptAnalyzer(options);
    const calls = { reads: 0, analyses: 0, disposals: 0 };
    const session: GradeCodeAnalysisSession = {
      read(path) {
        calls.reads += 1;
        return reader.read(path);
      },
      async analyze(snapshot) {
        calls.analyses += 1;
        return analyzer.analyze(snapshot);
      },
      async dispose() {
        calls.disposals += 1;
        try {
          await analyzer.dispose();
        } finally {
          reader.dispose?.();
        }
      },
    };
    return { session, calls };
  };
  const scopeForTarget = async (
    path: string,
    selector: string | null = null,
    currentManifest: ContractManifest = manifest,
    codeAnalysisSession?: GradeCodeAnalysisSession
  ): Promise<GradeScope> => {
    const linked = structuredClone(currentManifest);
    const target = linked.capabilities[0]!.stories[0]!.acceptance_criteria[0]!
      .links.find(
        (link) =>
          link.target.kind === "code" &&
          link.target.repository === REPOSITORY &&
          link.target.path === "src/feature.ts"
      )?.target;
    assert.equal(target?.kind, "code");
    if (!target || target.kind !== "code") {
      throw new Error("expected code target fixture");
    }
    target.path = path;
    target.selector = selector;
    return buildGradeScope({
      repositoryRoot: root,
      base: "HEAD",
      manifest: linked,
      baseManifest: linked,
      changes: [{ status: "modified", path }],
      sourceRoots: ["src"],
      ignore: [".git", ".tieline"],
      specDirectory: ".tieline/spec",
      codeAnalysisSession,
    });
  };

  const invalidManifest = structuredClone(manifest);
  const invalidTarget = invalidManifest.capabilities[0]!.stories[0]!
    .acceptance_criteria[0]!.links.find(
      (link) =>
        link.target.kind === "code" && link.target.path === "src/feature.ts"
    )?.target;
  assert.equal(invalidTarget?.kind, "code");
  if (!invalidTarget || invalidTarget.kind !== "code") {
    throw new Error("expected invalid-manifest fixture target");
  }
  invalidTarget.path = "../outside.ts";
  const reconciliationFailureCalls = { reads: 0, analyses: 0, disposals: 0 };
  await assert.rejects(
    buildGradeScope({
      repositoryRoot: root,
      base: "HEAD",
      manifest: invalidManifest,
      baseManifest: invalidManifest,
      changes: [],
      sourceRoots: ["src"],
      codeAnalysisSession: {
        read(path) {
          reconciliationFailureCalls.reads += 1;
          return { status: "missing", path, detail: "must not be read" };
        },
        async analyze() {
          reconciliationFailureCalls.analyses += 1;
          return null;
        },
        async dispose() {
          reconciliationFailureCalls.disposals += 1;
          throw new Error("injected disposal failure");
        },
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /not repository-relative/);
      assert.equal(error.errors.length, 2);
      assert.match(String(error.errors[1]), /injected disposal failure/);
      return true;
    }
  );
  assert.deepEqual(reconciliationFailureCalls, {
    reads: 0,
    analyses: 0,
    disposals: 1,
  });

  const baseTraversalFailureCalls = { reads: 0, analyses: 0, disposals: 0 };
  await assert.rejects(
    buildGradeScope({
      repositoryRoot: root,
      base: "HEAD",
      manifest,
      baseManifest: invalidManifest,
      changes: [],
      sourceRoots: ["src"],
      codeAnalysisSession: {
        read(path) {
          baseTraversalFailureCalls.reads += 1;
          return { status: "missing", path, detail: "must not be read" };
        },
        async analyze() {
          baseTraversalFailureCalls.analyses += 1;
          return null;
        },
        async dispose() {
          baseTraversalFailureCalls.disposals += 1;
        },
      },
    }),
    /not repository-relative/
  );
  assert.deepEqual(baseTraversalFailureCalls, {
    reads: 0,
    analyses: 0,
    disposals: 1,
  });

  const feature = await scopeFor([
    { status: "modified", path: "src/feature.ts" },
  ]);
  assert.equal(feature.base, "HEAD");
  assert.equal(feature.repository, REPOSITORY);
  assert.equal(feature.scoped_links, 1);
  assert.equal(feature.entries[0]?.acceptance_criterion_stable_id, "FEATURE-001-AC1");
  assert.equal(feature.entries[0]?.acceptance_criterion, "Tieline must emit every changed link without relevance filtering.");
  assert.equal(feature.entries[0]?.relation, "implements");
  assert.equal(feature.entries[0]?.provenance, "authored");
  assert.equal(feature.entries[0]?.link_scope, "direct");
  assert.deepEqual(
    [
      feature.entries[0]?.target_kind,
      feature.entries[0]?.repository,
      feature.entries[0]?.selector,
      feature.entries[0]?.framework_hint,
    ],
    ["code", REPOSITORY, null, null]
  );
  assert.equal(feature.entries[0]?.path, "src/feature.ts");
  assert.equal(feature.entries[0]?.previous_path, null);
  assert.equal(feature.entries[0]?.reason, "modified");
  assert.deepEqual(feature.entries[0]?.symbols, ["function:computeFeature"]);
  assert.equal(feature.entries[0]?.symbols.includes("function:commentOnlyFeature"), false);
  assert.equal(feature.entries[0]?.code_evidence.status, "available");
  assert.equal(feature.entries[0]?.code_evidence.reason, null);
  assert.equal(feature.entries[0]?.code_evidence.language, "typescript");
  assert.match(feature.entries[0]?.code_evidence.content_hash ?? "", /^[a-f0-9]{64}$/);
  assert.match(
    feature.entries[0]?.code_evidence.parser_compatibility ?? "",
    /web-tree-sitter-0\.26\.12/
  );
  assert.equal("digest" in feature.entries[0]!.code_evidence, false);
  assert.deepEqual(
    feature.entries[0]?.code_evidence.symbols.map(
      (symbol) => symbol.canonical_selector
    ),
    ["function:computeFeature"]
  );
  const computeEvidence = feature.entries[0]?.code_evidence.symbols[0];
  assert.equal(computeEvidence?.native_kind, "function_declaration");
  assert.equal(computeEvidence?.syntax_status, "exact");
  assert.match(computeEvidence?.symbol_identity ?? "", /^symbol:[a-f0-9]{64}$/);
  assert.match(computeEvidence?.snippet.text ?? "", /return featureLocal/);
  assert.equal("language" in computeEvidence!, false);
  assert.equal("analyzed_content_hash" in computeEvidence!, false);
  assert.equal("compatibility" in computeEvidence!, false);
  assert.ok(computeEvidence?.name_range);
  assert.ok(computeEvidence?.range);
  assert.match(feature.entries[0]?.id ?? "", /^grade:[a-f0-9]{64}$/);
  assert.deepEqual(
    await scopeFor([{ status: "modified", path: "src/feature.ts" }]),
    feature
  );

  const rewrittenCriterionManifest = structuredClone(manifest);
  rewrittenCriterionManifest.capabilities[0]!.stories[0]!.acceptance_criteria[0]!
    .criterion = "Tieline must emit changed links with parser-backed evidence.";
  const rewrittenCriterionScope = await buildGradeScope({
    repositoryRoot: root,
    base: "HEAD",
    manifest: rewrittenCriterionManifest,
    baseManifest: rewrittenCriterionManifest,
    changes: [{ status: "modified", path: "src/feature.ts" }],
    sourceRoots: ["src"],
  });
  assert.notEqual(
    rewrittenCriterionScope.entries[0]?.id,
    feature.entries[0]?.id,
    "the exact current criterion sentence contributes to the grade identity"
  );

  writeFileSync(
    resolve(root, "src/feature.ts"),
    readFeatureSource().replace("const featureLocal = 1", "const featureLocal = 2")
  );
  const rewrittenCode = await scopeFor([
    { status: "modified", path: "src/feature.ts" },
  ]);
  assert.notEqual(
    rewrittenCode.entries[0]?.id,
    feature.entries[0]?.id,
    "a same-symbol source rewrite contributes to the grade identity"
  );
  writeFileSync(resolve(root, "src/feature.ts"), readFeatureSource());

  const python = await scopeForTarget("src/feature.py");
  assert.deepEqual(python.entries[0]?.symbols, [
    "class:Worker",
    "class:Worker/method:run",
    "class:Worker/method:stop",
  ]);
  assert.equal(python.entries[0]?.code_evidence.language, "python");
  assert.equal(
    python.entries[0]?.code_evidence.symbols.some((symbol) =>
      symbol.canonical_selector.includes("local_only")
    ),
    false
  );

  const rust = await scopeForTarget("src/feature.rs");
  assert.deepEqual(rust.entries[0]?.symbols, ["type:Worker", "type:Worker/method:run"]);
  assert.equal(rust.entries[0]?.code_evidence.language, "rust");
  assert.equal(
    rust.entries[0]?.code_evidence.symbols.some((symbol) =>
      symbol.canonical_selector.includes("local_only")
    ),
    false
  );

  const firstOversizedContent = oversizedSource("a");
  const rewrittenOversizedContent = oversizedSource("b");
  assert.equal(
    firstOversizedContent.slice(0, 64 * 1024),
    rewrittenOversizedContent.slice(0, 64 * 1024),
    "the rewrite differs only beyond the streaming hash chunk"
  );
  const firstOversized = await scopeForTarget("src/oversized.ts");
  assert.deepEqual(firstOversized.entries[0]?.symbols, []);
  assert.equal(firstOversized.entries[0]?.code_evidence.status, "unavailable");
  assert.equal(firstOversized.entries[0]?.code_evidence.reason, "oversized");
  assert.match(
    firstOversized.entries[0]?.code_evidence.content_hash ?? "",
    /^[a-f0-9]{64}$/
  );
  assert.equal(
    firstOversized.entries[0]?.code_evidence.content_hash,
    createHash("sha256").update(firstOversizedContent).digest("hex")
  );
  writeFileSync(resolve(root, "src/oversized.ts"), rewrittenOversizedContent);
  const rewrittenOversized = await scopeForTarget("src/oversized.ts");
  assert.deepEqual(rewrittenOversized.entries[0]?.symbols, []);
  assert.equal(
    rewrittenOversized.entries[0]?.code_evidence.status,
    "unavailable"
  );
  assert.equal(
    rewrittenOversized.entries[0]?.code_evidence.reason,
    "oversized"
  );
  assert.equal(
    rewrittenOversized.entries[0]?.code_evidence.content_hash,
    createHash("sha256").update(rewrittenOversizedContent).digest("hex")
  );
  assert.notEqual(
    rewrittenOversized.entries[0]?.code_evidence.content_hash,
    firstOversized.entries[0]?.code_evidence.content_hash,
    "an equal-size oversized rewrite receives a new streamed content hash"
  );
  assert.notEqual(
    rewrittenOversized.entries[0]?.id,
    firstOversized.entries[0]?.id,
    "an equal-size oversized rewrite invalidates the previous verdict ID"
  );

  const boundedSession = instrumentedAnalysisSession({ maxSymbols: 0 });
  const truncated = await scopeForTarget(
    "src/feature.ts",
    null,
    manifest,
    boundedSession.session
  );
  assert.deepEqual(truncated.entries[0]?.symbols, []);
  assert.equal(truncated.entries[0]?.code_evidence.status, "unavailable");
  assert.equal(truncated.entries[0]?.code_evidence.reason, "parse_incomplete");
  assert.deepEqual(boundedSession.calls, {
    reads: 1,
    analyses: 1,
    disposals: 1,
  });

  const plainConst = await scopeForTarget(
    "src/selectors.ts",
    "function:plainValue"
  );
  assert.deepEqual(plainConst.entries[0]?.symbols, []);
  assert.equal(plainConst.entries[0]?.code_evidence.reason, "selector_unresolved");

  const callableAlias = await scopeForTarget(
    "src/selectors.ts",
    "function:callableValue"
  );
  assert.deepEqual(callableAlias.entries[0]?.symbols, []);
  assert.equal(callableAlias.entries[0]?.code_evidence.reason, "selector_unresolved");
  const callableCanonical = await scopeForTarget(
    "src/selectors.ts",
    "const:callableValue"
  );
  assert.deepEqual(callableCanonical.entries[0]?.symbols, ["const:callableValue"]);

  const intactDespiteDamage = await scopeForTarget(
    "src/damaged.ts",
    "function:intact"
  );
  assert.deepEqual(intactDespiteDamage.entries[0]?.symbols, ["function:intact"]);
  assert.equal(intactDespiteDamage.entries[0]?.code_evidence.status, "available");
  assert.ok(intactDespiteDamage.entries[0]!.code_evidence.diagnostics.length > 0);
  assert.deepEqual(
    intactDespiteDamage.entries[0]?.code_evidence.symbols[0]?.diagnostics,
    []
  );

  const referenceBoundedSession = instrumentedAnalysisSession({ maxReferences: 0 });
  const referenceTruncated = await scopeForTarget(
    "src/importing.ts",
    "function:importing",
    manifest,
    referenceBoundedSession.session
  );
  assert.deepEqual(referenceTruncated.entries[0]?.symbols, ["function:importing"]);
  assert.equal(referenceTruncated.entries[0]?.code_evidence.status, "available");
  assert.deepEqual(referenceBoundedSession.calls, {
    reads: 1,
    analyses: 1,
    disposals: 1,
  });

  const selectorManifest = structuredClone(manifest);
  const selectorLinks =
    selectorManifest.capabilities[0]!.stories[0]!.acceptance_criteria[0]!.links;
  const selectorLinkIndex = selectorLinks.findIndex(
    (link) =>
      link.target.kind === "code" &&
      link.target.repository === REPOSITORY &&
      link.target.path === "src/feature.ts"
  );
  const selectorLink = selectorLinks[selectorLinkIndex];
  assert.equal(selectorLink?.target.kind, "code");
  if (selectorLink?.target.kind !== "code") {
    throw new Error("expected a code link fixture");
  }
  selectorLink.target.path = "src/feature.py";
  selectorLink.target.selector = "class:Worker/method:run";
  const secondSelector = structuredClone(selectorLink);
  secondSelector.target.selector = "class:Worker/method:stop";
  selectorLinks.splice(selectorLinkIndex + 1, 0, secondSelector);
  const selectorScope = await buildGradeScope({
    repositoryRoot: root,
    base: "HEAD",
    manifest: selectorManifest,
    baseManifest: selectorManifest,
    changes: [{ status: "modified", path: "src/feature.py" }],
    sourceRoots: ["src"],
  });
  assert.equal(selectorScope.scoped_links, 2);
  assert.equal(new Set(selectorScope.entries.map((entry) => entry.id)).size, 2);
  assert.deepEqual(
    selectorScope.entries.map((entry) => [
      entry.target_kind,
      entry.repository,
      entry.linked_path,
      entry.selector,
      entry.framework_hint,
      entry.relation,
      entry.link_scope,
    ]),
    [
      [
        "code",
        REPOSITORY,
        "src/feature.py",
        "class:Worker/method:run",
        null,
        "implements",
        "direct",
      ],
      [
        "code",
        REPOSITORY,
        "src/feature.py",
        "class:Worker/method:stop",
        null,
        "implements",
        "direct",
      ],
    ]
  );
  assert.deepEqual(
    selectorScope.entries.map((entry) => entry.symbols),
    [["class:Worker/method:run"], ["class:Worker/method:stop"]]
  );
  const crossSelectorCitation = verifyGradeVerdicts({
    scope: selectorScope,
    verdicts: [
      {
        id: selectorScope.entries[0]!.id,
        grade: "supported",
        citation: "class:Worker/method:stop",
      },
      {
        id: selectorScope.entries[1]!.id,
        grade: "partial",
        reason: "Not part of this isolation assertion.",
      },
    ],
  });
  assert.equal(crossSelectorCitation.entries[0]?.grade, "unsupported");
  assert.equal(crossSelectorCitation.entries[0]?.cause, "fabricated_citation");

  writeFileSync(
    resolve(root, "src/ambiguous.ts"),
    "export function duplicate(): number;\nexport function duplicate(): string;\n"
  );
  const ambiguous = await scopeForTarget(
    "src/ambiguous.ts",
    "function:duplicate"
  );
  assert.deepEqual(ambiguous.entries[0]?.symbols, []);
  assert.equal(ambiguous.entries[0]?.code_evidence.status, "unavailable");
  assert.equal(ambiguous.entries[0]?.code_evidence.reason, "selector_ambiguous");

  const incomplete = await scopeForTarget("src/incomplete.ts");
  assert.deepEqual(incomplete.entries[0]?.symbols, []);
  assert.equal(incomplete.entries[0]?.code_evidence.status, "unavailable");
  assert.equal(incomplete.entries[0]?.code_evidence.reason, "parse_incomplete");

  const unreadableSessionCalls = { analyses: 0, disposals: 0 };
  const unreadable = await scopeForTarget(
    "src/feature.ts",
    null,
    manifest,
    {
      read(path) {
        return { status: "unreadable" as const, path, detail: "test read failure" };
      },
      async analyze() {
        unreadableSessionCalls.analyses += 1;
        throw new Error("unreadable source must not be analyzed");
      },
      async dispose() {
        unreadableSessionCalls.disposals += 1;
      },
    }
  );
  assert.deepEqual(unreadable.entries[0]?.symbols, []);
  assert.equal(unreadable.entries[0]?.code_evidence.reason, "unreadable");
  assert.deepEqual(unreadableSessionCalls, { analyses: 0, disposals: 1 });

  const isolatedReader = createFilesystemSourceSnapshotReader({
    repositoryRoot: root,
  });
  const isolatedFailureCalls = {
    events: [] as string[],
    disposals: 0,
  };
  const isolatedFailures = await buildGradeScope({
    repositoryRoot: root,
    base: "HEAD",
    manifest,
    baseManifest: manifest,
    changes: [
      { status: "modified", path: "src/feature.ts" },
      { status: "modified", path: "src/renamed.ts" },
    ],
    sourceRoots: ["src"],
    codeAnalysisSession: {
      read(path) {
        isolatedFailureCalls.events.push(`read:${path}`);
        return isolatedReader.read(path);
      },
      async analyze(snapshot) {
        isolatedFailureCalls.events.push(`analyze:${snapshot.path}`);
        if (snapshot.path === "src/feature.ts") {
          throw new Error("injected analyzer failure");
        }
        return null;
      },
      release(path) {
        isolatedFailureCalls.events.push(`release:${path}`);
        isolatedReader.release?.(path);
      },
      async dispose() {
        isolatedFailureCalls.disposals += 1;
        isolatedReader.dispose?.();
      },
    },
  });
  assert.deepEqual(isolatedFailureCalls, {
    events: [
      "read:src/feature.ts",
      "analyze:src/feature.ts",
      "release:src/feature.ts",
      "read:src/renamed.ts",
      "analyze:src/renamed.ts",
      "release:src/renamed.ts",
    ],
    disposals: 1,
  });
  assert.deepEqual(
    isolatedFailures.entries.map((entry) => [
      entry.path,
      entry.code_evidence.status,
      entry.code_evidence.reason,
      entry.symbols,
    ]),
    [
      ["src/feature.ts", "unavailable", "analysis_failed", []],
      ["src/renamed.ts", "unavailable", "analyzer_unavailable", []],
    ]
  );

  // Direct and Story-fallback claims are different assertions and both remain
  // in scope. The deliberately unrelated identifier proves grading does not
  // inherit link-plausibility filtering.
  const shared = await scopeFor([
    { status: "modified", path: "src/shared.ts" },
  ]);
  assert.equal(shared.scoped_links, 3);
  assert.deepEqual(
    shared.entries.map((entry) => [
      entry.acceptance_criterion_stable_id,
      entry.link_scope,
      entry.path,
    ]),
    [
      ["FEATURE-001-AC1", "direct", "src/shared.ts"],
      ["FEATURE-001-AC1", "story_fallback", "src/shared.ts"],
      ["FEATURE-001-AC2", "story_fallback", "src/shared.ts"],
    ]
  );
  assert.equal(new Set(shared.entries.map((entry) => entry.id)).size, 3);
  assert.deepEqual(shared.entries[0]?.symbols, [
    "const:unrelatedSharedImplementation",
  ]);
  const sharedSession = instrumentedAnalysisSession();
  const sharedWithInstrumentedSession = await buildGradeScope({
    repositoryRoot: root,
    base: "HEAD",
    manifest,
    baseManifest: manifest,
    changes: [{ status: "modified", path: "src/shared.ts" }],
    sourceRoots: ["src"],
    codeAnalysisSession: sharedSession.session,
  });
  assert.equal(sharedWithInstrumentedSession.scoped_links, 3);
  assert.equal(
    new Set(
      sharedWithInstrumentedSession.entries.map((entry) => entry.code_evidence)
    ).size,
    1,
    "claims for the same path and selector share one evidence projection"
  );
  assert.deepEqual(sharedSession.calls, {
    reads: 1,
    analyses: 1,
    disposals: 1,
  });

  // Links in another repository and unlinked changes are not local grading
  // work, even if their path string happens to match a local file.
  assert.equal(feature.scoped_links, 1);
  assert.deepEqual(
    (await scopeFor([{ status: "modified", path: "src/unlinked.ts" }])).entries,
    []
  );

  // With no base manifest — the initial contract — every local link is a new
  // claim, so onboarding is graded even though not one artifact changed.
  const initial = await scopeFor([], null);
  assert.equal(initial.scoped_links, 7);
  assert.equal(new Set(initial.entries.map((entry) => entry.id)).size, 7);
  for (const entry of initial.entries) {
    assert.equal(entry.reason, "link_added");
    assert.equal(entry.previous_path, null);
    assert.equal(entry.linked_path, entry.path);
  }
  assert.deepEqual(
    initial.entries.map((entry) => [
      entry.acceptance_criterion_stable_id,
      entry.link_scope,
      entry.path,
    ]),
    [
      ["FEATURE-001-AC1", "direct", "src/feature.ts"],
      ["FEATURE-001-AC1", "direct", "src/renamed.ts"],
      ["FEATURE-001-AC1", "direct", "src/shared.ts"],
      ["FEATURE-001-AC1", "story_fallback", "src/shared.ts"],
      ["FEATURE-001-AC2", "direct", "src/deleted.ts"],
      ["FEATURE-001-AC2", "direct", "src/notes.md"],
      ["FEATURE-001-AC2", "story_fallback", "src/shared.ts"],
    ]
  );
  assert.deepEqual(initial.entries[0]?.symbols, [
    "function:computeFeature",
  ]);

  // A re-worded criterion re-opens every link it claims, including inherited
  // story fallbacks, without touching any artifact. Grading judges the current
  // sentence, so the entry carries it rather than the base's.
  const rewordedBase = structuredClone(manifest);
  rewordedBase.capabilities[0]!.stories[0]!.acceptance_criteria[0]!.criterion =
    "Tieline must emit only relevant changed links.";
  const reworded = await scopeFor([], rewordedBase);
  assert.equal(reworded.scoped_links, 4);
  for (const entry of reworded.entries) {
    assert.equal(entry.reason, "criterion_changed");
    assert.equal(entry.acceptance_criterion_stable_id, "FEATURE-001-AC1");
    assert.equal(
      entry.acceptance_criterion,
      "Tieline must emit every changed link without relevance filtering."
    );
  }

  // A claim that is both diff-scoped and claim-side changed yields exactly one
  // entry, carrying the diff's reason.
  const overlapping = await scopeFor(
    [{ status: "modified", path: "src/feature.ts" }],
    null
  );
  assert.equal(overlapping.scoped_links, 7);
  assert.equal(
    overlapping.entries.find((entry) => entry.path === "src/feature.ts")
      ?.reason,
    "modified"
  );

  unlinkSync(resolve(root, "src/deleted.ts"));
  const deleted = await scopeFor([
    { status: "deleted", path: "src/deleted.ts" },
  ]);
  assert.equal(deleted.entries[0]?.reason, "deleted");
  assert.deepEqual(deleted.entries[0]?.symbols, []);
  assert.equal(deleted.entries[0]?.code_evidence.status, "unavailable");
  assert.equal(deleted.entries[0]?.code_evidence.reason, "missing");

  const unsupportedLanguage = await scopeFor([
    { status: "modified", path: "src/notes.md" },
  ]);
  assert.deepEqual(unsupportedLanguage.entries[0]?.symbols, []);
  assert.equal(unsupportedLanguage.entries[0]?.code_evidence.status, "unavailable");
  assert.equal(
    unsupportedLanguage.entries[0]?.code_evidence.reason,
    "unsupported_language"
  );
  for (const unavailableScope of [
    ambiguous,
    incomplete,
    truncated,
    unreadable,
    deleted,
    unsupportedLanguage,
  ]) {
    const unavailableEntry = unavailableScope.entries[0]!;
    const attemptedSupport = verifyGradeVerdicts({
      scope: unavailableScope,
      verdicts: [
        {
          id: unavailableEntry.id,
          grade: "supported",
          citation: unavailableEntry.selector ?? "function:invented",
        },
      ],
    });
    assert.equal(attemptedSupport.entries[0]?.grade, "unsupported");
    assert.equal(attemptedSupport.entries[0]?.cause, "fabricated_citation");
  }

  unlinkSync(resolve(root, "src/renamed.ts"));
  renameSync(resolve(root, "src/feature.ts"), resolve(root, "src/renamed.ts"));
  const renamed = await scopeFor([
    {
      status: "renamed",
      old_path: "src/feature.ts",
      path: "src/renamed.ts",
    },
  ]);
  assert.equal(renamed.scoped_links, 2);
  assert.deepEqual(
    renamed.entries.map((entry) => ({
      linked_path: entry.linked_path,
      path: entry.path,
      previous_path: entry.previous_path,
      reason: entry.reason,
    })),
    [
      {
        linked_path: "src/feature.ts",
        path: "src/renamed.ts",
        previous_path: "src/feature.ts",
        reason: "renamed",
      },
      {
        linked_path: "src/renamed.ts",
        path: "src/renamed.ts",
        previous_path: "src/feature.ts",
        reason: "renamed",
      },
    ]
  );
  assert.equal(new Set(renamed.entries.map((entry) => entry.id)).size, 2);
  for (const entry of renamed.entries) {
    assert.deepEqual(entry.symbols, [
      "function:computeFeature",
    ]);
  }
  const incompleteRename = verifyGradeVerdicts({
    scope: renamed,
    verdicts: [
      {
        id: renamed.entries[0]!.id,
        grade: "supported",
        citation: "function:computeFeature",
      },
    ],
    strict: true,
  });
  assert.equal(incompleteRename.strict_failure, true);
  assert.equal(incompleteRename.missing_verdicts.length, 1);
  assert.equal(
    incompleteRename.missing_verdicts[0]?.linked_path,
    "src/renamed.ts"
  );

  assert.deepEqual((await scopeFor([])).entries, []);
  assert.deepEqual(
    (await scopeFor([
      { status: "modified", path: ".tieline/spec/feature.yaml" },
    ])).entries,
    []
  );

  // Exercise the complete CLI chain over an actual Git diff and sharded
  // manifest. Restore files changed by the focused domain scenarios first.
  renameSync(resolve(root, "src/renamed.ts"), resolve(root, "src/feature.ts"));
  writeFileSync(
    resolve(root, "src/renamed.ts"),
    "export const futureRenameTarget = true;\n"
  );
  writeFileSync(
    resolve(root, "src/deleted.ts"),
    "export const deletedFeature = true;\n"
  );
  writeFileSync(
    resolve(root, ".tieline/config.json"),
    `${JSON.stringify(
      {
        version: 1,
        product: { name: "Grade fixture", repo_name: REPOSITORY },
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
          spec_directory: "spec",
          manifest: "manifest",
        },
        created_at: "2026-08-04T00:00:00.000Z",
        updated_at: "2026-08-04T00:00:00.000Z",
      },
      null,
      2
    )}\n`
  );
  writeContractManifest(
    resolve(root, ".tieline/manifest"),
    compileContractManifestWithSources({
      repositoryRoot: root,
      repositoryKey: REPOSITORY,
      specDirectory: ".tieline/spec",
    })
  );

  // A snapshot parse of the directory just written yields the manifest the
  // compiler produced, so a base-ref read compares like with like; and a
  // snapshot that was never a compiled manifest is refused, not guessed at.
  const manifestDirectory = resolve(root, ".tieline/manifest");
  const snapshotFiles = readdirSync(manifestDirectory).map((name) => ({
    name,
    content: readFileSync(resolve(manifestDirectory, name), "utf8"),
  }));
  assert.deepEqual(
    parseContractManifestSnapshot(snapshotFiles, "ref 'TEST'"),
    manifest
  );
  assert.throws(
    () =>
      parseContractManifestSnapshot(
        snapshotFiles.filter((file) => file.name !== "index.json"),
        "ref 'TEST'"
      ),
    /has no 'index\.json'/
  );
  assert.throws(
    () =>
      parseContractManifestSnapshot(
        snapshotFiles.filter((file) => file.name === "index.json"),
        "ref 'TEST'"
      ),
    /index but no capabilities/
  );
  assert.throws(
    () =>
      parseContractManifestSnapshot(
        snapshotFiles.map((file) =>
          file.name === "index.json" ? file : { ...file, name: "WRONG.json" }
        ),
        "ref 'TEST'"
      ),
    /belongs in/
  );

  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.test"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Tieline Test"], {
    cwd: root,
  });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "baseline"], {
    cwd: root,
    stdio: "ignore",
  });

  let output = "";
  const io: TielineCliIO = {
    write(message) {
      output += message;
    },
    error(message) {
      throw new Error(message);
    },
    async question() {
      throw new Error("contract grade must not prompt");
    },
  };

  // An empty diff is an explicit successful scope, not an error or omission.
  assert.equal(
    await runCli(
      ["contract", "grade", root, "--base", "HEAD", "--emit-scope", "--json"],
      io,
      {}
    ),
    0
  );
  assert.deepEqual(JSON.parse(output).entries, []);
  assert.equal(JSON.parse(output).scoped_links, 0);

  writeFileSync(
    resolve(root, "src/feature.ts"),
    `${readFeatureSource()}export const changedFeature = true;\n`
  );

  output = "";
  assert.equal(
    await runCli(
      ["contract", "grade", root, "--base", "HEAD", "--emit-scope", "--json"],
      io,
      {}
    ),
    0
  );
  const emitted = JSON.parse(output) as GradeScope;
  assert.equal(emitted.base, "HEAD");
  assert.equal(emitted.repository, REPOSITORY);
  assert.equal(emitted.scoped_links, 1);
  assert.equal(emitted.entries[0].path, "src/feature.ts");
  assert.deepEqual(emitted.entries[0].symbols, [
    "const:changedFeature",
    "function:computeFeature",
  ]);

  output = "";
  assert.equal(
    await runCli(
      ["contract", "grade", root, "--base", "HEAD", "--emit-scope"],
      io,
      {}
    ),
    0
  );
  assert.match(output, /Grading scope: 1 changed contract link/);
  assert.match(output, /FEATURE-001-AC1/);
  assert.match(output, /src\/feature\.ts/);
  assert.match(output, /function:computeFeature/);

  const scopeEntry = emitted.entries[0]!;
  const verify = (document: unknown, strict = false) =>
    verifyGradeVerdicts({
      scope: emitted,
      verdicts: parseGradeVerdicts(document),
      strict,
    });

  const supported = verify({
    verdicts: [
      {
        id: scopeEntry.id,
        grade: "supported",
        citation: "function:computeFeature",
      },
    ],
  });
  assert.deepEqual(supported.counts, {
    supported: 1,
    partial: 0,
    unsupported: 0,
  });
  assert.equal(supported.entries[0]?.grade, "supported");
  assert.equal(supported.entries[0]?.cause, null);
  assert.deepEqual(supported.proposed_selectors, [
    {
      acceptance_criterion_stable_id: "FEATURE-001-AC1",
      path: "src/feature.ts",
      selector: "function:computeFeature",
    },
  ]);

  const partial = verify(
    {
      verdicts: [
        {
          id: scopeEntry.id,
          grade: "partial",
          reason: "The symbol contributes, but does not establish the whole outcome.",
        },
      ],
    },
    true
  );
  assert.equal(partial.entries[0]?.grade, "partial");
  assert.equal(partial.strict_failure, false);
  assert.equal(partial.findings.length, 1);

  const unsupported = verify({
    verdicts: [
      {
        id: scopeEntry.id,
        grade: "unsupported",
        reason: "This file no longer implements the accepted outcome.",
      },
    ],
  });
  assert.equal(unsupported.entries[0]?.grade, "unsupported");
  assert.equal(unsupported.entries[0]?.submitted_grade, "unsupported");

  const missing = verify({ verdicts: [] });
  assert.equal(missing.entries[0]?.grade, "unsupported");
  assert.equal(missing.entries[0]?.submitted_grade, null);
  assert.equal(missing.entries[0]?.cause, "missing_verdict");
  assert.equal(missing.missing_verdicts.length, 1);

  for (const citation of ["function:inventedFeature", undefined]) {
    const fabricated = verify({
      verdicts: [
        {
          id: scopeEntry.id,
          grade: "supported",
          ...(citation ? { citation } : {}),
        },
      ],
    });
    assert.equal(fabricated.entries[0]?.grade, "unsupported");
    assert.equal(fabricated.entries[0]?.submitted_grade, "supported");
    assert.equal(fabricated.entries[0]?.cause, "fabricated_citation");
    assert.equal(fabricated.downgrades.length, 1);
  }

  assert.throws(
    () =>
      verify({
        verdicts: [
          {
            id: scopeEntry.id,
            grade: "partial",
            reason: "Some support.",
            citation: "function:computeFeature",
          },
        ],
      }),
    GradeVerdictError
  );
  assert.throws(
    () =>
      verify({
        verdicts: [{ id: scopeEntry.id, grade: "unsupported" }],
      }),
    GradeVerdictError
  );
  assert.throws(
    () =>
      verify({
        verdicts: [
          {
            id: "grade:0000000000000000000000000000000000000000000000000000000000000000",
            grade: "unsupported",
            reason: "Not current scope.",
          },
        ],
      }),
    /outside the derived grading scope/
  );
  assert.throws(
    () =>
      verify({
        verdicts: [
          {
            id: scopeEntry.id,
            grade: "unsupported",
            reason: "First.",
          },
          {
            id: scopeEntry.id,
            grade: "unsupported",
            reason: "Second.",
          },
        ],
      }),
    /Duplicate verdict/
  );
  assert.throws(
    () => parseGradeVerdicts([{ id: scopeEntry.id, grade: "supported" }]),
    GradeVerdictError
  );

  const verdictsPath = resolve(root, "verdicts.json");
  const writeVerdicts = (document: unknown): void => {
    writeFileSync(verdictsPath, `${JSON.stringify(document, null, 2)}\n`);
  };

  writeVerdicts({
    verdicts: [
      {
        id: scopeEntry.id,
        grade: "supported",
        citation: "const:changedFeature",
      },
    ],
  });
  output = "";
  assert.equal(
    await runCli(
      [
        "contract",
        "grade",
        root,
        "--base",
        "HEAD",
        "--verify",
        verdictsPath,
        "--strict",
        "--json",
      ],
      io,
      {}
    ),
    0
  );
  assert.equal(JSON.parse(output).counts.supported, 1);

  writeVerdicts({
    verdicts: [
      {
        id: scopeEntry.id,
        grade: "supported",
        citation: "function:notReal",
      },
    ],
  });
  output = "";
  assert.equal(
    await runCli(
      ["contract", "grade", root, "--base", "HEAD", "--verify", verdictsPath],
      io,
      {}
    ),
    0
  );
  assert.match(output, /unsupported=1/);
  assert.match(output, /fabricated_citation/);

  output = "";
  assert.equal(
    await runCli(
      [
        "contract",
        "grade",
        root,
        "--base",
        "HEAD",
        "--verify",
        verdictsPath,
        "--strict",
      ],
      io,
      {}
    ),
    1
  );
  assert.match(output, /Strict mode/);

  await assert.rejects(
    runCli(
      [
        "contract",
        "grade",
        root,
        "--base",
        "HEAD",
        "--verify",
        "missing-verdicts.json",
      ],
      io,
      {}
    ),
    /Cannot read grade verdicts/
  );

  await assert.rejects(
    runCli(["contract", "grade", root, "--base", "HEAD"], io, {}),
    /requires exactly one of --emit-scope or --verify/
  );
  await assert.rejects(
    runCli(
      [
        "contract",
        "grade",
        root,
        "--base",
        "HEAD",
        "--emit-scope",
        "--verify",
        "verdicts.json",
      ],
      io,
      {}
    ),
    /cannot be used with option '--verify(?: <verdicts\.json>)?'/
  );

  // Re-wording a criterion is claim-side scope over real git history; the
  // artifact the branch also changed keeps its diff reason.
  const specPath = resolve(root, ".tieline/spec/feature.yaml");
  writeFileSync(
    specPath,
    readFileSync(specPath, "utf8").replace(
      "Tieline must emit every changed link without relevance filtering.",
      "Tieline must emit every changed link and every changed claim."
    )
  );
  writeContractManifest(
    resolve(root, ".tieline/manifest"),
    compileContractManifestWithSources({
      repositoryRoot: root,
      repositoryKey: REPOSITORY,
      specDirectory: ".tieline/spec",
    })
  );
  output = "";
  assert.equal(
    await runCli(
      ["contract", "grade", root, "--base", "HEAD", "--emit-scope", "--json"],
      io,
      {}
    ),
    0
  );
  const rewordedScope = JSON.parse(output) as GradeScope;
  assert.equal(rewordedScope.scoped_links, 4);
  assert.deepEqual(
    rewordedScope.entries.map((entry) => [entry.path, entry.reason]),
    [
      ["src/feature.ts", "modified"],
      ["src/renamed.ts", "criterion_changed"],
      ["src/shared.ts", "criterion_changed"],
      ["src/shared.ts", "criterion_changed"],
    ]
  );
  for (const entry of rewordedScope.entries) {
    assert.equal(entry.acceptance_criterion_stable_id, "FEATURE-001-AC1");
    assert.equal(
      entry.acceptance_criterion,
      "Tieline must emit every changed link and every changed claim."
    );
  }
  execFileSync("git", ["checkout", "--", ".tieline"], { cwd: root });

  // An init-style base — no manifest at the ref — grades the entire contract:
  // the changed artifact keeps its diff reason and every other link is a new
  // claim.
  execFileSync("git", ["rm", "-r", "--cached", "--quiet", ".tieline"], {
    cwd: root,
  });
  execFileSync("git", ["commit", "-m", "untrack contract"], {
    cwd: root,
    stdio: "ignore",
  });
  output = "";
  assert.equal(
    await runCli(
      ["contract", "grade", root, "--base", "HEAD", "--emit-scope", "--json"],
      io,
      {}
    ),
    0
  );
  const initScope = JSON.parse(output) as GradeScope;
  assert.equal(initScope.scoped_links, 7);
  assert.equal(
    initScope.entries.filter((entry) => entry.reason === "link_added").length,
    6
  );
  assert.equal(
    initScope.entries.find((entry) => entry.path === "src/feature.ts")?.reason,
    "modified"
  );

  rmSync(resolve(root, ".tieline/manifest"), {
    recursive: true,
    force: true,
  });
  await assert.rejects(
    runCli(
      ["contract", "grade", root, "--base", "HEAD", "--emit-scope"],
      io,
      {}
    ),
    /Cannot derive grading scope.*contract compile/s
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("grade tests passed");

function readFeatureSource(): string {
  return `// commentOnlyFeature is prose, not a legal citation.
export function computeFeature(): number {
  const featureLocal = 1;
  return featureLocal;
}
`;
}
