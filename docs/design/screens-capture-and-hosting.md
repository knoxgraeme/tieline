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

### What an app provides

Capture is configured by one module in the app's repository, because reaching a screen is code:

```ts
// .tieline/capture.config.ts
import { defineCapture } from "tieline/capture";

export default defineCapture({
  // Either start the app here, or point at one that is already running
  // (a local dev server, or a preview deployment in CI).
  target: {
    start: "npm run dev",
    url: "http://localhost:3000",
    ready: { path: "/health", timeoutMs: 60_000 },
  },
  seed: "npm run db:seed:screens",
  // One identity per `applies_to.role` value, logged in once and reused.
  identities: {
    member: { login: "scenes/login.ts#member" },
    admin: { login: "scenes/login.ts#admin" },
    viewer: { login: "scenes/login.ts#viewer" },
  },
  determinism: {
    viewports: [{ width: 1280, height: 800 }],
    locale: "en-US",
    timezoneId: "UTC",
    clock: "2026-01-01T09:00:00Z",
    reducedMotion: true,
    mask: ["[data-testid=relative-time]"],
  },
  // Route parameters for screens reached by plain navigation.
  params: { noteId: "note-seed-1", token: "expired-share-token" },
});
```

Credentials come from environment variables or CI secrets, never from the repository.

### Scenes

Most pages need no code: their default scene navigates to `route` with `params` filled in, as the
identity their `applies_to` names. States, dialogs, toasts, and errors need a short scene that
ends in the state to capture. The reserved catalog field `scene` points at it:

```yaml
- key: notes-share-denied
  route: /notes/:noteId
  kind: inline-error
  applies_to: { role: [viewer] }
  scene: scenes/sharing.ts#shareDenied
```

```ts
// scenes/sharing.ts
export async function shareDenied({ page }) {
  await page.getByRole("button", { name: "Share" }).click();
  await page.getByText("Only editors can share this note").waitFor();
}
```

### Three ways to adopt, lowest effort first

1. **Instrument existing end-to-end tests.** Inside a Playwright test the app already has, call
   `await captureScreen(page, { key, title, kind, when })` from `tieline/playwright`. It writes
   the screenshot and a catalog entry, and `tieline screens import` takes it from there. This
   reuses navigation, seeding, and logins the app already maintains.
2. **Scene files and `tieline screens capture`.** Tieline drives the browser from the catalog and
   the scenes above, which keeps capture independent of the test suite.
3. **Agent-assisted onboarding.** The Tieline skill reads the app's routes and drafts catalog
   entries and scenes for a human to review, the same way it drafts the initial contract.

Playwright is an optional peer dependency: the app installs it, and Tieline loads it only when
capture runs, explaining how to install it when it is missing. Tieline's own dependencies do not
grow.

### What each capture records

| Output | Where | Purpose |
| --- | --- | --- |
| Screenshot | Captures directory, git-ignored | What reviewers look at |
| Image `sha256` | Catalog, committed | Puts a visual change into the reviewed diff (exists today) |
| Text snapshot | `.tieline/screens/text/<key>.txt`, committed | Copy changes reviewed line by line in the diff |
| Capture record (reserved `capture` field) | Catalog, committed | Viewport, scene identity, and capture-tool version, so a digest change can be attributed |

## 2. Coverage capture, then incremental captures

**Coverage capture** (`tieline screens capture --all`) records every screen once, on `main`, and
establishes the accepted digests. It is re-run on a schedule — nightly or weekly — to catch drift
that incremental selection missed. Drift appears as changed screens like any other change.

**Incremental capture** (`tieline screens capture --changed --base origin/main`) re-captures only
the screens a branch may have affected, chosen by these rules in order:

1. screens whose catalog entry or scene changed in the diff;
2. screens shown by acceptance criteria whose linked code or tests changed (contract coupling);
3. screens owned by changed files, through optional path globs per group in the capture config;
4. screens owned by dependents of changed files, through the existing code-topology blast radius,
   so a change to a shared component reaches the pages that use it;
5. everything, when a configured global path changed (theme, layout, global styles, translations).

Every selected screen reports why it was selected, and screens that were not selected keep
`main`'s digest. A re-captured screen whose digest equals `main`'s is unchanged and drops out of
the review.

## 3. Offline mode (the default)

```bash
tieline screens capture --changed --base origin/main
tieline screens import .tieline/captures/import.json
tieline contract review . --base origin/main
```

Everything stays on the developer's machine. The review page badges new, changed, and removed
Stories, ACs, and screens (this part exists today). Only the current screenshot is on disk, so
the "before" picture is not shown; the text snapshot diff still shows copy changes.

## 4. Hosted mode (optional)

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
| Schedule on `main` | CI | Coverage capture and publish, so accepted images exist for every screen |

### Storage

- **Images** are content-addressed (`sha256/<digest>.<ext>`), immutable, and insert-only, in an
  S3-compatible bucket. Neon Object Storage is the first target, because Neon is the hosted
  Postgres Tieline provisions; Cloudflare R2, AWS S3, and Supabase Storage use the same
  interface. A Postgres-backed image store is a fallback for teams without a bucket.
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

Images referenced by `main`'s accepted state, and by its history within a configured window, are
kept. A pull request's snapshot is deleted a configured number of days after it closes, and a
retention job removes images nothing references. Every window is bounded and configurable.

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

## 5. History: "last changed by"

Every Story, AC, and screen has a `contract_hash`, and screens also have an image digest. A commit
changed an entity when either differs from its parent commit's manifest. The commit maps to a pull
request through the squash-merge title (`… (#123)`) or the host's API.

- **Offline:** the review page can show "Last changed in #71 · 4 changes" by walking manifest
  history with a bounded depth.
- **Hosted:** the post-merge sync records a change event only when a hash changes. Today every
  sync increments the revision of every Story and AC and records the last synced commit, so
  "last changed" cannot be read from the database yet; the new events fix that.

## 6. Risks and required review

| Change | Why it is critical | Containment |
| --- | --- | --- |
| New migration and `tieline_capture_publisher` role | Database roles and migrations are critical surfaces | Insert-only grants on new tables; no access to accepted tables; integration tests on a disposable database |
| Hosted handler | Remote HTTP exposure | Runs only behind the host's access control; read-only database role; bounded responses |
| Image serving | Uploaded bytes are untrusted | Content-type allowlist; size bounds; `X-Content-Type-Options: nosniff`; SVG either refused for hosted serving or served with a sandboxing CSP, because an SVG opened directly can run script |
| Publish from CI | Credentials in CI | Publisher credentials can only add new objects and snapshots; fork pull requests do not receive secrets, so they cannot publish |
| Snapshots | Untrusted payloads | Publish refuses a catalog that does not validate; payload size is bounded |

Each of the database, role, and hosting changes needs review by someone other than the
implementing agent, as `AGENTS.md` requires.

## 7. Proposed order

1. Done in this stack: catalog, `shows` links, import, Screens view, `--base` changes, and image
   digests.
2. Capture: configuration, the Playwright helper, `capture --all` and `--changed` with selection
   reasons, text snapshots, and capture records.
3. Offline history: "last changed by" from git.
4. Hosted: review of this design, then the migration and roles, `publish`, the core handler and
   Netlify adapter, the sync of accepted screen state, and the pull-request comment.
5. More hosts and image stores as teams need them.

## Open questions

- Exact digests, or a perceptual fingerprint that tolerates anti-aliasing noise?
- Commit text snapshots, or rely on the catalog's `copy`?
- Retention windows for pull-request snapshots and `main`'s image history.
- Neon Object Storage is available in four AWS regions; should provisioning create the Neon
  project in one of them when screens are enabled?
