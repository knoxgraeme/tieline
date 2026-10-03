import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
  readObjectStoreSettings,
  S3ObjectStore,
  type ObjectStore,
} from "../adapters/object-store/s3.js";
import { closeConnections, getScreensPublishSql, getSyncSql } from "../adapters/postgres/connections.js";
import {
  PostgresHostedScreensRepository,
  type HostedImagePruneResult,
  type HostedRefPruneResult,
  type StoredHostedSnapshot,
} from "../adapters/postgres/hosted-screens-repository.js";
import type { ScreensHostedConfig } from "../config.js";
import { mapWithConcurrency } from "../embeddings.js";
import {
  compileContractManifestWithSources,
  parseStoredContractManifest,
  storedContractManifest,
  type ContractManifest,
} from "../contract/manifest.js";
import {
  diffReviewManifests,
  summarizeReviewChanges,
  type ReviewComparison,
} from "../contract/review-changes.js";
import { screenSettingsForRepository, type ScreenSettings } from "../contract/screen-catalog.js";
import {
  changedScreenImages,
  HOSTED_SCREEN_LIMITS,
  hostedImageKey,
  hostedImageReferences,
  hostedRefLabel,
  parseHostedRef,
  readLocalHostedImage,
  screenImageDigests,
  type HostedImageReference,
  type HostedImageType,
} from "../contract/screen-hosting.js";
import { commitPullRequest, readReviewHistory } from "../contract/history.js";
import type { ReviewHistory } from "../contract/review-page.js";
import { renderHostedReviewPage } from "../tieline/review.js";
import { escapeTerminalText, resolveCommandContext, type CommandIO } from "./shared.js";

const NOT_ENABLED =
  'Screens are not enabled for this repository. Add "screens": { "enabled": true } to .tieline/config.json to opt in.';
const HOSTING_NOT_ENABLED =
  'Hosted screens are not enabled for this repository. Add "hosted": { "enabled": true, "bucket": "<bucket>" } to the screens block of .tieline/config.json to opt in.';
const COMMIT = /^([a-f0-9]{40}|[a-f0-9]{64})$/;

export type HostedScreensRepository = Pick<
  PostgresHostedScreensRepository,
  | "repositoryId"
  | "snapshot"
  | "touchImages"
  | "publishRef"
  | "closePullRequest"
  | "publishMain"
  | "pruneRefs"
  | "pruneImages"
>;

export interface HostedScreensDependencies {
  /** The database as the capture publisher or as repository sync. */
  repository(role: "publisher" | "sync"): HostedScreensRepository;
  store(hosted: ScreensHostedConfig): ObjectStore;
  /** Releases every connection `repository` opened. */
  close(): Promise<void>;
  headCommit(root: string): string;
}

export const DEFAULT_HOSTED_SCREENS_DEPENDENCIES: HostedScreensDependencies = {
  repository: (role) =>
    new PostgresHostedScreensRepository(role === "publisher" ? getScreensPublishSql : getSyncSql),
  store: (hosted) => new S3ObjectStore(readObjectStoreSettings(process.env, hosted.bucket)),
  close: closeConnections,
  headCommit: (root) =>
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(),
};

export type HostedSettings = ScreenSettings & { hosted: ScreensHostedConfig };

function hostedSettings(root: string): HostedSettings {
  const settings = screenSettingsForRepository(root);
  if (!settings) throw new Error(NOT_ENABLED);
  if (!settings.hosted) throw new Error(HOSTING_NOT_ENABLED);
  return { ...settings, hosted: settings.hosted };
}

function fullCommit(commit: string): string {
  if (!COMMIT.test(commit)) {
    throw new Error(`Hosted screens record a full commit SHA, not '${commit}'.`);
  }
  return commit;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs `operation` over `values` a few at a time and waits for every one to
 * settle before failing, so no request is still in flight when the caller
 * reports the failure and closes its connections.
 */
async function settleEach<T, R>(values: readonly T[], operation: (value: T) => Promise<R>): Promise<R[]> {
  const settled = await mapWithConcurrency(
    [...values],
    HOSTED_SCREEN_LIMITS.concurrency,
    async (value): Promise<{ ok: true; value: R } | { ok: false; error: unknown }> => {
      try {
        return { ok: true, value: await operation(value) };
      } catch (error) {
        return { ok: false, error };
      }
    }
  );
  return settled.map((entry) => {
    if (!entry.ok) throw entry.error;
    return entry.value;
  });
}

export interface MissingHostedImage {
  digest: string;
  screens: string[];
  detail: string;
}

export interface StoredHostedImages {
  referenced: number;
  uploaded: number;
  already_stored: number;
  missing: MissingHostedImage[];
}

type LocalImageState =
  | { status: "ok"; contentType: HostedImageType; byteSize: number }
  | { status: "missing" | "unusable"; detail: string };

/**
 * Makes sure the bucket holds every image a page shows. Images are recorded
 * as referenced first, so retention cannot delete one between the check and
 * the page that shows it; then every image is checked in the bucket, and those
 * it lacks are uploaded from the captures directory when the file there is
 * the one the catalog names. An image the bucket lacks and the captures
 * directory cannot supply is reported, and the caller publishes nothing.
 */
export async function storeHostedImages(input: {
  settings: ScreenSettings;
  repositoryKey: string;
  repositoryId: string;
  references: readonly HostedImageReference[];
  repository: HostedScreensRepository;
  store: ObjectStore;
  signal?: AbortSignal;
}): Promise<StoredHostedImages> {
  const local = new Map<string, LocalImageState>();
  for (const reference of input.references) {
    const read = readLocalHostedImage(input.settings, reference);
    local.set(
      reference.digest,
      read.status === "ok"
        ? { status: "ok", contentType: read.image.contentType, byteSize: read.image.bytes.byteLength }
        : read
    );
  }
  await input.repository.touchImages(
    input.repositoryKey,
    input.repositoryId,
    input.references.flatMap((reference) => {
      const state = local.get(reference.digest)!;
      return state.status === "ok"
        ? [{ digest: reference.digest, contentType: state.contentType, byteSize: state.byteSize }]
        : [];
    }),
    input.references.map((reference) => reference.digest)
  );
  const present = await settleEach(input.references, (reference) =>
    input.store.head(hostedImageKey(input.repositoryKey, reference.digest), input.signal)
  );
  const absent = input.references.filter((_, index) => !present[index]);
  const missing: MissingHostedImage[] = [];
  let uploaded = 0;
  await settleEach(absent, async (reference) => {
    // Read again rather than keep every image in memory, and prove again that
    // the bytes are the ones the catalog names.
    const read = readLocalHostedImage(input.settings, reference);
    if (read.status !== "ok") {
      missing.push({ digest: reference.digest, screens: reference.screens, detail: `not in the bucket, and ${read.detail}` });
      return;
    }
    await input.store.put(
      hostedImageKey(input.repositoryKey, reference.digest),
      read.image.bytes,
      read.image.contentType,
      input.signal
    );
    uploaded += 1;
  });
  return {
    referenced: input.references.length,
    uploaded,
    already_stored: input.references.length - absent.length,
    missing: missing.sort((left, right) => left.digest.localeCompare(right.digest)),
  };
}

/** When each item last changed, for a hosted page; none when git history cannot be read. */
function pageHistory(root: string, manifestPath: string): { history?: ReviewHistory } {
  const history = readReviewHistory(root, manifestPath);
  return history.status === "read" ? { history: { items: history.items, truncated: history.truncated } } : {};
}

function boundedPage(page: string): string {
  const bytes = Buffer.byteLength(page);
  if (bytes > HOSTED_SCREEN_LIMITS.pageBytes) {
    throw new Error(
      `The rendered review page is ${bytes} bytes; hosted screens store pages of at most ${HOSTED_SCREEN_LIMITS.pageBytes} bytes.`
    );
  }
  return page;
}

function boundedManifest(manifest: ContractManifest): unknown {
  const value = storedContractManifest(manifest);
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes > HOSTED_SCREEN_LIMITS.manifestBytes) {
    throw new Error(
      `The compiled manifest is ${bytes} bytes; hosted screens store manifests of at most ${HOSTED_SCREEN_LIMITS.manifestBytes} bytes.`
    );
  }
  return value;
}

/** The comparison with `main`'s published state, or why there is none. */
function comparisonWithMain(
  main: StoredHostedSnapshot | null,
  current: ContractManifest
): { comparison: ReviewComparison; baseImages: Map<string, string> } {
  if (!main) {
    return {
      comparison: {
        base: "main",
        unavailable: "main has not been published yet; `tieline contract sync` publishes it when hosted screens are enabled.",
      },
      baseImages: new Map(),
    };
  }
  try {
    const base = parseStoredContractManifest(main.manifest, "main's hosted snapshot");
    return {
      comparison: { changes: diffReviewManifests(base, current, "main") },
      baseImages: screenImageDigests(base),
    };
  } catch (error) {
    return {
      comparison: { base: "main", unavailable: `main's published manifest cannot be read: ${message(error)}` },
      baseImages: new Map(),
    };
  }
}

function renderMissing(missing: readonly MissingHostedImage[], io: CommandIO): void {
  for (const image of missing) {
    io.write(
      `  missing  ${image.digest.slice(0, 12)} (${escapeTerminalText(image.screens.join(", "))}): ${escapeTerminalText(image.detail)}\n`
    );
  }
}

export interface ScreensPublishOptions {
  repository?: string;
  pullRequest?: string;
  branch?: string;
  /** The commit published; defaults to HEAD. CI passes the event's head commit. */
  commit?: string;
  /** Where to write a Markdown summary for a pull-request comment, once published. */
  summaryFile?: string;
  json?: boolean;
  signal?: AbortSignal;
}

/** Marks the one pull-request comment CI keeps up to date. */
export const SCREENS_COMMENT_MARKER = "<!-- tieline-screens -->";

function countPhrase(counts: Record<"added" | "changed" | "removed", number>, noun: string): string | null {
  const parts = [
    counts.added > 0 ? `${counts.added} new` : null,
    counts.changed > 0 ? `${counts.changed} changed` : null,
    counts.removed > 0 ? `${counts.removed} removed` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? `${noun} ${parts.join(", ")}` : null;
}

/**
 * The Markdown CI posts as the pull request's screens comment: what changed
 * against `main`, and a link to the published page when the site's URL is
 * configured. Everything in it is counts, a validated ref, a commit SHA, and
 * the configured URL, so nothing from the branch can inject Markdown.
 */
export function renderPublishSummary(input: {
  label: string;
  commit: string;
  siteUrl: string | null;
  comparison: ReviewComparison;
}): string {
  let changes: string;
  if (input.comparison.changes) {
    const summary = summarizeReviewChanges(input.comparison.changes);
    const phrases = [
      countPhrase(summary.stories, "Stories:"),
      countPhrase(summary.acceptance_criteria, "acceptance criteria:"),
      countPhrase(summary.screens, "screens:"),
    ].filter((phrase): phrase is string => phrase !== null);
    changes = phrases.length > 0 ? `Changes against \`main\`: ${phrases.join(" · ")}.` : "No changes against `main`.";
  } else {
    changes = "Changes against `main` are not shown: main has not been published yet, or its page cannot be read.";
  }
  const link = input.siteUrl
    ? `[Open the review of ${input.label}](${input.siteUrl}/?ref=${encodeURIComponent(input.label)}) · `
    : "";
  return `${SCREENS_COMMENT_MARKER}\n### Screens\n\n${changes}\n\n${link}published at \`${input.commit.slice(0, 12)}\`\n`;
}

/**
 * `tieline screens publish`: stores a pull request's or branch's review page,
 * compared with `main`, and every image it shows, replacing the ref's previous
 * page. Runs with the capture publisher's database role, which cannot write
 * `main`, from a trusted CI job or a developer's machine.
 */
export async function runScreensPublishCommand(
  options: ScreensPublishOptions,
  io: CommandIO,
  dependencies: HostedScreensDependencies = DEFAULT_HOSTED_SCREENS_DEPENDENCIES
): Promise<number> {
  const ref = parseHostedRef({ pullRequest: options.pullRequest, branch: options.branch });
  const { root, repositoryKey, specDirectory, manifestPath } = resolveCommandContext(options);
  const settings = hostedSettings(root);
  const commit = fullCommit(options.commit ?? dependencies.headCommit(root));
  const current = compileContractManifestWithSources({
    repositoryRoot: root,
    repositoryKey,
    specDirectory,
    onUnhashableArtifact: "omit_hash",
  }).manifest;
  const references = hostedImageReferences(current);
  const manifest = boundedManifest(current);
  const store = dependencies.store(settings.hosted);
  const repository = dependencies.repository("publisher");
  try {
    const repositoryId = await repository.repositoryId(repositoryKey);
    if (!repositoryId) {
      throw new Error(
        `Repository '${repositoryKey}' has never been synced, so there is nothing to publish against. Run \`tieline contract sync\` on main first.`
      );
    }
    const { comparison, baseImages } = comparisonWithMain(
      await repository.snapshot(repositoryId, "main", "main"),
      current
    );
    const digests = references.map((reference) => reference.digest);
    const page = boundedPage(
      renderHostedReviewPage({
        root,
        repositoryKey,
        specDirectory,
        hosted: { served: new Set(digests), base: baseImages, baseLabel: "main" },
        comparison,
        ...pageHistory(root, manifestPath),
      })
    );
    const images = await storeHostedImages({
      settings,
      repositoryKey,
      repositoryId,
      references,
      repository,
      store,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const label = hostedRefLabel(ref);
    if (images.missing.length > 0) {
      if (options.json) {
        io.write(`${JSON.stringify({ published: false, ref: label, commit, images }, null, 2)}\n`);
      } else {
        io.write(
          `Nothing was published for ${escapeTerminalText(label)}: ${images.missing.length} image(s) are not in the bucket and cannot be uploaded from the captures directory.\n`
        );
        renderMissing(images.missing, io);
        io.write("Capture those screens in the pinned environment, then publish again.\n");
      }
      return 1;
    }
    await repository.publishRef(repositoryId, ref, { headCommit: commit, manifest, images: digests, pageHtml: page });
    if (options.summaryFile) {
      writeFileSync(
        options.summaryFile,
        renderPublishSummary({ label, commit, siteUrl: settings.hosted.site_url, comparison })
      );
    }
    const changes = comparison.changes ? summarizeReviewChanges(comparison.changes) : { base: "main", unavailable: comparison.unavailable };
    if (options.json) {
      io.write(
        `${JSON.stringify(
          {
            published: true,
            ref: label,
            commit,
            url: settings.hosted.site_url ? `${settings.hosted.site_url}/?ref=${encodeURIComponent(label)}` : null,
            page_bytes: Buffer.byteLength(page),
            images,
            changes,
          },
          null,
          2
        )}\n`
      );
      return 0;
    }
    io.write(
      `Published ${escapeTerminalText(label)} at ${commit.slice(0, 12)}: ${images.referenced} image(s), ${images.uploaded} uploaded and ${images.already_stored} already stored.\n${
        comparison.changes
          ? `Changes against main: ${comparison.changes.records.filter((record) => record.kind === "story").length} Stories, ${comparison.changes.records.filter((record) => record.kind === "acceptance_criterion").length} acceptance criteria, ${comparison.changes.screens.length} screens.\n`
          : `Changes against main are not shown: ${comparison.unavailable}\n`
      }${settings.hosted.site_url ? `View it at ${settings.hosted.site_url}/?ref=${encodeURIComponent(label)}\n` : ""}`
    );
    return 0;
  } finally {
    await dependencies.close();
  }
}

export interface ScreensCloseOptions {
  repository?: string;
  pullRequest: string;
  json?: boolean;
}

/**
 * `tieline screens close`: marks a pull request closed, so `screens prune`
 * deletes its page once the grace period has passed. Publishing it again
 * reopens it.
 */
export async function runScreensCloseCommand(
  options: ScreensCloseOptions,
  io: CommandIO,
  dependencies: HostedScreensDependencies = DEFAULT_HOSTED_SCREENS_DEPENDENCIES
): Promise<number> {
  const ref = parseHostedRef({ pullRequest: options.pullRequest });
  const { root, repositoryKey } = resolveCommandContext(options);
  hostedSettings(root);
  const repository = dependencies.repository("publisher");
  try {
    const repositoryId = await repository.repositoryId(repositoryKey);
    const closed = repositoryId ? await repository.closePullRequest(repositoryId, ref.name) : false;
    const label = hostedRefLabel(ref);
    io.write(
      options.json
        ? `${JSON.stringify({ ref: label, closed }, null, 2)}\n`
        : closed
          ? `Marked ${label} closed; \`tieline screens prune\` deletes its page after ${HOSTED_SCREEN_LIMITS.closedGraceHours} hours.\n`
          : `${label} has no open published page; nothing to close.\n`
    );
    return 0;
  } finally {
    await dependencies.close();
  }
}

export type MainScreensResult =
  | {
      outcome: "published";
      commit: string;
      images: StoredHostedImages;
      history_added: number;
    }
  | { outcome: "superseded"; commit: string; synced_commit: string | null }
  | { outcome: "failed"; commit: string; reason: string; images?: StoredHostedImages };

/**
 * Publishes `main`: the page for the reviewed manifest just synced, without a
 * comparison, and a history row for each screen whose image changed. Every
 * image must already be in the bucket or be uploadable from the captures
 * directory; otherwise nothing is published, so `main`'s page never shows a
 * digest the bucket lacks. Called by `tieline contract sync`, with the
 * repository sync role.
 */
export async function publishMainScreens(input: {
  root: string;
  repositoryKey: string;
  specDirectory: string;
  /** The committed manifest's directory, for each item's history; none shown when omitted. */
  manifestPath?: string;
  manifest: ContractManifest;
  commit: string;
  settings: HostedSettings;
  repository: HostedScreensRepository;
  store: ObjectStore;
  signal?: AbortSignal;
}): Promise<MainScreensResult> {
  const commit = input.commit;
  if (!COMMIT.test(commit)) {
    return { outcome: "failed", commit, reason: `hosted screens record a full commit SHA, not '${commit}'` };
  }
  const repositoryId = await input.repository.repositoryId(input.repositoryKey);
  if (!repositoryId) {
    return { outcome: "failed", commit, reason: `repository '${input.repositoryKey}' is not in the database` };
  }
  const references = hostedImageReferences(input.manifest);
  const digests = references.map((reference) => reference.digest);
  const page = boundedPage(
    renderHostedReviewPage({
      root: input.root,
      repositoryKey: input.repositoryKey,
      specDirectory: input.specDirectory,
      hosted: { served: new Set(digests), base: new Map(), baseLabel: "main" },
      ...(input.manifestPath ? pageHistory(input.root, input.manifestPath) : {}),
    })
  );
  const manifest = boundedManifest(input.manifest);
  const images = await storeHostedImages({
    settings: input.settings,
    repositoryKey: input.repositoryKey,
    repositoryId,
    references,
    repository: input.repository,
    store: input.store,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (images.missing.length > 0) {
    return {
      outcome: "failed",
      commit,
      reason: `${images.missing.length} image(s) main shows are not in the bucket and cannot be uploaded from the captures directory`,
      images,
    };
  }
  const result = await input.repository.publishMain(
    input.repositoryKey,
    repositoryId,
    { headCommit: commit, manifest, images: digests, pageHtml: page },
    screenImageDigests(input.manifest),
    changedScreenImages,
    commitPullRequest(input.root, commit)
  );
  return result.outcome === "published"
    ? { outcome: "published", commit, images, history_added: result.history_added }
    : { outcome: "superseded", commit, synced_commit: result.synced_commit };
}

/** Terminal lines for a `main` publish, as `contract sync` reports it. */
export function renderMainScreensResult(result: MainScreensResult, io: CommandIO): void {
  switch (result.outcome) {
    case "published":
      io.write(
        `Published main's screens: ${result.images.referenced} image(s), ${result.images.uploaded} uploaded and ${result.images.already_stored} already stored; ${result.history_added} screen image change(s) recorded.\n`
      );
      return;
    case "superseded":
      io.write(
        `Did not replace main's hosted page: the database has synced ${result.synced_commit ?? "no commit"}, not ${result.commit}.\n`
      );
      return;
    case "failed":
      io.write(`The contract was synced, but main's hosted screens were not published: ${escapeTerminalText(result.reason)}.\n`);
      if (result.images) renderMissing(result.images.missing, io);
      io.write("Capture the missing screens in the pinned environment, then run `tieline contract sync` again.\n");
      return;
  }
}

export interface ScreensPruneOptions {
  repository?: string;
  json?: boolean;
  signal?: AbortSignal;
}

/**
 * `tieline screens prune`: applies retention with the repository sync role.
 * It deletes closed pull requests' pages after the grace period, branches not
 * published for `retention.branch_days`, `main` history beyond
 * `retention.main_history` replaced images per screen, and then images
 * nothing references any more. Run it in the trusted `main` job after sync,
 * never on a pull request's close event.
 */
export async function runScreensPruneCommand(
  options: ScreensPruneOptions,
  io: CommandIO,
  dependencies: HostedScreensDependencies = DEFAULT_HOSTED_SCREENS_DEPENDENCIES
): Promise<number> {
  const { root, repositoryKey } = resolveCommandContext(options);
  const settings = hostedSettings(root);
  const store = dependencies.store(settings.hosted);
  const repository = dependencies.repository("sync");
  try {
    const repositoryId = await repository.repositoryId(repositoryKey);
    let refs: HostedRefPruneResult = { closed_pull_requests: 0, branches: 0, history: 0 };
    let images: HostedImagePruneResult = { deleted: [], failed: [] };
    if (repositoryId) {
      refs = await repository.pruneRefs(repositoryKey, repositoryId, {
        branchDays: settings.hosted.retention.branch_days,
        mainHistory: settings.hosted.retention.main_history,
        closedGraceHours: HOSTED_SCREEN_LIMITS.closedGraceHours,
      });
      images = await repository.pruneImages(
        repositoryKey,
        repositoryId,
        { graceHours: HOSTED_SCREEN_LIMITS.imageGraceHours, limit: HOSTED_SCREEN_LIMITS.pruneImages },
        async (digests) => {
          const outcomes = await settleEach(digests, async (digest) => {
            try {
              await store.delete(hostedImageKey(repositoryKey, digest), options.signal);
              return { digest, detail: null };
            } catch (error) {
              if (options.signal?.aborted) throw error;
              return { digest, detail: message(error) };
            }
          });
          return {
            deleted: outcomes.filter((outcome) => outcome.detail === null).map((outcome) => outcome.digest),
            failed: outcomes.flatMap((outcome) =>
              outcome.detail === null ? [] : [{ digest: outcome.digest, detail: outcome.detail }]
            ),
          };
        }
      );
    }
    const complete = images.failed.length === 0;
    if (options.json) {
      io.write(
        `${JSON.stringify(
          { complete, refs, images: { deleted: images.deleted.length, failed: images.failed } },
          null,
          2
        )}\n`
      );
      return complete ? 0 : 1;
    }
    io.write(
      `Pruned hosted screens: ${refs.closed_pull_requests} closed pull request(s), ${refs.branches} expired branch(es), ${refs.history} history row(s), and ${images.deleted.length} unreferenced image(s).\n`
    );
    for (const failure of images.failed) {
      io.write(`  kept  ${failure.digest.slice(0, 12)}: ${escapeTerminalText(failure.detail)}\n`);
    }
    if (!complete) io.write("Images that could not be deleted are kept and retried by the next prune.\n");
    return complete ? 0 : 1;
  } finally {
    await dependencies.close();
  }
}
