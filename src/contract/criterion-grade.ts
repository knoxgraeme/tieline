import { createHash } from "node:crypto";
import { z } from "zod";
import { buildGradeScope, GradeVerdictError, type BuildGradeScopeInput, type GradeScopeEntry } from "./grade.js";
import { analyzeContractReconciliation, buildContractIntentIndex, contractClaimIdentity, type IntentAcceptanceCriterionRecord } from "./reconciliation.js";

export type CriterionGradeSelection = "claims" | "impacted";
const MAX_CRITERIA = 1_000;
const MAX_LINKS = 5_000;

/** Semantic review inputs exclude measured hashes, aliases, and display ordering. */
export function criterionReviewBasis(record: IntentAcceptanceCriterionRecord): string {
  return JSON.stringify({
    criterion: record.acceptance_criterion.criterion,
    scenarios: record.acceptance_criterion.scenarios
      .map(({ given, when, then }) => ({ given, when, then }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    applies_to: record.acceptance_criterion.applies_to,
    story_applies_to: record.story.applies_to,
    capability_applies_to: record.capability.applies_to,
    story_lifecycle: record.story.lifecycle,
    links: record.claims.map((claim) => [contractClaimIdentity(claim), claim.provenance]),
  });
}

export interface CriterionGradeEntry {
  id: string;
  acceptance_criterion_stable_id: string;
  acceptance_criterion: IntentAcceptanceCriterionRecord["acceptance_criterion"];
  story: IntentAcceptanceCriterionRecord["story"];
  reason: "claim_changed" | "artifact_changed";
  evidence: Array<Omit<GradeScopeEntry, "reason">>;
  external_links: IntentAcceptanceCriterionRecord["claims"];
}

export interface CriterionGradeScope {
  unit: "criterion";
  selection: CriterionGradeSelection;
  base: string;
  repository: string;
  scoped_criteria: number;
  entries: CriterionGradeEntry[];
  /** Still require semantic reconciliation; these have not been graded. */
  implementation_only_criteria: string[];
  removed_criteria: string[];
}

export async function buildCriterionGradeScope(
  input: BuildGradeScopeInput & { selection: CriterionGradeSelection }
): Promise<CriterionGradeScope> {
  const current = buildContractIntentIndex(input.manifest).acceptance_criteria_by_stable_id;
  const base = input.baseManifest
    ? buildContractIntentIndex(input.baseManifest).acceptance_criteria_by_stable_id
    : new Map<string, IntentAcceptanceCriterionRecord>();
  const changed = new Set<string>();
  for (const [id, record] of current) {
    const previous = base.get(id);
    if (!previous || criterionReviewBasis(record) !== criterionReviewBasis(previous)) changed.add(id);
  }
  const reconciliation = analyzeContractReconciliation({ ...input });
  const impacted = new Set(reconciliation.claimed_changes.flatMap((change) =>
    change.claimed_by.map((claim) => claim.acceptance_criterion_stable_id)));
  const selected = new Set([...changed, ...(input.selection === "impacted" ? impacted : [])]);
  const linkCount = [...selected].reduce((total, id) => total + (current.get(id)?.claims.length ?? 0), 0);
  if (selected.size > MAX_CRITERIA || linkCount > MAX_LINKS) {
    throw new GradeVerdictError(`Criterion grading exceeds ${MAX_CRITERIA} criteria or ${MAX_LINKS} links; split the change before grading.`);
  }
  // Select complete AC neighborhoods. A null base asks the existing parser-backed
  // scope builder for every local link, including unchanged supporting files.
  const evidenceScope = await buildGradeScope({
    ...input,
    baseManifest: null,
    // Selection already used the diff. Evidence identity must not change merely
    // because an unchanged file moves from untracked to committed/added.
    changes: input.changes.filter((change) => change.status === "renamed"),
    manifest: {
      ...input.manifest,
      capabilities: input.manifest.capabilities.map((capability) => ({
        ...capability,
        stories: capability.stories.map((story) => ({
          ...story,
          acceptance_criteria: story.acceptance_criteria.filter((criterion) => selected.has(criterion.stable_id)),
        })),
      })),
    },
  });
  const entries: CriterionGradeEntry[] = [];
  for (const id of [...selected].sort()) {
    const record = current.get(id)!;
    const evidence = evidenceScope.entries
      .filter((entry) => entry.acceptance_criterion_stable_id === id)
      .map(({ reason: _reason, ...entry }) => entry);
    const external = record.claims.filter((claim) => claim.repository !== input.manifest.repository.key);
    const digest = createHash("sha256").update(JSON.stringify([
      "criterion-v1", input.selection, id, criterionReviewBasis(record), evidence.map((entry) => entry.id),
    ])).digest("hex");
    entries.push({
      id: `criterion-grade:${digest}`,
      acceptance_criterion_stable_id: id,
      acceptance_criterion: record.acceptance_criterion,
      story: record.story,
      reason: changed.has(id) ? "claim_changed" : "artifact_changed",
      evidence,
      external_links: external,
    });
  }
  return {
    unit: "criterion", selection: input.selection, base: input.base,
    repository: input.manifest.repository.key, scoped_criteria: entries.length, entries,
    implementation_only_criteria: [...impacted].filter((id) => !changed.has(id)).sort(),
    removed_criteria: [...base.keys()].filter((id) => !current.has(id)).sort(),
  };
}

const text = z.string().trim().min(1).max(16_000);
const linkId = z.string().regex(/^grade:[a-f0-9]{64}$/);
const shared = {
  id: z.string().regex(/^criterion-grade:[a-f0-9]{64}$/),
  reason: text,
  link_findings: z.array(z.object({ link_id: linkId, reason: text }).strict()).max(MAX_LINKS).default([]),
};
const verdict = z.discriminatedUnion("grade", [
  z.object({ ...shared, grade: z.literal("supported"), citations: z.array(z.object({ link_id: linkId, selector: text }).strict()).max(MAX_LINKS) }).strict(),
  z.object({ ...shared, grade: z.literal("partial") }).strict(),
  z.object({ ...shared, grade: z.literal("unsupported") }).strict(),
  z.object({ ...shared, grade: z.literal("inconclusive") }).strict(),
]);
const document = z.object({ verdicts: z.array(verdict).max(MAX_CRITERIA) }).strict();
export type CriterionGradeVerdict = z.infer<typeof verdict>;

export function parseCriterionGradeVerdicts(value: unknown): CriterionGradeVerdict[] {
  const parsed = document.safeParse(value);
  if (!parsed.success) throw new GradeVerdictError(`Criterion verdicts are malformed: ${parsed.error.message}`);
  return parsed.data.verdicts;
}

export function verifyCriterionGradeVerdicts(input: {
  scope: CriterionGradeScope;
  verdicts: CriterionGradeVerdict[];
  strict?: boolean;
}) {
  const allowed = new Map(input.scope.entries.map((entry) => [entry.id, entry]));
  const submitted = new Map<string, CriterionGradeVerdict>();
  for (const value of input.verdicts) {
    if (!allowed.has(value.id)) throw new GradeVerdictError(`Verdict '${value.id}' is outside the current criterion scope.`);
    if (submitted.has(value.id)) throw new GradeVerdictError(`Duplicate verdict '${value.id}'.`);
    submitted.set(value.id, value);
  }
  const entries = input.scope.entries.map((entry) => {
    const value = submitted.get(entry.id);
    const links = new Map(entry.evidence.map((link) => [link.id, link]));
    const seenFindings = new Set<string>();
    for (const finding of value?.link_findings ?? []) {
      if (!links.has(finding.link_id) || seenFindings.has(finding.link_id)) {
        throw new GradeVerdictError(`Duplicate or out-of-scope link finding '${finding.link_id}'.`);
      }
      seenFindings.add(finding.link_id);
    }
    const citations = value?.grade === "supported" ? value.citations : [];
    const seenCitations = new Set<string>();
    let fabricated = value?.grade === "supported" && citations.length === 0;
    for (const citation of citations) {
      const key = JSON.stringify(citation);
      if (seenCitations.has(key)) throw new GradeVerdictError(`Duplicate citation '${key}'.`);
      seenCitations.add(key);
      if (!links.get(citation.link_id)?.symbols.includes(citation.selector)) fabricated = true;
    }
    return {
      ...entry,
      grade: !value || fabricated ? "unsupported" as const : value.grade,
      submitted_grade: value?.grade ?? null,
      reason: !value ? "No verdict was submitted." : fabricated ? "A supported verdict needs citations from this AC's emitted evidence." : value.reason,
      cause: !value ? "missing_verdict" as const : fabricated ? "fabricated_citation" as const : null,
      citations,
      link_findings: value?.link_findings ?? [],
    };
  });
  const counts = { supported: 0, partial: 0, unsupported: 0, inconclusive: 0 };
  for (const entry of entries) counts[entry.grade]++;
  return {
    ...input.scope, entries, counts,
    findings: entries.filter((entry) => entry.grade !== "supported" || entry.link_findings.length > 0),
    strict_failure: input.strict === true && entries.some((entry) =>
      entry.grade === "unsupported" || entry.grade === "inconclusive" || entry.link_findings.length > 0),
  };
}
