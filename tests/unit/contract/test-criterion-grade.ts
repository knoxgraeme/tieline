import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, renameSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { stringify } from "yaml";
import { buildCriterionGradeScope, parseCriterionGradeVerdicts, verifyCriterionGradeVerdicts } from "../../../src/contract/criterion-grade.js";
import { compileContractManifestWithSources, writeContractManifest } from "../../../src/contract/manifest.js";
import { runCli } from "../../../src/cli.js";

const root = mkdtempSync(resolve(tmpdir(), "tieline-criterion-grade-"));
try {
  mkdirSync(resolve(root, ".tieline/spec"), { recursive: true });
  mkdirSync(resolve(root, "src"));
  writeFileSync(resolve(root, "src/consent.ts"), "export function confirm(approved: boolean) { return approved; }\n");
  writeFileSync(resolve(root, "src/checkout.ts"), "export function checkout(approved: boolean) { if (!approved) throw new Error('confirmation required'); return 'charged'; }\n");
  const spec = {
    version: 1,
    capability: { key: "BILLING", name: "Billing", description: "Confirmed checkout", stories: [{
      key: "BILLING-001", title: "Confirm checkout", actor: "buyer", goal: "confirm a purchase", benefit: "avoid unintended charges", lifecycle: "production",
      acceptance_criteria: [{ key: "AC-BILLING-001", criterion: "Checkout must require confirmation.",
        scenarios: [{ given: "an unconfirmed purchase", when: "checkout is requested", then: "no charge occurs" }],
        links: ["consent", "checkout"].map((name) => ({ relation: "implements", provenance: "authored", target: { kind: "code", repository: "fixture", path: `src/${name}.ts` } })),
      }],
    }] },
  };
  writeFileSync(resolve(root, ".tieline/spec/billing.yaml"), stringify(spec));
  const compiled = compileContractManifestWithSources({ repositoryRoot: root, repositoryKey: "fixture" });
  const manifest = compiled.manifest;
  const build = (selection: "claims" | "impacted", current = manifest, base = manifest) => buildCriterionGradeScope({
    repositoryRoot: root, base: "HEAD", manifest: current, baseManifest: base,
    changes: [{ status: "modified", path: "src/checkout.ts" }], sourceRoots: ["src"], selection,
  });
  const claims = await build("claims");
  assert.equal(claims.scoped_criteria, 0, "implementation-only changes do not trigger claim grading");
  assert.deepEqual(claims.implementation_only_criteria, ["AC-BILLING-001"], "skipped semantic work remains explicit");
  const impacted = await build("impacted");
  const entry = impacted.entries[0]!;
  assert.equal(entry.evidence.length, 2, "unchanged supporting files are included");
  const verify = (verdicts: unknown, scope = impacted, strict = false) => verifyCriterionGradeVerdicts({ scope, verdicts: parseCriterionGradeVerdicts({ verdicts }), strict });
  const supported = { id: entry.id, grade: "supported", reason: "Confirmation and checkout jointly enforce the condition.", citations: entry.evidence.map((link) => ({ link_id: link.id, selector: link.symbols[0]! })) };
  assert.equal(verify([supported]).counts.supported, 1);
  assert.equal(verify([{ ...supported, citations: [{ link_id: entry.evidence[0]!.id, selector: "function:invented" }] }]).entries[0]!.cause, "fabricated_citation");
  assert.equal(verify([{ ...supported, citations: [] }]).entries[0]!.cause, "fabricated_citation");
  assert.equal(verify([]).entries[0]!.cause, "missing_verdict");
  assert.throws(() => verify([supported, supported]), /Duplicate verdict/);
  assert.throws(() => verify([{ ...supported, id: `criterion-grade:${"0".repeat(64)}` }]), /outside/);
  assert.throws(() => verify([{ ...supported, citations: [supported.citations[0], supported.citations[0]] }]), /Duplicate citation/);
  assert.throws(() => verify([{ ...supported, citations: [
    { link_id: entry.evidence[0]!.id, selector: "function:invented" }, supported.citations[0], supported.citations[0],
  ] }]), /Duplicate citation/, "fabricated citations must not short-circuit validation");
  assert.equal(verify([{ id: entry.id, grade: "inconclusive", reason: "Missing external evidence." }], impacted, true).strict_failure, true);
  const linkFinding = { link_id: entry.evidence[0]!.id, reason: "This locator needs review." };
  assert.equal(verify([{ ...supported, link_findings: [linkFinding] }], impacted, true).findings.length, 1, "supported behavior does not hide bad links");
  assert.throws(() => verify([{ ...supported, link_findings: [linkFinding, linkFinding] }]), /Duplicate/);
  assert.throws(() => verify([{ ...supported, link_findings: [{ ...linkFinding, link_id: `grade:${"0".repeat(64)}` }] }]), /out-of-scope/);
  for (const mutation of ["scenario", "applicability", "story-applicability", "link-removal"] as const) {
    const changed = structuredClone(manifest);
    const story = changed.capabilities[0]!.stories[0]!;
    const ac = story.acceptance_criteria[0]!;
    if (mutation === "scenario") ac.scenarios[0]!.then = "an explicit error is returned";
    if (mutation === "applicability") ac.applies_to = { plan: ["pro"] };
    if (mutation === "story-applicability") story.applies_to = { plan: ["pro"] };
    if (mutation === "link-removal") ac.links.pop();
    const scope = await build("claims", changed);
    assert.equal(scope.scoped_criteria, 1, mutation);
    assert.notEqual(scope.entries[0]!.id, entry.id);
    assert.throws(() => verify([supported], scope), /outside/, "earlier verdict cannot survive a claim change");
  }
  const unavailable = structuredClone(manifest);
  const unavailableTarget = unavailable.capabilities[0]!.stories[0]!.acceptance_criteria[0]!.links[0]!.target;
  assert.notEqual(unavailableTarget.kind, "help");
  if (unavailableTarget.kind === "help") throw new Error("expected code fixture");
  unavailableTarget.path = "src/missing.ts";
  const unavailableScope = await build("claims", unavailable);
  assert.equal(unavailableScope.entries[0]!.evidence.find((link) => link.path === "src/missing.ts")!.code_evidence.status, "unavailable");
  const oversized = structuredClone(manifest);
  const template = oversized.capabilities[0]!.stories[0]!.acceptance_criteria[0]!;
  oversized.capabilities[0]!.stories[0]!.acceptance_criteria = Array.from({ length: 1001 }, (_, i) => ({ ...template, stable_id: `AC-LIMIT-${i}` }));
  await assert.rejects(build("claims", oversized), /exceeds 1000 criteria/);
  const metadata = structuredClone(manifest);
  metadata.capabilities[0]!.stories[0]!.acceptance_criteria[0]!.aliases.push("Payment confirmation");
  metadata.capabilities[0]!.stories[0]!.acceptance_criteria[0]!.links[0]!.reviewed_content_hash = "a".repeat(64);
  assert.equal((await build("claims", metadata)).scoped_criteria, 0, "aliases and fingerprints do not create semantic work");
  const external = structuredClone(manifest);
  for (const link of external.capabilities[0]!.stories[0]!.acceptance_criteria[0]!.links) {
    if (link.target.kind !== "help") link.target.repository = "external";
  }
  const externalScope = await build("claims", external);
  assert.equal(externalScope.entries[0]!.evidence.length, 0);
  assert.equal(externalScope.entries[0]!.external_links.length, 2);
  const fallback = structuredClone(manifest);
  fallback.capabilities[0]!.stories[0]!.links.push(fallback.capabilities[0]!.stories[0]!.acceptance_criteria[0]!.links[0]!);
  assert.equal((await build("claims", fallback)).entries[0]!.evidence.length, 3, "direct and Story fallback remain distinct evidence");
  const oversizedLinks = structuredClone(manifest);
  const originalLink = oversizedLinks.capabilities[0]!.stories[0]!.acceptance_criteria[0]!.links[0]!;
  if (originalLink.target.kind === "help") throw new Error("expected code fixture");
  const originalTarget = originalLink.target;
  oversizedLinks.capabilities[0]!.stories[0]!.acceptance_criteria[0]!.links = Array.from({ length: 5001 }, (_, i) => ({ ...originalLink, target: { ...originalTarget, path: `src/limit-${i}.ts` } }));
  await assert.rejects(build("claims", oversizedLinks), /5000 links/);
  const noLinks = structuredClone(manifest);
  noLinks.capabilities[0]!.stories[0]!.acceptance_criteria[0]!.links = [];
  assert.equal((await build("claims", noLinks)).entries[0]!.evidence.length, 0, "removing all evidence still receives review");
  const removed = structuredClone(manifest);
  removed.capabilities[0]!.stories[0]!.acceptance_criteria = [];
  assert.deepEqual((await build("claims", removed)).removed_criteria, ["AC-BILLING-001"]);
  writeFileSync(resolve(root, "src/consent.ts"), "export function confirm(approved: boolean) { return !approved; }\n");
  assert.notEqual((await build("impacted")).entries[0]!.id, entry.id, "unchanged-diff supporting evidence binds identity too");
  renameSync(resolve(root, "src/consent.ts"), resolve(root, "src/renamed.ts"));
  const renamed = await buildCriterionGradeScope({ repositoryRoot: root, base: "HEAD", manifest, baseManifest: manifest, changes: [{ status: "renamed", old_path: "src/consent.ts", path: "src/renamed.ts" }], sourceRoots: ["src"], selection: "impacted" });
  assert.equal(renamed.entries[0]!.evidence.find((link) => link.linked_path === "src/consent.ts")!.path, "src/renamed.ts");
  renameSync(resolve(root, "src/renamed.ts"), resolve(root, "src/consent.ts"));
  const refreshed = compileContractManifestWithSources({ repositoryRoot: root, repositoryKey: "fixture" });
  writeContractManifest(resolve(root, ".tieline/manifest"), refreshed);
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git(["init"]); git(["add", "."]); git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"]);
  let output = "";
  const cliIO = { write: (s: string) => { output += s; }, error: (s: string) => { throw new Error(s); }, question: async () => { throw new Error("unexpected prompt"); } };
  const cliBase = ["contract", "grade", root, "--repo", "fixture", "--base", "HEAD", "--unit", "criterion", "--scope", "claims"];
  assert.equal(await runCli([...cliBase, "--emit-scope", "--json"], cliIO, {}), 0);
  assert.equal(JSON.parse(output).scoped_criteria, 0);
  writeFileSync(resolve(root, "verdicts.json"), '{"verdicts":[]}');
  output = "";
  assert.equal(await runCli([...cliBase, "--verify", resolve(root, "verdicts.json"), "--json"], cliIO, {}), 0);
  assert.equal(JSON.parse(output).strict_failure, false);
  truncateSync(resolve(root, "verdicts.json"), 16 * 1024 * 1024 + 1);
  await assert.rejects(runCli([...cliBase, "--verify", resolve(root, "verdicts.json")], cliIO, {}), /16 MiB/);
  console.log("criterion grading tests passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
