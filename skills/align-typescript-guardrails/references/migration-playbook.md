# Incremental Migration Playbook

## Contents

1. Preconditions
2. Migration phases
3. Legacy ratchets
4. Verification
5. Stop conditions

## Preconditions

Before editing:

1. Complete the audit matrix from `audit-report.md`.
2. Record the current git status and preserve unrelated user changes.
3. Run the existing fastest credible baseline checks.
4. Identify supported Node/TypeScript versions and framework constraints.
5. Identify generated code and files excluded intentionally.
6. Classify the migration itself and any touched product code as Routine, Behavioral, or Critical.
7. Identify the existing guardrail-test command, fixtures, and CI triggers.

Do not combine broad product refactors with guardrail adoption.

## Migration phases

Choose only phases justified by the audit. Keep each independently reviewable.

### Phase A — Canonical verification

Establish or repair:

- explicit `typecheck`, `lint`, `test`, `build`, and format-check commands;
- one canonical `check` command;
- CI required jobs using the same commands;
- full TypeScript surface coverage, including separate configs for tests/scripts where needed.

Do not add expensive integration suites to the fast lane if doing so makes developers bypass it.

### Phase B — Type and promise safety

Adopt:

- `strict`;
- high-value additional compiler flags from TG-1;
- stable recommended type-aware linting;
- promise and exhaustiveness rules.

Migration order:

1. Enable one coherent group.
2. Capture diagnostics.
3. Fix production source by narrowing, validation, exhaustive handling, or better types.
4. Use a narrow documented waiver only when upstream typings or generated code make a real fix unavailable.
5. Run typecheck, lint, tests, and build.

Never mass-insert `any`, non-null assertions, double casts, or ignores.

### Phase C — Boundary and failure contracts

Map trust boundaries and operation boundaries.

- Add or consolidate runtime schemas.
- Parse environment at startup.
- Remove unchecked casts of external data.
- Define domain versus unexpected error behavior.
- Remove swallowed errors.
- Add invariants to important state transitions.

Prefer a few strong boundary schemas over validation scattered through internal code.

### Phase D — Bounded execution

Inventory network calls, retries, worker pools, pagination, streams, caches, recursive traversal, and data-sized `Promise.all`.

- propagate cancellation;
- add timeouts and size/concurrency limits;
- make retry safety/idempotency explicit;
- test limit exhaustion and cancellation;
- preserve framework-native mechanisms when they already provide the control.

Avoid arbitrary constants. Name limits by operational meaning and make appropriate ones configurable with validated bounds.

### Phase E — Behavioral assurance

- Add regression tests for known defects.
- Add invalid/boundary/off-nominal cases for changed behavior.
- remove committed focus markers and unjustified skips;
- make time/randomness/external state deterministic;
- apply stronger branch, property, or mutation tests only to critical pure logic.

Do not chase global coverage percentages without a risk argument.

### Phase F — Control-plane protection

In repository files:

- add ratchet checks for suppressions and excluded surfaces;
- document control-plane paths;
- add ownership definitions when identities are known;
- make check failures blocking in CI configuration;
- add a waiver format/location if the project needs exceptions.

Recommend, but do not silently configure, server-side required reviews, rulesets, or code scanning.

Add deterministic tests for each control introduced in this phase. Include at least one
violation and one legitimate counterexample for every blocking hook or command-policy
rule.

### Phase G — Guardrail self-evaluation

Adopt only the layers justified by the repository's autonomy and risk:

1. Establish a dependency-light repository-native guardrail-test command.
2. Add violation, legitimate-counterexample, and protected-control bypass fixtures.
3. Grade repository state and observed checks, not agent claims.
4. Add 3–5 disposable synthetic agent scenarios for the most consequential rules when
   static fixtures cannot prove instruction following or bypass resistance.
5. Run deterministic tests on every guardrail or protected-control change.
6. Run repeated agent scenarios on risk-triggered, scheduled, or model/instruction
   upgrade lanes.
7. Add confirmed escapes and false positives as regression cases.

Do not add Promptfoo during initial adoption unless the repository already uses it or
needs multi-model matrices, repeated-run reporting, or a larger scenario corpus.

## Legacy ratchets

When full adoption is too disruptive:

- snapshot existing violations by category and file;
- fail only on increases or violations in changed code;
- prohibit new suppressions without rationale;
- burn down one category at a time;
- set an owner and review date;
- do not call a permanent baseline a waiver.

Prefer tool-native baselines when available. Otherwise keep a small deterministic manifest whose regeneration is explicit and reviewed.

## Verification

After each phase:

1. Run the changed tool directly.
2. Run relevant focused tests.
3. Run affected guardrail fixtures.
4. Run the canonical check.
5. Inspect the diff for weakened controls, generated churn, and unrelated edits.
6. Compare collector signals before and after.

At completion, run the project’s clean-install/full CI equivalent when proportionate and available.

## Stop conditions

Stop and report instead of forcing progress when:

- a required change would break a public contract outside the authorized scope;
- a framework/tool version does not support the intended control;
- existing tests reveal behavior ambiguity that requires a product decision;
- adoption would require broad unsafe casts or exclusions;
- critical control changes lack an independent approver;
- dependencies cannot be installed or checks cannot run and the remaining edit would be speculative.
