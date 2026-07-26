# `stories.draft.json` — the canonical draft shape

A draft is JSON. Each **story payload is the import contract** (the exact fields
that get written to Postgres) plus a `_review` sidecar used only during review and
stripped on import. This is the same shape `src/authoring/schema.ts` validates, so
write it exactly.

**Shards use this identical shape.** You author one draft per product area at
`.tieline/drafts/<area>.draft.json`, then `tieline merge` folds them into
`.tieline/stories.draft.json`. Anything valid in a shard is valid in the merged
draft — there is no separate shard format.

```jsonc
{
  "version": 1,
  "mode": "backfill",              // "backfill" (whole repo) or "generate" (new work)
  "repo": "my-app",               // stable import source; must match .tieline config
  "product_context_checksum": "<64-character sha256 from .tieline/config.json>",
  "generated_at": "<ISO 8601>",   // optional
  "sections": [
    {
      "section_key": "project-sharing",   // kebab-case, stable id for the product area
      "section_name": "Project Sharing",
      "parent_area": "projects",          // optional
      "actor": "member",                  // optional default actor for the section
      "definition": "Inviting teammates and managing project access.", // optional
      "routes": ["/projects/:id/sharing"] // optional, real route paths
    }
  ],
  "stories": [
    {
      // ── import contract (identical at lock + import time) ──
      "story_key": null,                  // null = mint on import; or an existing key to update
      "section_key": "project-sharing",   // must match a section above (or an existing one)
      "title": "Invite a teammate to a project",
      "story_text": "As a member, I want to invite a teammate so that we can collaborate on a project.",
      "actor": "member",                  // optional
      "status": "production",             // production|qa|in_progress|in_review|idea|feature_request|cancelled (default: idea)
      "entity_slugs": ["project", "invitation", "access-control"], // canonical concepts (reuse the taxonomy vocabulary)
      "code_paths": [                     // REAL files that implement it — the tie to code
        "src/projects/InviteMember.ts",
        "src/projects/projectAccess.ts"
      ],
      // ── review-only sidecar (importer ignores it) ──
      "_review": {
        "id": "d-0001",                   // stable per-story id
        "state": "pending",               // pending|approved|rejected (you leave as pending)
        "comment": "",
        "confidence": 0.85,               // optional 0..1
        "provenance": "src/projects/InviteMember.ts" // optional: where you derived it
      }
    }
  ]
}
```

## Field rules
- **`section_key`** on a story must resolve to a section — either one listed in
  `sections` or an already-existing section in the brain.
- **`status`** — for backfilling *shipped* features use `production`; for planned work
  use `idea` / `in_progress`. See `docs://how-to-query` for the full definitions.
- **`entity_slugs`** — kebab-case canonical concepts. Reuse the existing vocabulary
  from `schema://taxonomy`; only mint a new slug for a genuinely new concept.
- **`code_paths`** — must be files that actually exist in the target repo. Never invent
  paths; use repository-relative paths with no `..`. They power `find_crossover`, and
  Tieline-managed imports reject missing/escaping paths.
- **`story_key`** — leave `null` for new stories (a section-consistent key is minted).
  Supply an existing key only to update that story.
- **`_review.state`** — leave `"pending"`; you approve/reject in the review page.
- **`repo`** — for a Tieline backfill, copy `config.product.repo_name`. It is both the
  idempotent import source and the code-asset repository identity.
- **`product_context_checksum`** — copy `config.context.approved_checksum` after the
  human approves the product profile. Import rejects stale/missing values.
- **`_review.id`** — stable within its own shard; `d-0001` may repeat across shards.
  Merge rewrites it to `<shard>/<id>`, and for a keyless story that merged value becomes
  the `import_ref`, so retrying the same approved draft skips an already committed story.
  Never renumber a shard's ids after review has begun: the id is the identity that carries
  a human's approval, and changing it re-imports the story as a new record.

## Merge rules

`tieline merge` is deterministic and idempotent. It refuses to write when:

- two shards define the same `section_key` with different fields;
- two shards produce the same namespaced `_review.id` or the same explicit `import_ref`;
- shards declare different `repo` values, draft `mode`s, or `product_context_checksum`s;
- a shard is unparseable;
- the merged draft still holds stories no shard produces (pass `--prune` to drop them).

It preserves `_review.state` and `_review.comment` from the previous merged draft, so
re-merging after regenerating one area does not reset the review board. Two stories
sharing a section and title are reported as a warning, never silently combined —
distinct behaviors can legitimately share a title.
