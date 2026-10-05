# Grade complete acceptance criteria

Use this workflow for implementation closeout. For an explicitly requested
link-by-link review, use [grading.md](grading.md). Both are advisory unless the
caller explicitly requests strict mode.

## Select and emit

```sh
tieline contract grade . --base <base-ref> --unit criterion --scope claims --emit-scope --json
```

`claims` selects added or changed criterion text, scenarios, AC/Story/capability
applicability, Story lifecycle, and local or external code/test links (including removals).
Every selected AC includes all its local implementation/test evidence, even
files unchanged in the branch. Rules with no links remain in scope.
`implementation_only_criteria` and `removed_criteria` are explicit reconciliation
work, not silently accepted behavior. Record whether each still matches intended
behavior; correct inaccurate rules and investigate uncertainty. Use
`--scope impacted` when permissions/security change, behavior is uncertain, or
the user requests broader grading. It also selects ACs behind changed files.

An empty scope means no selected claims changed. It does not certify the product.
Scope is bounded to 1,000 ACs and 5,000 links; split larger changes.

## Judge each AC and its links

Give a fresh subagent each complete entry (batch small related ACs if useful),
these rules, and access to the named artifacts and diff. Do not share authoring
rationale or conversation. Bound simultaneous agents to available capacity.
Read the criterion, scenarios, applicability, and all linked artifacts. Parser
facts identify legal citations, not semantic truth or successful test execution.

- `supported`: the combined evidence supports the entire claimed outcome.
  Cite one or more exact `(link_id, selector)` pairs from `evidence[].id` and
  that link's `symbols`. No individual symbol needs to implement the whole AC.
- `partial`: inspected evidence supports only part of the actual outcome;
  explain the missing behavior, not merely that several files participate.
- `unsupported`: inspected evidence contradicts or does not establish the claim.
- `inconclusive`: unavailable evidence, external dependencies, or parser limits
  prevent a sound decision. State exactly what is missing.

When the inspected evidence is demonstrably irrelevant (for example, prose
linked as executable implementation), use `unsupported` and report the bad link.
When relevant code delegates the claimed behavior to unavailable evidence, use
`inconclusive`; absence of that evidence does not prove the behavior is wrong.

Also inspect whether each link is relevant. Record every wrong or overstated
local link in `link_findings`, even if the AC has enough other evidence to be
supported. A relevant implementation file remains the right locator when its
behavior is buggy or incomplete: report that defect in the AC grade and reason,
not as a wrong-link finding. Reserve link findings for irrelevant, obsolete, or
misidentified evidence, including prose mislabeled as an implementation.
External links are displayed for context but have no locally verified
citations; explain external evidence limitations in the verdict reason.
Do not treat a missing parser citation as proof of a product defect.

Print each original judgment, citations, and reasons, then write a temporary
verdict document. Every verdict requires a substantive `reason`:

```json
{
  "verdicts": [{
    "id": "criterion-grade:<emitted digest>",
    "grade": "supported",
    "reason": "The confirmation handler supplies approval and checkout rejects its absence.",
    "citations": [
      { "link_id": "grade:<emitted link digest>", "selector": "function:confirm" },
      { "link_id": "grade:<other emitted link digest>", "selector": "function:checkout" }
    ],
    "link_findings": []
  }]
}
```

Non-supported verdicts omit `citations`. `link_findings` contains
`{ "link_id": "grade:<emitted link digest>", "reason": "..." }` records.

## Verify and act

```sh
tieline contract grade . --base <base-ref> --unit criterion --scope claims --verify <verdicts.json> --json
```

Use the same scope choice and base for emission and verification. IDs bind the
claim's behavior and all local evidence; after edits re-emit and reassess changed
IDs. Unchanged IDs may retain their verdict within this closeout. Do not persist
grades as accepted contract state.

Missing judgments and fabricated citations become unsupported; duplicate or
out-of-scope IDs are rejected. Optional `--strict` also fails for inconclusive
judgments or link findings; partial alone remains advisory. Report those findings
honestly rather than choosing a different grade to obtain a pass.

For implementation, return findings to the implementing agent and follow
[the resolution loop](grading.md#resolve-findings-during-implementation). For a
grading-only request, report and stop. Keep the grader read-only in both cases.
Remove temporary verdict files after reporting.

For an implementation flow with authorized commits, preserve review dispositions
separately through [commit-bound closeout](closeout.md). Verified grading is input
to that record; neither a grade nor a compiled fingerprint substitutes for it.
