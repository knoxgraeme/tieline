---
name: tieline
description: Semantically onboard an initialized Tieline repository, or author, plan, implement, grade, and reconcile Tieline User Stories and Acceptance Criteria. Use after `tieline init` to inspect configured context and create the first repository-specific capabilities, Stories, and ACs. Use before handing off implementation, committing, pushing, or opening or updating a pull request so final branch work receives semantic closeout. Also use to refine planning Stories/ACs or Backlog Items in Postgres, materialize planning records into repository YAML, connect branch work to product behavior, grade changed contract evidence, resolve likely duplicate definitions, or prepare a semantic contract change for pull-request review.
---

# Tieline

Treat the pull request as the proposal and merge as approval. Never create a
separate draft, proposal, or semantic-approval record.

Read [contract.md](references/contract.md) before editing contract YAML.

If `.tieline/config.json` does not exist, bootstrap deterministic setup first:
run `npx -y tieline@latest init . --yes --agent <this-agent-id>` and continue
once it succeeds. Never wait for tieline MCP tools mid-session — registered
servers load when the client starts its next session, and every workflow here
also works through the CLI (`npx -y tieline <command>`).

When invoked after `tieline init` as an installed skill or MCP prompt, inspect
`.tieline/spec/`. If it has no YAML, read
[onboarding.md](references/onboarding.md) and perform semantic onboarding
before choosing a normal authoring flow. Onboarding starts with a
conversation, not with repository reading: after the silent checks that
choose this flow (`.tieline/spec/` and `.tieline/config.json`), the first
visible action is the orientation and setup exchange in onboarding.md — the
"Orient to this repository" steps below run after that conversation ends,
not before it. Init records auto-detected values, so
verify rather than interrogate: confirm detected identity with the user and
correct `.tieline/config.json` when a detection is wrong, but never ask for
anything the repository can answer. Treat the initial contract as a
repository-wide semantic baseline, not a narrow seed that merely makes the
workspace non-empty.

## Orient to this repository

1. Read `.tieline/config.json` before searching or authoring.
2. Use each configured context source:
   - Treat inline `description` content as product framing.
   - Read `local` locations from the repository.
   - Fetch a `website` only when its `allow_external_fetch` value is `true`.
3. Report which sources informed the work and which were unavailable. A source
   locator is not evidence that its content was actually inspected.
4. Review `repository.source_roots` against the discovered code. Treat these
   paths as mapping-coverage scope rather than product context, correct obvious
   detection gaps before claiming coverage, and disclose any correction.

## Choose the flow

- For ideation or planning, use MCP writes when planning writes are available.
  Keep Stories/ACs in Postgres with `authority=planning` and
  `lifecycle=backlog`. Do not modify the worktree. If planning writes are
  unavailable, disclose that the planning record cannot yet be persisted.
- For implementation, materialize a selected planning Story/AC or author the
  repository definition directly under `.tieline/spec/`.
- For reconciliation, compare the branch, accepted YAML, planning candidates,
  and `list_handoff_conflicts`; then update YAML and its manifest. Present both
  the merged repository definition and later planning snapshot before choosing
  what to preserve.
- For grading an existing contract change, read
  [grading.md](references/grading.md), run that workflow without editing
  contract YAML, report its results, and stop. Do not enter the authoring,
  materialization, or reconciliation steps below.
- For work coordination without a defined behavior, create or update a Backlog
  Item. It remains a DB record and never moves into YAML.

An Observation is evidence, not a required starting point. A flow may begin
from an Observation, Backlog Item, planning Story, existing AC, or branch diff.
The remaining sections apply only to onboarding, planning, implementation, and
reconciliation; the grading-only flow returns after its report.

## Close out branch semantics before handoff

For any flow that changes implementation or the repository-owned contract, run
semantic closeout against the final branch diff before handing off
implementation, committing, pushing, or opening or updating a pull request.
Project installation of this skill, or explicit invocation through the
equivalent MCP prompt, is the trigger; do not add a separate
`.tieline/config.json` existence check before deciding whether closeout applies.
Planning-only and grading-only flows keep their earlier stopping points.

1. Determine the comparison base as described under **Materialize or reconcile
   repository behavior**, then inspect the tracked diff, the reconcile output,
   and the untracked-file inventory from
   `git ls-files --others --exclude-standard`. Because the tracked diff and
   reconcile output omit untracked paths, read every relevant untracked file and
   fold its observable behavior into a behavior cluster below, or retain an
   exclusion reason. Group related changes by coherent, externally observable
   behavior rather than by file, package, or internal implementation layer.
2. Classify every changed behavior cluster as exactly one of:
   - `covered`: an accepted AC already expresses the behavior accurately and its
     evidence links still identify the right implementation or tests.
   - `exclude`: the cluster is internal-only, generated, test-only, or otherwise
     does not change observable product behavior. Retain the reason in the
     closeout report; do not create an AC merely to eliminate an unmapped file.
   - `update`: an accepted Story, AC, scenario, rationale, or evidence link must
     change to remain truthful.
   - `add`: distinct observable behavior is not represented by an accepted AC.
   - `unresolved`: a material ambiguity prevents an accurate decision. Surface
     the exact ambiguity instead of silently choosing another disposition.
3. For every `update` or `add`, edit the repository YAML and compile its manifest
   directly. Do not post a comment or request separate approval first. The
   pull-request diff is the review surface and merge is approval.
4. Complete the validation, coverage, reconciliation, check, and grading steps
   below. Report the disposition of each cluster, including exclusions and any
   unresolved item.
5. When the active workflow already includes a commit, push, or pull-request
   update, include closeout artifacts in the same pending commit. If the
   implementation was already committed, create a focused local follow-up
   commit. Push that follow-up without asking again only when the active workflow
   explicitly includes push or opening or updating a pull request, or when a
   pull request for the branch is already open and the active request is not
   commit-only. A commit-only request always overrides the open-pull-request
   exception: stop after the local follow-up commit and do not push. This
   authority covers only the in-scope contract and generated artifacts.
6. If the implementation diff changes after closeout, run closeout again against
   the new final diff before handoff or publication.

## Read exact intent before discovery

When the task already names a repository path, canonical selector, or exact
Acceptance Criterion stable ID, read its accepted context before editing or
semantic search:

- For a known code or test locator, call `get_asset_intent_context` with its
  repository-relative `path` and optional `kind` and `selector`, or run
  `tieline contract context --path <path> [--kind code|test] [--selector <selector>] --json`.
- For a known AC ID, call `get_acceptance_criterion_context` with `stable_id`,
  or run `tieline contract context --ac <stable-id> --json`.
- Use `get_path_criteria` only when the compatibility path-to-AC list is enough.
  Prefer asset context when selector identity or associated code/tests matter.

These two primitive reads answer from the compiled manifest without Postgres,
embeddings, or network access. They return the repository key and
content-derived manifest digest that identify the reviewed contract. Asset
context reports `has_context`, `no_criteria`, or `not_found`; AC context returns
the exact product ancestry, criterion, scenarios, direct links, and
Story-fallback links or an explicit `not_found` result for an unknown ID.

Treat associated code and tests as a bounded **intent neighborhood** and shared
AC links as **contract coupling**. The result stops after one AC-mediated hop;
it is not a runtime dependency graph or comprehensive blast radius. Keep
provenance, link scope, freshness, locator resolution, and semantic support as
separate assurance facts. `resolved` and current are structural observations,
while `unresolved`, `not_checked`, broken causes, and unknown states remain
explicit. `not_assessed` is not semantic proof, and a linked test is an evidence
locator, not a claim that it ran or passed.

Only use `find_related` or `search_knowledge` for discovery when the exact path,
selector, or AC ID is unknown, or when the task explicitly needs broader
semantic candidates.

## Trace derived code relationships when needed

After reading exact authored intent, use derived topology only when the task
needs dependency direction or potential change propagation:

- After selected source or resolver changes, explicitly run
  `tieline code compile . --json`, review and commit
  `.tieline/topology/graph.json`, then
  use `tieline code validate . --json` for a parser-free freshness check.
- Call `trace_code_dependencies`, or run
  `tieline code trace --path <path> [--selector <selector>] --direction dependencies|dependents --json`,
  for one exact locator.
- Call `analyze_code_blast_radius`, or run
  `tieline code blast-radius --base <base-ref> --json`, for advisory AC-aware
  impact. Its default direction is `dependents`.
- Keep the default limits unless the task needs a smaller result. Defaults are
  depth 4, 500 nodes, 2,000 edges/frontiers, and 100 paths; hard maxima are
  depth 8, 1,000 nodes, 4,000 edges/frontiers, and 200 paths.

Local topology is language-aware for JavaScript/JSX/TypeScript/TSX, Python,
Rust, and conservative SQL declarations, and works without Postgres. SQL
object references do not yet produce dependency edges. Trace and blast select an existing workspace
or exact-commit artifact; they never parse, compile, write, or silently repair
it. The explicit compiler parses an immutable source snapshot and resolves only
supported static project-local module forms. Treat `ambiguous`,
`unresolved`, `external`, dynamic, glob, generated, and unsupported outcomes as
frontiers to investigate, never as license to guess an edge. Hosted dependency
trace may use a compatible complete Postgres generation; hosted topology
without a readable authored manifest cannot perform the AC join.

Preserve the result vocabulary exactly: code reachability is
`derived_code_dependency`; accepted links are `contract_coupling`; impact is
only `may_be_impacted`; semantic support stays `not_assessed`. Sharing an AC
never creates a code edge. Neither parser evidence, a current hash, a resolved
selector, nor topology proves that implementation satisfies the AC or that a
test ran. Repository YAML and its compiled manifest remain business-intent
authority; committed topology is a derived traversal projection, while hosted
Postgres generations preserve the richer relational projection of accepted
`main`. Local compilation and reads never publish to Postgres; a protected
merge-only publisher must own that boundary when hosted publication is enabled.

## Search before creating

1. Run `tieline status --json` and inspect its capability flags.
2. Search local YAML and the manifest for stable IDs, aliases, and related
   criteria. If an exact locator or AC ID emerges, use its exact context before
   continuing discovery.
3. If semantic matching is unavailable, continue with the local search and
   state that org-wide duplicate checking was not performed. Otherwise call
   `find_related` with `profile=discovery` and the intended behavior.
4. Prefer, in order: reuse the existing record; add an alias; update or
   supersede the existing record; create a new stable ID.
5. Never treat a semantic score as confirmation. Present credible matches and
   honor the user's reuse or explicit-continue choice.

## Shape planning work

- Use `create_planning_story` or `update_planning_story` for desired behavior.
- Use `create_backlog_item`, `update_backlog_item`, and
  `set_backlog_item_links` for optional consolidated work.
- Before updating a Backlog Item or replacing its links, call
  `get_backlog_item`. Use its current revision and preserve every existing link
  the user did not explicitly remove.
- Write familiar Story language: actor, goal, and benefit are separate fields.
- Write each AC as one observable outcome using
  `<subject> must <outcome> [when <condition>]`.
- Allow incomplete planning records when information is genuinely unresolved.
  Complete every required field before materialization.

## Materialize or reconcile repository behavior

1. Determine an available comparison base from repository metadata, preferring
   the remote-tracking default branch. Ask the user only if repository metadata
   cannot identify a usable base. Replace `<base-ref>` below with the selected
   reference.
2. Run `tieline contract reconcile . --base <base-ref> --json` and work from its
   output. `claimed_changes` names the ACs whose evidence moved; re-read those
   definitions first. `unclaimed_changes` names changed source files no link
   targets; treat each as a question about whether behavior changed, not as a
   missing AC. Refactors, renames, and internal restructuring belong there and
   need no new AC. Never author an AC to drive that count to zero.
   `excluded_changes` records paths the command set aside and why. Inspect the
   diff itself for anything the output leaves unresolved.
3. Call `list_handoff_conflicts` for the Story being materialized or
   reconciled. Resolve the later planning definition explicitly rather than
   silently overwriting it.
4. When materializing a planning Story, preserve its Story and AC stable IDs
   and add `planning_origin.record_id` plus its current `revision`.
5. Put implementation, test, and help locators on the most specific AC. Use a
   Story-level link only as a shared or coarse fallback.
6. Preserve Backlog Item and Observation IDs only as `motivated_by` pointers;
   never copy their payloads into YAML.
7. Write strict YAML under `.tieline/spec/`.
8. Run:

   ```sh
   tieline contract validate .
   tieline contract compile .
   tieline contract coverage .
   tieline contract reconcile . --base <base-ref>
   tieline check --base <base-ref>
   ```

9. Read [grading.md](references/grading.md) and grade the contract change. The
   grading scope covers both sides of every link — artifacts the branch moved,
   and links or criteria the branch added or re-worded against unchanged code.
   You authored these links, so dispatch fresh subagents batched by artifact
   path and give them only the emitted scope entries, never your authoring
   rationale.
10. Summarize the semantic diff, impacted ACs, grade findings, freshness
    warnings, coverage delta, likely duplicates, unresolved conflicts, and
    unmapped source files.

Do not mutate a repository-owned Story through MCP. Change its YAML on the
branch and let normal PR review accept or reject it.

## Completion

Leave the branch with valid YAML and a byte-current `.tieline/manifest/`.
For implementation and repository-contract flows, completion also requires a
semantic-closeout disposition for every changed behavior cluster against the
final diff; later implementation changes invalidate the earlier closeout.
Warnings are review input, not a second gate. Do not claim that linked tests ran;
test links are framework-agnostic evidence locators only.

Present contract content by pointing at `.tieline/review.html` (regenerated by
every compile) rather than pasting Story or AC definitions into chat. Close
every flow with the report shape in [report.md](references/report.md): the
review page leads, at most three review bullets and two caveats follow, and
the detailed narrative goes into the pull-request body instead of chat.
