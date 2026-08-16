# Codex enforcement examples

Use the smallest layer that can express the rule reliably. Do not install every example
by default.

## Contents

1. [Layer selection](#layer-selection)
2. [Repository instructions](#repository-instructions)
3. [Code review rules](#code-review-rules)
4. [Command execution policy](#command-execution-policy)
5. [Lifecycle hooks](#lifecycle-hooks)
6. [CI and repository-host enforcement](#ci-and-repository-host-enforcement)
7. [End-to-end examples](#end-to-end-examples)
8. [Installation and verification](#installation-and-verification)

## Layer selection

| Need | Primary layer | Do not rely on |
| --- | --- | --- |
| Explain architecture, coding expectations, and commands | `AGENTS.md` | A hook guessing design intent |
| Focus Codex review on semantic invariants | `## Code Review Rules` | Formatting advice or generic style preferences |
| Allow, prompt for, or forbid escalated commands | `.codex/rules/*.rules` | Rules for source-code shape or file contents |
| Intercept an agent action or run a deterministic turn check | Codex hooks | Hooks as the only merge gate |
| Prove a guardrail catches violations without blocking safe work | Repository-native guardrail evals | Configuration presence or agent claims |
| Prove every submitted change passes mechanical checks | CI required checks | Agent-authored completion claims |
| Require an independent approver for critical changes | Repository-host rules and ownership | Self-review by the implementing agent |

Use defense in depth only for consequential failure modes. Duplication is useful when
layers fail differently; it is noise when the same prose is repeated without stronger
enforcement.

## Repository instructions

Start from `assets/AGENTS.guardrails.template.md`. Replace its command placeholders with
commands observed in the repository.

Good:

```md
## Canonical commands

- Fast validation: `pnpm test --filter changed`
- Full required validation: `pnpm check`

## Type and boundary safety

- Parse HTTP, environment, and queue payloads at their entry point. Pass validated
  domain values inward.
- Do not introduce `@ts-ignore`. Use `@ts-expect-error` only with a reason and a test
  that demonstrates the expected compiler error.
```

Why this works:

- It names exact commands.
- It states the invariant and the safe path.
- It assigns semantic expectations to agent guidance and mechanical enforcement to
  repository tools.

Avoid:

```md
- Write clean code.
- Always use best practices.
- Never make mistakes.
- Every function must be under 20 lines.
```

These statements are ambiguous, untestable, or encourage agents to optimize a proxy
instead of preserving behavior.

## Code review rules

Place repository-wide review rules under the exact `## Code Review Rules` heading in the
root `AGENTS.md`. Put service-specific rules in the closest nested `AGENTS.md`.

Good:

```md
## Code Review Rules

### Authorization

- Flag handlers that load or mutate tenant-owned data before checking the caller's
  authority for that tenant.
  Safe path: derive tenant scope from authenticated context and enforce it in the data
  access operation.

### Validation integrity

- Flag changes that make TypeScript, lint, tests, or coverage pass by checking less
  code.
  Safe path: fix the violation or add a narrow, owned, expiring waiver.
```

Use review rules for consequential invariants that need judgment. Include:

- the behavior to flag;
- why it matters when the consequence is not obvious;
- a safe implementation path or valid exception.

Do not use review rules for formatting, import ordering, semicolons, or diagnostics a
deterministic tool can report more reliably.

## Command execution policy

Use project-local `.codex/rules/*.rules` to govern commands Codex requests to run outside
the sandbox. Start from `assets/codex-guardrails-example/.codex/rules/guardrails.rules`.

Example:

```python
prefix_rule(
    pattern = ["git", "reset", "--hard"],
    decision = "forbidden",
    justification = "Preserve user changes. Inspect the diff and use a targeted, recoverable operation.",
    match = ["git reset --hard", "git reset --hard HEAD~1"],
    not_match = ["git reset --soft HEAD~1"],
)

prefix_rule(
    pattern = [["npm", "pnpm"], "publish"],
    decision = "prompt",
    justification = "Publishing is an external production-side effect and requires approval.",
    match = ["npm publish", "pnpm publish --access public"],
    not_match = ["npm pack", "pnpm test"],
)
```

Use:

- `forbidden` when there is a safe alternative and the command should never be needed
  by the agent;
- `prompt` for legitimate but externally consequential operations;
- `allow` sparingly for narrow, repeatedly approved read-only commands.

Do not use `.rules` to detect `@ts-ignore`, validate tests, protect file contents, or
replace the sandbox. Command rules apply to outside-sandbox execution and remain an
experimental Codex surface.

Test each file:

```sh
codex execpolicy check --pretty \
  --rules .codex/rules/guardrails.rules \
  -- git reset --hard
```

Keep `match` and `not_match` examples beside each rule as executable policy examples.

## Lifecycle hooks

Use hooks only when enforcement depends on an agent lifecycle event or tool input,
earlier interception materially reduces risk or wasted work, and the decision is fast
and high confidence. Start from:

- `assets/codex-guardrails-example/.codex/hooks.json`
- `assets/codex-guardrails-example/.codex/hooks/pre-tool-use.mjs`
- `assets/codex-guardrails-example/.codex/hooks/verify-before-stop.mjs`

### PreToolUse

The example inspects added patch lines before `apply_patch` runs. It:

- denies high-confidence bypasses such as new `@ts-ignore` and focused tests;
- adds model-visible context for skipped tests so a legitimate quarantine remains
  possible through the repository's waiver process;
- adds model-visible context when a patch touches a protected control-plane path;
- leaves contextual decisions to review rather than blocking every configuration edit.

Use `PreToolUse` for checks that must happen before side effects. Return
`permissionDecision: "deny"` only for high-confidence violations with an actionable
safe path.

Do not make a regex hook the sole parser for TypeScript semantics. Mirror important
source rules in ESLint or another syntax-aware tool.

### PostToolUse

Use `PostToolUse` for feedback that requires the resulting filesystem or command output:

- scan the resulting diff;
- report generated-file churn;
- detect a new violation baseline;
- remind the agent which expanded checks a control-plane edit requires.

A blocking `PostToolUse` response does not undo the completed action. Use it to force a
correction, not to claim rollback.

### Stop

The example `verify-before-stop.mjs` is intentionally not enabled by the bundled
`hooks.json`. It demonstrates how to run a fast repository check when relevant files
changed. If the check fails, it returns a continuation reason so Codex can fix the
failure before handing off.

Enable it only after measuring the ordinary turn latency and false-positive rate.
Tailor the `CHECK_PROGRAM`, `CHECK_ARGUMENTS`, timeout, and relevant-path filter. Keep
the default Stop-hook check materially faster than the full CI path. Use
`stop_hook_active` to avoid an infinite continuation loop.

A Stop hook can improve early feedback; it is not proof that a change can merge and
must not duplicate an expensive full suite after every turn. `AGENTS.md` and CI remain
the default completion and merge controls.

### Hook limitations

- Project hooks run only in trusted projects.
- Non-managed hooks require review and trust when their definition changes.
- Some specialized tools can bypass the normal local tool-hook path.
- Hooks execute local code and must be reviewed like build scripts.
- Blocking hooks require both violating fixtures and legitimate counterexamples.
- Demote or remove a hook when measured false positives or latency exceed the
  repository's budget.
- The bundled hook commands use POSIX command substitution; provide `commandWindows`
  equivalents when the repository must support Windows hosts.
- Keep output concise and never emit secrets, credentials, or transcript contents.

For organization-wide, non-disableable policy, use managed hooks and requirements rather
than assuming a repository hook cannot be turned off.

## CI and repository-host enforcement

Create one canonical command in `package.json`:

```json
{
  "scripts": {
    "check": "npm run format:check && npm run typecheck && npm run lint && npm test && npm run build"
  }
}
```

Use the repository's actual package manager and existing scripts. Avoid duplicating the
logic in workflow YAML.

Example GitHub Actions job:

```yaml
name: quality

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm run check
```

Then configure the repository host to:

- require the `quality / check` status before merge;
- prevent direct pushes to protected branches;
- require an independent reviewer for critical paths;
- apply ownership to control-plane files where practical.

Workflow YAML alone does not make a status required. Repository-host configuration is
the independent authority.

## End-to-end examples

### An agent adds `@ts-ignore`

1. `AGENTS.md` tells the agent not to introduce it and gives the safe alternative.
2. `PreToolUse` rejects a patch that adds it.
3. Type-aware lint rejects it if the edit arrived through another path.
4. CI runs that lint independently.
5. A review rule flags attempts to disable or narrow the lint control.

`.codex/rules` is not involved because this is a source-content rule, not an
outside-sandbox command decision.

### An agent edits `tsconfig.json` to exclude a failing file

1. `AGENTS.md` identifies compiler configuration as protected control plane.
2. `PreToolUse` adds explicit context that the patch needs rationale and expanded
   verification.
3. CI typechecks the complete intended source surface.
4. The validation-integrity review rule flags reduced coverage.
5. Ownership or branch rules require independent approval.

Do not block every `tsconfig.json` edit; legitimate migrations need a controlled path.

### An agent attempts a destructive command

1. The sandbox contains normal execution.
2. `.codex/rules` forbids `git reset --hard` outside the sandbox and recommends a safe
   alternative.
3. A `PermissionRequest` hook can add organization-specific denial when managed policy
   requires it.
4. `AGENTS.md` explains the preservation expectation but is not the enforcement boundary.

### An agent claims completion without running checks

1. `AGENTS.md` requires observed results from the canonical command.
2. The agent runs the canonical command before handoff.
3. An optional fast Stop hook may catch an omitted check when its measured benefit
   exceeds its latency.
4. CI reruns the required command from a clean environment.
5. Required status checks prevent merge when CI fails or never ran.

## Installation and verification

When migration includes Codex-specific controls:

1. Merge the tailored AGENTS template with existing instructions.
2. Copy only the needed `.codex` examples.
3. Tailor protected paths, commands, and package manager.
4. Syntax-check every hook script and parse `hooks.json`.
5. Run the bundled hook tests and add repository-specific violation and counterexample
   fixtures.
6. Run the bundled command-policy tests and add repository-specific match and non-match
   cases.
7. Run the repository-native guardrail suite, including legitimate counterexamples.
8. Use `/hooks` to inspect and trust the project hook definitions.
9. Run the canonical check directly.
10. Confirm CI invokes the same underlying command.
11. Report repository-host protections that still require an authorized human or admin.

Never silently install hooks, command policy, or repository-host settings during an
audit-only request.
