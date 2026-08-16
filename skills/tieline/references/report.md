# Report completion

Every flow closes with a short report in chat. The report is a pointer to
artifacts, not a transcript of the work: the review page carries the
definitions, the pull request carries the diff and the detailed narrative,
and the report carries only what the user must act on.

## Shape, in order

1. **Deliverable first.** Open with the review page and the command to open
   it, before any findings:

   > **Review the contract:** `open .tieline/review.html`
   > 12 capabilities · 27 Stories · 74 acceptance criteria — all valid,
   > compiled, evidence-linked.

   `tieline contract compile` regenerates the page, and compiling is the
   last authoring step — so the page is current when you report. Never
   describe it as stale and never tell the user to regenerate it by hand.

2. **Needs your review** — at most three bullets naming decisions only a
   human can make: inferred links awaiting promotion to `authored`,
   corrected links worth re-reading, unresolved duplicate candidates. Name
   keys and paths, not definitions.

3. **Caveats** — at most two bullets (for example: coverage maps the
   product spine rather than every file; test links are evidence locators
   and were not executed).

4. **Next step** — one line. The pull request is the proposal and merge is
   the approval.

## Rules

- Fifteen lines or fewer before any code block.
- No inventory of sources read, no command-by-command verification table,
  no capability descriptions, no link-by-link narratives in chat. That
  detail earns its keep in the pull-request body where diff review can use
  it — write it there when opening the PR.
- Never enumerate Stories or acceptance criteria inline; the page carries
  them.
- Disclosed corrections (config fixes, moved links) get one line each in
  "Needs your review", with the full story in the PR body.
