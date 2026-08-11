---
name: tieline
description: Semantically onboard an initialized Tieline repository, or author, plan, implement, grade, and reconcile Tieline User Stories and Acceptance Criteria. Use after `tieline init` to inspect configured context and create the first repository-specific capabilities, Stories, and ACs; also use to refine planning Stories/ACs or Backlog Items in Postgres, materialize planning records into repository YAML, connect branch work to product behavior, grade changed contract evidence, resolve likely duplicate definitions, or prepare a semantic contract change for pull-request review.
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
anything the repository can answer.

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
Warnings are review input, not a second gate. Do not claim that linked tests ran;
test links are framework-agnostic evidence locators only.

Present contract content by pointing at `.tieline/review.html` (regenerated by
every compile) rather than pasting Story or AC definitions into chat. Close
every flow with the report shape in [report.md](references/report.md): the
review page leads, at most three review bullets and two caveats follow, and
the detailed narrative goes into the pull-request body instead of chat.
