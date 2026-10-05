# Record review separately from compilation

A `compiled_content_hash` records whole-file contents at compilation. Legacy
`reviewed_content_hash` is the same baseline under its deprecated name. Neither
proves review. Refreshing these hashes cannot resolve a semantic finding.

When the authorized workflow includes a commit or PR, finish implementation,
rule corrections, grading and tests before committing. After the final commit:

```sh
tieline contract closeout . --base <PR-target-ref> --head HEAD --emit-scope --json
```

This reads immutable Git objects, not the worktree or generated manifest. It
compares the target/head merge base with head, using both revisions' authored
rules and links. Removed rules/links remain visible. Config changes conservatively
include all rules. It records full target, merge-base and head commit IDs.
Uncommitted changes are excluded: inspect `git status` before using the report as
handoff evidence. Read the reviewed evidence with `git show <head>:<path>` and
the emitted merge-base/head diff if the checkout differs from those revisions.
For an uncommitted-only task, report that the commit-bound record
is pending; do not create a commit merely to satisfy this workflow.

Create a temporary JSON report outside the reviewed tree, for example in ignored
`.context/closeout.json`. Copy `binding` exactly from the scope. For each affected
AC, record one disposition; related ACs may share an explanation:

```json
{
  "schema_version": 1,
  "binding": { "repository": "<key>", "base_commit": "<full SHA>", "merge_base_commit": "<full SHA>", "head_commit": "<full SHA>", "scope_sha256": "<emitted digest>" },
  "dispositions": [{
    "criteria": ["AC-CHECKOUT-001"],
    "disposition": "still_valid",
    "reason": "The copy changed; the confirmation guard and its regression test still enforce the rule.",
    "changed_paths": []
  }]
}
```

- `still_valid`: explain why the changed implementation preserves the rule.
- `updated`: explain the corrected rule/implementation and cite at least one
  repository-relative path from `changed_paths` in the emitted scope. Added,
  removed or reworded claims require this disposition or `unresolved`.
- `unresolved`: state the missing evidence or decision. Do not rewrite the rule
  or select a different disposition merely to make the check pass.

```sh
tieline contract closeout . --base <PR-target-ref> --head HEAD --verify .context/closeout.json --json
```

Verification recomputes the scope. Stale bindings, duplicate/unknown ACs and
invalid citations fail; missing or unresolved dispositions exit nonzero. An
unresolved report can be complete while not ready. Reasons still need semantic
review: this command checks completeness, not truth, test execution, grader
independence, or human approval. `unmapped_changed_paths` are outside this
completeness check; retain the ordinary behavior-cluster review for those paths.

Include the verified JSON in the PR body in a fenced `json` block labeled
`Tieline closeout`, alongside actual tests and unresolved findings. For a
commit-only task, provide the external report location at handoff. Do not commit
the report into its own reviewed revision: that would invalidate its binding.
Any later commit or target-ref change requires re-emission and verification;
reassess affected explanations instead of blindly replacing commit IDs.

For CI adoption, retrieve the report from the PR and run verification against
trusted event-provided target/head revisions with the trusted installed CLI.
Do not take the expected revisions from the submitted report itself. The command
is available to CI, but it does not install a required branch-protection check.
