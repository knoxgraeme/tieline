<!--
Copy the applicable sections into the repository-root AGENTS.md.
Replace every {{PLACEHOLDER}} and delete rules that do not apply.
Keep repository-wide rules here; place narrower overrides in nested AGENTS.md files.
AGENTS.md is guidance. Enforce deterministic rules with TypeScript, lint, tests, CI,
and hooks.
-->

# Repository Working Agreements

## Scope and precedence

- These instructions apply to the entire repository unless a closer `AGENTS.md` or
  `AGENTS.override.md` supplies narrower instructions.
- Preserve existing behavior unless the task explicitly authorizes a behavior change.
- If requested work conflicts with these instructions, stop and report the conflict.
- Do not guess unresolved `{{PLACEHOLDER}}` values. Determine them from repository
  configuration or ask for direction.

## Canonical commands

- Install dependencies: `{{INSTALL_COMMAND}}`
- Fast validation: `{{FAST_CHECK_COMMAND}}`
- Full required validation: `{{FULL_CHECK_COMMAND}}`
- Risk-triggered integration validation: `{{INTEGRATION_CHECK_COMMAND}}`
- Guardrail verification: `{{GUARDRAIL_TEST_COMMAND}}`

Use the repository's pinned Node and package-manager versions. Do not substitute a
different package manager. Completion requires observed command results; configuration
or an existing test file is not evidence that a check passed.

## Change discipline

- Make the smallest coherent change that satisfies the requested behavior.
- Keep unrelated cleanup out of the change.
- Follow existing module boundaries and public contracts. Do not introduce an
  abstraction until it has a concrete current use.
- Explain any new production dependency and why existing dependencies or platform
  capabilities are insufficient.
- Do not edit generated output directly; change its source and regenerate it.

## Type and boundary safety

- Keep TypeScript strict. Do not weaken compiler options or exclude failing source
  paths.
- Do not introduce broad `eslint-disable`, `@ts-ignore`, unsafe `any`, or unexplained
  double casts. Use a narrow documented exception only when a real fix is unavailable.
- Treat network, file, environment, database, queue, CLI, and deserialized values as
  untrusted. Parse and validate them at the boundary before constructing trusted domain
  values.
- Make invalid states difficult to represent. Use discriminated unions and exhaustive
  handling for closed state sets.

## Control flow, resources, and failures

- Keep control flow locally understandable. Split code when a function mixes
  orchestration, policy, I/O, and transformation.
- Bound retries, polling, queues, concurrency, recursion, and input-dependent work.
  Define timeout, cancellation, backoff, and terminal failure behavior where relevant.
- Await or intentionally supervise every promise. Preserve useful failure context and
  never silently swallow errors.
- Release timers, listeners, streams, handles, transactions, and temporary resources on
  success, failure, and cancellation.
- Make state transitions and side effects explicit. Protect critical assumptions with
  executable invariants or validation.

## Behavioral evidence

- Add or update tests for changed behavior.
- For bug fixes, add a regression test that fails without the fix.
- Cover the intended path and relevant invalid, boundary, timeout, cancellation, and
  dependency-failure paths.
- Keep tests deterministic: control time, randomness, network, and external state.
- Do not delete, skip, focus, loosen, or inflate timeouts in tests merely to obtain a
  passing result.
- Run the narrowest relevant checks during implementation and
  `{{FULL_CHECK_COMMAND}}` before completion. Report checks not run and why.

## Protected control plane

Treat these as control-plane surfaces:

- `AGENTS.md`, nested agent instructions, `.codex/`, hooks, and command rules;
- TypeScript, lint, formatting, test, coverage, and build configuration;
- CI workflows, required-check definitions, ownership files, and release configuration;
- dependency manifests and lockfiles;
- authorization, secrets, migrations, destructive tooling, public contracts, schemas,
  and generated-code sources.

Do not silently weaken a control-plane surface. Report material changes separately,
including why they are required and what evidence protects the change. Do not:

- change a required check to advisory;
- reduce checked paths, coverage scope, or assertion strength;
- add unexplained suppressions, skips, focus markers, timeout increases, snapshot churn,
  or lockfile churn;
- change authorization, destructive behavior, public contracts, or migration semantics
  without explicit risk analysis.

Critical control-plane changes require review by someone other than the implementing
agent. The implementing agent cannot approve its own waiver.

## Guardrail verification

- Add a violating fixture and a legitimate counterexample when adding or changing a
  mechanical rule.
- Add every confirmed bypass or false positive as a regression case.
- Run `{{GUARDRAIL_TEST_COMMAND}}` after changing agent instructions, hooks, command
  rules, CI, compiler/test configuration, or guardrail evaluation files.
- Grade final repository state and observed check results. Do not treat an agent's
  completion claim as proof.
- Keep synthetic agent scenarios in disposable workspaces without production
  credentials or unrestricted internal network access.

## Waivers

Store exceptions in `{{WAIVER_PATH}}`. Every waiver must identify:

- rule and exact scope;
- rationale and accepted consequence;
- mitigation and compensating evidence;
- owner and independent approver;
- creation date, expiry date, and invalidation conditions.

An expired or scope-mismatched waiver does not apply. Convenience alone is not a
justification.

A waiver record affects a mechanical guard only when the trusted grader explicitly
parses and validates its schema, scope, approval, and expiry. A record alone does not
disable a check.

## Completion report

At handoff, state:

- behavior changed and intentionally unchanged;
- files and control-plane surfaces changed;
- commands run and their observed results;
- guardrail cases run when protected controls changed;
- checks not run and why;
- remaining risks, follow-ups, and active waivers.

## Code Review Rules

### Validation integrity

- Flag changes that make TypeScript, lint, tests, coverage, build, or CI pass by checking
  less code or enforcing less behavior.
  Safe path: fix the underlying issue or add a narrow, owned, expiring waiver.

### Trust boundaries

- Flag unvalidated external data entering trusted application state and validation that
  occurs only after unsafe use.
  Safe path: parse once at the boundary and pass a trusted representation inward.

### Async and resource bounds

- Flag unbounded retries, polling, concurrency, queues, recursion, or waits, and resources
  that are not released on every exit path.
  Safe path: add explicit limits, timeout/cancellation behavior, terminal failure, and
  cleanup.

### Failure semantics

- Flag swallowed errors, floating promises, ambiguous partial success, and retries of
  unsafe operations without idempotency protection.
  Safe path: make failure observable, preserve context, and define safe recovery.

### Behavioral evidence

- Flag behavior changes without relevant positive and off-nominal evidence, and bug fixes
  without a regression test.
  Safe path: add focused tests at the lowest level that proves the contract.

### Protected controls

- Flag material edits to agent instructions, hooks, command rules, CI, test/compiler
  configuration, authorization, migrations, destructive tooling, or public contracts
  that lack an explicit rationale and independent review appropriate to their risk.
  Safe path: isolate the control change, describe its effect, retain or strengthen
  enforcement, and obtain independent approval for critical changes.

### Guardrail regressions

- Flag a new or changed blocking rule without both a violating fixture and a legitimate
  counterexample, or an agent eval that grades only the final prose response.
  Safe path: add executable cases that inspect the final repository state and observed
  validation evidence.
