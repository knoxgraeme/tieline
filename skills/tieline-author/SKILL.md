---
name: tieline-author
description: Semantically onboard an initialized Tieline repository, or author, plan, implement, and reconcile Tieline User Stories and Acceptance Criteria. Use after `tieline init` to inspect configured context and create the first repository-specific capabilities, Stories, and ACs; also use to refine planning Stories/ACs or Backlog Items in Postgres, materialize planning records into repository YAML, connect branch work to product behavior, resolve likely duplicate definitions, or prepare a semantic contract change for pull-request review.
---

# Tieline author

Treat the pull request as the proposal and merge as approval. Never create a
separate draft, proposal, or semantic-approval record.

Read [contract.md](references/contract.md) before editing contract YAML.

When invoked after `tieline init` as an installed skill or MCP prompt, start
with semantic onboarding below. The CLI has already captured deterministic
setup; do not ask the user to repeat product, repository, source-root, or
context answers that are present in `.tieline/config.json`.

## Orient to this repository

1. Read `.tieline/config.json` before searching or authoring.
2. Use each configured context source:
   - Treat inline `description` content as product framing.
   - Read `local` locations from the repository.
   - Fetch a `website` only when its `allow_external_fetch` value is `true`.
3. Report which sources informed the work and which were unavailable. A source
   locator is not evidence that its content was actually inspected.
4. Review `repository.source_roots` and confirm they describe the code whose
   mapping coverage will be measured.

When `.tieline/spec/` has no YAML, perform semantic onboarding before normal
reconciliation. Discover repository-specific capabilities from configured
context, README and product docs, public code entry points, and tests. Author
the capability boundaries and first Stories/ACs, then summarize them for normal
pull-request review; never create generic starter capabilities merely to make
the directory non-empty.

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
- For work coordination without a defined behavior, create or update a Backlog
  Item. It remains a DB record and never moves into YAML.

An Observation is evidence, not a required starting point. A flow may begin
from an Observation, Backlog Item, planning Story, existing AC, or branch diff.

## Search before creating

1. Run `tieline status --json` and inspect its capability flags.
2. Search local YAML and the manifest for stable IDs, aliases, and related
   criteria.
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

9. Summarize the semantic diff, impacted ACs, freshness warnings, coverage
   delta, likely duplicates, unresolved conflicts, and unmapped source files.

Do not mutate a repository-owned Story through MCP. Change its YAML on the
branch and let normal PR review accept or reject it.

## Completion

Leave the branch with valid YAML and a byte-current `.tieline/manifest/`.
Warnings are review input, not a second gate. Do not claim that linked tests ran;
test links are framework-agnostic evidence locators only.
