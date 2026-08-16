---
name: align-typescript-guardrails
description: Audit, test, or incrementally migrate TypeScript/Node.js repositories toward a compact, tested code-assurance baseline for agent-generated code. Use when asked to assess TypeScript maintainability, establish coding guardrails, evaluate whether agents can bypass rules, add guardrail evals, measure hook false positives, harden an agent workflow, add bounded async/error/type/test controls, prevent agents from weakening checks, or migrate an existing JavaScript/TypeScript project without a disruptive rewrite.
---

# Align TypeScript Guardrails

Create locally analyzable code and independently verifiable changes without imposing safety-critical ceremony on ordinary work.

## Resolve the mode

Choose one mode from the request:

- **Audit** — inspect and report; do not modify repository files.
- **Migrate** — audit first, then implement a phased ratchet and verify each phase.
- **Evaluate** — run existing guardrail tests and bounded synthetic agent scenarios, then
  report effectiveness; do not create or repair evals unless the request authorizes edits.
- **Explain** — answer from `references/rules.md` without inspecting or changing a repository.

If audit versus migration is ambiguous, default to audit. Never infer permission to migrate from a request to review, assess, or recommend.

## Load only the required references

- Always read `references/rules.md`.
- For audit mode, also read `references/audit-report.md`.
- For migrate mode, also read `references/migration-playbook.md`.
- For evaluate mode, and for migrations that add or change enforcement, also read
  `references/guardrail-evals.md`.
- For Codex-specific enforcement or examples, also read
  `references/codex-enforcement-examples.md`.
- When creating or revising repository agent instructions, use
  `assets/AGENTS.guardrails.template.md`. Merge applicable sections into existing
  instructions; replace every placeholder and do not overwrite repository-specific
  guidance.

## Keep enforcement surfaces distinct

- Use `AGENTS.md` for durable repository instructions and scoped code-review guidance.
- Use TypeScript, lint, tests, and CI for deterministic code checks.
- Use repository-native guardrail evals to prove that controls catch violations without
  blocking legitimate work.
- Use Codex lifecycle hooks only for fast, high-confidence checks where earlier
  interception materially reduces risk or wasted work.
- Use Codex `.rules` files only for command execution policy; do not treat them as
  general coding rules.
- Consult current Codex documentation before generating hooks or `.rules` because their
  schemas and maturity may change.
- Use `assets/codex-guardrails-example/` as a tailored starting point, not as a bundle to
  install unchanged.

## Establish repository facts

From the repository root:

1. Read active `AGENTS.md`/`CLAUDE.md` instructions.
2. Inspect `package.json`, lockfiles, Node/package-manager pins, all relevant `tsconfig`
   files, lint/format configs, test configs, source layout, CI workflows, agent
   instructions, hooks, command rules, and existing guardrail evals.
3. Identify the project’s canonical install, typecheck, lint, test, build, and full-check commands. Do not invent replacements before understanding existing conventions.
4. Run the deterministic evidence collector:

   ```sh
   node <skill-dir>/scripts/collect-signals.mjs <repository-root>
   ```

5. Treat its output as search leads, never as a compliance verdict. Verify material findings in the referenced files.
6. Inspect representative code at trust boundaries, async/resource loops, error boundaries, state transitions, and high-risk paths. Do not judge alignment from configuration files alone.
7. Do not install dependencies during an audit. Run existing non-mutating checks when dependencies are already available and the commands are bounded.

## Audit workflow

Evaluate every applicable rule in `references/rules.md` as:

- **Aligned** — enforced and supported by representative implementation evidence.
- **Partial** — useful control exists but has meaningful gaps or uncovered surfaces.
- **Missing** — no effective control or a routinely bypassed control.
- **Not applicable** — explain why.
- **Unknown** — evidence could not be obtained; never convert unknown into missing.

Follow the output contract in `references/audit-report.md`.

Audit behavior, not aesthetics:

- Prefer direct `file:line` evidence.
- Separate configuration presence from enforcement and enforcement from demonstrated behavior.
- Report high-leverage systemic gaps before individual code smells.
- Do not assign a single numeric quality score.
- Identify existing strengths so migration preserves them.
- Detect control-plane bypasses: disabled rules, excluded source surfaces, broad suppressions, skipped tests, warning-only CI, or checks that agents need not run.
- Classify findings by actual consequence, not by which tool reported them.

End audit mode after the report and recommended migration sequence. Do not edit.

## Evaluation workflow

Follow `references/guardrail-evals.md`.

1. Run existing deterministic hook, command-policy, lint/configuration, and fixture
   tests before any model-driven scenario.
2. Verify that each blocking control has both a violating case and a legitimate
   counterexample.
3. Run synthetic agent scenarios only in disposable workspaces with bounded cost,
   time, permissions, credentials, and network access.
4. Grade the final repository state, executed checks, and relevant trace metadata.
   Do not grade only the agent's final explanation.
5. Report catch rate, safe-task completion, bypasses, false positives, and latency by
   rule and risk tier. Do not collapse them into one score.
6. Treat missing or inaccessible execution evidence as Unknown.

Do not install Promptfoo or another evaluation framework merely to run an initial
evaluation. Use an existing project-native runner first.

## Migration workflow

Follow `references/migration-playbook.md`.

Core constraints:

1. Audit before editing and record the current passing/failing baseline.
2. Preserve existing behavior unless the user explicitly requested behavior changes.
3. Prefer stable, low-opinion controls. Start with TypeScript strictness and type-aware correctness linting; do not enable every available rule.
4. Ratchet legacy debt. Block new violations before attempting broad cleanup.
5. Make small coherent phases and run the narrowest relevant checks after each phase.
6. Fix root causes. Do not make diagnostics disappear through `any`, double casts, blanket ignores, deleted tests, weaker assertions, longer timeouts, or warning-only CI.
7. Do not add runtime validation to already trusted internal values indiscriminately. Validate at trust boundaries and protect state transitions with invariants.
8. Do not apply hard line-count or complexity limits as universal correctness gates. Use them as review triggers and tune them to the repository.
9. Protect control files in-repository where possible. Recommend repository-host settings such as required reviews separately; do not mutate external settings without explicit authorization.
10. When a control cannot be adopted, create a narrow waiver with rule, scope, rationale, risk, mitigation, owner, and expiry. Never silently omit it.
11. When agent instructions are in scope, tailor
    `assets/AGENTS.guardrails.template.md` to observed repository commands and risks.
    Preserve existing instructions, delete inapplicable rules, and leave no unresolved
    placeholders.
12. Add a violating fixture and a legitimate counterexample for every new or changed
    mechanical guardrail. Add bypass cases for controls protecting critical surfaces.
13. Start with repository-native deterministic tests. Add synthetic agent runs only
    where they test behavior that static fixtures cannot prove.
14. When Codex-specific enforcement is in scope, select only the necessary examples from
    `assets/codex-guardrails-example/`. Test hook inputs and outputs, validate every
    command-rule decision, and keep CI as the independent merge gate.

After migration, rerun the collector and all relevant existing checks. Report:

- controls added or strengthened;
- source fixes required by those controls;
- tests/evidence run;
- remaining gaps and waivers;
- any checks not run and why;
- suggested next ratchet.

## Risk-based escalation

Use the change profiles in `references/rules.md`.

- Apply the baseline to every change.
- Add behavioral and off-nominal evidence for product behavior.
- Require independent human approval and rollback/safe-forward evidence for critical changes.

An implementing agent must not be the only authority that approves a critical change or its waiver.

## Preserve validation integrity

Never “solve” the skill by weakening its evidence:

- no new broad `eslint-disable`, `@ts-ignore`, unsafe `any`, or unexplained double casts;
- no deleting, skipping, focusing, or loosening tests to obtain green status;
- no excluding failing files from TypeScript, lint, tests, coverage, or CI without a documented waiver;
- no changing a required check to advisory;
- no claiming a command passed unless its output was observed in this run;
- no treating a linked test or configured tool as proof that it executed successfully.

If the requested migration conflicts with these constraints, stop and explain the conflict.
