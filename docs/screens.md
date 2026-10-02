# Screens

[README](../README.md) · [Setup](setup.md) · [Concepts](concepts.md) · [CLI](cli.md) · [MCP](mcp.md) · [Operations](operations.md)

Screens catalogue the user-visible states of an application — pages, empty states, dialogs,
drawers, toasts, inline errors, error pages, redirects, and loading states — beside the Stories
and acceptance criteria (ACs) they show. A reviewer can then see every screen of the app in one
place, open a Story or AC and see what it looks like, and review copy and UI with the code.

Screens are **optional**. A repository that does not opt in compiles, checks, reviews, and syncs
exactly as it did before the feature existed, and Tieline never reads its screen catalog
directory.

This page describes phase 1: the catalog, `shows` links, `tieline check` validation, the
importer, and the review page. Capturing screenshots, PR summaries of changed screens, and
database sync come later; see [What comes later](#what-comes-later).

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
| `catalog_directory` | `"screens"` | Reviewed catalog YAML, relative to `.tieline/`. Must stay inside `.tieline/` and outside the captures directory, which is git-ignored. |
| `captures_directory` | `"captures"` | Screenshot files, relative to `.tieline/`. May be anywhere inside the repository. |

A malformed block fails loudly rather than silently leaving the feature off. Defaults are applied
when the block is read and are never written back into the file.

## Catalog format

The catalog is repository-owned YAML under `.tieline/screens/`, one file per capability, reviewed
in pull requests like the spec. The importer names new files `<CAPABILITY-KEY>.yaml`.

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
4 MiB, and more than 10,000 screens in total. The catalog directory is walked with bounds — 8
levels deep, 10,000 entries, 1,000 YAML files, 64 MiB — and symbolic links are judged by where they
really lead. Unknown fields are errors.

### Image locators

Screenshots are **never committed by default**. The catalog only points at them:

- `image: { path: notes/list.png }` names a file relative to the captures directory
  (`.tieline/captures/` by default). The path must be relative, use `/`, contain no `.` or `..`
  segments, and end in `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.avif`, or `.svg`.
- `image: { url: https://… }` names an image hosted elsewhere. Only `http` and `https` URLs are
  accepted.
- Either form may add `sha256`, the lowercase hex SHA-256 of the screenshot's bytes. Screenshots
  are not committed, so this digest is what makes a re-captured image visible in the reviewed
  diff. The importer records it for every screenshot it can read.

When the captures directory is inside `.tieline/`, `tieline screens import` creates a
`.gitignore` in it that ignores everything. A captures directory configured elsewhere is left for
the repository to ignore. Every view works when an image is missing: cards and the detail panel
show a placeholder that names the expected file.

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
  valid; the review page counts them instead.
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

## Import

```bash
tieline screens import screens.json [--prune] [--skip-unknown-capabilities] [--dry-run] [--json]
```

The importer turns a JSON file produced by a capture tool, or by hand, into catalog YAML. The file
is either a JSON array of entries or `{ "version": 1, "screens": [ … ] }`. Each entry has the
catalog fields above plus `capability`:

```json
[
  {
    "key": "notes-share-denied",
    "capability": "SHARING",
    "group": "Invitations",
    "title": "Sharing not allowed",
    "route": "/notes/:noteId",
    "kind": "inline-error",
    "when": "A viewer without edit rights presses Share.",
    "applies_to": { "role": ["viewer"] },
    "copy": ["Only editors can share this note"],
    "image": "sharing/share-denied.png"
  }
]
```

`image` accepts a path string (shorthand for `{ "path": … }`), `{ "path": … }`, or
`{ "url": … }`, optionally with a `sha256` the capture tool already knows. A complete synthetic
example ships at [`docs/examples/screens/acme-notes.json`](examples/screens/acme-notes.json).

For every imported screen whose image is a `path` — including a path kept from the catalog because
the input omitted `image` — the importer reads the screenshot from the captures directory and
records its digest, unless the input supplied one. Each distinct file is read once however many
screens name it; each may be at most 25 MiB, and one import reads at most 4 GiB in total. A path
that resolves outside the captures directory (through a symbolic link, for example) stops the
import. Entries skipped for an unknown capability are never read. A screenshot that is not on
this machine is reported, not fatal; if the catalog already records a digest for the same path,
that reviewed digest is kept rather than erased.

The input is treated as untrusted:

- the file may be at most 16 MiB and hold at most 10,000 entries, checked before entries are
  parsed;
- every entry is validated with the catalog's bounds, and every problem is reported with its
  index and key;
- duplicate keys in the file are rejected;
- nothing is written unless the whole import, merged with the existing catalog, validates —
  including every catalog file staying within the 4 MiB limit;
- writing is all-or-nothing across catalog files: every file is staged first, and if replacing one
  fails, the files already replaced are restored (the error names any that could not be, to
  restore from git).

Merging is by key, so re-importing the same file changes nothing and never duplicates an entry.
For an existing key, required fields are replaced, an omitted optional field keeps its catalog
value, and `null` removes it. A key that moves to another capability is moved between files.
Files whose entries did not change are not rewritten, and comments outside replaced entries are
preserved.

Entries are never deleted unless `--prune` is passed. With `--prune`, catalog entries absent from
the file are removed, but only within the capabilities the file names, so importing one area of
an app cannot wipe another.

An entry whose `capability` is not declared in `.tieline/spec/` stops the import, listing the
unknown capabilities, and nothing is written. Add the capability first, or pass
`--skip-unknown-capabilities` to import the rest and report the skipped entries.

The importer refuses to run when screens are not enabled, or when the existing catalog does not
validate. After an import, run `tieline contract compile .`.

## Review page

`tieline contract review` and every `compile` render `.tieline/review.html`, which stays a single
self-contained file. With screens enabled it gains:

- a **Screens** view with every screen grouped by capability and then group. Section and group
  labels stay pinned while scrolling and readable at every zoom level. A zoom control (or `+` and
  `-`) switches between a dense overview with small thumbnails and larger cards.
- filters for kind, each `applies_to` dimension (a screen without that dimension applies to every
  value), and linked or unlinked, plus a search whose matches are listed in the sidebar so they
  are reachable at any zoom level.
- a detail panel with the full image or a placeholder, the metadata, key copy, and the Stories
  and ACs that show the screen. `←`/`→` (or `j`/`k`) step through the current results; `Esc`
  closes it. `#screen/<key>` links to a screen.
- coverage counts: screens shown by Stories, screens with no links, and Stories that show no
  screens.
- on every Story and AC, its linked screens as thumbnail chips that open the detail panel.

Only images scrolled into view are requested, so a catalog of about a thousand screens opens
quickly. The page works without any screenshots present.

### Changes on a branch

```bash
tieline contract review . --base origin/main
```

`--base` compares the working tree with the manifest committed where the branch left a git ref
(`git merge-base <ref> HEAD`), so work that reached the ref afterwards is not shown as the
branch's own. It highlights what the branch changed, offline and without a database:

- a summary above both views lists Stories and ACs that are new, changed (`content`, or `screens`
  when only their `shows` links moved), or removed, and screens that are new, changed (`details`
  for their catalog fields, `image` for a new screenshot digest), or removed;
- changed Stories are badged in the navigation and changed ACs in their Story, while every other
  record stays navigable;
- screen cards and the detail panel carry the same badges, and a **Branch** filter narrows the
  map to new or changed screens.

The page still renders when the working tree does not compile; it then explains that changes are
not shown. A base ref without a compiled manifest reports everything as new. The "before" picture
of a changed screen is not shown locally, because only the current screenshot is on disk.

## Database sync

The database does not store screens yet. `tieline contract sync` removes the screen catalogs and
every `shows` link from the manifest before anything reaches Postgres. Because `shows` links
never contribute to contract hashes, what it syncs is exactly what the same contract synced
before screens existed. When it skipped anything, it says so (`screens_skipped` in JSON). Exact
context reads and MCP tools likewise give the answers they did before; only the content-derived
`manifest_digest` changes, because the reviewed manifest now includes the catalog.

## What comes later

These phases are planned and not implemented. The phase 1 format is designed to accommodate them.
[Capture and hosted review](design/screens-capture-and-hosting.md) proposes how they would work,
for review before anything is built:

1. **Capture.** A `tieline screens capture` command with Playwright as an optional peer
   dependency, driven by the app's own Playwright tests tagged per screen, producing committed
   ARIA snapshots for copy review and capture records (the reserved `capture` field) that `check`
   compares. The reserved `scene` field stays available for other browser drivers.
2. **Pull-request flow.** Re-capture only affected screens, compare with the accepted
   fingerprints on the base branch, flag new routes without screens, and summarize changed, new,
   and removed screens beside changed Stories.
3. **Database and agents.** Sync catalogs, links, and fingerprints to Postgres and add MCP tools
   such as "screens for this AC".
