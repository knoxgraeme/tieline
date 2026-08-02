---
name: tieline-grade
description: Grade whether the contract links a branch touches are actually true. Use when asked to grade, judge, or check the evidence quality of Tieline Acceptance Criterion links, to verify that a linked file really implements or tests the AC it claims, or to review link claims before a pull request is merged.
---

# Tieline grade

Tieline proves a linked path exists and that its bytes have not changed since
review. It does not prove the file has anything to do with the Acceptance
Criterion. You supply that judgment. Tieline supplies the work list, the closed
set of legal citations, and a fence that checks every citation you make.

Read [grading.md](references/grading.md) before grading.

You are the only step in this pipeline Tieline does not control. Everything
handed to you is deterministic, and everything you hand back passes through the
fence before it can affect an exit code. Grade accordingly.

## Get the work list

```sh
tieline contract grade . --base origin/main --emit-scope --json
```

This runs offline. It emits one entry per contract link the diff touched, each
carrying:

- `acceptance_criterion_stable_id` and `criterion` — the behavior being claimed
- `path`, `kind`, and `relation` — the artifact and the claim it makes
- `vocabulary` — **the complete set of symbols you may cite for that artifact**
- `link_scope` — `direct`, or `story_fallback` when the link sits on the Story

An empty scope means the diff touched no contract link. Say so and stop.

## Judge each entry

For every entry, read the artifact at `path` with your own tools, then decide
which single grade the evidence supports.

| Grade | Citation | Reason | Use when |
| --- | --- | --- | --- |
| `supported` | **required**, must be in `vocabulary` | optional | A named symbol in the artifact serves this AC |
| `partial` | **not permitted** | **required** | The artifact participates; no single symbol carries the AC |
| `unsupported` | **not permitted** | **required** | No support found |

Rules, in force for every entry:

1. **Cite only from `vocabulary`.** Never invent a symbol name, never cite a
   symbol from a different artifact, and never adjust spelling to make a
   citation fit. Copy the string exactly as emitted.
2. **Do not stretch a citation.** If no symbol in `vocabulary` serves the AC,
   the honest grade is `partial` or `unsupported`. Reaching for the nearest
   plausible name is the failure this skill exists to prevent.
3. **`unsupported` is an expected outcome, not a failed run.** State it plainly.
   A run that returns several `unsupported` grades has done its job.
4. **An empty `vocabulary` means `supported` is unreachable.** Deleted files and
   non-TypeScript artifacts arrive this way. Grade `partial` or `unsupported`
   and say which.
5. **Grade the link, not the change.** The question is whether this artifact
   serves this criterion — not whether the diff was any good.

## Print your judgment before verifying

Print every grade, its citation, and its reason **before** running `--verify`.
The judgment must be auditable independently of the tool's own report; a reader
has to be able to see what you claimed and what the fence did to it.

## Verify

Write the verdicts to a file, one per scoped entry:

```json
{
  "verdicts": [
    {
      "acceptance_criterion_stable_id": "CONTRACT-001-AC3",
      "path": "src/contract/impact.ts",
      "grade": "supported",
      "symbol": "analyzeContractImpact"
    },
    {
      "acceptance_criterion_stable_id": "CONTRACT-001-AC3",
      "path": "src/commands/check.ts",
      "grade": "partial",
      "reason": "Reports impacts, but freshness is computed in impact.ts."
    }
  ]
}
```

```sh
tieline contract grade . --base origin/main --verify verdicts.json
```

Submit exactly one verdict per scoped entry. A scoped entry you leave out is
reported `unsupported` — omission is not a way to skip a hard link. A verdict
for a pair that is not in scope, or a second verdict for a pair, is rejected as
malformed.

The command exits 0 by default. Add `--strict` only when the caller asked for a
gate; it exits non-zero while any `unsupported` grade remains.

## Report

State, in this order:

1. Scope size and the base ref it was derived from.
2. Counts by grade.
3. Every non-`supported` entry with its reason. Never drop one.
4. Every downgrade the fence applied, named as such. A downgrade means you cited
   a symbol that is not in the artifact — report it as your error, not noise.
5. Proposed `selector` values from `supported` grades, offered for the author to
   accept through normal pull-request review.

Do not edit YAML from this skill, and do not persist grades. Grades are a check,
not a record. The durable fact — which symbol serves an AC — belongs in the
contract's `selector` field, accepted through review like any other contract
change.
