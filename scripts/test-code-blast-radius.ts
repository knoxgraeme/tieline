import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeCodeTopologyStore } from "../src/adapters/fakes/fake-code-topology-store.js";
import { analyzeCodeBlastRadius } from "../src/contract/code-blast-radius.js";
import { compileContractManifest } from "../src/contract/manifest.js";
import { buildCommittedTopologyGeneration } from "../src/contract/topology-generation.js";
import { report, test } from "./lib/harness.js";

const root = mkdtempSync(join(tmpdir(), "tieline-blast-radius-"));
const store = new FakeCodeTopologyStore();
const git = (args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

async function build() {
  const result = await buildCommittedTopologyGeneration({
    repositoryRoot: root,
    repository: "blast-fixture",
    revision: "HEAD",
    sourceRoots: ["src"],
  });
  assert.equal(result.status, "complete");
  if (result.status !== "complete") throw new Error(result.detail);
  return result.generation;
}

try {
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".tieline/spec"), { recursive: true });
  writeFileSync(join(root, "src/b.ts"), "export const b = 1;\n");
  writeFileSync(join(root, "src/a.ts"), 'import { b } from "./b";\nexport const a = b;\n');
  writeFileSync(join(root, "src/c.ts"), "export const c = 1;\n");
  writeFileSync(join(root, ".tieline/spec/blast.yaml"), `version: 1
capability:
  key: BLAST
  name: Blast radius
  description: Keep code dependencies separate from authored coupling.
  stories:
    - key: US-BLAST-001
      title: See potentially affected intent
      actor: agent
      goal: inspect dependency paths
      benefit: review remains bounded
      lifecycle: production
      links:
        - relation: implements
          provenance: authored
          target: { kind: code, repository: blast-fixture, path: src/a.ts }
      acceptance_criteria:
        - key: AC-BLAST-001
          criterion: Tieline must keep derived dependencies separate from authored links.
          links:
            - relation: implements
              provenance: authored
              target: { kind: code, repository: blast-fixture, path: src/b.ts }
            - relation: implements
              provenance: authored
              target: { kind: code, repository: blast-fixture, path: src/c.ts }
`);
  git(["init", "-q"]);
  git(["config", "user.email", "blast@example.test"]);
  git(["config", "user.name", "Blast Test"]);
  git(["add", "."]);
  git(["commit", "-qm", "base"]);
  const base = await build();
  await store.commitGeneration({ generation: base, expected_previous_generation_identity: null });

  writeFileSync(join(root, "src/b.ts"), "export const b = 2;\n");
  git(["add", "src/b.ts"]);
  git(["commit", "-qm", "change dependency"]);
  const current = await build();
  await store.commitGeneration({
    generation: current,
    expected_previous_generation_identity: base.header.identity,
  });
  const manifest = compileContractManifest({
    repositoryRoot: root,
    repositoryKey: "blast-fixture",
    specDirectory: ".tieline/spec",
  });

  await test("defaults to dependents and joins exact direct/fallback authored claims", async () => {
    const calls = { comparison: 0, paths: 0, reverse: 0, frontiers: 0 };
    for (const [method, key] of [
      ["compareGenerations", "comparison"],
      ["listSymbolsByPaths", "paths"],
      ["listReverseEdges", "reverse"],
      ["listDependencyFrontiers", "frontiers"],
    ] as const) {
      const original = store[method].bind(store) as (...args: any[]) => Promise<any>;
      (store[method] as any) = async (...args: any[]) => {
        calls[key] += 1;
        return original(...args);
      };
    }
    const result = await analyzeCodeBlastRadius({
      base: { store, generation_identity: base.header.identity },
      current: { store, generation_identity: current.header.identity },
      manifest,
      authored_checkpoint: { identity: "contract-current", revision: current.header.revision },
    });
    assert.equal(result.status, "complete");
    if (result.status !== "complete") return;
    assert.equal(result.direction, "dependents");
    assert.ok(result.topology_changes.files.some((change) => change.status === "modified" && change.path === "src/b.ts"));
    assert.ok(result.visited.some((node) => node.locator.path === "src/a.ts"));
    assert.ok(result.intent_impacts.some((impact) => impact.locator.path === "src/b.ts" && impact.link_scope === "direct"));
    assert.ok(result.intent_impacts.some((impact) => impact.locator.path === "src/a.ts" && impact.link_scope === "story_fallback"));
    assert.ok(result.intent_impacts.some((impact) => impact.locator.path === "src/b.ts" && impact.locator.selector !== null && impact.match_precision === "file_level"));
    assert.ok(!result.visited.some((node) => node.locator.path === "src/c.ts"), "sharing an AC must not manufacture an edge");
    assert.ok(result.intent_impacts.every((impact) => impact.relationship === "contract_coupling" && impact.semantic_support === "not_assessed"));
    assert.equal(result.revision_divergence.current, "aligned");
    assert.equal(calls.comparison, 1, "base/current compare in one store snapshot");
    assert.ok(calls.paths <= 4, "comparison and traversal each batch locators per role");
    assert.equal(calls.reverse, calls.frontiers);
  });

  await test("labels unknown and divergent authored checkpoints without implying review", async () => {
    const unknown = await analyzeCodeBlastRadius({
      current: { store, generation_identity: current.header.identity },
      manifest,
      changes: [{ status: "modified", locator: { repository: "blast-fixture", kind: "code", path: "src/b.ts", selector: null, framework_hint: null } }],
    });
    assert.equal(unknown.status, "complete");
    if (unknown.status === "complete") assert.equal(unknown.revision_divergence.current, "unknown");
    const divergent = await analyzeCodeBlastRadius({
      current: { store, generation_identity: current.header.identity },
      manifest,
      authored_checkpoint: { identity: "contract-old", revision: "f".repeat(40) },
      changes: [{ status: "modified", locator: { repository: "blast-fixture", kind: "code", path: "src/b.ts", selector: null, framework_hint: null } }],
    });
    assert.equal(divergent.status, "complete");
    if (divergent.status === "complete") assert.equal(divergent.revision_divergence.current, "diverged");
  });

  await test("compares rename and edge-retarget roles without losing deleted-side intent", async () => {
    renameSync(join(root, "src/b.ts"), join(root, "src/d.ts"));
    writeFileSync(join(root, "src/a.ts"), 'import { b } from "./d";\nexport const a = b;\n');
    git(["add", "-A"]);
    git(["commit", "-qm", "rename and retarget"]);
    const retargeted = await build();
    await store.commitGeneration({
      generation: retargeted,
      expected_previous_generation_identity: current.header.identity,
    });
    const result = await analyzeCodeBlastRadius({
      base: { store, generation_identity: current.header.identity },
      current: { store, generation_identity: retargeted.header.identity },
      manifest,
    });
    assert.equal(result.status, "complete");
    if (result.status !== "complete") return;
    assert.ok(result.topology_changes.files.some((change) =>
      change.status === "renamed" && change.path === "src/d.ts" && change.previous_path === "src/b.ts"
    ));
    assert.ok(result.topology_changes.edges.some((change) => change.status === "deleted"));
    assert.ok(result.topology_changes.edges.some((change) => change.status === "added"));
    assert.ok(result.intent_impacts.some((impact) =>
      impact.locator.path === "src/b.ts" && impact.generation_role === "base"
    ));
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}

report();
