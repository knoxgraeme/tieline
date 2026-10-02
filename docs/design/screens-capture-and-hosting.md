# Screens: capture and hosted review (design proposal)

[Screens](../screens.md) · **Capture and hosted review (proposal)**

**Status: proposal for review. Capture (sections 1 to 4, step 2 of the
[proposed order](#8-proposed-order)) is implemented; history and hosted review are not.** What
exists today — the catalog, `shows` links, `tieline screens import`, the Screens view,
`tieline contract review --base`, `tieline screens capture`, and `tieline screens audit` — is
documented in [Screens](../screens.md), and [how capture was built](#how-capture-was-built)
records where it refines this proposal. This page proposes how screenshots get produced for any
app, and how a team can review them together, so that the later phases can be reviewed before
any database, role, or hosting change is built.

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
| Log in once per role | A setup project that saves a `storageState` per role | — (each screen's test picks one identity; see below) |
| Stable rendering | `use: { viewport, locale, timezoneId, reducedMotion }`, `page.clock`, screenshot `mask` and `animations: "disabled"`, the official Playwright Docker image | Records a fingerprint of every pixel-affecting setting with each capture |
| Reach a screen | A test that navigates and interacts | Tags it `@screen:<key>` |
| Run only some screens | `--grep` over test tags | Computes the tags for the screens a branch may affect |
| Text snapshot | `locator.ariaSnapshot()` | Writes it to `.tieline/screen-text/` |
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
records the ARIA snapshot, and hands both to the reporter.

- **Visual differences never fail a test.** Whether a screen changed is decided in review, not by
  an assertion.
- **Operational failures always fail the capture.** If navigation, settling, the screenshot, the
  ARIA snapshot, or the reporter's writes fail, the capture job fails with the screen key and the
  cause. The reporter writes a completion record listing every selected key, and import and
  publish refuse a run in which any selected key has no capture, so a partial run can never
  replace a reviewed digest or publish half a snapshot.
- **One identity and one viewport per screen.** A screen key is captured exactly once, by one test
  logged in as one identity, at the repository's single configured viewport. Screens that look
  different for different roles are separate catalog entries (a viewer's share dialog and an
  owner's are two screens), so every key has exactly one screenshot, digest, ARIA snapshot, and
  capture record. Several viewports per screen would need a variant in the key and are out of
  scope for now.
- **Only selected screens are kept.** When a test captures several screens but the branch selected
  only some of them, the reporter discards the others, so a screen that was not selected always
  keeps `main`'s digest.

Plain pages need no hand-written test: a `screensFromCatalog()` helper generates one navigation
test per `page` entry, filling route parameters from a small fixtures map. (Not built yet.)

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
| ARIA snapshot | `.tieline/screen-text/<key>.yml`, **committed** | Copy and structure changes reviewed line by line in the diff, independent of pixels |
| Capture record (reserved `capture` field) | Catalog, committed | A fingerprint of the capture environment (see section 3), so digests are only ever compared like for like |

ARIA snapshots live in their own directory, beside the catalog rather than inside it: the catalog
loader reads every YAML file under the catalog directory as a catalog document, so a snapshot
there would make the catalog invalid.

## 2. Initial coverage capture, then every pull request

**Initial coverage capture.** `tieline screens capture --all` runs once on `main`. It records
every screen's digest and ARIA snapshot and establishes the accepted state.

**Every pull request.** `tieline screens capture --changed --base origin/main` re-captures only
the screens a branch may have affected, chosen by these rules in order:

1. screens whose catalog entry or scene test changed in the diff;
2. screens shown by acceptance criteria whose linked code or tests changed (contract coupling);
3. screens owned by changed files, through optional path globs per catalog entry (`paths`);
4. screens owned by dependents of changed files, through the existing code-topology blast radius,
   so a change to a shared component reaches the pages that use it;
5. everything, when a configured global path changed (theme, layout, global styles, translations).

Every selected screen reports why it was selected, and the selection becomes a `--grep` over
screen tags. Screens that were not selected keep `main`'s digest, and a re-captured screen whose
digest and ARIA snapshot both equal `main`'s drops out of the review.

**Committed outputs must match a fresh capture.** Digests, ARIA snapshots, and capture records are
committed outputs, like the compiled manifest, and git is the source of truth for them. They reach
a pull request in one of two ways:

- the developer runs `tieline screens capture --changed` in the pinned Playwright image and commits
  the result; or
- for same-repository pull requests, the trusted publish job (section 5) pushes a commit with the
  updated outputs to the pull request's branch, when the repository opts in.

Either way, pull-request CI runs `tieline screens capture --changed --verify` in the pinned image.
It fails, naming each screen and the command to fix it, when a selected screen's fresh digest or
ARIA snapshot differs from what the branch commits. A required `--verify` check means a pull
request cannot merge with stale screen outputs, so the post-merge sync of `main` reads a
trustworthy catalog.

**No schedule; a manual audit instead.** `tieline screens audit` finds what incremental capture
cannot:

- **Missing**, without capturing anything: catalog entries with no screenshot digest, no ARIA
  snapshot, or no `@screen` test. It is cheap enough to also run as a `check` warning.
- **Drift**, with `--capture`: re-captures every screen and reports those whose digest or ARIA
  snapshot differs from `main`'s accepted state — changes the selection rules missed. Run it before
  a release or after a large refactor; its updated outputs land in a normal pull request. It plays the
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
structure changes regardless of pixels. The capture record holds a fingerprint — a hash of the
canonical form of every setting that affects pixels: browser and Playwright versions, container
image digest, viewport, device scale factor, color scheme, locale, timezone, frozen clock, reduced
motion, animation handling, masks, and installed fonts. Digests with different fingerprints are
never compared; a mismatch is reported as "re-capture in the pinned environment" rather than as a
change. Fuzzy comparison is added only if pinned captures still prove noisy.

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
| Pull request push | Untrusted capture job: runs the pull request's code, holds **no** credentials | Incremental capture and `--verify` in the pinned image, then uploads the screenshots and a snapshot manifest (keys, digests, ARIA snapshots, fingerprints) as a CI artifact |
| After the capture job | Trusted publish job: runs Tieline from the default branch, never checks out pull-request code, holds the publish credentials | Takes the repository, pull-request number, and head commit from the CI event — never from the artifact — re-hashes every screenshot and accepts only files whose digest matches, enforces size and type limits, then uploads only images the store lacks, records that pull request's snapshot, and posts or updates one PR comment. Works the same for fork pull requests, whose untrusted runs never see a secret |
| Merge to `main` | Trusted `main` job | Verifies every image `main`'s catalog now references exists in the store, captures and publishes any that are missing, then runs `tieline contract sync`, which fails rather than accept a digest with no stored image |
| Once, then on demand | A developer or CI on `main` | `capture --all` for the initial coverage, and `audit --capture` when drift is suspected; both land through a normal pull request |

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
| `screen_snapshots` | repository, ref kind (`pr` or `branch`), ref name, head commit, pull-request number, compiled screens and changes, published, superseded, and closed times | capture publisher |
| `screens`, `screen_links` | accepted screen state and `shows` links from `main` | repository sync |
| `contract_change_events` | entity, kind of change (content, links, image, or text), commit, pull request — recorded only when one of those identities changes | repository sync |

### Roles and isolation

| Role | May |
| --- | --- |
| `tieline_reader` | Read snapshots, accepted state, and image metadata (the hosted site) |
| `tieline_capture_publisher` (new) | Insert images and snapshots for non-`main` refs; nothing else. Held only by the trusted publish job, which binds each snapshot to the ref and head commit of the CI event that triggered it |
| `tieline_repository_sync` | Write accepted screen state, from `main` only, checkpointed by commit |

The bucket mirrors this: the publisher can create objects but never overwrite or delete them,
the site can only read, and the retention step in the trusted `main` job can only delete
unreferenced objects. Untrusted pull-request code never holds any of these credentials.

Pull requests are isolated from `main` by construction. Accepted state changes only through the
post-merge sync of `main`. Pull-request snapshots live in their own table and cannot touch
accepted rows. Images are addressed by digest and never overwritten, so a pull request can never
replace a picture `main` uses; on merge nothing is copied, because the sync simply records which
digests `main` now references.

### Retention

- **Each image is stored once.** Images are addressed by digest, so when a pull request merges,
  `main`'s accepted state simply references the digests the pull request already uploaded.
  Nothing is copied.
- **Each ref keeps only its latest snapshot.** Publishing a new head marks the previous snapshot of
  that pull request or branch superseded, and superseded snapshots are deleted.
- **Branches without a pull request** expire after `retention.branch_days` (default 14) without a
  new publish.
- **Closed pull requests:** `retention.closed_pull_requests` is `delete` by default, or a number of
  days to keep them.
- **`main`:** accepted images are always kept. Images `main` has since replaced are kept according
  to `retention.main_history`: `all` (every earlier version), `{ "keep_changes": N }` (the last N
  replaced versions of each screen), or `none`. The default is `{ "keep_changes": 5 }`.
- **Deletion only happens in the trusted `main` job, after sync.** It never runs on a pull
  request's close event, which can arrive before `main` has synced the images that pull request
  just merged. At deletion time an image is removed only if nothing still references it:
  `main`'s accepted state, its retained history, or any live snapshot.

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

A commit changed an entity when any of its identities differs from its parent commit's manifest:
the `contract_hash` (content), its `shows` links (which are kept out of that hash), and for
screens the image digest and the ARIA snapshot. The commit maps to a pull request through the
squash-merge title (`… (#123)`) or the host's API.

- **Offline:** the review page can show "Last changed in #71 · 4 changes" by walking manifest
  history with a bounded depth.
- **Hosted:** the post-merge sync records a change event only when one of those identities changes,
  and records which one. Today every
  sync increments the revision of every Story and AC and records the last synced commit, so
  "last changed" cannot be read from the database yet; the new events fix that.

## 7. Risks and required review

| Change | Why it is critical | Containment |
| --- | --- | --- |
| New migration and `tieline_capture_publisher` role | Database roles and migrations are critical surfaces | Insert-only grants on new tables; no access to accepted tables; integration tests on a disposable database |
| Hosted handler | Remote HTTP exposure | Runs only behind the host's access control; read-only database role; bounded responses |
| Image serving | Uploaded bytes are untrusted | Content-type allowlist; size bounds; `X-Content-Type-Options: nosniff`; SVG either refused for hosted serving or served with a sandboxing CSP, because an SVG opened directly can run script |
| Publish from CI | Pull-request code runs in CI and could misuse credentials | Capture runs with no credentials; a separate trusted job publishes, binds the snapshot to the triggering ref and head commit, and re-hashes every file before upload; publisher credentials can only add objects and snapshots |
| Capture failures | A silent failure could keep a stale digest or publish half a snapshot | Operational capture errors fail the job; import and publish refuse runs missing any selected key |
| Snapshots | Untrusted payloads | Publish refuses a catalog that does not validate; payload size is bounded |

Each of the database, role, and hosting changes needs review by someone other than the
implementing agent, as `AGENTS.md` requires.

## 8. Proposed order

1. Done in this change: catalog, `shows` links, import, Screens view, `--base` changes, image
   digests, and branch-point comparisons for every `--base` command.
2. Done: capture. The Playwright fixture and reporter, `capture --all`, `--changed`, and
   `--verify` with selection reasons, committed ARIA snapshots, capture records, and
   `screens audit`.
3. Offline history: "last changed by" from git.
4. Hosted: review of this design, then the migration and roles, `publish`, the core handler and
   Netlify adapter, the sync of accepted screen state, and the pull-request comment.
5. More hosts and image stores as teams need them.

## How capture was built

Step 2 follows sections 1 to 4, with these refinements found while building it:

- **Path ownership is per screen, not per group.** Each catalog entry may list `paths`: the files
  that render it, usually one page or route file. A group is a display label, so keying ownership
  off it would break when a heading is reworded and leave ungrouped screens unowned. Shared
  components need no listing: the dependency rule follows them through the code-topology blast
  radius to the page files that import them. `paths` is used only for selection and stays out of
  the manifest and the contract hash.
- **A sixth selection rule, `outputs`.** A screen whose committed digest, capture record, or ARIA
  snapshot changed on the branch is always selected, so `--verify` re-captures every output a
  pull request touches and a hand-edited digest cannot pass.
- **New files count.** `--changed` adds untracked files git does not ignore to the branch's
  changes, since a developer capturing locally often has not added them yet. `tieline check` is
  unchanged.
- **The capture record also names the scene's test file** (`capture.test`), tying each screenshot
  to the test that produced it as well as to its screen, Stories, and ACs.
- **The frozen clock is not in the fingerprint.** Whether and when a test froze `page.clock` is
  not observable from the page, and recording the live time would change the fingerprint on every
  run. A scene that shows the time must freeze it; otherwise verification reports the screenshot as
  changed, which is the honest result.
- **`check` and `audit` find `@screen` tests by reading tags as text**, bounded, without loading
  the app's Playwright configuration or running repository code; the capture run itself is the
  authority on which test captured which screen. A tag must be written literally to be found.
- **`--verify` writes nothing**, not even git-ignored screenshots.
- **The fixture and reporter are CommonJS** (`tieline/playwright`), so they load in test projects
  Playwright compiles to CommonJS on every Node version Tieline supports, as well as in ESM
  projects. Tieline's package gained an `exports` map for that subpath; every existing file path
  stays importable.
- **Not built yet:** `screensFromCatalog()`, which would generate navigation tests for plain
  pages, and Tieline-drafted scene files. Both remain proposals.

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
- Replaced `main` images follow `retention.main_history`: all, the last N changes, or none; the
  default is the last 5 changes per screen.
- Provisioning creates the Neon project in a region with Object Storage when hosted screens are
  enabled.
- The capture call is `tielineSnapshot(page, key)`, parallel to `percySnapshot` and
  `argosScreenshot`.
- Every `--base` comparison starts from the branch point, `git merge-base <base> HEAD`
  (implemented in this change for `check`, `reconcile`, `grade`, `blast-radius`, and `review`).
- Committed screen outputs must match a fresh capture (`capture --verify`), and capture runs
  without credentials while a separate trusted job publishes.

## Follow-ups not yet designed

- **Thumbnails.** An optional `thumbnail` locator beside `image`, produced by the capture tool, so the
  zoomed-out Screens view loads small files at catalog scale. Tieline would only reference
  thumbnails, never generate them, because that needs an image-processing dependency.
- **Typed browser code for the review page.** Move the review page's browser script out of a
  TypeScript string into type-checked browser `.ts` files compiled into the page at build time,
  with DOM-level tests for search, filters, and the detail panel. No framework is needed.

## Open questions

- None outstanding; the questions raised so far are recorded under Decided.
