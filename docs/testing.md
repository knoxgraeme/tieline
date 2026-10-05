# Testing

[README](../README.md) · [Architecture](architecture.md) · [Setup](setup.md) · [CLI](cli.md) · **Testing** · [Operations](operations.md)

## Test layout

| Location | Purpose |
| --- | --- |
| `tests/unit/` | Deterministic tests for contract, retrieval, runtime, topology, and evidence behavior. |
| `tests/integration/` | Database-backed integration tests. These write only to a guarded disposable database. |
| `tests/smoke/` | End-to-end smoke coverage of core repository workflows. |
| `tests/evaluations/` | Retrieval and behavior evaluations with explicit fixtures and scoring. |
| `tests/fixtures/` | Controlled source, contract, and parser inputs. |
| `tests/support/` | Shared test harnesses and helpers. |
| `tests/support/fakes/` | Test doubles; never production adapters. |
| `benchmarks/` | Repeatable performance measurements, outside the ordinary test gate. |
| `scripts/` | Development and verification utilities, including the generated-artifact gate. |

## Commands

```bash
npm ci
npm run check:fast
npm run check
```

`npm run check:fast` runs typechecking, the production build, the offline test suite, and guardrail checks. `npm run check` is the canonical full validation path; it adds CLI/onboarding validation and a package dry run.

During focused work, run the narrowest relevant `npm run test:*` command, then run `npm run check` before handoff. Use `npm run check:generated-artifacts` whenever authored specs or generated artifacts change.

## Contract grading evaluations

Deterministic grading tests run in `npm run check`: `test:criterion-grade` covers
scope selection and citation verification, `test:manifest-maintenance` exercises
publication with disposable local Git remotes, and `test:grading-evaluation`
checks the evaluation harness with canned verdicts. Canned verdicts test the
scorer; they are not evidence of model quality.

`npm run test:closeout` uses disposable local Git histories to verify immutable
scope, removed rules/links, inherited applicability, stale commit bindings,
missing/duplicate dispositions, and unresolved readiness. It also exercises the
actual CLI from a subdirectory with malformed uncommitted configuration. These
tests verify report mechanics, not whether an agent's explanation is correct.

Run a separate semantic experiment when changing the grading rubric:

```bash
npm run eval:grading -- prepare .context/grading-experiment
# Give fresh independent graders only grader-instructions.md,
# grader-rubric.md and each case's packet.json from that directory.
# Save their original responses as case-XX/verdicts.json.
npm run eval:grading -- score .context/grading-experiment
```

Preparation refuses to overwrite an experiment and freezes the rubric with a
hash and corpus version. The grader must not see evaluator expectations or
authoring rationale. Use disposable, credential-free environments with no
network or product execution; the supplied packets contain all authorized
evidence. This harness has no model client and does not provide an agent sandbox;
the caller must enforce isolation. Ordinary checks require no model credentials.

Scoring regenerates scopes from controlled fixtures, rejects altered source,
extra files, changed packets and a mismatched rubric receipt, and verifies
citations with the production verifier. It reports case pass rates, false
support, missed and spurious link findings, and verification failures. A failing
case makes scoring exit nonzero. Receipts detect accidental changes, not a
malicious host rewriting both data and receipts. Preserve original results when
correcting a corpus; never reclassify an earlier experiment as passing.

The seven cases cover distributed support, overclaims, obsolete links,
irrelevant evidence, implementation drift, cosmetic edits, and unavailable
dependencies. They are a small rubric regression corpus, not a general quality
benchmark or an automated end-to-end agent-fix evaluation. See the
[initial experiment report](evaluations/grading-2026-10-05.md).

## Disposable database guard

`npm run test:integration` and the other database-writing integration commands require guarded, disposable test credentials and a verified test-only database target. Never point them at a development, staging, or production `DATABASE_URL`. The ordinary offline suite does not need production credentials.
