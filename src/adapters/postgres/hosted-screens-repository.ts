/**
 * Hosted screens in Postgres: each ref's rendered page, the images pages
 * reference, and `main`'s image history. Which role runs a method decides
 * what it may do — the capture publisher writes pull-request and branch rows
 * and records images, while repository sync alone writes `main` and deletes —
 * and the database enforces that split, not this class.
 */
import type { Sql, TransactionSql } from "postgres";
import type { HostedRef } from "../../contract/hosted-ref.js";

type Tx = TransactionSql<Record<string, never>>;

function jsonValue(tx: Tx, value: unknown): ReturnType<Tx["json"]> {
  return tx.json(value as Parameters<Tx["json"]>[0]);
}

/**
 * Serializes every write that adds or removes image references for one
 * repository, so retention never deletes an image a publish has just
 * claimed.
 */
async function lockScreens(tx: Tx, repositoryKey: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext('tieline-screens'), hashtext(${repositoryKey}))`;
}

export interface HostedImageRow {
  digest: string;
  contentType: string;
  byteSize: number;
}

export interface HostedSnapshotInput {
  headCommit: string;
  manifest: unknown;
  /** Every image digest the page shows. */
  images: string[];
  pageHtml: string;
}

export interface StoredHostedSnapshot {
  headCommit: string;
  manifest: unknown;
  publishedAt: Date;
}

export interface HostedRetention {
  branchDays: number;
  mainHistory: number;
  closedGraceHours: number;
}

export interface HostedRefPruneResult {
  closed_pull_requests: number;
  branches: number;
  history: number;
}

export interface HostedImagePruneResult {
  deleted: string[];
  failed: Array<{ digest: string; detail: string }>;
}

export type MainPublishResult =
  | { outcome: "published"; history_added: number }
  | { outcome: "superseded"; synced_commit: string | null };

export class PostgresHostedScreensRepository {
  constructor(private readonly sqlProvider: () => Sql) {}

  async repositoryId(repositoryKey: string): Promise<string | null> {
    const rows = await this.sqlProvider()<{ id: string }[]>`
      select id from repositories where key = ${repositoryKey}`;
    return rows[0]?.id ?? null;
  }

  async snapshot(repositoryId: string, kind: "main" | HostedRef["kind"], name: string): Promise<StoredHostedSnapshot | null> {
    const rows = await this.sqlProvider()<{ head_commit: string; manifest: unknown; published_at: Date }[]>`
      select head_commit, manifest, published_at
      from screen_snapshots
      where repository_id = ${repositoryId} and ref_kind = ${kind} and ref_name = ${name}`;
    const row = rows[0];
    return row ? { headCommit: row.head_commit, manifest: row.manifest, publishedAt: row.published_at } : null;
  }

  /**
   * Marks images as referenced now: inserts the ones read from disk and
   * refreshes the rest. Runs before the images are checked in the bucket, so
   * retention, which waits a grace period after the last reference, cannot
   * delete one between that check and the page that shows it.
   */
  /**
   * Records the images a page is about to show as referenced, inserting the
   * metadata of those the captures directory supplies, and returns which of
   * `referenced` have a metadata row: the site serves no image without one.
   */
  async touchImages(
    repositoryKey: string,
    repositoryId: string,
    local: readonly HostedImageRow[],
    referenced: readonly string[]
  ): Promise<string[]> {
    return this.sqlProvider().begin(async (tx) => {
      await lockScreens(tx, repositoryKey);
      if (local.length > 0) {
        await tx`
          insert into screen_images (repository_id, digest, content_type, byte_size)
          select ${repositoryId}, digest, content_type, byte_size
          from unnest(
            ${local.map((image) => image.digest)}::text[],
            ${local.map((image) => image.contentType)}::text[],
            ${local.map((image) => image.byteSize)}::integer[]
          ) as image(digest, content_type, byte_size)
          on conflict (repository_id, digest) do update
            set last_referenced_at = now()`;
      }
      if (referenced.length === 0) return [];
      const recorded = await tx<{ digest: string }[]>`
        update screen_images
        set last_referenced_at = now()
        where repository_id = ${repositoryId} and digest = any(${[...referenced]}::text[])
        returning digest`;
      return recorded.map((row) => row.digest);
    });
  }

  /** Replaces a pull request's or branch's page, reopening a closed pull request. */
  async publishRef(repositoryId: string, ref: HostedRef, snapshot: HostedSnapshotInput): Promise<void> {
    const sql = this.sqlProvider();
    await sql`
      insert into screen_snapshots (
        repository_id, ref_kind, ref_name, head_commit, manifest, images, page_html, published_at, closed_at
      ) values (
        ${repositoryId}, ${ref.kind}, ${ref.name}, ${snapshot.headCommit},
        ${sql.json(snapshot.manifest as Parameters<Sql["json"]>[0])}, ${snapshot.images}::text[], ${snapshot.pageHtml}, now(), null
      )
      on conflict (repository_id, ref_kind, ref_name) do update
        set head_commit = excluded.head_commit,
            manifest = excluded.manifest,
            images = excluded.images,
            page_html = excluded.page_html,
            published_at = excluded.published_at,
            closed_at = null`;
  }

  /** Marks a pull request closed; retention deletes its page after a grace period. */
  async closePullRequest(repositoryId: string, number: string): Promise<boolean> {
    const rows = await this.sqlProvider()`
      update screen_snapshots
      set closed_at = now()
      where repository_id = ${repositoryId} and ref_kind = 'pr' and ref_name = ${number} and closed_at is null
      returning ref_name`;
    return rows.length > 0;
  }

  /**
   * Replaces `main`'s page and records each screen whose image changed, but
   * only for the commit repository sync last recorded: a sync of an older
   * commit that finishes late must not replace a newer page.
   */
  async publishMain(
    repositoryKey: string,
    repositoryId: string,
    snapshot: HostedSnapshotInput,
    screenImages: ReadonlyMap<string, string>,
    changedImages: (previous: ReadonlyMap<string, string>, current: ReadonlyMap<string, string>) => Array<{ key: string; digest: string }>,
    /** The pull request the commit merged, recorded with each image change. */
    pullRequest: number | null = null
  ): Promise<MainPublishResult> {
    return this.sqlProvider().begin(async (tx) => {
      await lockScreens(tx, repositoryKey);
      const checkpoints = await tx<{ commit_sha: string }[]>`
        select commit_sha from repository_sync_checkpoints where repository_id = ${repositoryId}`;
      const synced = checkpoints[0]?.commit_sha ?? null;
      if (synced !== snapshot.headCommit) return { outcome: "superseded" as const, synced_commit: synced };
      const latest = await tx<{ screen_key: string; digest: string }[]>`
        select distinct on (screen_key) screen_key, digest
        from screen_history
        where repository_id = ${repositoryId}
        order by screen_key, id desc`;
      const changed = changedImages(new Map(latest.map((row) => [row.screen_key, row.digest])), screenImages);
      if (changed.length > 0) {
        await tx`
          insert into screen_history (repository_id, screen_key, digest, commit_sha, pull_request)
          select ${repositoryId}, screen_key, digest, ${snapshot.headCommit}, ${pullRequest}
          from unnest(
            ${changed.map((row) => row.key)}::text[],
            ${changed.map((row) => row.digest)}::text[]
          ) with ordinality as change(screen_key, digest, position)
          order by position`;
      }
      await tx`
        insert into screen_snapshots (
          repository_id, ref_kind, ref_name, head_commit, manifest, images, page_html, published_at
        ) values (
          ${repositoryId}, 'main', 'main', ${snapshot.headCommit},
          ${jsonValue(tx, snapshot.manifest)}, ${snapshot.images}::text[], ${snapshot.pageHtml}, now()
        )
        on conflict (repository_id, ref_kind, ref_name) do update
          set head_commit = excluded.head_commit,
              manifest = excluded.manifest,
              images = excluded.images,
              page_html = excluded.page_html,
              published_at = excluded.published_at`;
      await tx`
        insert into audit_events (event_kind, detail)
        values (
          'hosted_screens_main_published',
          ${jsonValue(tx, {
            repository: repositoryKey,
            commit: snapshot.headCommit,
            images: snapshot.images.length,
            history_added: changed.length,
          })}
        )`;
      return { outcome: "published" as const, history_added: changed.length };
    });
  }

  /**
   * Deletes the pages retention no longer keeps — closed pull requests after
   * the grace period, and branches not published for `branchDays` — and trims
   * each screen's `main` history to its current image plus `mainHistory`
   * replaced ones. A screen `main`'s page no longer shows keeps no history, so
   * removed screens do not hold images forever; `mainScreenKeys` reads which
   * screens it shows from its stored manifest, and null (unreadable) keeps
   * every screen's history as if it were still shown.
   */
  async pruneRefs(
    repositoryKey: string,
    repositoryId: string,
    retention: HostedRetention,
    mainScreenKeys: (manifest: unknown) => readonly string[] | null
  ): Promise<HostedRefPruneResult> {
    return this.sqlProvider().begin(async (tx) => {
      await lockScreens(tx, repositoryKey);
      // Read under the lock, so a sync cannot publish screens this prune does not know of.
      const [main] = await tx<{ manifest: unknown }[]>`
        select manifest from screen_snapshots
        where repository_id = ${repositoryId} and ref_kind = 'main' and ref_name = 'main'`;
      const shown = main ? mainScreenKeys(main.manifest) : null;
      const closed = await tx`
        delete from screen_snapshots
        where repository_id = ${repositoryId}
          and ref_kind = 'pr'
          and closed_at < now() - make_interval(hours => ${retention.closedGraceHours})
        returning ref_name`;
      const branches = await tx`
        delete from screen_snapshots
        where repository_id = ${repositoryId}
          and ref_kind = 'branch'
          and published_at < now() - make_interval(days => ${retention.branchDays})
        returning ref_name`;
      const history = await tx`
        delete from screen_history history
        using (
          select id, screen_key, row_number() over (partition by screen_key order by id desc) as position
          from screen_history
          where repository_id = ${repositoryId}
        ) ranked
        where history.id = ranked.id
          and (
            ranked.position > ${retention.mainHistory + 1}
            or (${shown !== null}::boolean and ranked.screen_key <> all(${[...(shown ?? [])]}::text[]))
          )
        returning history.id`;
      const result = { closed_pull_requests: closed.length, branches: branches.length, history: history.length };
      if (result.closed_pull_requests + result.branches + result.history > 0) {
        await tx`
          insert into audit_events (event_kind, detail)
          values ('hosted_screens_refs_pruned', ${jsonValue(tx, { repository: repositoryKey, ...result })})`;
      }
      return result;
    });
  }

  /**
   * Deletes images nothing references — no page and no retained history —
   * and nothing has referenced for `graceHours`, at most `limit` at a time.
   * `remove` deletes them from the bucket while the screens lock is held,
   * and only the rows of images it removed are deleted, so a failed removal
   * is retried by the next prune.
   */
  async pruneImages(
    repositoryKey: string,
    repositoryId: string,
    options: { graceHours: number; limit: number },
    remove: (digests: string[]) => Promise<HostedImagePruneResult>
  ): Promise<HostedImagePruneResult> {
    return this.sqlProvider().begin(async (tx) => {
      await lockScreens(tx, repositoryKey);
      const candidates = await tx<{ digest: string }[]>`
        select image.digest
        from screen_images image
        where image.repository_id = ${repositoryId}
          and image.last_referenced_at < now() - make_interval(hours => ${options.graceHours})
          and not exists (
            select 1 from screen_snapshots snapshot
            where snapshot.repository_id = image.repository_id
              and snapshot.images @> array[image.digest]
          )
          and not exists (
            select 1 from screen_history history
            where history.repository_id = image.repository_id
              and history.digest = image.digest
          )
        order by image.last_referenced_at, image.digest
        limit ${options.limit}
        for update of image`;
      if (candidates.length === 0) return { deleted: [], failed: [] };
      const result = await remove(candidates.map((row) => row.digest));
      if (result.deleted.length > 0) {
        await tx`
          delete from screen_images
          where repository_id = ${repositoryId} and digest = any(${result.deleted}::text[])`;
        await tx`
          insert into audit_events (event_kind, detail)
          values (
            'hosted_screen_images_pruned',
            ${jsonValue(tx, { repository: repositoryKey, deleted: result.deleted.length, failed: result.failed.length })}
          )`;
      }
      return result;
    });
  }
}

export interface HostedPage {
  html: string;
  headCommit: string;
  publishedAt: Date;
}

export interface HostedImage {
  contentType: string;
  byteSize: number;
}

/** What the hosted site reads, with the reader role. */
export class PostgresHostedScreensReader {
  constructor(private readonly sqlProvider: () => Sql) {}

  async page(repositoryKey: string, ref: { kind: "main" } | HostedRef): Promise<HostedPage | null> {
    const name = ref.kind === "main" ? "main" : ref.name;
    const rows = await this.sqlProvider()<{ page_html: string; head_commit: string; published_at: Date }[]>`
      select snapshot.page_html, snapshot.head_commit, snapshot.published_at
      from screen_snapshots snapshot
      join repositories repository on repository.id = snapshot.repository_id
      where repository.key = ${repositoryKey}
        and snapshot.ref_kind = ${ref.kind}
        and snapshot.ref_name = ${name}`;
    const row = rows[0];
    return row ? { html: row.page_html, headCommit: row.head_commit, publishedAt: row.published_at } : null;
  }

  async image(repositoryKey: string, digest: string): Promise<HostedImage | null> {
    const rows = await this.sqlProvider()<{ content_type: string; byte_size: number }[]>`
      select image.content_type, image.byte_size
      from screen_images image
      join repositories repository on repository.id = image.repository_id
      where repository.key = ${repositoryKey} and image.digest = ${digest}`;
    const row = rows[0];
    return row ? { contentType: row.content_type, byteSize: row.byte_size } : null;
  }
}
