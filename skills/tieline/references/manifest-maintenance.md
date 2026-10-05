# Manifest maintenance modes

Read `manifest_mode` in `.tieline/config.json`. An absent value or `committed`
keeps the existing workflow: compile and commit the byte-current manifest in
feature PRs. Do not switch a repository's policy merely to get a check to pass.

In explicitly configured `post_merge` mode:

- Update authored YAML in the behavior-changing PR and resolve semantic findings
  before handoff. Reconcile still uses Git changes and current authored links.
- Run validate, coverage, reconcile, check, and selected grading before merge.
  Check and grade compile current YAML in memory; grading reads the base's
  authored YAML even if its generated publication is delayed. Missing/broken
  evidence still fails validation. A pending publication is reported explicitly.
- For the review page, use `contract compile . --output <temporary-directory>`
  with a fresh disposable directory and remove that directory afterward. The
  review page is still generated. Do not stage fingerprint-only manifest changes
  from another branch or run a blanket restore over the user's existing work.
- Commit YAML and implementation. A configured integration publisher refreshes
  only `.tieline/manifest/` after merge. A hash refresh neither proves semantic
  support nor resolves any grading finding.

The repository must actually install and monitor a publisher before adopting
this mode. `contract refresh-manifest . --branch <integration-branch>` is an
explicit Git write command for that trusted job; do not run it as PR closeout.
It fetches the current branch, compiles in a disposable worktree, validates,
commits only manifest files, and pushes normally. At most three attempts handle
concurrent merges. Errors remain visible; no force push or branch-policy bypass
is attempted. Automatic publication currently requires standard spec/manifest
paths. The repository's default mode remains unchanged by this feature.

Artifact-first context and topology readers continue to expose the published
snapshot and its freshness; they do not silently compile a newer authority.
Inspect current YAML when reviewing unpublished edits. Topology compilation and
its existing validation/commit requirements are unchanged.
