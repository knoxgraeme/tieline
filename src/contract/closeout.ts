import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import { z } from "zod";
import { tielineConfigSchema } from "../tieline/workspace.js";
import { readAuthoredContractAtBase } from "./authored-snapshot.js";
import { criterionReviewBasis } from "./criterion-grade.js";
import { buildContractIntentIndex, type IntentAcceptanceCriterionRecord } from "./reconciliation.js";
import { canonicalRepositoryRelativePath } from "./paths.js";

const LIMIT = 1000;
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const text = z.string().trim().min(1).max(16_000);
const bindingSchema = z.object({
  repository: text, base_commit: sha, merge_base_commit: sha, head_commit: sha,
  scope_sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const reportSchema = z.object({
  schema_version: z.literal(1), binding: bindingSchema,
  dispositions: z.array(z.object({
    criteria: z.array(z.string().trim().min(1).max(160)).min(1).max(LIMIT),
    disposition: z.enum(["still_valid", "updated", "unresolved"]),
    reason: text,
    changed_paths: z.array(z.string().min(1).max(4096)).max(1000).default([]),
  }).strict()).max(LIMIT),
}).strict();
export type CloseoutReport = z.infer<typeof reportSchema>;
export interface CloseoutCriterion {
  id: string;
  before: string | null;
  after: string | null;
  reasons: Array<"added" | "removed" | "claim_changed" | "linked_file_changed" | "configuration_changed">;
  changed_linked_paths: string[];
}
export interface CloseoutScope {
  schema_version: 1;
  binding: z.infer<typeof bindingSchema>;
  criteria: CloseoutCriterion[];
  changed_paths: string[];
  unmapped_changed_paths: string[];
  working_tree_included: false;
  semantic_support: "not_assessed";
}

/** Reads only Git objects. Neither generation nor verification executes checked-out
 * code or mistakes uncommitted files / a refreshed manifest for reviewed state.
 */
export function buildCloseoutScope(input: { repositoryRoot: string; base: string; head: string }): CloseoutScope {
  let gitRoot = input.repositoryRoot;
  const git = (args: string[]) => execFileSync("git", args, {
    cwd: gitRoot, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const root = git(["rev-parse", "--show-toplevel"]).trim();
  gitRoot = root;
  const commit = (ref: string) => {
    if (!ref || ref.length > 1024 || ref.includes("\0")) throw new Error("Invalid closeout revision.");
    return git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim();
  };
  const base = commit(input.base);
  const head = commit(input.head);
  const mergeBase = git(["merge-base", base, head]).trim();
  const snapshot = (revision: string) => {
    const configPath = ".tieline/config.json";
    const entry = git(["ls-tree", "-z", revision, "--", configPath]);
    if (!entry) return null;
    if (!/^100(?:644|755) blob [a-f0-9]+\t\.tieline\/config\.json\0$/.test(entry)) {
      throw new Error("Closeout requires a regular committed Tieline config.");
    }
    const config = tielineConfigSchema.parse(JSON.parse(git(["show", `${revision}:${configPath}`])));
    if (resolve(root, ".tieline", config.repository.root) !== root) {
      throw new Error("Closeout requires the Tieline repository root to be the Git root.");
    }
    const specPath = relative(resolve(root, ".tieline"), resolve(root, ".tieline", config.files.spec_directory));
    if (!canonicalRepositoryRelativePath(specPath)) throw new Error("Invalid committed spec directory.");
    const manifest = readAuthoredContractAtBase({ repositoryRoot: root, repositoryKey: config.product.repo_name,
      specDirectory: `.tieline/${specPath}`, base: revision });
    if (!manifest) throw new Error("Committed Tieline config has no authored contract; restore it or remove the config with the contract.");
    return { key: config.product.repo_name, manifest };
  };
  const previous = snapshot(mergeBase);
  const current = snapshot(head);
  if (!previous && !current) throw new Error("No committed Tieline contract at either revision.");
  const before = previous ? buildContractIntentIndex(previous.manifest).acceptance_criteria_by_stable_id : new Map<string, IntentAcceptanceCriterionRecord>();
  const after = current ? buildContractIntentIndex(current.manifest).acceptance_criteria_by_stable_id : new Map<string, IntentAcceptanceCriterionRecord>();
  const paths = git(["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", mergeBase, head, "--"]).split("\0").filter(Boolean).sort();
  if (paths.length > 10_000) throw new Error("Closeout exceeds 10,000 changed paths; split the change.");
  const changed = new Set(paths);
  const linked = new Set<string>();
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort();
  if (ids.length > 10_000) throw new Error("Closeout exceeds 10,000 contract criteria.");
  const criteria: CloseoutCriterion[] = [];
  for (const id of ids) {
    const old = before.get(id);
    const next = after.get(id);
    const claims = [...(old?.claims ?? []).filter((claim) => claim.repository === previous?.key),
      ...(next?.claims ?? []).filter((claim) => claim.repository === current?.key)];
    const touched = [...new Set(claims.map((claim) => claim.linked_path).filter((path) => changed.has(path)))].sort();
    for (const path of touched) linked.add(path);
    const reasons: CloseoutCriterion["reasons"] = [];
    if (!old) reasons.push("added");
    else if (!next) reasons.push("removed");
    else if (criterionReviewBasis(old) !== criterionReviewBasis(next)) reasons.push("claim_changed");
    if (changed.has(".tieline/config.json")) reasons.push("configuration_changed");
    if (touched.length) reasons.push("linked_file_changed");
    if (reasons.length) criteria.push({ id, before: old?.acceptance_criterion.criterion ?? null,
      after: next?.acceptance_criterion.criterion ?? null, reasons, changed_linked_paths: touched });
  }
  if (criteria.length > LIMIT) throw new Error("Closeout exceeds 1,000 affected criteria; split the change.");
  const basis = { repository: current?.key ?? previous!.key, base_commit: base, merge_base_commit: mergeBase, head_commit: head };
  const digest = createHash("sha256").update(JSON.stringify({ basis, criteria, paths })).digest("hex");
  return { schema_version: 1, binding: { ...basis, scope_sha256: digest }, criteria, changed_paths: paths,
    unmapped_changed_paths: paths.filter((path) => !linked.has(path)), working_tree_included: false, semantic_support: "not_assessed" };
}

export function verifyCloseoutReport(scope: CloseoutScope, value: unknown) {
  const report = reportSchema.parse(value);
  for (const key of Object.keys(scope.binding) as Array<keyof typeof scope.binding>) {
    if (report.binding[key] !== scope.binding[key]) throw new Error(`Stale or mismatched closeout binding: ${key}.`);
  }
  const expected = new Set(scope.criteria.map((criterion) => criterion.id));
  const seen = new Set<string>();
  const unresolved: string[] = [];
  for (const disposition of report.dispositions) {
    if (disposition.disposition === "updated" && disposition.changed_paths.length === 0) {
      throw new Error("An updated disposition must cite at least one changed path.");
    }
    for (const path of disposition.changed_paths) {
      if (!scope.changed_paths.includes(path)) throw new Error(`Closeout cites a path outside the reviewed diff: ${path}`);
    }
    for (const id of disposition.criteria) {
      if (!expected.has(id)) throw new Error(`Out-of-scope closeout criterion: ${id}`);
      if (seen.has(id)) throw new Error(`Duplicate closeout disposition: ${id}`);
      if (disposition.disposition === "still_valid" && scope.criteria.find((criterion) => criterion.id === id)!.reasons.some((reason) =>
        reason === "added" || reason === "removed" || reason === "claim_changed")) {
        throw new Error(`Changed claim ${id} requires an updated or unresolved disposition.`);
      }
      seen.add(id);
      if (disposition.disposition === "unresolved") unresolved.push(id);
    }
  }
  const missing = [...expected].filter((id) => !seen.has(id));
  return { binding: scope.binding, complete: missing.length === 0, ready: missing.length === 0 && unresolved.length === 0,
    missing, unresolved, dispositions: report.dispositions, semantic_support: "not_assessed" as const,
    disclaimer: "Checks commit binding and disposition completeness only. Reasons and cited changes still require semantic review; unmapped paths are outside this completeness check." };
}
