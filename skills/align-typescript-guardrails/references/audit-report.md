# Audit Report Contract

Produce a concise Markdown report in the conversation unless the user requests a file.

## 1. Verdict

Use one:

- **Strong baseline** — most applicable baseline rules are enforced; gaps are localized.
- **Partial baseline** — useful controls exist, but systemic gaps allow inconsistent agent output.
- **Weak baseline** — foundational controls or canonical verification are missing/bypassable.
- **Unknown** — access or runnable evidence is too limited for a responsible verdict.

Add one sentence describing the dominant risk. Do not calculate a single numeric score.

## 2. Existing strengths

List controls worth preserving, with `file:line` or command evidence.

## 3. Rule matrix

| Rule | Alignment | Evidence | Consequence / gap |
|---|---|---|---|
| TG-1 | Aligned / Partial / Missing / N/A / Unknown | `path:line`, command | Short factual statement |

Include all TG-1 through TG-11.

## 4. Prioritized findings

Each finding must contain:

- **ID:** `TG-<rule>-F<number>`
- **Severity:** Critical / High / Medium / Low
- **Evidence:** precise path/line or observed command output
- **Why it matters:** concrete bug, maintenance, or bypass consequence
- **Recommendation:** smallest effective change
- **Migration phase:** reference the recommended sequence
- **Confidence:** High / Medium / Low, lowered when based on pattern evidence

Severity meanings:

- **Critical** — active control bypass or likely severe security/data-loss behavior.
- **High** — systemic absence likely to permit recurring correctness failures.
- **Medium** — meaningful maintainability or limited-scope correctness gap.
- **Low** — local smell or defense-in-depth improvement.

Do not report generated/vendor code unless it changes the project’s control surface.

## 5. Guardrail effectiveness

State:

- the canonical guardrail-test command, if one exists;
- which controls have violating fixtures and legitimate counterexamples;
- whether protected-control bypasses are tested;
- whether agent scenarios inspect final repository state and command evidence;
- known false positives, escapes, latency, and untested controls.

Do not infer effectiveness merely from the presence of configuration or hook files.

## 6. Risk-profile observations

Name sensitive areas found and whether Behavioral/Critical escalation is represented in tests, ownership, or CI. Do not claim repository-host protections are absent merely because their server-side settings are not visible; mark them Unknown.

## 7. Migration sequence

Recommend 2–5 ordered phases. Each phase must:

- have a bounded purpose;
- state expected touched surfaces;
- identify the checks that prove it;
- avoid depending on a later phase for basic correctness.

## 8. Evidence limits

List commands not run, inaccessible external settings, missing dependencies, or uninspected surfaces. Unknown is not failure.
