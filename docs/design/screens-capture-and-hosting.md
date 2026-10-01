# Screens: capture and hosted review (design proposal)

[Screens](../screens.md) · **Capture and hosted review (proposal)**

**Status: proposal for review. Nothing on this page is implemented.** What exists today — the
catalog, `shows` links, `tieline screens import`, the Screens view, and
`tieline contract review --base` — is documented in [Screens](../screens.md). This page proposes
how screenshots get produced for any app, and how a team can review them together, so that the
later phases can be reviewed before any database, role, or hosting change is built.

## Goals

- **Any web app can adopt capture** without bespoke tooling, starting from the tests it already
  has.
- **One coverage capture, then incremental captures.** An initial capture records every screen;
  each pull request re-captures only the screens it may have changed.
- **Offline stays first-class.** A developer can capture and review their own branch locally,
  with no database, hosting, or network.
- **Hosted review is optional.** One deployed site shows `main` and every open pull request or
  branch. Pull-request comments link into it, and reviewers never need screenshots on their own
  machine.
- **Nothing is public by default.** Tieline never implements login; the host's access control sits
  in front.
- **Host-neutral.** Netlify is the first host. Others are small adapters.

Not in scope: native mobile or desktop capture, a pixel-diff UI, or committing screenshots to
git.

## 1. Capture for any app

Capture is **Playwright-native**. A screen's scene is an ordinary Playwright test, and Tieline adds
a small fixture and a reporter. An app that already has Playwright end-to-end tests keeps its
configuration as it is; nothing here is a new test framework.

### What Playwright already provides, and what Tieline adds

| Need | Playwright standard, reused as is | Tieline adds |
| --- | --- | --- |
| Start the app | `webServer` in `playwright.config.ts` | — |
| Log in once per role | A setup project that saves a `storageState` per role | Maps each `applies_to.role` value to its project |
| Stable rendering | `use: { viewport, locale, timezoneId, reducedMotion }`, `page.clock`, screenshot `mask` and `animations: "disabled"`, the official Playwright Docker image | Records the environment with each capture |
| Reach a screen | A test that navigates and interacts | Tags it `@screen:<key>` |
| Run only some screens | `--grep` over test tags | Computes the tags for the screens a branch may affect |
| Text snapshot | `locator.ariaSnapshot()` | Writes it beside the catalog |
| Output | Reporters | A reporter that writes screenshots, ARIA snapshots, and an import file |

### Scenes are Playwright tests

```ts
// e2e/screens/sharing.screens.ts
import { test } from "@playwright/test";
import { tielineSnapshot } from "tieline/playwright";

test.use({ storageState: "playwright/.auth/viewer.json" });

test("share denied", { tag: "@screen:notes-share-denied" }, async ({ page }) => {
  await page.goto("/notes/note-seed-1");
  await page.getByRole("button", { name: "Share" }).click();
  await page.getByText("Only editors can share this note").waitFor();
  await tielineSnapshot(page, "notes-share-denied");
});
```

The tag links the catalog entry to its test, so Playwright scenes need no `scene` field in the
catalog; that reserved field stays available for other browser drivers. One test may capture
several screens, and existing end-to-end tests can capture screens by adding a single call.
`tielineSnapshot` waits for the page to settle, takes the screenshot with the configured masks,
records the ARIA snapshot, and hands both to the reporter. It never asserts, so capturing can
never fail an app's test suite.

Plain pages need no hand-written test: a `screensFromCatalog()` helper generates one navigation
test per `page` entry, filling route parameters from a small fixtures map.

### Three ways to adopt, lowest effort first

1. **Add `tielineSnapshot` calls to existing Playwright tests.** Navigation, seeding, and logins are
   already maintained there.
2. **Write `*.screens.ts` files** for states the existing suite does not reach.
3. **Let the Tieline skill draft those files** from the app's routes and the catalog, for a human
   to review, the same way it drafts the initial contract.

`@playwright/test` stays an optional peer dependency that the app already has or installs; Tieline
loads it only when capture runs. An app that uses another browser driver can keep producing the
import file itself, as it can today.

### What each capture records

| Output | Where | Purpose |
| --- | --- | --- |
| Screenshot | Captures directory, git-ignored | What reviewers look at |
| Image `sha256` | Catalog, committed | Puts a visual change into the reviewed diff (exists today) |
| ARIA snapshot | `.tieline/screens/text/<key>.yml`, **committed** | Copy and structure changes reviewed line by line in the diff, independent of pixels |
| Capture record (reserved `capture` field) | Catalog, committed | Browser version, container image, and viewport, so digests are only ever compared like for like |

## 2. Initial coverage capture, then every pull request

**Initial coverage capture.** `tieline screens capture --all` runs once on `main`. It records
every screen's digest and ARIA snapshot and establishes the accepted state.

**Every pull request.** `tieline screens capture --changed --base origin/main` re-captures only
the screens a branch may have affected, chosen by these rules in order:

1. screens whose catalog entry or scene test changed in the diff;
2. screens shown by acceptance criteria whose linked code or tests changed (contract coupling);
3. screens owned by changed files, through optional path globs per catalog group;
4. screens owned by dependents of changed files, through the existing code-topology blast radius,
   so a change to a shared component reaches the pages that use it;
5. everything, when a configured global path changed (theme, layout, global styles, translations).

Every selected screen reports why it was selected, and the selection becomes a `--grep` over
screen tags. Screens that were not selected keep `main`'s digest, and a re-captured screen whose
digest and ARIA snapshot both equal `main`'s drops out of the review.

**No schedule; a manual audit instead.** `tieline screens audit` finds what incremental capture
cannot:

- **Missing**, without capturing anything: catalog entries with no screenshot digest, no ARIA
  snapshot, or no `@screen` test. It is cheap enough to also run as a `check` warning.
- **Drift**, with `--capture`: re-captures every screen and reports those whose digest or ARIA
  snapshot differs from `main`'s accepted state — changes the selection rules missed. Run it before
  a release or after a large refactor; its results land in a normal pull request. It plays the
  role Argos calls Monitoring mode and Playwright's advice to run the full suite after
  `--only-changed`: selection is a heuristic, so a full pass is available on demand.

Every comparison starts from where the branch left `main` (`git merge-base`), so screens that
reached `main` after the branch point are never reported as the branch's changes.

## 3. How a change is detected

- **Exact.** The screenshot's SHA-256. Any pixel difference counts as a change. That is only
  reliable when the rendering environment is identical: the same browser build, fonts, graphics
  path, and pixel density. The same page rendered on a laptop and on a Linux CI runner differs at
  the pixel level, so comparing them reports false changes.
- **Fuzzy.** Compare the two images pixel by pixel and call it a change only above a tolerance
  (Playwright's `threshold`, `maxDiffPixels`, and `maxDiffPixelRatio`). It hides rendering noise,
  can also hide a genuinely tiny change, and needs the previous image's bytes rather than just its
  digest.

Proposal: always record exact digests, and make the captures that count — accepted on `main` and
published for review — in the official Playwright Docker image at a pinned version, in CI and
optionally locally, which keeps exact digests stable. The committed ARIA snapshot catches copy and
structure changes regardless of pixels. The capture record names the environment, and digests from
different environments are never compared; a mismatch is reported as "re-capture in the pinned
environment" rather than as a change. Fuzzy comparison is added only if pinned captures still
prove noisy.

## 4. Offline mode (the default)

```bash
tieline screens capture --changed --base origin/main
tieline contract review . --base origin/main
```

`capture` runs the app's Playwright project for the selected screens and imports the result.
Everything stays on the developer's machine. The review page badges new, changed, and removed
Stories, ACs, and screens (this part exists today), and the ARIA snapshot diff shows copy changes.
Only the current screenshot is on disk, so the "before" picture is not shown locally.

## 5. Hosted mode (optional)

### Shape

One deployed site per repository shows `main` by default and any pull request or branch through a
query parameter, with the same deep links the local page uses:
`https://<site>/?ref=pr-123#screen/notes-share-denied`. The whole contract stays navigable from
any ref, and the changes against `main` are highlighted as they are locally. There is no deploy
per pull request; the site is redeployed only when Tieline itself is upgraded.

### Data flow

| When | Who | Does |
| --- | --- | --- |
| Pull request push | CI | Incremental capture, import, then `tieline screens publish --ref pr-123`: uploads only images the store lacks, records the pull request's snapshot, and posts or updates one PR comment with a summary and a link |
| Merge to `main` | CI, the existing post-merge sync | `tieline contract sync` records the accepted screen state from `main`, exactly as it does for Stories and ACs |
| Once, then on demand | A developer or CI on `main` | `capture --all` for the initial coverage, and `audit --capture` when drift is suspected; both publish like any other change |

### Storage

- **Images** are content-addressed (`sha256/<digest>.<ext>`), immutable, and insert-only, in an
  S3-compatible bucket. Neon Object Storage is the first target, because Neon is the hosted
  Postgres Tieline provisions; Cloudflare R2, AWS S3, and Supabase Storage use the same
  interface. A Postgres-backed image store is a fallback for teams without a bucket.
- **Provisioning picks a region that has Object Storage.** Neon Object Storage is currently
  available in four AWS regions (`aws-us-east-2`, `aws-us-east-1`, `aws-eu-central-1`,
  `aws-ap-southeast-1`). When hosted screens are enabled, the provisioning flow creates the Neon
  project in one of them, asking which when the team's location does not decide it. An existing
  project in another region keeps working for the contract, and its images go to another
  S3-compatible bucket instead. This changes the provisioning skill reference, an agent-instruction
  surface, so it is reviewed with the hosted work.
- **Metadata** lives in Postgres, as a projection of git: the catalog in git stays the source of
  truth for which digest a screen has at a commit.

Proposed tables (one new migration):

| Table | Holds | Written by |
| --- | --- | --- |
| `screen_images` | digest, byte size, content type, dimensions, storage key, first seen | capture publisher |
| `screen_snapshots` | repository, ref kind (`pr` or `branch`), ref name, head commit, pull-request number, compiled screens and changes, opened and closed times | capture publisher |
| `screens`, `screen_links` | accepted screen state and `shows` links from `main` | repository sync |
| `contract_change_events` | entity, kind of change, commit, pull request — recorded only when a hash changes | repository sync |

### Roles and isolation

| Role | May |
| --- | --- |
| `tieline_reader` | Read snapshots, accepted state, and image metadata (the hosted site) |
| `tieline_capture_publisher` (new) | Insert images and snapshots for non-`main` refs; nothing else |
| `tieline_repository_sync` | Write accepted screen state, from `main` only, checkpointed by commit |

The bucket mirrors this: the publisher can create objects but never overwrite or delete them,
the site can only read, and a separate retention job can only delete unreferenced objects.

Pull requests are isolated from `main` by construction. Accepted state changes only through the
post-merge sync of `main`. Pull-request snapshots live in their own table and cannot touch
accepted rows. Images are addressed by digest and never overwritten, so a pull request can never
replace a picture `main` uses; on merge nothing is copied, because the sync simply records which
digests `main` now references.

### Retention

- **Each image is stored once.** Images are addressed by digest, so when a pull request merges,
  `main`'s accepted state simply references the digests the pull request already uploaded.
  Nothing is copied.
- **Open pull requests keep their latest snapshot.** Screenshots from earlier pushes of the same
  pull request that nothing references any more are removed on its next publish.
- **Closed pull requests:** `retention.closed_pull_requests` is `delete` by default — the
  snapshot, and any images only it referenced, are removed when the pull request closes — or a
  number of days to keep them.
- **`main`:** accepted images are always kept. Images `main` has since replaced are kept according
  to `retention.main_history`: `all` (every earlier version), `{ "keep_changes": N }` (the last N
  replaced versions of each screen), or `none`. The proposed default is `{ "keep_changes": 10 }`,
  enough for "last changed by" history to show recent before-and-after pictures.

### The hosted site, independent of host

| Layer | Contents | Host-specific |
| --- | --- | --- |
| Core handler (in `tieline`) | A standard `Request` → `Response` handler that renders the same review page for a ref, with images at `/images/<digest>`, and serves images | No |
| Stores | Snapshot reads through a store interface (Postgres adapter); images through an image-store interface (S3-compatible adapter first) | No |
| Host adapter | A few lines wrapping the core handler, a configuration template, and docs. Netlify first, via `tieline hosted init --host netlify` | Yes |

Because the site holds no data, it deploys through the host's normal Git integration. Adding
Vercel, Cloudflare, or a plain Node server is a new adapter, template, and docs page; the core,
stores, and publishing do not change. Hosts differ in function response size and time limits, so
an adapter may hand large images to the image store with a very short-lived link, issued only
after the host's access check, instead of streaming them.

### Access control

Each host's own feature: Netlify "Private" project visibility (viewers log in to Netlify and must
be invited; Free, Personal, and Pro), a shared password (Pro, optionally previews only), or team
SSO (Enterprise). Tieline documents the setup per host and never implements login. To confirm
before building: that Netlify's protection also covers the site's functions.

### Pull-request comment

CI posts or updates one comment per pull request: "Stories changed: 2 · Screens changed 3, new 1,
removed 1", with a link into the hosted site at that ref. Inline thumbnails are off by default,
because they would need publicly fetchable image URLs.

## 6. History: "last changed by"

Every Story, AC, and screen has a `contract_hash`, and screens also have an image digest. A commit
changed an entity when either differs from its parent commit's manifest. The commit maps to a pull
request through the squash-merge title (`… (#123)`) or the host's API.

- **Offline:** the review page can show "Last changed in #71 · 4 changes" by walking manifest
  history with a bounded depth.
- **Hosted:** the post-merge sync records a change event only when a hash changes. Today every
  sync increments the revision of every Story and AC and records the last synced commit, so
  "last changed" cannot be read from the database yet; the new events fix that.

## 7. Risks and required review

| Change | Why it is critical | Containment |
| --- | --- | --- |
| New migration and `tieline_capture_publisher` role | Database roles and migrations are critical surfaces | Insert-only grants on new tables; no access to accepted tables; integration tests on a disposable database |
| Hosted handler | Remote HTTP exposure | Runs only behind the host's access control; read-only database role; bounded responses |
| Image serving | Uploaded bytes are untrusted | Content-type allowlist; size bounds; `X-Content-Type-Options: nosniff`; SVG either refused for hosted serving or served with a sandboxing CSP, because an SVG opened directly can run script |
| Publish from CI | Credentials in CI | Publisher credentials can only add new objects and snapshots; fork pull requests do not receive secrets, so they cannot publish |
| Snapshots | Untrusted payloads | Publish refuses a catalog that does not validate; payload size is bounded |

Each of the database, role, and hosting changes needs review by someone other than the
implementing agent, as `AGENTS.md` requires.

## 8. Proposed order

1. Done in this stack: catalog, `shows` links, import, Screens view, `--base` changes, and image
   digests.
2. Capture: the Playwright fixture and reporter, `capture --all` and `--changed` with selection
   reasons, committed ARIA snapshots, capture records, and `screens audit`.
3. Offline history: "last changed by" from git.
4. Hosted: review of this design, then the migration and roles, `publish`, the core handler and
   Netlify adapter, the sync of accepted screen state, and the pull-request comment.
5. More hosts and image stores as teams need them.

## How this compares to existing tools

Tieline's capture step deliberately follows the pattern hosted visual-testing services already
proved: a call inside existing Playwright tests plus a reporter, with `main` as the baseline.

| | Playwright `toHaveScreenshot` | Argos, Percy | Tieline screens (proposed) |
| --- | --- | --- | --- |
| Capture | An assertion in a test | `argosScreenshot(page, name)` or `percySnapshot(page, name)` in tests, plus a reporter | `tielineSnapshot(page, key)` in tests, plus a reporter |
| Baseline | PNG files committed beside the tests | Stored in the service; Argos uses the merge-base build on `main`, Percy the last approved build | Images in the team's own store (or only on disk offline); the digest and ARIA snapshot are committed, and accepted means merged to `main` |
| Comparison | Fuzzy pixel diff with tolerances | The service's pixel diff | Exact digest in a pinned environment, plus the ARIA snapshot diff |
| Review and approval | A failing test with diff images | A review UI where reviewers approve or reject; a status check blocks the merge until then | The Tieline review page, local or hosted; approval is the normal pull-request review and merge |
| Effect on the suite | Fails the test on a difference | Fails the status check until approved | Never fails a test; `check` fails only on an invalid catalog or broken links |
| What a screenshot is | A test artifact | A named snapshot | A catalogued product screen: route, kind, trigger, roles, copy, and the Stories and ACs that show it |
| Runs | The whole suite or a `--grep` | The whole suite | Only screens a branch may affect, each with a reason |
| Hosting | None | The vendor's service | Offline, or self-hosted behind the team's own access control |

What Tieline adds is the product layer: screens are catalogued, linked to accepted behavior,
counted for coverage, and reviewed in the same pull request as the code and contract, with no
third-party service. What the services have that this proposal does not: per-screenshot
approve-and-comment workflows, a merge-blocking status check, cross-browser matrices, and richer
side-by-side and overlay diff views. Those are candidates for later, not prerequisites.

## Decided

- Scenes are Playwright tests tagged `@screen:<key>`; Tieline adds a fixture and a reporter.
- An initial coverage capture, then incremental captures on every pull request; drift is found by
  a manual `tieline screens audit`, not a schedule.
- ARIA snapshots are committed as the text snapshot.
- Images are stored once; a closed pull request's screenshots are deleted by default, configurable.
- Exact digests, captured in a pinned Playwright Docker image; fuzzy comparison only if that
  proves noisy.
- `tieline check` warns about catalog entries the audit reports as missing.
- Replaced `main` images follow `retention.main_history`: all, the last N changes, or none.
- Provisioning creates the Neon project in a region with Object Storage when hosted screens are
  enabled.
- The capture call is `tielineSnapshot(page, key)`, parallel to `percySnapshot` and
  `argosScreenshot`.
- Every `--base` comparison starts from the branch point, `git merge-base <base> HEAD`. #80 makes
  that change for `check`, `reconcile`, `grade`, and `blast-radius`, and #78 uses the same helper
  for `review`.

## Open questions

- Should the default for `retention.main_history` be `{ "keep_changes": 10 }`?
