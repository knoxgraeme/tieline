# TypeScript/Node Agent Guardrail Rules

## Contents

1. Operating principle
2. Baseline rules
3. Change-risk profiles
4. Tailoring and waivers
5. Literal NASA rules not to copy

## Operating principle

Make compliant work the easiest path. Constrain shapes that hide control flow, state, resource use, failures, authority, or evidence. Do not assume an agent is malicious; prevent accidental bypass and make deliberate weakening visible.

The baseline applies to TypeScript and Node.js services, libraries, CLIs, workers, and web backends. Adapt framework-specific mechanics without weakening the outcome.

## Baseline rules

### TG-1 — Type correctness is a gate

Require:

- `strict: true`;
- `noUncheckedIndexedAccess: true`;
- `exactOptionalPropertyTypes: true`;
- `noImplicitReturns: true`;
- `noFallthroughCasesInSwitch: true`;
- `noImplicitOverride: true` when classes are used;
- typechecking for production, test, script, and generated-code surfaces through appropriate configs;
- exhaustive handling of closed domain states.

For legacy projects, establish a ratchet instead of adding casts or excluding files. Record flags that cannot yet be enabled.

Evidence:

- effective TypeScript configuration;
- a required zero-error typecheck command;
- representative code without unsafe escape hatches.

### TG-2 — Type-aware correctness linting is a gate

Start from a stable recommended type-checked configuration. Require rules that detect:

- floating or misused promises;
- awaiting non-promises;
- non-exhaustive switches over closed unions;
- unsafe assignment, calls, arguments, member access, and returns;
- throwing non-Error values;
- unnecessary conditions that reveal model drift, when signal quality is acceptable.

Use a formatter for whitespace. Do not turn on every lint rule. Treat `any`, non-null assertions, and suppressions as ratcheted signals; permit narrow documented exceptions.

Evidence:

- lint config and covered file globs;
- zero-error required CI result;
- suppressions sampled for scope and rationale.

### TG-3 — Trust boundaries parse; internal code consumes trusted types

Validate and normalize:

- HTTP/RPC/event input;
- environment and configuration;
- files and serialized state;
- database values not guaranteed by the local schema;
- third-party API responses;
- user-controlled paths, URLs, identifiers, and sizes.

Prefer one canonical runtime schema with derived TypeScript types. Do not duplicate interface and validation definitions manually. Do not validate every internal function argument.

Evidence:

- schemas at representative boundaries;
- explicit rejection/normalization behavior;
- no `as TrustedType` conversion of untrusted data.

### TG-4 — Async work and resources are bounded

Require explicit limits for:

- timeouts and cancellation;
- retries and backoff;
- concurrency and worker pools;
- pagination and result sets;
- request/file/body sizes;
- queues, buffers, caches, and retained histories;
- recursive traversal of untrusted structures.

Retries of mutations require idempotency or proof that repetition is safe. Avoid unbounded `Promise.all` over data-sized collections. Respect stream backpressure.

Evidence:

- locally visible constants/configuration;
- `AbortSignal` or equivalent propagation;
- tests for timeout, cancellation, retry exhaustion, and limit behavior where material.

### TG-5 — Failure handling is explicit

Catch only to recover, translate, add actionable context, or clean up. Expected domain failures should be distinguishable from programmer/invariant failures. Unexpected failures must reach an operation boundary that fails the request, job, or process safely.

Require:

- no empty or silently swallowed catches;
- preserved causal errors where supported;
- cleanup in `finally`/resource scopes;
- explicit top-level process/request/job error policy;
- no continuing from a violated invariant.

Do not mandate a `Result` wrapper for every function.

### TG-6 — Code is locally comprehensible

Prefer:

- simple control flow and early exits;
- single-purpose functions;
- narrow mutable state and smallest practical scope;
- explicit dependencies and a visible composition root;
- shallow indirection;
- no import-time side effects outside entrypoints;
- one canonical definition for contracts and workflow rules.

Use thresholds only as review triggers. Suggested starting triggers for changed code:

- nesting deeper than 4;
- cyclomatic/cognitive complexity above 15;
- functions above 80–100 substantive lines;
- new dependency cycles;
- large mixed-purpose diffs.

Tune from real defect and review data. Do not split code into meaningless one-line helpers to satisfy metrics.

### TG-7 — Behavior has positive and negative evidence

Require:

- a behavioral test for new externally observable behavior;
- a regression test for a defect when reproducible;
- boundary and invalid-input cases;
- timeout, cancellation, duplicate/replay, partial-failure, and recovery cases when applicable;
- deterministic control of time, randomness, network, and external state;
- no focused tests in committed code and documented reasons for skips.

Coverage is a search signal, not proof of correctness. Do not require universal 100% line coverage. Use stronger branch/mutation/property testing selectively for pure critical logic.

### TG-8 — Builds and dependencies are reproducible

Require:

- pinned supported Node and package-manager policy;
- committed lockfile and clean/frozen CI install;
- deterministic generated artifacts;
- dependency and license review proportional to use;
- automated update and vulnerability scanning;
- explanation for new runtime dependencies;
- no secrets in repository, logs, fixtures, or build output.

Treat vulnerability scanner output as triage evidence, not an infallible verdict.

### TG-9 — One canonical verification path exists

Provide a documented command such as `npm run check` or equivalent that covers:

- format check;
- all TypeScript surfaces;
- type-aware lint;
- bounded unit tests;
- build/package verification.

CI must run the same underlying checks as required statuses. Keep long integration, security, mutation, and flake suites in risk-triggered or scheduled lanes when putting them on every PR would make the baseline unusable.

Completion requires observed command results, not an agent-authored claim.

### TG-10 — The control plane cannot be silently weakened

Identify control-plane files:

- compiler, lint, formatting, and test configuration;
- CI workflows and required-check definitions;
- dependency manifests and lockfiles;
- authorization/security boundaries;
- migrations and destructive tooling;
- public schemas/contracts;
- generated-code sources;
- ownership and agent instruction files.

Require explicit reporting and independent review for material changes to them. Detect new suppressions, excluded paths, skipped/focused tests, weaker assertions, increased timeouts, reduced coverage scope, advisory-only checks, and unexplained lockfile/snapshot churn.

Protect ownership/rules files themselves when the repository host supports it.

### TG-11 — Guardrails are executable and tested

Treat guardrails as production software. Require:

- a violating fixture for every mechanical rule;
- a legitimate counterexample for every blocking rule;
- bypass cases for compiler, lint, test, CI, agent-instruction, hook, and command-policy
  controls where applicable;
- deterministic graders that inspect repository state and observed command results;
- bounded synthetic agent scenarios for critical semantic or workflow controls that
  static fixtures cannot prove;
- regression cases for confirmed escapes and false positives;
- measured catch rate, safe-task completion, bypass rate, false-positive rate, and
  latency by rule or risk tier.

Run deterministic guardrail tests whenever their implementation or protected
control-plane files change. Run costly repeated agent scenarios on risk-triggered,
scheduled, or model/instruction-upgrade lanes.

Do not require Promptfoo or another orchestration framework for initial adoption. A
repository-native runner with disposable fixtures and executable graders is sufficient.

Evidence:

- a canonical guardrail-test command;
- violation, counterexample, and bypass fixtures;
- CI triggers for guardrail changes;
- observed results from deterministic and, where justified, agent-driven scenarios.

## Change-risk profiles

### Routine

Examples: documentation, formatting, tests, and internal refactors with unchanged behavior.

Require TG-1 through TG-11 baseline checks as applicable. Agent self-review may be sufficient.

### Behavioral

Examples: new product behavior, API behavior, persistence changes, jobs, and external integrations.

Additionally require:

- intended behavior and affected contracts;
- positive plus relevant off-nominal tests;
- compatibility and migration impact;
- a reviewer distinct from the implementer when practical.

### Critical

Examples: authentication/authorization, payments, secrets, destructive operations, data transformations, shared-state concurrency, PII, deployment controls, and public compatibility contracts.

Additionally require:

- independent human approval;
- explicit prohibited outcomes and failure modes;
- rollback or safe-forward procedure;
- realistic integration/off-nominal evidence;
- staged release or containment where practical;
- no self-approved waiver.

## Tailoring and waivers

Tailor by risk; never by convenience alone.

Every waiver must state:

- rule ID;
- exact scope;
- why compliance is currently impractical;
- accepted risk and likely consequence;
- mitigation and compensating evidence;
- owner and approver;
- creation and expiry date;
- events that invalidate the waiver.

Expired or scope-mismatched waivers do not apply. Prefer a repository-tracked structured record over an undocumented comment.

## Literal NASA rules not to copy

Do not:

- ban recursion globally—bound depth for untrusted structures;
- ban dynamic allocation—bound collections, queues, caches, and payloads;
- enforce a universal 60-line function failure—use review triggers;
- require a fixed assertion count—place contracts at meaningful boundaries;
- demand maximum rigor for every change—use risk profiles;
- treat zero warnings from one tool as proof—combine independent evidence;
- equate test links or line coverage with verified behavior.
