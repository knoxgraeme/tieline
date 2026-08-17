import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createPythonAnalyzer } from "../../../src/contract/code-analysis/python.js";
import { createRustAnalyzer } from "../../../src/contract/code-analysis/rust.js";
import {
  createPythonModuleResolver,
  readPythonResolutionConfiguration,
} from "../../../src/contract/code-resolution/python.js";
import {
  createRustModuleResolver,
  readRustResolutionConfiguration,
} from "../../../src/contract/code-resolution/rust.js";
import type {
  CodeResolutionOutcome,
  CodeResolutionStatus,
} from "../../../src/contract/code-resolution/types.js";
import { createSourceInventory, type SourceInventory } from "../../../src/contract/source-inventory.js";
import {
  createFilesystemSourceSnapshotReader,
  type SourceSnapshotReader,
} from "../../../src/contract/source-snapshot.js";
import { report, test } from "../../support/harness.js";

async function analyze(
  repositoryRoot: string,
  sourceRoots: string[],
  language: "python" | "rust"
) {
  const inventory = createSourceInventory({ repositoryRoot, sourceRoots });
  const reader = createFilesystemSourceSnapshotReader({ repositoryRoot, inventory });
  const analyzer = language === "python" ? createPythonAnalyzer() : createRustAnalyzer();
  const analyses = new Map();
  try {
    for (const file of inventory.files) {
      if (!file.language || !analyzer.languages.has(file.language)) continue;
      const read = reader.read(file.path);
      assert.equal(read.status, "read", file.path);
      if (read.status === "read") analyses.set(file.path, await analyzer.analyze(read.snapshot));
    }
  } finally {
    await analyzer.dispose();
  }
  return { inventory, reader, analyses } satisfies {
    inventory: SourceInventory;
    reader: SourceSnapshotReader;
    analyses: Map<string, Awaited<ReturnType<typeof analyzer.analyze>>>;
  };
}

function outcomeFor(
  outcomes: readonly CodeResolutionOutcome[],
  moduleSpecifier: string,
  occurrence = 0
): CodeResolutionOutcome {
  const matches = outcomes.filter((entry) => entry.reference.moduleSpecifier === moduleSpecifier);
  assert.ok(matches.length > occurrence, `expected outcome ${occurrence} for ${moduleSpecifier}`);
  return matches[occurrence]!;
}

function assertOutcome(
  outcome: CodeResolutionOutcome,
  status: CodeResolutionStatus,
  rule: string
): void {
  assert.equal(outcome.status, status);
  assert.equal(outcome.rule, rule);
  assert.match(outcome.configurationDigest, /^[a-f0-9]{64}$/);
  assert.equal(outcome.reference.resolution, "unresolved");
}

await test("resolves Python roots, relative modules, aliases, and unique top-level symbols", async () => {
  const repositoryRoot = resolve("tests/fixtures/code-resolution/python");
  const { inventory, reader, analyses } = await analyze(repositoryRoot, ["src", "vendor", "."], "python");
  const configuration = readPythonResolutionConfiguration({ inventory, reader });
  assert.equal(configuration.files[0]?.path, "pyproject.toml");
  assert.deepEqual(configuration.sourceRoots, ["src", "vendor"]);
  const outcomes = createPythonModuleResolver({ inventory, analyses, configuration })
    .resolveFile("src/pkg/main.py");

  const relative = outcomeFor(outcomes, ".models", 0);
  assertOutcome(relative, "resolved", "python_relative_module");
  assert.equal(relative.targets[0]?.path, "src/pkg/models.py");
  assert.equal(relative.targets[0]?.selector, "class:Model");

  const alias = outcomeFor(outcomes, "pkg.util");
  assertOutcome(alias, "resolved", "python_declared_root_module");
  assert.equal(alias.targets[0]?.path, "src/pkg/util.py");
  assert.equal(alias.targets[0]?.selector, "function:helper");

  const absoluteChild = outcomeFor(outcomes, "pkg");
  assertOutcome(absoluteChild, "resolved", "python_declared_root_module");
  assert.deepEqual(absoluteChild.targets.map((target) => [target.path, target.selector]), [
    ["src/pkg/submodule.py", null],
  ]);

  const relativeChild = outcomeFor(outcomes, ".");
  assertOutcome(relativeChild, "resolved", "python_relative_module");
  assert.deepEqual(relativeChild.targets.map((target) => [target.path, target.selector]), [
    ["src/pkg/sibling.py", null],
  ]);

  const ambiguousChild = outcomeFor(outcomes, "pkg", 1);
  assertOutcome(ambiguousChild, "ambiguous", "python_declared_root_module");
  assert.equal(ambiguousChild.reason, "ambiguous_module");
  assert.deepEqual(ambiguousChild.candidates.map((target) => target.path), [
    "src/pkg/ambiguous_child.py",
    "src/pkg/ambiguous_child/__init__.py",
  ]);

  const missingChild = outcomeFor(outcomes, "pkg", 2);
  assertOutcome(missingChild, "unresolved", "python_declared_root_module");
  assert.equal(missingChild.reason, "export_not_found");
  assert.deepEqual(missingChild.candidates, []);

  const namespace = outcomeFor(outcomes, "nsmod");
  assertOutcome(namespace, "resolved", "python_declared_root_module");
  assert.equal(namespace.targets[0]?.path, "vendor/nsmod.py");

  const duplicate = outcomeFor(outcomes, "shared");
  assertOutcome(duplicate, "ambiguous", "python_declared_root_module");
  assert.equal(duplicate.reason, "ambiguous_module");
  assert.deepEqual(duplicate.candidates.map((candidate) => candidate.path), [
    "src/shared.py",
    "vendor/shared.py",
  ]);

  const wildcard = outcomeFor(outcomes, ".models", 1);
  assertOutcome(wildcard, "unresolved", "python_glob_import");
  assert.equal(wildcard.reason, "glob_import");
  assert.equal(wildcard.candidates[0]?.path, "src/pkg/models.py");

  const external = outcomeFor(outcomes, "external_package");
  assertOutcome(external, "external", "python_external_package");
  assert.equal(external.reason, "external_package");

  assert.deepEqual(
    createPythonModuleResolver({ inventory, analyses, configuration }).resolveFile("src/pkg/main.py"),
    outcomes,
    "identical Python facts and configuration produce stable ordered outcomes"
  );
});

await test("resolves conventional Rust modules and crate/self/super paths conservatively", async () => {
  const repositoryRoot = resolve("tests/fixtures/code-resolution/rust");
  const { inventory, reader, analyses } = await analyze(repositoryRoot, ["src", "."], "rust");
  const configuration = readRustResolutionConfiguration({ inventory, reader });
  assert.equal(configuration.files[0]?.path, "Cargo.toml");
  assert.deepEqual(configuration.crateRoots, ["src/lib.rs", "src/main.rs"]);
  assert.ok(configuration.diagnostics.some((entry) => entry.code === "rust_build_script_not_executed"));
  const resolver = createRustModuleResolver({ inventory, analyses, configuration });
  const outcomes = resolver.resolveFile("src/lib.rs");

  const modelsModule = outcomeFor(outcomes, "models");
  assertOutcome(modelsModule, "resolved", "rust_mod_conventional");
  assert.equal(modelsModule.targets[0]?.path, "src/models/mod.rs");

  const modernModule = outcomeFor(outcomes, "modern");
  assertOutcome(modernModule, "resolved", "rust_mod_conventional");
  assert.equal(modernModule.targets[0]?.path, "src/modern.rs");

  const generated = outcomeFor(outcomes, "generated");
  assertOutcome(generated, "unresolved", "rust_mod_conventional");
  assert.equal(generated.reason, "module_not_found_or_generated");

  const crateUse = outcomeFor(outcomes, "crate::models::Model");
  assertOutcome(crateUse, "resolved", "rust_crate_path");
  assert.equal(crateUse.targets[0]?.path, "src/models/mod.rs");
  assert.equal(crateUse.targets[0]?.selector, "type:Model");

  const grouped = outcomeFor(outcomes, "self::modern");
  assertOutcome(grouped, "resolved", "rust_self_path");
  assert.deepEqual(grouped.targets.map((target) => target.selector), ["type:Modern", "type:Nested"]);
  assert.deepEqual(grouped.targets.map((target) => target.path), ["src/modern.rs", "src/modern/nested.rs"]);

  const wildcard = outcomeFor(outcomes, "crate::models");
  assertOutcome(wildcard, "unresolved", "rust_glob_import");
  assert.equal(wildcard.reason, "glob_import");

  const external = outcomeFor(outcomes, "external_crate::Thing");
  assertOutcome(external, "external", "rust_external_crate");
  assert.equal(external.reason, "external_crate");

  const nested = resolver.resolveFile("src/modern/nested.rs");
  const parent = outcomeFor(nested, "super::Modern");
  assertOutcome(parent, "resolved", "rust_super_path");
  assert.equal(parent.targets[0]?.path, "src/modern.rs");
  assert.equal(parent.targets[0]?.selector, "type:Modern");

  const binary = resolver.resolveFile("src/main.rs");
  const binaryModule = outcomeFor(binary, "modern");
  assertOutcome(binaryModule, "resolved", "rust_mod_conventional");
  assert.equal(binaryModule.targets[0]?.path, "src/modern.rs");
  const binaryUse = outcomeFor(binary, "crate::modern::Modern");
  assertOutcome(binaryUse, "resolved", "rust_crate_path");
  assert.equal(binaryUse.targets[0]?.selector, "type:Modern");
});

await test("Python and Rust outcomes retain the normalized explanatory contract", async () => {
  const fixtures = [
    { language: "python" as const, root: "python", path: "src/pkg/main.py" },
    { language: "rust" as const, root: "rust", path: "src/lib.rs" },
  ];
  const statuses = new Set<CodeResolutionStatus>();
  for (const fixture of fixtures) {
    const repositoryRoot = resolve(`tests/fixtures/code-resolution/${fixture.root}`);
    const sourceRoots = fixture.language === "python" ? ["src", "vendor", "."] : ["src", "."];
    const { inventory, reader, analyses } = await analyze(repositoryRoot, sourceRoots, fixture.language);
    const outcomes = fixture.language === "python"
      ? createPythonModuleResolver({
          inventory,
          analyses,
          configuration: readPythonResolutionConfiguration({ inventory, reader }),
        }).resolveFile(fixture.path)
      : createRustModuleResolver({
          inventory,
          analyses,
          configuration: readRustResolutionConfiguration({ inventory, reader }),
        }).resolveFile(fixture.path);
    for (const outcome of outcomes) {
      statuses.add(outcome.status);
      assert.match(outcome.identity, /^resolution:[a-f0-9]{64}$/);
      assert.equal(outcome.source.path, fixture.path);
      assert.ok(outcome.rule.length > 0);
      assert.ok(outcome.reason !== undefined);
      assert.ok(Array.isArray(outcome.targets));
      assert.ok(Array.isArray(outcome.candidates));
      assert.ok(Array.isArray(outcome.via));
      assert.ok(Array.isArray(outcome.diagnostics));
    }
  }
  assert.deepEqual([...statuses].sort(), ["ambiguous", "external", "resolved", "unresolved"]);
});

report();
