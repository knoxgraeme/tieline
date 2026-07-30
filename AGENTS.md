# Repository Working Agreements

## Scope and precedence

- These instructions apply to the entire repository unless a closer `AGENTS.md` or
  `AGENTS.override.md` supplies narrower instructions.
- Preserve existing behavior unless the task explicitly authorizes a behavior change.
- If requested work conflicts with these instructions, stop and report the conflict.

## Canonical commands

- Install dependencies: `npm ci`
- Fast validation: `npm run check:fast`
- Full required validation: `npm run check`
- Risk-triggered read integration validation: `npm run test:integration`
- Guardrail verification: `npm run test:guardrails`
- Submitted-diff grading: `git diff --no-renames --unified=0 <base> HEAD | node guardrail-evals/run.mjs --stdin`

Use the Node version supported by `package.json` and npm with the committed lockfile.
Do not substitute a different package manager. Completion requires observed command
results; configuration or an existing test file is not evidence that a check passed.

Write-capable integration commands, including `npm run test:import` and
`npm run test:approval-mode`, require guarded disposable test credentials and a
verified test-only database target. [DB-WRITE] Never run them using a general
development, staging, or production `DATABASE_URL`, and never infer authorization to
run them from a request to run the ordinary test suite.

## Change discipline

- Make the smallest coherent change that satisfies the requested behavior.
- Keep unrelated cleanup out of the change.
- Follow existing boundaries among domain logic, adapters, MCP tools, HTTP transport,
  commands, and browser UI. Do not introduce an abstraction until it has a concrete
  current use.
- Explain any new production dependency and why existing dependencies or Node
  capabilities are insufficient.
- Do not edit generated `dist/` output or generated browser bundles directly; change
  their source and rebuild.

## Type and boundary safety

- [TG-1] Keep TypeScript strict. Do not weaken compiler options or exclude failing
  production, UI, test, or script paths to obtain a passing result.
- [TG-2] Do not introduce `@ts-ignore`, broad `eslint-disable`, unsafe `any`, or
  unexplained double casts. Prefer a real type or boundary fix. A narrow
  `@ts-expect-error` or rule-specific suppression requires an adjacent reason and
  evidence that the exception is intentional.
- Treat MCP, HTTP, environment, file, CLI, database, and embedding-provider values as
  untrusted. Parse and bound them at entry before constructing trusted domain values.
- Make invalid lifecycle states difficult to represent. Handle closed states
  exhaustively and preserve revision and approval invariants.

## Control flow, resources, and failures

- Keep control flow locally understandable. Split code when a function mixes
  orchestration, policy, I/O, and transformation.
- Bound retries, polling, pagination, queues, concurrency, recursion, request bodies,
  import files, result sets, and retained histories.
- Define timeout, cancellation, backoff, idempotency, and terminal failure behavior
  where relevant.
- Await or intentionally supervise every promise. Preserve useful failure context and
  never silently swallow errors.
- Release timers, listeners, streams, handles, transactions, and temporary resources
  on success, failure, and cancellation.
- Keep database privilege separation intact. Changes to approval functions,
  `SECURITY DEFINER` SQL, migration checksums, remote HTTP binding, or gateway trust
  assumptions are critical changes.

## Behavioral evidence

- [TG-7] Add or update deterministic tests for changed behavior. Do not delete, skip,
  focus, loosen, or inflate timeouts in tests merely to obtain a passing result.
- For bug fixes, add a regression case that fails without the fix.
- Cover the intended path and relevant invalid, boundary, timeout, cancellation,
  duplicate/replay, and dependency-failure paths.
- Control time, randomness, network, and external state. Tests in the fast and full
  canonical paths must not require production credentials.
- Run the narrowest relevant checks during implementation and `npm run check` before
  completion. Report any checks not run and why.

## Protected control plane

Treat these as protected control-plane surfaces:

- [TG-10] `AGENTS.md`, nested agent instructions, `guardrail-evals/`, and waivers;
- TypeScript, lint, formatting, test, coverage, package, and build configuration;
- `.github/workflows/`, required-check definitions, ownership, and release files;
- dependency manifests and lockfiles;
- authorization, database roles, migrations, destructive tooling, public contracts,
  runtime schemas, and generated-code sources.

Do not silently weaken a protected surface. Report material changes separately,
including their reason and the evidence protecting them. Do not:

- change a required check to advisory or omit `npm run check` from required CI;
- reduce checked paths, test scope, or assertion strength;
- add unexplained suppressions, skips, focus markers, timeout increases, snapshot
  churn, or lockfile churn;
- change authorization, destructive behavior, public contracts, migration semantics,
  or remote-exposure assumptions without explicit risk analysis.

Critical control-plane changes require review by someone other than the implementing
agent. The implementing agent cannot approve its own waiver. Repository administrators
must configure branch protection to require the `quality` and trusted-base `guardrail`
jobs plus Code Owner approval; repository-local files cannot make their own enforcement
tamper-proof.

## Guardrail verification

- [TG-9] `npm run check` is the canonical full verification path. Do not replace it
  with a narrower command in required CI or completion reports.
- [TG-11] Run `npm run test:guardrails` after changing agent instructions,
  `guardrail-evals/`, CI, package scripts, compiler/lint/test configuration, or another
  protected validation control.
- Required pull-request CI must grade the submitted diff in addition to self-testing
  the guardrail fixture corpus.
- Add a violating fixture and a legitimate counterexample when adding or changing a
  mechanical rule. Add a bypass fixture for consequential control-plane rules.
- Grade the final repository diff and observed command results. Do not treat an
  agent's completion claim as proof.
- Keep any future synthetic agent scenario in a disposable workspace without
  production credentials or unrestricted internal network access.
- Repository lifecycle hooks are not part of the baseline. Add one only when measured
  early-interception value justifies its false-positive rate and latency; CI remains
  the independent merge gate.

## Waivers

Store any necessary exception as a reviewed Markdown record under
`docs/guardrail-waivers/`. Every waiver must identify:

- rule and exact scope;
- rationale and accepted consequence;
- mitigation and compensating evidence;
- owner and independent approver;
- creation date, expiry date, and invalidation conditions.

An expired or scope-mismatched waiver does not apply. Convenience alone is not a
justification. There are no implicit or verbal waivers.

## Completion report

At handoff, state:

- behavior changed and intentionally unchanged;
- files and protected surfaces changed;
- commands run and their observed results;
- guardrail cases run when protected controls changed;
- checks not run and why;
- remaining risks, follow-ups, and active waivers.

## Code Review Rules

### Validation integrity

- Flag changes that make TypeScript, lint, tests, build, guardrails, or CI pass by
  checking less code or enforcing less behavior.
  Safe path: fix the underlying issue or add a narrow, owned, expiring waiver.

### Trust boundaries

- Flag unvalidated external data entering trusted application state and validation
  that occurs only after unsafe use.
  Safe path: parse once at the boundary, enforce size/path limits, and pass a trusted
  representation inward.

### Async and resource bounds

- Flag unbounded retries, polling, concurrency, pagination, queues, recursion, waits,
  or resources that are not released on every exit path.
  Safe path: add explicit limits, timeout/cancellation behavior, terminal failure, and
  cleanup.

### Failure semantics

- Flag swallowed errors, floating promises, ambiguous partial success, and retries of
  unsafe operations without idempotency protection.
  Safe path: make failure observable, preserve context, and define safe recovery.

### Database and lifecycle integrity

- Flag migration, database-role, approval, lifecycle, or revision changes that weaken
  authorization, history, idempotency, or stale-write protection.
  Safe path: preserve the database-enforced invariant, add off-nominal integration
  evidence on a disposable target, and obtain independent review.

### HTTP exposure

- Flag remote binding, CORS, gateway, authentication, request-size, or response-size
  changes that expand trust without an explicit containment model.
  Safe path: keep local binding as the default, validate gateway configuration, bound
  payloads, and test rejected origins and oversized input.

### Behavioral evidence

- Flag behavior changes without positive and relevant off-nominal evidence, and bug
  fixes without a regression test.
  Safe path: add focused tests at the lowest level that proves the contract.

### Protected controls

- Flag material edits to agent instructions, guardrail graders, CI, test/compiler
  configuration, package scripts, authorization, migrations, destructive tooling, or
  public contracts that lack an explicit rationale and independent review appropriate
  to their risk.
  Safe path: isolate the control change, describe its effect, retain or strengthen
  enforcement, and obtain independent approval for critical changes.

### Guardrail regressions

- Flag a blocking rule without both a violating fixture and a legitimate
  counterexample, a consequential rule without a bypass fixture, or an eval that
  grades only an agent's prose.
  Safe path: add executable cases that inspect the final diff and observed validation
  evidence.
