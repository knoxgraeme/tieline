# Screens

[README](../README.md) · [Setup](setup.md) · [Concepts](concepts.md) · [CLI](cli.md) · [MCP](mcp.md) · [Operations](operations.md)

Screens catalogue the user-visible states of an application — pages, empty states, dialogs,
drawers, toasts, inline errors, error pages, redirects, and loading states — beside the Stories
and acceptance criteria (ACs) they show. A reviewer can then see every screen of the app in one
place, open a Story or AC and see what it looks like, and review copy and UI with the code.

Screens are **optional**. A repository that does not opt in compiles, checks, reviews, and syncs
exactly as it did before the feature existed, and Tieline never reads its screen catalog
directory.

This page describes phase 1: the catalog, `shows` links, and their compile, check, and sync
behavior. Capturing screenshots, PR summaries of changed screens, and database sync come later;
see [What comes later](#what-comes-later).

## Opt in

Add a `screens` block to `.tieline/config.json`:

```json
{
  "screens": { "enabled": true }
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | required | `true` turns the feature on. `false`, or no block at all, leaves it off. |
| `catalog_directory` | `"screens"` | Reviewed catalog YAML, relative to `.tieline/`. Must stay inside `.tieline/`. |
| `captures_directory` | `"captures"` | Screenshot files, relative to `.tieline/`. May be anywhere inside the repository. |

A malformed block fails loudly rather than silently leaving the feature off. Defaults are applied
when the block is read and are never written back into the file.

## Catalog format

The catalog is repository-owned YAML under `.tieline/screens/`, one file per capability, reviewed
in pull requests like the spec. Name each file after its capability key, for example
`SHARING.yaml`.

```yaml
version: 1
capability: SHARING            # must be a capability declared in .tieline/spec/
screens:
  - key: notes-share-denied    # stable identifier, unique across the whole catalog
    title: Sharing not allowed
    group: Invitations         # optional grouping within the capability
    route: /notes/:noteId      # route or location
    kind: inline-error
    when: A viewer without edit rights presses Share.
    applies_to:                # optional; the same applicability schema as Stories and ACs
      role: [viewer]
    copy:                      # optional key visible copy
      - Only editors can share this note
    image:                     # optional image locator
      path: sharing/share-denied.png
```

| Field | Required | Bound | Notes |
| --- | --- | --- | --- |
| `key` | yes | 160 chars | Letters, digits, `.`, `_`, `-`; starts with a letter or digit. |
| `title` | yes | 200 chars, one line | |
| `group` | no | 120 chars, one line | Screens without a group are shown as "Ungrouped". |
| `route` | yes | 500 chars, one line | A URL path pattern, or a short location such as `global toast region`. |
| `kind` | yes | | `page`, `state`, `dialog`, `drawer`, `toast`, `inline-error`, `error-page`, `redirect`, `loading`. |
| `when` | yes | 500 chars | A short description of what makes the screen appear. |
| `applies_to` | no | 16 dimensions, 32 values each, 120 chars each | Absent means the screen applies to everyone. |
| `copy` | no | 50 items, 500 chars each | Key visible text, in display order. |
| `image` | no | | Either `path` or `url`; see below. |
| `scene` | reserved | | Reserved for the script that reaches the screen (phase 2). Must be omitted. |
| `capture` | reserved | | Reserved for capture fingerprints (phase 2). Must be omitted. |

Validation also rejects duplicate screen keys anywhere in the catalog, two catalog files for one
capability, a catalog for a capability the spec does not declare, catalog files larger than
4 MiB, and more than 10,000 screens in total. Unknown fields are errors.

### Image locators

Screenshots are **never committed by default**. The catalog only points at them:

- `image: { path: notes/list.png }` names a file relative to the captures directory
  (`.tieline/captures/` by default). The path must be relative, use `/`, contain no `.` or `..`
  segments, and end in `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.avif`, or `.svg`.
- `image: { url: https://… }` names an image hosted elsewhere. Only `http` and `https` URLs are
  accepted.

Keep the captures directory git-ignored. Nothing in Tieline requires an image to exist, and a
missing image is never an error.

## `shows` links

Stories and ACs link to screens under their existing `links`:

```yaml
acceptance_criteria:
  - key: SHARING-001-AC2
    criterion: A viewer must not be able to share a note.
    links:
      - relation: shows
        provenance: authored
        target: { kind: screen, key: notes-share-denied }
```

- A link to an unknown screen key fails `tieline contract validate` and `compile`, the same way a
  link to a missing file stops compilation.
- A `shows` link while screens are not enabled is an error that says how to opt in.
- A screen may have no links. Most toasts and loading states never map to an AC, and that is
  valid.
- One screen may be shown by several Stories or ACs, in any capability.
- Prefer the most specific AC. A Story-level `shows` link is a coarse fallback.

`shows` links are kept apart from evidence links. They never contribute to a Story or AC
`contract_hash`, freshness, coverage, grading, or the code blast radius, so adding one does not
create a new database revision of the AC.

## Compile and check

`tieline contract compile` writes each capability's catalog into that capability's manifest file
under `screen_catalog`, with screens sorted by key and a `contract_hash` per screen (the image
locator is deliberately excluded from that hash). `shows` links are written under `shows` on the
Story or AC, sorted by target. Both are omitted entirely when absent, so a repository without
screens produces byte-identical manifests.

When screens are enabled, `tieline check`:

- validates the working-tree catalog and fails (`exit_reason: invalid_screen_catalog`) when it
  does not validate;
- fails like a broken link (`exit_reason: broken_links`, downgradable with
  `--no-fail-on-broken`) when a committed `shows` link names a screen the catalog no longer
  contains;
- adds a `screens` section to its JSON output and a `broken screen link(s)=N` count to its text
  summary.

When screens are disabled none of this runs, and the output is unchanged.

## Database sync

The database does not store screens yet. `tieline contract sync` removes the screen catalogs and
every `shows` link from the manifest before anything reaches Postgres. Because `shows` links
never contribute to contract hashes, what it syncs is exactly what the same contract synced
before screens existed. When it skipped anything, it says so (`screens_skipped` in JSON). Exact
context reads and MCP tools likewise give the answers they did before; only the content-derived
`manifest_digest` changes, because the reviewed manifest now includes the catalog.

## What comes later

These phases are planned and not implemented. The phase 1 format is designed to accommodate them:

1. **Capture.** A `tieline screens capture` command with an optional browser-automation peer
   dependency, driven by repository-supplied scene scripts (the reserved `scene` field), producing
   committed text snapshots for copy review and image fingerprints (the reserved `capture` field)
   that `check` compares.
2. **Pull-request flow.** Re-capture only affected screens, compare with the accepted
   fingerprints on the base branch, flag new routes without screens, and summarize changed, new,
   and removed screens beside changed Stories.
3. **Database and agents.** Sync catalogs, links, and fingerprints to Postgres and add MCP tools
   such as "screens for this AC".
