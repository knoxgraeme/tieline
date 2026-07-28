---
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
title: "tieline-sync: interactive drift remediation on a branch - Plan"
date: 2026-07-27
type: feat
---

# tieline-sync: interactive drift remediation on a branch - Plan

## Goal Capsule

- **Objective:** A branch-scoped skill you trigger that keeps the tieline story map (stories + acceptance criteria + test links) in sync with the code you're building — running the deterministic drift check to find what's stale, then re-mapping in-session (fixing stale stories **and** proposing net-new stories for new behavior), with you approving the result before it lands.
- **Product authority:** This document (from `ce-brainstorm`). Defines WHAT; `ce-plan` defines HOW.
- **Open blockers:** Depends on the living-spec plan's *detection* half being built first (see Dependencies). No product blockers.

---

## Product Contract

### Problem frame

The living-spec plan (`docs/plans/2026-07-27-002-feat-tieline-living-spec-plan.md`) builds the **detection** half: it flags, deterministically, which stories a branch's changes put out of sync (stale AC, moved/deleted code, removed tests). But detection just produces a list — the actual *re-mapping* is left to a human/agent loop the plan explicitly deferred.

Today that loop is manual and expensive: to keep the map current you'd re-run the whole backfill, or hand-edit stories one by one. So in practice the map drifts — the spec quietly stops matching the code — which is exactly the failure the living-spec work exists to prevent. The gap: a **bounded, in-session** way to consume the drift signal and bring the map back into sync *on the branch, before the PR*, without re-scanning the world.

### Actors

- **A1 — Developer (human):** building on a feature branch; triggers the skill and approves the proposed draft.
- **A2 — The skill (agent):** the semantic re-mapper — reads the diff, re-evaluates behavior, proposes story/AC/link changes.
- **A3 — tieline CLI:** the deterministic layer — `tieline drift` (detection) and the review/import path (persistence).

### Requirements

- **R1 — Branch-scoped.** The skill operates on the current branch versus its merge-base with the default branch: "drift" means *what this branch changed*.
- **R2 — Reuse deterministic detection.** The skill runs `tieline drift` to get the flagged stories + the changed-path set; it does not re-implement detection.
- **R3 — Strictly bounded.** The skill only considers drift-flagged stories **and** new behavior visible in the branch diff. It never does a full-map re-scan or re-backfill.
- **R4 — Remediate existing stories.** For each stale story, propose revised acceptance criteria, repointed or removed code/test links, and status changes where behavior was removed.
- **R5 — Forward-generate net-new stories.** For new behavior in the diff with no covering story, propose **net-new stories** (with new AC + test links) at a non-shipped status (`in_progress`/`idea`).
- **R6 — Draft → existing review → import.** The skill emits its proposals as a draft into the `.tieline` workspace; the human reviews/edits via the existing `tieline review` flow; `tieline import` persists them and regenerates the manifest. No new incremental-write path.
- **R7 — Updates preserve history.** Changes to existing stories flow through tieline's existing change-proposal / approval / revision lifecycle — not silent overwrite.
- **R8 — Propose, don't persist.** Nothing lands without human approval through the existing gate; the skill shows before/after for each proposed change.
- **R9 — Composes with detection + closes the loop.** The skill sits on top of the living-spec detection half; after import the manifest regenerates so the branch is back in sync (drift clean).

### Acceptance examples

- **AE1 (R5):** On a branch that adds a new endpoint + its tests, the skill proposes a net-new story (`in_progress`) with AC derived from the new tests, linked to the new code + test files.
- **AE2 (R4):** On a branch that renames a file 3 stories reference, the skill proposes repointing those 3 stories' links to the new path.
- **AE3 (R4/R7):** On a branch that removes a feature, the skill proposes marking the affected story `cancelled` (or removing links) through the change-proposal/revision lifecycle, preserving history.
- **AE4 (R6/R8/R9):** The proposals appear as a reviewable draft; nothing persists until the human approves via review/import; after import the manifest regenerates and `tieline drift` is clean for the branch.
- **AE5 (R3):** A branch touching one area leaves stories in unrelated areas untouched — the skill only proposes changes for drift-flagged + diff-covered behavior.

### Key decisions (from brainstorm)

- **KD1** v1 does both: **remediate** stale stories **and** **forward-generate** net-new stories for new behavior.
- **KD2** Apply via **draft → existing `tieline review` → `tieline import`** — reuses the existing approval UX and the living-spec batch-AC-import path; **dissolves** the incremental-write dependency. Batch approval.
- **KD3** Updates to existing stories flow through the existing **change-proposal / revision lifecycle** (history preserved).
- **KD4** **Strictly bounded** to the branch diff — never a full re-scan.
- **KD5** **Diff-driven v1** — running the test suite in the loop is deferred.
- **KD6** **Manually triggered** — CI-flag → auto-trigger wiring is deferred.

### Scope Boundaries

**In scope (v1):** R1–R9.

**Deferred for later:**
- **Live/incremental MCP writes** — the draft path makes them unnecessary for v1.
- **Test-run in the loop** — using actual pass/fail to inform re-mapping/verification (KD5); v1 is diff-driven.
- **CI-flag → auto-trigger** — wiring the CI drift flag to auto-invoke the skill (KD6); v1 is manual.
- **Whole-map re-sync** — remediating drift outside the current branch (a full-map refresh) is a separate mode.

**Outside this product's identity:**
- Not a **code/test generator** — it maps *behavior*, it does not write code or tests.
- Not a **merge gate** — it's a pre-PR sync aid, not a blocker.
- The **CLI stays deterministic** — the semantic re-mapping lives in the skill (agent), never in the `tieline` CLI.

### Success criteria

- After running the skill on a branch and approving the draft, `tieline drift` is clean for that branch (map matches the code).
- A typical branch's map changes — both edits and net-new stories — are produced in one bounded, in-session pass, not a full re-backfill.
- No map change persists without human approval; existing unrelated stories are never touched.

### Dependencies / Assumptions

- **Depends on the living-spec detection half** (`docs/plans/2026-07-27-002-feat-tieline-living-spec-plan.md`): the `tieline drift` command, the committed manifest, and AC/test-link persistence + AC-in-import. This skill is **sequenced after** that plan.
- **Requires import to update existing stories** (not only create) via the change-proposal/revision lifecycle — tieline already has that machinery (story revisions/events/proposals); verify the draft→import path exercises it in planning.
- **Assumes a merge-base is resolvable** for the branch (drift base = merge-base with the default branch).

### Outstanding Questions (for planning)

- **Draft reconciliation:** how the skill's draft merges with the *current* map for already-existing stories (reuse `tieline merge`'s conflict handling? new-vs-update disambiguation).
- **Base-ref resolution:** which base the drift/diff runs against (merge-base with default branch; configurable?).
- **Before/after presentation:** how much diff/context the skill surfaces per proposed change for approval.
- **Skill packaging:** is this a Claude Code skill (like `backfill-stories`) that orchestrates `tieline drift` + drafting, and how it shares/depends on the `backfill-stories` methodology (relates to the deferred skill↔handoff cleanup).
- **Test-run signal:** whether it becomes a fast-follow after v1 (KD5).
