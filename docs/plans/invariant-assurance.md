# Plan: invariant assurance

Status: proposed · Owner: TBD · Independent reviewer: TBD (required for Phase 2+)

## Goal

Make Tieline better at preventing consistency bugs in AI-written code by
borrowing the useful habits of formal methods such as TLA+ (precise
invariants, deliberately asking "what if these happen in a different order?",
and demanding evidence that tries to break the rule) without adding a second
specification language.

Success is measured in the contract, not in claims. Invariant ACs become more
precise, more of their edge cases are written down as scenarios, and their
evidence is stronger than happy-path tests.

## Non-goals

- No TLA+, Quint, or Lean generation, and no model-checker toolchain in the
  product or in `npm run check`.
- No `formal` link type yet. Per AGENTS.md, do not introduce an abstraction
  until it has a concrete current use. Revisit only if Phase 0b or a user asks
  for it.
- No database projection of the new field (see Phase 2). The coding agent
  reads it from the repository manifest; planning and read-only agents do not
  need it yet.
- No new production dependency.

## Complexity budget

The whole plan may add at most:

- one optional AC field;
- one skill reference document;
- a small number of advisory `tieline check` warnings (never new errors);
- one grading rule and one scope-reason change; and
- at most one dev-only dependency (Phase 4, only if justified).

If a phase needs more than its share, stop and re-plan rather than expand.

---

## Phase 0: Calibrate by hand (no product code)

**Why first:** it tests whether the idea is worth anything before we spend
schema changes on it.

1. Draft the formalization question set (the Phase 1 content) as a checklist.
2. Apply it by hand to 3–5 existing ACs that make "always/never/preserve"
   claims or involve concurrency. Candidates:
   - `AUTHORITY-002-AC1`: planning and repository sync handoff
     (`.tieline/spec/authority.yaml`)
   - `AUTHORITY-002-AC3`: pruning projected code assets on sync
   - `AUTHORITY-002-AC2`: separation of database responsibilities
   - `CONTRACT-004-AC3`: topology publication, whose scenarios cover interrupted
     compilation and concurrent publication races (`.tieline/spec/contract.yaml`)
   - one revision or approval invariant from RUNTIME or AUTHORITY
3. For each AC, record: questions asked, which answers were already covered
   by the AC, scenarios, or tests, which were genuinely unanswered, and
   whether any looks like a real bug.

**Exit criteria (decide before starting):**
- **Go** to Phase 1 if the pass surfaces at least 2 genuine gaps (a missing
  scenario, an ambiguous AC, or an untested interleaving) across the sample.
- **Stop** if every answer was already covered. Then the discipline is already
  present and the product change isn't worth its cost.

Output: a short findings note in the PR, plus AC/scenario edits for the gaps
found, reviewed as normal contract changes.

### Phase 0b (optional, time-boxed to 1–2 days): TLA+ pilot

Only if Phase 0 finds an ordering or concurrency gap in the sync handoff
(`AUTHORITY-002-AC1`). Hand-write a small TLA+ model of planning edits,
branch materialization, and repository sync, run TLC locally, and record
whether it found anything the Phase 0 pass missed. The result decides whether
a `formal` link type ever earns a place. The spec is not committed to the
product.

---

## Phase 1: Formalization pass in the skill (skill text only)

**Change:** add `skills/tieline/references/invariants.md` and one routing step
in `skills/tieline/SKILL.md` ("Shape planning work" and "Materialize or
reconcile repository behavior").

**Content of `invariants.md`:**

1. **When to run it.** The AC says "must always / never / only / preserve",
   or its linked code touches shared state: database writes, sync, revisions,
   approvals, caches, queues, files written by more than one process. Most ACs
   do not qualify. Say so and move on.
2. **The question set** (the TLA+ habits, in plain English):
   - What are all the operations that can change the state this AC is about?
   - What if two of them run at the same time or in the opposite order,
     including across `await` points, processes, and transactions?
   - What if one is retried, duplicated, or replayed?
   - What if the subject is deleted, renamed, or superseded partway through?
   - What if an operation fails halfway? What state is left?
   - Must the rule hold at every moment, or only once things settle?
   - What bounds apply (sizes, counts, time)?
3. **Where answers go.** Every answer that changes intent becomes an edit to
   the AC text, `rationale`, or a new `scenario`, proposed through the normal
   flow: MCP for backlog, YAML plus PR for repository authority. Answers never
   live only in chat, tests, or a side document.
4. **The evidence ladder** to recommend for invariant ACs, strongest first:
   1. enforced by the database or by construction (constraints, locks,
      conditional updates on a revision, serializable transactions), linked
      via `enforces`;
   2. a deterministic interleaving or concurrency test that forces the
      dangerous order;
   3. property-based or table-driven tests over boundaries and duplicates;
   4. a single happy-path example test (weakest; flag it).
5. **Ask, don't guess.** When the code and the AC disagree or the AC is
   silent, ask the user. Do not pick an answer and encode it.

**Protected-surface note:** skill files are product content, but they are
instructions to agents. Treat the change as reviewable control-plane text
and run `npm run test:guardrails` in addition to `npm run check`.

**Validation:** `npm run test:skill-install`, `npm run check`,
`npm run test:guardrails`. Dry-run the pass on one Phase 0 AC to confirm the
reference produces the same findings.

**Exit criteria:** the skill reproduces the Phase 0 findings unassisted on at
least one AC. Phase 2 is only worth doing if Phase 1 is used and the
warnings in Phase 2 would have caught something real.

---

## Phase 2: Optional invariant designation on ACs

**Change:** an optional AC field that marks the criterion as an invariant, so
tooling can hold it to a higher evidence standard.

```yaml
- key: AUTHORITY-002-AC1
  criterion: Tieline must preserve matching planning Story and Acceptance Criterion identities when a repository contract is synchronized.
  assurance: invariant        # optional; absent means ordinary behavior
```

Design choices to confirm in review:

- **Enum, not boolean** (`assurance: invariant`, with only one value for
  now). It leaves room for later levels without another schema break and
  keeps the YAML self-explanatory.
- **Repository contract only in the first cut.** Accepted in
  `acceptanceCriterionSchema`. Whether backlog ACs
  (`planningAcceptanceCriterionSchema`) accept it is an open decision: it
  would require the planning MCP tools and a migration, so defer unless asked.
- **Manifest:** add `assurance` to the compiled criterion in
  `src/contract/manifest.ts`. Decide explicitly whether this needs
  `CONTRACT_MANIFEST_VERSION` 2 → 3. The manifest schema is strict, so older
  readers would reject manifests that contain the field. Follow whatever
  convention the v1 → v2 change set, and prefer omitting the key when it is
  absent so existing manifests stay byte-identical.
- **Database:** not projected in this phase. `contract-sync-repository.ts`
  ignores the field. Add a migration only when an MCP consumer needs it.
- **Review page:** show a small "invariant" badge in `review-page.ts`.
- **Docs:** `skills/tieline/references/contract.md` (YAML shape) and
  `docs/concepts.md`.

**Advisory checks** (warnings in `tieline check`, never errors; consistent
with "warnings are review input, not a second gate"):

- an invariant AC with no `scenarios`;
- an invariant AC with no `tests` and no `enforces` link.

These are deterministic and structural. Tieline does not judge whether the
scenarios are good; the grader (Phase 3) and reviewers do.

**Protected surfaces:** public contract schema and compiled manifest format.
This needs explicit risk analysis in the PR, independent review, and
`npm run test:guardrails`.

**Tests (TG-7):** schema accepts and rejects (unknown value, wrong type);
manifest compile is byte-stable for contracts without the field; round-trip
with the field; each warning fires and does not fire on its counterexample;
the review page renders the badge.

---

## Phase 3: Grader holds invariant ACs to the ladder

**Change:** `tieline contract grade --emit-scope` includes the criterion's
`assurance` in each scope entry. `skills/tieline/references/grading.md` gains
one rule:

> For an `invariant` criterion, a `tests` link earns `supported` only if the
> cited test exercises the rule under an adversarial condition named by the
> AC or its scenarios (concurrent or reordered operations, duplicates or
> retries, deletion, partial failure). A test that shows only one happy path is
> `partial`, with a reason naming the missing condition.

Code changes in `src/contract/grade.ts` and `src/contract/reconciliation.ts`:

- Bind `assurance` into the entry ID, so marking or unmarking an AC as an
  invariant invalidates earlier verdicts.
- Put links in scope when `assurance` changes against the base manifest.
  Reuse `criterion_changed`, or add a distinct `assurance_changed` reason if
  reviewers want it visible; `criterion_changed` is simpler.

**Tests:** scope entries carry the field; toggling `assurance` against the
base puts the AC's links in scope; the ID changes when `assurance` changes;
verify/fence behavior is unchanged.

---

## Phase 4: Dogfood on Tieline's own contract

1. Mark the Phase 0 ACs that are genuine invariants with
   `assurance: invariant`.
2. Close the evidence gaps `tieline check` and the grader report, preferring
   the top of the ladder: database enforcement first, then deterministic
   interleaving tests.
3. **Interleaving tests without new dependencies first.** Use explicit
   step-by-step orchestration in integration tests, for example: start sync,
   perform a planning edit, finish sync, assert a handoff conflict. Add
   `fast-check` as a dev dependency only if a concrete test needs randomized
   scheduling. Pin its seed so it stays deterministic, and explain the
   dependency in the PR per AGENTS.md.
4. Integration tests that write to the database run only against a guarded
   disposable target ([DB-WRITE]). Never use a development or production
   `DATABASE_URL`.

---

## Validation per phase

| Phase | Commands |
| --- | --- |
| 0 | Contract edits only: `tieline contract validate/compile/coverage .`, `tieline check --base <base>`, grading per `grading.md` |
| 1 | `npm run test:skill-install`, `npm run check`, `npm run test:guardrails` |
| 2 | `npm run test:contract`, `npm run check`, `npm run test:guardrails` |
| 3 | `npm run test:grade`, `npm run test:contract`, `npm run check` |
| 4 | `npm run check`; `npm run test:integration` on a disposable target only |

Also grade each final PR diff with
`git diff --no-renames --unified=0 <base> <head> | node guardrail-evals/run.mjs --stdin --base-ref <base> --head-ref <head>`.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Question fatigue: the pass fires on too many ACs | Narrow triggers; "most ACs do not qualify" is explicit; Phase 0 measures yield first |
| Intent leaks into tests or chat instead of the AC | Rule: answers that change intent must become AC, rationale, or scenario edits via review |
| `invariant` gets over-applied and loses meaning | Warnings make it cost something; reviewers challenge each designation |
| Manifest format break for older readers | Omit the key when absent; explicit version decision; byte-stability test |
| Grader strictness produces noisy `partial` grades | Rule applies only to explicitly marked ACs; reason must name the missing condition |
| Flaky concurrency tests | Deterministic orchestration first; seeded property tests only if needed; no timeout inflation (TG-7) |
| Scope creep toward a formal-methods engine | Non-goals and complexity budget above; the `formal` link waits for demonstrated use |

## Open decisions

1. Does the backlog (planning) schema accept `assurance`, or only repository
   contracts? Recommendation: repository only for now.
2. Manifest version bump or not, following the existing convention.
3. A new `assurance_changed` scope reason, or reuse `criterion_changed`?
   Recommendation: reuse.
4. Run Phase 0b (TLA+ pilot) or not? Recommendation: only if Phase 0 finds an
   ordering gap in the sync handoff.

## Rollout order and stop points

Phase 0 → (stop if no gaps) → Phase 1 → (stop if unused or not reproducing
findings) → Phase 2 → Phase 3 → Phase 4. Each phase is a separate PR. Phases 2
and 3 touch protected surfaces and need independent review.
