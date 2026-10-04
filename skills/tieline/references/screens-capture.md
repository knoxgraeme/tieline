# Capturing screens

Read this only when `.tieline/config.json` enables `screens` and the work captures screens:
backfilling a catalog, or keeping one current on a branch. Read
[screens.md](screens.md) first for catalog entries and `shows` links.

## Rules for every scene

A scene is an ordinary Playwright test tagged `@screen:<key>` that ends in
`tielineSnapshot(page, "<key>")` from `tieline/playwright`. Scenes are generated or written by
you, never by a person: do not ask the user to write a test. A page whose default state is the
screen needs no written scene, because Tieline generates it (see below). Write a scene only for
a screen an acceptance criterion shows, or a state that takes steps to reach: dialogs, toasts,
errors, empty and permission states.

- **Capture the real app, never a faked response.** Reach a state with seeded data, or with a
  test-only switch the app honors only in test builds, so the real server code runs. Never use
  `page.route`, `context.route`, `routeFromHAR`, or `routeWebSocket` to answer the app's own
  requests. Blocking third-party requests (analytics, external avatars) for repeatable captures
  is fine. When no real trigger exists, do not capture the state: mark the screen
  `not_captured` with reason `needs-real-trigger` and a `detail` naming what is missing.
- **Where an acceptance criterion shows the screen, the scene is that criterion's test.** Tag it
  `@ac:<criterion key>` beside `@screen:<key>`. Write the Given as setup (seeded data, the login
  for the screen's role), the When as actions, and the Then as Playwright assertions, then
  capture. Add a `tests` link from the criterion to the scene file. A scene without an
  assertion only proves the screen renders.
- **One identity and one viewport per screen key.** A screen that differs by role is a separate
  catalog entry with its own scene.
- **Make it repeatable.** Use role and text locators (`getByRole`, `getByText`), never generated
  class names. Freeze the clock with `page.clock.setFixedTime` when the screen shows a time or
  date. Use fixed seed IDs and timestamps. Mask what cannot be fixed with the `mask` option;
  a masked region is captured as plain grey.
- **Never write capture outputs by hand.** `image.sha256`, the `capture` record, and the
  `.tieline/screen-text/` files are written by `tieline screens capture` only.
- **Use synthetic data only.** Never capture against production or shared staging data.

## Generated page scenes

Set this up once per repository, then keep it current:

1. Set `screens.capture.generated_scenes` in `.tieline/config.json`: `file`, a scene file the
   app's Playwright configuration runs (for example `e2e/pages.generated.screens.ts`), and
   `setup`, the module you write next (for example `e2e/screens.setup.ts`).
2. Write the setup module. It exports `prepare(page, screen)`, which every generated scene calls
   before opening the page: sign in as the screen's role (`screen.applies_to.role`) when the app
   needs it, seed what the page shows with synthetic data, and return the URL to open when the
   route has parameters (`/notes/:noteId` → `/notes/note-1`).
3. Run `tieline screens scenes` after every catalog change and commit the file. Never edit it.
   A page you write a scene for elsewhere leaves the file when it is regenerated, so the two
   never capture the same screen. A page that answers with an error, or whose route keeps a
   parameter, fails its scene rather than capture the wrong thing.

## Backfill: catalog and capture every reachable state

Work one capability at a time; independent capabilities can go to parallel subagents. Keep each
catalog file and scene file to that capability.

1. **Start from the acceptance criteria.** For each criterion whose outcome a user can see:
   catalog each screen that shows it, since one criterion can show several (`kind`, `route`,
   `when`, `applies_to`, key `copy`, and `paths` naming the page or route file that renders it),
   add the criterion's `shows` links, and write each scene as the criterion's test, as above.
2. **Then sweep for states no criterion covers.** Read the page and route files, guards, and
   components for empty, loading, error, permission-denied, dialog, drawer, toast, and redirect
   states. Catalog each one a user can reach and write its scene. Before treating a state as
   uncovered, look for a criterion that already states it, starting with the criteria whose
   `implements` links name the files in the screen's `paths`: link the screen to it, or, when
   the criterion is broader than the state, report the state under step 3. A screen with no
   criterion is valid; most toasts and loading states never have one.
3. **Report hidden states.** An error or permission screen that no criterion describes is
   behavior nobody wrote down. Draft a criterion only when the code states the intent plainly;
   otherwise list the screen under "Needs your review" as a hidden state for a person to judge.
4. **Mark what cannot be captured,** with `not_captured` and the closest reason: `flag-off`,
   `external`, `unreachable`, `needs-real-trigger`, `unstable`, or `other`. Every catalogued
   screen ends captured or marked.
5. **Configure page coverage, and generate page scenes.** Set `screens.capture.pages` to the
   patterns for page files (for example `app/**/page.tsx`, with `!` exclusions for API routes),
   so a page no screen claims is reported. Catalog every page as a `page` screen whose `paths`
   name its file, then generate its scene as above.
6. **Capture in the pinned environment,** the Playwright Docker image the app pins:

   ```sh
   tieline screens capture --all --repeat 3
   ```

   Fix each screen it reports as unstable, or mark it `not_captured` with reason `unstable`.
   Fix every failed scene: a failure writes nothing.
7. **Close every gap the audit names,** then compile:

   ```sh
   tieline screens audit --strict
   tieline contract compile .
   ```

   The strict audit passes only when every screen is captured or marked, every page file is
   claimed, and every criterion that shows a screen has a linked, tagged test.

## Keep screens current on a branch

Run this whenever a change touches what users see, as part of semantic closeout.

1. **Find what changed.** `tieline screens capture --changed --base <base-ref> --dry-run` lists the
   catalogued screens the branch may affect and why. Then read the diff for what no catalog
   entry covers yet: new pages, dialogs, toasts, errors, and changed copy.
2. **Update the catalog and scenes.** Catalog new pages and states, link each to the criterion
   that states it, and write the scenes the rules above call for. A new state no criterion
   states is an `update` or `add` in semantic closeout; run `tieline screens scenes` for new
   pages. When a criterion's behavior changes, change its scene's assertions with it. Remove the
   entries and scenes of screens that no longer exist, and regenerate.
3. **Capture what changed,** in the pinned environment:

   ```sh
   tieline screens capture --changed --base <base-ref>
   tieline screens capture --changed --base <base-ref> --verify
   ```

   The second command is the pull-request check; it must pass before the branch is handed off.
   It verifies every screen instead when a selection rule cannot run. When the repository
   requires it, `tieline screens audit --strict` must pass too.
4. **Compile and commit** the catalog, the ARIA snapshots under `.tieline/screen-text/`, and the
   manifest. Never commit screenshots.

## Report

Close with the shape in [report.md](report.md). Under the review-page line, give counts only:
screens captured, marked not captured by reason, not covered, and unstable. Under "Needs your
review", name hidden states that need a criterion and screens marked `needs-real-trigger`.
