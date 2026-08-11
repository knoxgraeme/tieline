import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createJavaScriptAnalyzer } from "../src/contract/code-analysis/javascript.js";
import {
  createJavaScriptModuleResolver,
  readJavaScriptResolutionConfiguration,
} from "../src/contract/code-resolution/javascript.js";
import type {
  CodeResolutionOutcome,
  CodeResolutionStatus,
} from "../src/contract/code-resolution/types.js";
import { createSourceInventory } from "../src/contract/source-inventory.js";
import { createFilesystemSourceSnapshotReader } from "../src/contract/source-snapshot.js";
import { report, test } from "./lib/harness.js";

const repositoryRoot = resolve("scripts/fixtures/code-resolution/javascript");

async function fixture() {
  const inventory = createSourceInventory({ repositoryRoot, sourceRoots: ["src", "."] });
  const reader = createFilesystemSourceSnapshotReader({ repositoryRoot, inventory });
  const analyzer = createJavaScriptAnalyzer();
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
  const configuration = readJavaScriptResolutionConfiguration({ inventory, reader });
  return { inventory, analyses, configuration };
}

function outcomeFor(
  outcomes: readonly CodeResolutionOutcome[],
  moduleSpecifier: string | null
): CodeResolutionOutcome {
  const matches = outcomes.filter((entry) => entry.reference.moduleSpecifier === moduleSpecifier);
  assert.equal(matches.length, 1, `expected one outcome for ${String(moduleSpecifier)}`);
  return matches[0]!;
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

await test("resolves conservative JS/TS modules and unique exported symbols", async () => {
  const { inventory, analyses, configuration } = await fixture();
  assert.equal(configuration.files[0]?.path, "tsconfig.json");
  assert.equal(configuration.aliases[0]?.pattern, "@app/*");
  const resolver = createJavaScriptModuleResolver({ inventory, analyses, configuration });
  const outcomes = resolver.resolveFile("src/main.ts");

  const relative = outcomeFor(outcomes, "./lib/value");
  assertOutcome(relative, "resolved", "javascript_relative_extensionless");
  assert.equal(relative.targets[0]?.path, "src/lib/value.ts");
  assert.equal(relative.targets[0]?.selector, "const:value");

  const index = outcomeFor(outcomes, "./directory");
  assertOutcome(index, "resolved", "javascript_relative_index");
  assert.equal(index.targets[0]?.path, "src/directory/index.ts");
  assert.equal(index.targets[0]?.selector, "const:item");

  const alias = outcomeFor(outcomes, "@app/types");
  assertOutcome(alias, "resolved", "javascript_paths_alias");
  assert.equal(alias.reference.isTypeOnly, true);
  assert.equal(alias.targets[0]?.path, "src/types.ts");
  assert.equal(alias.targets[0]?.selector, "type:Model");

  const reexport = outcomeFor(outcomes, "./barrel");
  assertOutcome(reexport, "resolved", "javascript_relative_extensionless");
  assert.equal(reexport.targets[0]?.path, "src/deep.ts");
  assert.equal(reexport.targets[0]?.selector, "const:through");
  assert.deepEqual(reexport.via.map((entry) => entry.path), ["src/barrel.ts"]);

  const ambiguousReexport = outcomeFor(outcomes, "./ambiguous-barrel");
  assertOutcome(ambiguousReexport, "ambiguous", "javascript_relative_extensionless");
  assert.equal(ambiguousReexport.reason, "ambiguous_export");
  assert.deepEqual(
    ambiguousReexport.candidates.map((candidate) => candidate.path),
    ["src/multiple.js", "src/multiple.ts"]
  );
  assert.ok(
    ambiguousReexport.diagnostics.some((entry) => entry.code === "reexport_target_ambiguous")
  );

  const duplicate = outcomeFor(outcomes, "./duplicates");
  assertOutcome(duplicate, "ambiguous", "javascript_relative_extensionless");
  assert.equal(duplicate.targets.length, 0);
  assert.equal(duplicate.candidates.length, 2);

  const sharedSymbol = outcomeFor(outcomes, "./same-symbol");
  assertOutcome(sharedSymbol, "resolved", "javascript_relative_extensionless");
  assert.equal(sharedSymbol.targets.length, 1, "two bindings may uniquely reach the same symbol");
  assert.equal(sharedSymbol.targets[0]?.selector, "const:original");

  const external = outcomeFor(outcomes, "external-package");
  assertOutcome(external, "external", "javascript_bare_external");
  assert.equal(external.reason, "external_package");

  const explicit = outcomeFor(outcomes, "./lib/explicit.js");
  assertOutcome(explicit, "resolved", "javascript_relative_exact");
  assert.equal(explicit.targets[0]?.path, "src/lib/explicit.js");

  const ambiguousModule = outcomeFor(outcomes, "./multiple");
  assertOutcome(ambiguousModule, "ambiguous", "javascript_relative_extensionless");
  assert.equal(ambiguousModule.reason, "ambiguous_module");
  assert.deepEqual(
    ambiguousModule.candidates.map((candidate) => candidate.path),
    ["src/multiple.js", "src/multiple.ts"]
  );

  const generated = outcomeFor(outcomes, "@app/generated");
  assertOutcome(generated, "unresolved", "javascript_paths_alias");
  assert.equal(generated.reason, "alias_target_not_found");

  const conditional = outcomeFor(outcomes, "#conditional");
  assertOutcome(conditional, "unresolved", "javascript_package_imports_unsupported");
  assert.equal(conditional.reason, "unsupported_conditional_exports");

  const common = outcomeFor(outcomes, "./common");
  assertOutcome(common, "resolved", "javascript_relative_extensionless");
  assert.equal(common.reference.nativeKind, "call_expression");
  assert.equal(common.targets[0]?.path, "src/common.cjs");
  assert.equal(common.targets[0]?.selector, null);

  const dynamic = outcomeFor(outcomes, null);
  assertOutcome(dynamic, "unresolved", "javascript_dynamic_specifier");
  assert.equal(dynamic.reason, "dynamic_specifier");

  const staticDynamic = outcomeFor(outcomes, "./lazy");
  assertOutcome(staticDynamic, "resolved", "javascript_relative_extensionless");
  assert.equal(staticDynamic.reference.kind, "dynamic_import");
  assert.equal(staticDynamic.targets[0]?.path, "src/lazy.ts");
});

await test("preserves re-export and configuration frontiers honestly", async () => {
  const { inventory, analyses, configuration } = await fixture();
  const resolver = createJavaScriptModuleResolver({ inventory, analyses, configuration });
  const barrel = resolver.resolveFile("src/barrel.ts");
  const reexport = outcomeFor(barrel, "./deep");
  assertOutcome(reexport, "resolved", "javascript_relative_extensionless");
  assert.equal(reexport.targets[0]?.selector, "const:through");

  const missingRoot = resolve("scripts/fixtures/code-resolution/javascript-no-config");
  const missingInventory = createSourceInventory({ repositoryRoot: missingRoot, sourceRoots: ["src"] });
  const missingReader = createFilesystemSourceSnapshotReader({
    repositoryRoot: missingRoot,
    inventory: missingInventory,
  });
  const missingAnalyzer = createJavaScriptAnalyzer();
  const read = missingReader.read("src/main.ts");
  assert.equal(read.status, "read");
  if (read.status !== "read") throw new Error("missing-config fixture was not readable");
  const missingAnalysis = await missingAnalyzer.analyze(read.snapshot);
  await missingAnalyzer.dispose();
  const missingConfiguration = readJavaScriptResolutionConfiguration({
    inventory: missingInventory,
    reader: missingReader,
  });
  assert.equal(missingConfiguration.files.length, 0);
  assert.equal(missingConfiguration.digest, missingConfiguration.emptyDigest);
  const missingConfig = createJavaScriptModuleResolver({
    inventory: missingInventory,
    analyses: new Map([[missingAnalysis.path, missingAnalysis]]),
    configuration: missingConfiguration,
  }).resolveFile("src/main.ts");
  const alias = outcomeFor(missingConfig, "@missing/item");
  assertOutcome(alias, "external", "javascript_bare_external");
  assert.equal(alias.reason, "external_package");
});

await test("normalized resolver outcomes retain stable explanatory fields", async () => {
  const { inventory, analyses, configuration } = await fixture();
  const outcomes = createJavaScriptModuleResolver({
    inventory,
    analyses,
    configuration,
  }).resolveFile("src/main.ts");
  for (const outcome of outcomes) {
    assert.match(outcome.identity, /^resolution:[a-f0-9]{64}$/);
    assert.equal(outcome.source.path, "src/main.ts");
    assert.ok(outcome.rule.length > 0);
    assert.ok(outcome.reason !== undefined);
    assert.ok(Array.isArray(outcome.diagnostics));
    assert.ok(Array.isArray(outcome.candidates));
    assert.ok(Array.isArray(outcome.via));
  }
  assert.deepEqual(
    createJavaScriptModuleResolver({ inventory, analyses, configuration }).resolveFile("src/main.ts"),
    outcomes,
    "identical facts and config produce byte-for-byte stable ordered outcomes"
  );
});

report();
