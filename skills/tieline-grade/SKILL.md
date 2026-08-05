---
name: tieline-grade
description: Judge whether the Tieline acceptance-criterion links touched by a branch are supported by their artifacts, then verify every judgment against a deterministic citation fence. Use when asked to grade, judge, audit, or check the evidence quality of changed Tieline contract links, or to confirm that linked code and tests still support their criteria before a pull request merges.
---

# Tieline grade

Tieline supplies a complete diff-scoped work list and a closed set of legal
citations. Supply the semantic judgment the deterministic tooling cannot make.

## Emit the work list

Use the caller's base ref, or `origin/main` when none was supplied:

```sh
tieline contract grade . --base origin/main --emit-scope --json
```

This command is offline and database-free. Each entry contains:

- `id`, the opaque identity to echo in the verdict;
- the acceptance-criterion ID and exact `acceptance_criterion` text;
- `relation`, `linked_path`, and `link_scope`, describing the contract link;
- `path`, the current artifact to inspect;
- `reason` and `previous_path`, describing the diff; and
- `symbols`, the complete allow-list of citations for that artifact.

An empty scope is a stated answer: report that no changed path is claimed by a
contract evidence link, then stop.

## Judge every entry

Read the artifact and relevant diff for every scope entry. For a rename,
`linked_path` is the exact old-path or new-path target named by the contract;
read the current `path` and use `previous_path` for context. For a deletion,
inspect the diff or base version; its empty symbol list means it cannot receive
`supported`.

Choose exactly one grade per entry:

| Grade | Citation | Reason | Meaning |
| --- | --- | --- | --- |
| `supported` | Required; copy one exact value from `symbols` | Optional | That named symbol serves the whole criterion claim |
| `partial` | Forbidden | Required | The artifact participates, but no emitted symbol supports the whole claim |
| `unsupported` | Forbidden | Required | The artifact does not support the criterion claim |

Apply these rules:

1. Grade the link, not the quality of the code change.
2. Judge direct and `story_fallback` entries separately, even when they name the
   same artifact and criterion.
3. Never invent, shorten, re-case, or borrow a citation. Copy a `kind:name`
   value exactly from that entry's `symbols`.
4. When `symbols` is empty or no listed symbol serves the criterion, use
   `partial` or `unsupported`. Do not stretch the nearest plausible name.
5. Treat `unsupported` as useful evidence, not a failed grading run. Never omit
   a difficult entry; omission is normalized to `unsupported`.

## Show the judgment before verification

Before invoking the fence, print every scope `id`, grade, citation if present,
and reason. The reader must be able to compare the original judgment with any
downgrade the verifier applies.

Write a temporary JSON document with exactly one verdict per entry:

```json
{
  "verdicts": [
    {
      "id": "grade:0123456789abcdef...",
      "grade": "supported",
      "citation": "function:buildGradeScope"
    },
    {
      "id": "grade:fedcba9876543210...",
      "grade": "unsupported",
      "reason": "This module does not implement the criterion."
    }
  ]
}
```

Do not add fields from the scope to a verdict. The opaque `id` binds the verdict
to the current acceptance criterion, relation, linked path, current artifact
path, and link scope.

## Verify and report

Use the same base ref that produced the scope:

```sh
tieline contract grade . --base origin/main --verify <verdicts.json>
```

Add `--strict` only when the caller explicitly requested a gate. Advisory mode
exits zero even with negative findings. Strict mode exits non-zero while any
`unsupported` result remains; `partial` alone does not fail it.

Report:

1. the base ref and scope size;
2. counts for `supported`, `partial`, and `unsupported`;
3. every non-supported result and its reason;
4. every `fabricated_citation` or `missing_verdict` fence cause; and
5. proposed selectors from supported citations for normal contract review.

A fabricated or absent citation is downgraded to `unsupported`. Duplicate or
out-of-scope IDs are rejected as malformed instead of being silently resolved.

Remove the temporary verdict file after reporting. Do not persist grades, call
a model or database from Tieline, or edit contract YAML from this skill. A
supported citation may be proposed as a link `selector`, but only a normal
contract change and pull-request review may accept it.
