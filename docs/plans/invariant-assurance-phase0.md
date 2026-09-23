# Invariant assurance: Phase 0 findings

Companion to [invariant-assurance.md](invariant-assurance.md). Phase 0 applied
the formalization question set by hand to five Acceptance Criteria to decide
whether the idea is worth building into Tieline.

## Method

One independent read-only reviewer per AC applied the seven questions
(operations, interleavings, retry/replay, deletion/supersession, partial
failure, always vs. eventually, bounds) against the AC, its linked code and
tests, and the SQL migrations. Each answer was classified as:

- `COVERED-AC`: the AC already states the behavior.
- `COVERED-TEST-ONLY`: the behavior is defined in code or tests but not stated
  in the AC.
- `GAP-AC`: intent is unstated and a product decision is needed.
- `GAP-TEST`: intent is clear, but the dangerous path is untested.
- `POSSIBLE-BUG`: the code appears to violate the AC under some ordering or
  failure.

Each possible bug was then spot-checked against the source by a second reader
(file references below). Nothing was executed. No test, database or model
checker was run, so every possible bug is a code-reading finding, not a
reproduction.

## Result

**Go.** The exit criterion was at least 2 genuine gaps across the sample. The
pass found **23 genuine gaps across 5 ACs**:

| AC | GAP-AC | GAP-TEST | POSSIBLE-BUG | Total |
| --- | --- | --- | --- | --- |
| AUTHORITY-001-AC1 (planning writes only backlog) | 3 | 2 | 1 | 6 |
| AUTHORITY-002-AC1 (identity preserved through sync handoff) | 1 | 2 | 1 | 4 |
| AUTHORITY-002-AC3 (prune unlinked code assets) | 2 | 1 | 1 | 4 |
| CONTRACT-004-AC3 (topology publication) | 2 | 1 | 1 | 4 |
| MATCHING-001-AC3 (suggestions stay suggested until decided) | 2 | 2 | 1 | 5 |
| **Total** | **10** | **8** | **5** | **23** |

What held up well matters as much as the gaps:

- **No data-integrity corruption was found.** The core invariants are
  enforced in the database (RLS, CHECK constraints, foreign keys, advisory
  locks, row locks, revision compare-and-swap) and hold under every ordering
  the reviewers traced.
- **`COVERED-TEST-ONLY` was the most common answer.** Much of the real
  behavior (sync is all-or-nothing, the only operations are X/Y/Z, conflicts
  resolve only via a later planning revision) is correct and tested, but
  written down only in code. The ACs under-state intent more than the code
  under-delivers it.

## Possible bugs (all low severity; none corrupt data)

| # | AC | Finding | Spot-checked |
| --- | --- | --- | --- |
| B1 | AUTHORITY-002-AC1 | The handoff-conflict snapshot omits `superseded_by`, `aliases`, `applies_to` and `motivated_by`. A planning-side supersession is then cleared by `applySupersession` when a manifest claims the story without declaring `supersedes`. The later planning decision is lost silently, and the fixture that claims "the complete later planning snapshot remains readable" asserts only title and AC count. | Yes: `contract-sync-repository.ts` `planningStorySnapshot` (~509-519) and `applySupersession` (~814-846) |
| B2 | MATCHING-001-AC3 | On observation replay, `record_observation` re-runs matching and returns already confirmed or dismissed suggestions as if they were new, because `MatchCandidate` carries no `state`. Stored state is not changed. | Yes: `semantic-matching.ts:36-49`; upsert never writes `state` (`semantic-repository.ts:613-617`) |
| B3 | AUTHORITY-001-AC1 | Deadlock between a plain update of a story that already has a successor (row lock first, then the trigger's supersession advisory lock) and a supersession update (advisory lock first, then row lock). Postgres aborts one side with `40P01` rather than a typed `stale`. | Yes: `planning-story-repository.ts:365-381`; trigger in `0001_baseline.sql:~474-484` |
| B4 | CONTRACT-004-AC3 | Stale-lock recovery has a check-then-act window between the second `lstat` and `unlinkSync`, so a live lock that was just re-created can be deleted and two writers proceed. graph.json stays atomic (rename), but one run can report `topology_invalid` after publishing. | Yes: `commands/code-topology-artifact.ts:114-143` |
| B5 | AUTHORITY-002-AC3 | Concurrent syncs of different repositories can race when one newly links an asset the other is pruning. The foreign key prevents silent loss, but one sync aborts with a raw FK error (23503) instead of a typed, retryable error. | Partly: prune SQL confirmed (`contract-sync-repository.ts:251-293`); lock interleaving is reasoned, not reproduced |

Additional finding worth acting on (not a bug):

- **Create is not idempotent** (AUTHORITY-001-AC1). A planning create without
  `stable_id` that is retried after a lost response creates a second story
  with a new generated ID (`planning-story-repository.ts:304`). With an
  explicit `stable_id`, it fails with a raw duplicate-key error.

## Product decisions needed (GAP-AC)

These cannot be fixed by an agent choosing an answer; each needs an owner
decision, then an AC or scenario edit through review.

1. **Retired records and asset pruning** (AUTHORITY-002-AC3). Should a retired
   Story or AC keep its code assets alive (current behavior, intentional per
   the code comment but unstated in the AC), or should retirement release them?
2. **Cross-repository orphans** (AUTHORITY-002-AC3). When repository Y stops
   linking an asset owned by X, is it removed now, when X next syncs, or never
   if X is never synced?
3. **Handoff resolution and ordering** (AUTHORITY-002-AC1). State that a
   conflict resolves only via a later planning revision, and decide whether
   `--expected-previous-commit` should be required so an older manifest cannot
   overwrite a newer projection.
4. **Create idempotency** (AUTHORITY-001-AC1). Require `stable_id`, accept an
   idempotency key, or return a typed `already_exists`?
5. **Input bounds** (AUTHORITY-001-AC1). Publish limits on ACs per Story,
   scenarios, aliases and text length (today only the title is bounded).
6. **Defense in depth for the write role** (AUTHORITY-001-AC1). Must the rule
   hold if `DATABASE_URL_WRITE` is misconfigured? If so, assert `current_user`
   at startup, and extend the backlog check to the scenario and alias RLS
   policies.
7. **Decision finality** (MATCHING-001-AC3). Can a confirmed suggestion be
   flipped to dismissed (and back)? Should decisions require the expected
   prior state and be audited?
8. **Dismissed pairs after content changes** (MATCHING-001-AC3). Stay
   dismissed forever, or resurface when the source or target text changes?
   What happens to a confirmed suggestion when its AC is retired?
9. **Topology race winner** (CONTRACT-004-AC3). Is "last successful
   publication wins" acceptable when it may be built from older inputs, as long
   as readers report it stale?
10. **Hosted reads during prune or rollback** (CONTRACT-004-AC3). Must a
    persisted trace return one consistent snapshot or `generation_unavailable`,
    and may the checkpoint move back to an older generation?

## Missing tests (GAP-TEST)

- Two-connection race tests: planning update vs. sync claim, for both commit
  orders (AUTHORITY-001-AC1, AUTHORITY-002-AC1).
- Database-level bypass tests as `tieline_planning_writer`: raw lifecycle
  change, update of repository-owned rows, delete, insert of an AC onto a
  repository story (AUTHORITY-001-AC1).
- Sync lock wait: no `lock_timeout`, so a long planning transaction blocks
  sync indefinitely (AUTHORITY-002-AC1).
- Prune rollback on a late sync failure (AUTHORITY-002-AC3).
- Re-persisting after a decision keeps the decision, and the matcher itself
  writes `suggested`. The linked test only round-trips a hand-set value
  (MATCHING-001-AC3).
- Crash between the temp-file write and the rename leaves a `.tmp` file
  in the reviewed `.tieline/topology` directory (CONTRACT-004-AC3).

## Link hygiene

CONTRACT-004-AC3 links `migrations/0003_sql_topology_language.sql` (only a
language check). The completeness and promotion logic it relies on is in
`migrations/0002_code_topology.sql`, and its hosted rollback tests live in
`tests/integration/integration-baseline.ts`, which it does not link.

## What this says about the plan

1. **The question set works and the yield is high.** About 4–6 gaps per AC,
   concentrated in exactly the categories the questions target: ordering,
   retry/replay, supersession, bounds. Ordinary review had not surfaced
   these.
2. **The dominant problem is under-stated intent, not broken code.** This
   supports Phase 1 (put the questions in the skill, and send answers back into
   ACs and scenarios) more than any formal-methods tooling.
3. **Evidence was weakest exactly where Phase 3 would look.** Several linked
   tests pass without exercising the invariant: MATCHING's test round-trips a
   hand-set state, and AUTHORITY-002's fixture claims a complete snapshot but
   checks two fields.
4. **Phase 0b (TLA+ pilot): recommend skipping for now.** The sync handoff did
   show ordering gaps, which was the trigger. But the plain-English pass
   already produced concrete interleavings, and the next most valuable step is
   the two-connection tests that exercise them against real code. Revisit
   TLA+ only if those tests keep exposing new orderings.
5. **Cost:** five parallel reviewers, about two minutes and roughly 100k tokens
   each. That is too expensive to run on every AC, which confirms the plan's
   narrow triggers: run only on ACs that make always/never/preserve claims
   or touch shared state.

## Recommended next steps

1. Owner answers the 10 product decisions above. Each becomes an AC or
   scenario edit in a normal contract PR.
2. Fix B1 (lossy handoff snapshot) first; it is the only finding where
   intent stated in a scenario is not delivered. Then B3 and B5 (map to
   typed, retryable errors) and B2. Each fix needs a regression test (TG-7).
3. Add the missing tests, starting with the two-connection race tests.
   Integration tests run only against a guarded disposable database
   ([DB-WRITE]).
4. Fix the CONTRACT-004-AC3 links.
5. Proceed to Phase 1 (skill text), using this note's findings as the
   reference cases the skill must reproduce.
