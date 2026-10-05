# Authoring screens

Read this only when `.tieline/config.json` has `"screens": { "enabled": true }`. Without that
block, never create `.tieline/screens/` files or `shows` links: validation rejects `shows` links
in a repository that has not opted in.

## Catalog entries

The catalog is reviewed YAML under the configured catalog directory (`.tieline/screens/` by
default), one file per capability:

```yaml
version: 1
capability: SHARING
screens:
  - key: notes-share-denied
    title: Sharing not allowed
    group: Invitations
    route: /notes/:noteId
    kind: inline-error
    when: A viewer without edit rights presses Share.
    applies_to:
      role: [viewer]
    copy:
      - Only editors can share this note
    image:
      path: sharing/share-denied.png
```

- `capability` must name a capability already declared under `.tieline/spec/`.
- `key` is a stable identifier, unique across the whole catalog. Describe the state, not the
  implementation (`notes-share-denied`, not `ShareButtonErrorBanner`). Never reuse a key for a
  different screen.
- `kind` is one of `page`, `state`, `dialog`, `drawer`, `toast`, `inline-error`, `error-page`,
  `redirect`, `loading`. Catalog each distinct user-visible state separately, including empty,
  loading, and error states.
- `when` states the trigger in one short sentence a reviewer can reproduce.
- `copy` holds only key visible text, verbatim. Do not paraphrase.
- `applies_to` reuses the Story/AC applicability dimensions (for example `role`, `plan`); omit
  it when the screen applies to everyone.
- `paths` is optional: the page or route files that render the screen, as repository-relative
  patterns. Name the screen's own page file; shared components need no listing.
- `image` is optional: `{ path }` relative to the git-ignored captures directory, or
  `{ url }` with `http(s)`, plus an optional `sha256` of the screenshot. Never commit screenshot
  files, never invent an image path that a capture did not produce, and never type a digest by
  hand — the importer or `tieline screens capture` records it from the file.
- `capture` is the capture record, written only by `tieline screens capture`. Never write it by
  hand.
- `not_captured` (`reason` and `detail`) says why a screen is deliberately not captured; see
  [screens-capture.md](screens-capture.md).
- `scene` is reserved and must be omitted.

To capture screens, or to backfill or update a catalog, read
[screens-capture.md](screens-capture.md).

Prefer `tieline screens import <file>` when a capture tool or a list of screens already exists;
it validates the whole input, merges by key, and never deletes without `--prune`. Read the
command's output before compiling: it names unknown capabilities and skipped entries.

## `shows` links

Link a Story or AC to the screens that show its behavior, under its existing `links`:

```yaml
links:
  - relation: shows
    provenance: authored
    target: { kind: screen, key: notes-share-denied }
```

- Put the link on the most specific AC whose outcome the screen makes visible. Use a Story-level
  link only when no single AC fits.
- Link only screens a reviewer would look at to judge that AC. Do not link every screen on the
  same route.
- Leave toasts, loading states, and other screens without a matching AC unlinked. An unlinked
  screen is valid; the review page reports it as coverage, not as an error.
- `shows` links are not evidence of implementation. Keep code and test links as they are.

## Validate

```sh
tieline contract validate .
tieline contract compile .
tieline check --base <base-ref>
```

Unknown screen keys, invalid catalog entries, and working-tree links to screens the catalog
does not contain fail.
Point reviewers at `.tieline/review.html`, whose Screens view shows the catalog, its coverage,
and each Story's and AC's linked screens. For branch work, render it with
`tieline contract review . --base <base-ref>` so the new, changed, and removed Stories, ACs, and
screens are highlighted.

## Hosted screens

When `screens.hosted` is enabled, CI publishes each pull request's screens to the team's hosted
site, and sync on `main` publishes `main`; nothing in this workflow changes. To set up the
bucket and its credentials, read [hosted-screens.md](hosted-screens.md).
