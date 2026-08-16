# Grade changed evidence

Tieline supplies a complete diff-scoped work list and a closed set of legal
citations. Supply the semantic judgment the deterministic tooling cannot make.

## Emit the work list

Use the caller's base ref when supplied. Otherwise, determine the comparison
ref from repository metadata, preferring the remote-tracking default branch.
Ask the caller only when it cannot be determined; do not assume a branch name.

```sh
tieline contract grade . --base <base-ref> --emit-scope --json
```

This command is offline and database-free. Each entry contains:

- `id`, the opaque identity to echo in the verdict;
- the acceptance-criterion ID and exact `acceptance_criterion` text;
- `relation`, `linked_path`, and `link_scope`, describing the contract link;
- `path`, the current artifact to inspect;
- `reason` and `previous_path`, describing why the link is in scope: a diff
  status when the artifact side moved, or `link_added` / `criterion_changed`
  when the claim side is new or re-worded against the base manifest; and
- `symbols`, the complete, closed allow-list of citations for that artifact;
  and
- `code_evidence`, ephemeral parser-backed facts for deciding whether one of
  those declarations serves the criterion.

A base ref with no contract manifest — the initial contract — puts every link
in scope as `link_added`, so onboarding is graded by this same workflow.

An empty scope is a stated answer: report that no contract link changed
against the base — no claimed artifact moved and no link or criterion is new
or re-worded — then stop.

## Read parser evidence as identity, not judgment

For JavaScript, JSX, TypeScript, TSX, Python, Rust, and SQL source, `code_evidence`
is derived through Tieline's existing Tree-sitter analyzers. Emitting it does
not call a model, network, or database, and neither scope emission nor verdict
verification persists a grade.

Available evidence contains one set of file-wide facts — `status`, `reason`,
`detail`, `language`, `content_hash`, `parser_compatibility`, and `diagnostics`
— followed by bounded facts for each citable declaration. Each declaration
includes its canonical selector, stable symbol identity, native kind, syntax status,
name and body ranges, source snippet, and diagnostics localized to that body.
Do not expect file-wide facts to be repeated inside each symbol.

Treat `symbols` as the authority for citations:

- An explicit contract selector must be an exact canonical parser selector.
  When it resolves uniquely, the evidence and allow-list contain only that
  declaration.
- A selectorless link includes only unique canonical top-level or owner-aware
  declarations. Local variables and names found only in comments are excluded.
- Missing, unreadable, oversized, or unsupported source; invalid, unresolved,
  or ambiguous selectors; incomplete symbol or diagnostic facts; and parser
  recovery that overlaps the selected declaration make evidence unavailable
  and leave `symbols` empty. Unrelated diagnostics do not block a clean exact
  selected declaration, and import/reference truncation alone does not make
  citation evidence incomplete.

The entry ID binds the exact Acceptance Criterion text and stable source/parser
evidence, including the content hash. Re-emit the scope after either the
criterion or source changes; a verdict for the previous ID is intentionally
stale. Human-facing detail and snippet wording are context, not identity.

Parser evidence proves declaration and source identity and currency, not
semantic satisfaction of the Acceptance Criterion. The host agent must still
make that judgment. If evidence is unavailable, or no listed declaration serves
the whole criterion, return `partial` or `unsupported` rather than stretching
the closest symbol.

SQL evidence is limited to conservative top-level table, view, and function
declarations with safely representable names. It does not include SQL object
references or SQL dependency edges; never infer blast-radius coverage from the
presence of a SQL declaration alone.

## Judge every entry

Read the artifact, its `code_evidence`, and relevant diff for every scope entry.
For a rename, `linked_path` is the exact old-path or new-path target named by
the contract; read the current `path` and use `previous_path` for context. For
a deletion, inspect the diff or base version; its empty symbol list means it
cannot receive `supported`. For `link_added` and `criterion_changed`, the
artifact may be untouched by the branch and there may be no diff hunk to lean
on; judge the artifact as it stands against the entry's criterion sentence.

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
3. Never invent, shorten, re-case, or borrow a citation. Copy an exact canonical
   parser selector from that entry's `symbols`.
4. When `symbols` is empty or no listed symbol serves the criterion, use
   `partial` or `unsupported`. Do not stretch the nearest plausible name.
5. Treat `unsupported` as useful evidence, not a failed grading run. Never omit
   a difficult entry; omission is normalized to `unsupported`.

## Dispatch fresh subagents for self-authored or bulk scopes

When the scope contains links authored in this session — onboarding grades the
entire initial contract this way — or is too large to judge in one context, do
not judge the entries yourself. A context holding the rationale that produced
a link cannot judge that link independently; what makes a grade independent is
what the judge cannot see.

1. Group the scope entries by `path`, one batch per artifact.
2. Dispatch one subagent per batch. Give it only the batch's scope entries —
   `id`, `acceptance_criterion`, `relation`, `linked_path`, `path`, `reason`,
   `symbols`, and `code_evidence` — plus the judgment rules above, and have it
   read the artifact and return exactly one verdict per entry. Never pass
   authoring notes, rationale, or surrounding conversation.
3. Collect the returned verdicts into the single verdicts document yourself,
   then verify as below.

The fence extends the subagents no trust: a fabricated citation is downgraded
and an unreturned verdict is normalized to `unsupported` either way. When
grading self-authored links directly instead, disclose in the report that the
grades are author-graded.

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
to the exact current acceptance criterion, relation, linked path, current
artifact path, link scope, and source/parser evidence. Re-emit the scope instead
of reusing verdicts after the criterion or source changes.

## Verify and report

Use the same base ref that produced the scope:

```sh
tieline contract grade . --base <base-ref> --verify <verdicts.json>
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
