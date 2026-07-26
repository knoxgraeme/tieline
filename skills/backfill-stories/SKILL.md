---
name: backfill-stories
description: >-
  Initialize a Tieline workspace, build a human-approved company/product profile,
  generate user stories from an existing codebase, review them, and load the
  approved map into the user-story knowledge brain. Triggers: "backfill user
  stories", "map this codebase", "onboard this repository", "tieline init".
---

# Backfill user stories from a codebase

Turn a repository into a reviewed product map in five phases:
**init → understand the product → map the code (one area per shard, then merge) →
review → import**.

The `tieline` CLI owns deterministic setup, workspace files, approval checks, and
status. You own semantic work: synthesize context, interpret the code, and propose
stories. The human approves product meaning and story meaning before persistence.

## Phase 0 — Initialize or resume

From the target repository, look for `.tieline/config.json`.

- If it exists, run `tieline status .` and resume the reported next action. Do not
  overwrite human edits.
- If it does not exist, ask for or infer the product name and run:

  ```sh
  tieline init . --product "Product name"
  ```

  The CLI asks for a stable repository identity, optional marketing/help/docs
  sources, source roots, and confirmation. In a non-interactive run, supply the
  values explicitly with `--yes`.

All generated artifacts live in `.tieline/`:

- `config.json` — repository identity, context sources, source roots, ignores
- `product-context.md` — combined company/product profile
- `coverage.json` — evidence of what was and was not examined
- `drafts/<area>.draft.json` — one draft per product area; the unit you actually write
- `stories.draft.json` — canonical reviewable draft, produced by `tieline merge`
- `AGENT_HANDOFF.md` — portable instructions for any coding agent

Never write database secrets into `.tieline/`; credentials remain environment variables.

## Phase 1 — Understand the product

Read `.tieline/config.json`, `.tieline/AGENT_HANDOFF.md`, repository README/docs, and
every user-approved context source.

Complete `.tieline/product-context.md` with:

- what the product does;
- primary users and actors;
- main user jobs/outcomes;
- canonical vocabulary;
- known user-recognizable product areas;
- boundaries/non-goals;
- source provenance, assumptions, and unresolved questions.

Marketing establishes language, customers, and intended outcomes. It is not evidence
that a feature is shipped. Repository evidence decides whether behavior is production.

Present the profile to the human. Do not approve it yourself. After explicit approval,
run `tieline context approve . --yes`. This stores a checksum; later edits make the
approval stale and require another review.

## Phase 2 — Orient to existing knowledge

If the brain already has data, reuse its vocabulary:

- Read `schema://taxonomy` for section keys, actors, statuses, and entity slugs; or
  call `query_stories(group_by='section')`.
- Prefer existing `section_key`, `entity_slug`, and actor terms.
- Before proposing each story, call `find_related(scope='stories')`; prefer updating
  a real match over creating a duplicate.

If `DATABASE_URL` is unavailable, continue offline and record `dedup_checked: false`
and `taxonomy_reused: false` in coverage.

## Phase 3 — Analyze and draft

Analyze only the configured source roots and honor the ignore list.

1. **Sections are product areas.** Infer them from routes, pages, navigation, and
   feature boundaries. Use stable kebab-case keys and real routes.
2. **Stories are user-facing behaviors.** Write one story per thing a user can do,
   at the altitude a PM, support agent, and engineer would recognize.
3. Keep implementation mechanisms out of story prose. Put them in entities and code paths.
4. Use only repository-relative code paths that exist. Never invent a path.
5. Set `production` only for shipped behavior supported by code evidence. Marketing-only
   behavior is unverified or an idea, not a production backfill.

**Work one product area at a time.** Write each area into its own shard,
`.tieline/drafts/<area>.draft.json`, and save it before starting the next area. A
shard is a checkpoint: an interrupted session keeps every area already written,
and regenerating one area never touches the others. Each shard follows
`reference/draft-schema.md` and must include:

- `repo` equal to `config.product.repo_name`;
- `product_context_checksum` equal to `config.context.approved_checksum`;
- `_review.id` values that are stable and unique *within that shard* — `d-0001` is
  fine in every shard, because merge namespaces them as `<shard>/<id>`;
- `_review.state: "pending"` initially;
- concrete provenance for each story.

Then fold the shards into the canonical draft:

```sh
tieline merge .
```

Merge preserves review decisions already recorded, and refuses to write when two
shards define the same section differently, collide on a review id or `import_ref`,
or disagree on the product-context checksum. Rerun it after regenerating any shard.
It reports same-section duplicate titles as warnings rather than merging them away.

Update `.tieline/coverage.json` with examined areas/routes, proposed story count,
mapped and uncertain areas, unmapped candidates, invalid paths, and taxonomy/dedup state.
Set `status: "complete"` and copy the approved `product_context_checksum` when the
analysis pass is finished. Empty areas are better than invented stories.

## Phase 4 — Human story review

Do not import until the human confirms the set.

**Conversational review (default):** present a compact table of section, title,
status, confidence, and code paths. Apply edits to the draft and mark each record
`approved` or `rejected`.

**Local review page (optional):** run:

```sh
tieline review /absolute/path/to/repo/.tieline/stories.draft.json
```

The page autosaves edits and can import approved stories directly when
`DATABASE_URL_INGEST` is configured, or export a locked payload.

Run `tieline status .` at any point to see context freshness, coverage, story counts,
import state, and the next action.

## Phase 5 — Import

```sh
tieline import /absolute/path/to/repo/.tieline/stories.draft.json --batch-size 50
```

The Tieline-managed import requires explicit `DATABASE_URL_INGEST` and rejects:

- unapproved or stale product context;
- drafts generated from a different context checksum;
- a conflicting repository identity;
- missing/incomplete coverage for the approved context;
- missing, absolute, or escaping code paths.

Approved stories are embedded, imported in bounded atomic batches, linked to entities
and code assets, and recorded as revisions/events. Stable draft `_review.id` values become
import refs, so retries skip already committed records instead of duplicating them. The
import report is written next to the draft.

## Quality bar

- Product context was explicitly approved before mapping.
- Real code paths only; every stored path exists inside the target repository.
- Consistent actors, section keys, and entity vocabulary.
- One story equals one user-facing behavior.
- Search dedup was performed, or coverage explicitly records why it was not.
- Coverage makes unmapped and uncertain areas visible.
- Every shard merged cleanly; no collision was resolved by deleting a story.
- Human approval precedes every initial backfill import.
