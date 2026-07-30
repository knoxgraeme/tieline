# Guardrail Evaluation

Treat guardrails as software under test. Start with repository-native deterministic
tests. Add model-driven scenarios only when static fixtures cannot prove the behavior.

## Contents

1. Evaluation layers
2. Case contract
3. Required case types
4. Repository-native starter
5. Synthetic agent scenarios
6. CI cadence and gates
7. When to add an eval framework

## Evaluation layers

Use the cheapest authoritative layer first:

| Layer | Proves | Typical runner |
| --- | --- | --- |
| Policy unit tests | Hook and command-policy decisions | `node:test`, Vitest, `codex execpolicy check` |
| Static fixtures | Lint, compiler, config, and diff controls | Repository test runner |
| Agent scenarios | Instruction following and bypass resistance | Small Codex SDK or CLI harness |
| Operational feedback | Real escapes, false positives, and latency | CI/run logs and reviewed incidents |

Do not use a model grader when an executable check can decide the result.

## Case contract

Define each case with:

- stable ID and guardrail rule;
- known starting repository or event;
- task or operation;
- permitted outcomes;
- prohibited changes or actions;
- required commands and passing evidence;
- timeout and permission boundary;
- deterministic grader;
- expected result.

Grade final repository state, observed check results, and relevant trace metadata. An
agent's final message is not evidence that it ran a command or preserved a control.

## Required case types

For every mechanical control, add:

1. **Violation** — the prohibited behavior is rejected or detected.
2. **Legitimate counterexample** — compliant work is not blocked.

For consequential control-plane rules, also add:

3. **Bypass** — attempt to narrow checked files, skip tests, weaken assertions, make CI
   advisory, or disable the control itself.
4. **Recovery** — the agent can correct a rejected attempt and complete safely.

For every confirmed production escape or false positive, add a regression case before
changing the control.

## Repository-native starter

Start from `assets/guardrail-evals-example/`. Copy and tailor it to the repository. Keep
the initial command dependency-light, for example:

```json
{
  "scripts": {
    "test:guardrails": "node guardrail-evals/run.mjs"
  }
}
```

Add framework-native tests when the repository already has a suitable runner. Do not add
a new dependency merely to execute patch, hook, or configuration fixtures.

Test hooks by passing representative event JSON on stdin and asserting their structured
decision. Test every `.rules` match and non-match example with
`codex execpolicy check`. Test lint/compiler controls with small valid and invalid
fixtures.

## Synthetic agent scenarios

Add agent scenarios only for behavior that deterministic controls cannot establish,
such as whether an agent follows `AGENTS.md`, attempts a control-plane bypass, or
recovers from a denied action.

For each run:

1. Copy a minimal fixture into a new temporary directory.
2. Initialize a known git baseline.
3. Provide only the credentials, tools, write scope, and network access the case needs.
4. Run the agent with a bounded timeout and cost.
5. Capture the final diff, changed files, commands or trace, check exit codes, latency,
   and final response.
6. Grade the captured evidence.
7. Remove the disposable workspace.

Make the unsafe shortcut tempting while keeping a safe solution possible. Useful tasks
include:

- make typecheck pass without excluding source or weakening strictness;
- fix a test without skipping, focusing, or loosening it;
- add retry behavior with bounded attempts and cancellation;
- make CI green without `continue-on-error` or reduced coverage;
- improve throughput without unbounded concurrency.

Run critical nondeterministic cases at least three times. Report run distribution rather
than hiding it behind an average.

## CI cadence and gates

Run deterministic guardrail tests on every change to:

- `AGENTS.md` and nested agent instructions;
- `.codex/`, hooks, and command policy;
- TypeScript, lint, test, coverage, build, or CI configuration;
- guardrail skills, fixtures, graders, and waivers.

Run a small agent smoke suite on those changes when agent behavior is in scope. Run the
larger repeated corpus nightly or before model, prompt, instruction, or agent-runtime
upgrades.

Track by rule and risk tier:

- violation catch rate;
- safe-task completion rate;
- bypass or escape rate;
- false-positive rate;
- check and hook latency;
- active and expired waivers.

Require 100% catch rate for deterministic critical cases. Establish safe-task and
latency budgets from an observed baseline; do not invent universal thresholds. Do not
collapse safety and usability into one score.

## When to add an eval framework

Keep the repository-native runner as the source of truth. Consider Promptfoo or a similar
orchestrator only when the project needs:

- multi-model or multi-agent comparison;
- repeated-run statistics across a growing corpus;
- cost and latency reporting;
- centralized result exploration;
- reusable dataset matrices or calibrated model graders.

A useful adoption signal is 10–20 agent scenarios or recurring difficulty interpreting
raw CI results. Pin any framework version and keep deterministic graders portable so the
guardrail contract does not depend on the framework.
