/**
 * Hosted screens against a disposable database: the roles and row policies
 * that keep the capture publisher away from `main`, and the publish, history,
 * and retention queries. Object storage is an in-memory fake; nothing here
 * reaches the network.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import postgres from "postgres";
import type { ObjectStore } from "../../src/adapters/object-store/s3.js";
import { PostgresHostedScreensRepository } from "../../src/adapters/postgres/hosted-screens-repository.js";
import { DEFAULT_HOSTED_CHECK_DEPENDENCIES } from "../../src/commands/hosted.js";
import { migrateDatabase } from "../../src/commands/migrate.js";
import { publishMainScreens, runScreensPublishCommand } from "../../src/commands/screens-hosting.js";
import { compileContractManifest } from "../../src/contract/manifest.js";
import { screenSettingsForRepository } from "../../src/contract/screen-catalog.js";
import { changedScreenImages, hostedImageKey } from "../../src/contract/screen-hosting.js";
import { withRole, type TielineRole } from "../support/db.js";
import { requireIntegrationDatabaseAdminUrl } from "../support/integration-database-preflight.js";
import { captureIO, createScreensWorkspace, REPO_KEY } from "../support/screen-fixtures.js";

const adminUrl = requireIntegrationDatabaseAdminUrl(process.env);

await migrateDatabase(adminUrl);
const sql = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => undefined });
const repositoryKey = `hosted-screens-${Date.now()}`;
const digest = (character: string): string => character.repeat(64);
const commit = (character: string): string => character.repeat(40);
const repository = new PostgresHostedScreensRepository(() => sql);
// Login roles a test creates, dropped however it ends.
const createdRoles: string[] = [];
const as = <T>(role: TielineRole, operation: () => Promise<T>): Promise<T> => withRole(sql, role, operation);
const PUBLISHER = "tieline_capture_publisher";
const SYNC = "tieline_repository_sync";
const snapshot = (images: string[], page: string, head = commit("1")) => ({
  headCommit: head,
  manifest: { schema_version: 3 },
  images,
  pageHtml: page,
});

class MemoryStore implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  async head(key: string): Promise<boolean> {
    return this.objects.has(key);
  }
  async get(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key) ?? null;
  }
  async put(key: string, body: Uint8Array): Promise<void> {
    this.objects.set(key, body);
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

const workspace = createScreensWorkspace({
  screens: { enabled: true, hosted: { enabled: true, bucket: "acme-screens" } },
  catalog: {
    ".tieline/screens/NOTES.yaml": "",
  },
});

let repositoryId = "";
try {
  const [created] = await sql<{ id: string }[]>`
    insert into repositories (key, display_name)
    values (${repositoryKey}, ${repositoryKey})
    returning id`;
  repositoryId = created!.id;

  // The publisher records images and replaces a pull request's page.
  await as(PUBLISHER, () =>
    repository.touchImages(repositoryKey, repositoryId, [{ digest: digest("a"), contentType: "image/png", byteSize: 10 }], [digest("a")])
  );
  await as(PUBLISHER, () => repository.publishRef(repositoryId, { kind: "pr", name: "12" }, snapshot([digest("a")], "<p>first</p>")));
  await as(PUBLISHER, () => repository.publishRef(repositoryId, { kind: "pr", name: "12" }, snapshot([digest("a")], "<p>second</p>", commit("2"))));
  const prRows = await sql<{ page_html: string; head_commit: string }[]>`
    select page_html, head_commit from screen_snapshots
    where repository_id = ${repositoryId} and ref_kind = 'pr' and ref_name = '12'`;
  assert.deepEqual(prRows.map((row) => [row.page_html, row.head_commit]), [["<p>second</p>", commit("2")]], "a publish replaces the ref's page");
  assert.equal((await as(PUBLISHER, () => repository.snapshot(repositoryId, "pr", "12")))?.headCommit, commit("2"));

  // Closing marks the pull request once; publishing again reopens it.
  assert.equal(await as(PUBLISHER, () => repository.closePullRequest(repositoryId, "12")), true);
  assert.equal(await as(PUBLISHER, () => repository.closePullRequest(repositoryId, "12")), false);
  await as(PUBLISHER, () => repository.publishRef(repositoryId, { kind: "pr", name: "12" }, snapshot([digest("a")], "<p>third</p>")));
  const [reopened] = await sql<{ closed_at: Date | null }[]>`
    select closed_at from screen_snapshots where repository_id = ${repositoryId} and ref_kind = 'pr' and ref_name = '12'`;
  assert.equal(reopened!.closed_at, null);

  // main is written only by repository sync, and only for the synced commit.
  assert.deepEqual(
    await as(SYNC, () =>
      repository.publishMain(repositoryKey, repositoryId, snapshot([digest("a")], "<p>main</p>"), new Map([["notes-list", digest("a")]]), changedScreenImages)
    ),
    { outcome: "superseded", synced_commit: null }
  );
  await sql`
    insert into repository_sync_checkpoints (repository_id, commit_sha, synced_at)
    values (${repositoryId}, ${commit("1")}, now())`;
  assert.deepEqual(
    await as(SYNC, () =>
      repository.publishMain(
        repositoryKey,
        repositoryId,
        snapshot([digest("a"), digest("b")], "<p>main</p>"),
        new Map([
          ["notes-list", digest("a")],
          ["notes-list-empty", digest("b")],
        ]),
        changedScreenImages
      )
    ),
    { outcome: "published", history_added: 2 }
  );
  await sql`update repository_sync_checkpoints set commit_sha = ${commit("3")} where repository_id = ${repositoryId}`;
  assert.deepEqual(
    await as(SYNC, () =>
      repository.publishMain(
        repositoryKey,
        repositoryId,
        snapshot([digest("c"), digest("b")], "<p>main 3</p>", commit("3")),
        new Map([
          ["notes-list", digest("c")],
          ["notes-list-empty", digest("b")],
        ]),
        changedScreenImages
      )
    ),
    { outcome: "published", history_added: 1 },
    "only the screen whose image changed adds history"
  );
  // A late sync of an older commit does not replace the newer page.
  assert.deepEqual(
    await as(SYNC, () =>
      repository.publishMain(repositoryKey, repositoryId, snapshot([digest("a")], "<p>stale</p>"), new Map(), changedScreenImages)
    ),
    { outcome: "superseded", synced_commit: commit("3") }
  );
  const [main] = await sql<{ page_html: string }[]>`
    select page_html from screen_snapshots where repository_id = ${repositoryId} and ref_kind = 'main'`;
  assert.equal(main!.page_html, "<p>main 3</p>");

  // The publisher cannot reach main, history, deletion, or other columns.
  await assert.rejects(
    as(PUBLISHER, () => repository.publishMain(repositoryKey, repositoryId, snapshot([], "<p>x</p>", commit("3")), new Map(), changedScreenImages)),
    /permission denied/
  );
  await assert.rejects(
    as(PUBLISHER, () => sql`
      insert into screen_snapshots (repository_id, ref_kind, ref_name, head_commit, manifest, images, page_html)
      values (${repositoryId}, 'main', 'main', ${commit("9")}, '{}', '{}', 'forged')`),
    /row-level security/
  );
  assert.equal(
    (await as(PUBLISHER, () => sql`update screen_snapshots set page_html = 'forged' where repository_id = ${repositoryId} and ref_kind = 'main' returning ref_name`)).length,
    0,
    "the publisher's updates never match main"
  );
  await assert.rejects(
    as(PUBLISHER, () => sql`update screen_snapshots set ref_kind = 'main', ref_name = 'main' where repository_id = ${repositoryId} and ref_kind = 'pr'`),
    /permission denied/
  );
  await assert.rejects(as(PUBLISHER, () => sql`delete from screen_snapshots where repository_id = ${repositoryId}`), /permission denied/);
  await assert.rejects(as(PUBLISHER, () => sql`delete from screen_images where repository_id = ${repositoryId}`), /permission denied/);
  await assert.rejects(
    as(PUBLISHER, () => sql`insert into screen_history (repository_id, screen_key, digest, commit_sha) values (${repositoryId}, 'x', ${digest("f")}, ${commit("f")})`),
    /permission denied/
  );
  await assert.rejects(as(PUBLISHER, () => sql`update screen_images set byte_size = 1 where repository_id = ${repositoryId}`), /permission denied/);
  await assert.rejects(as(PUBLISHER, () => sql`select display_name from repositories`), /permission denied/);
  await assert.rejects(as(PUBLISHER, () => sql`select 1 from user_stories limit 1`), /permission denied/);

  // The reader reads everything the site shows and writes nothing; planning
  // writers have no access at all.
  const readable = await as("tieline_reader", () => sql`
    select ref_kind from screen_snapshots where repository_id = ${repositoryId} order by ref_kind`);
  assert.deepEqual(readable.map((row) => row.ref_kind), ["main", "pr"]);
  await as("tieline_reader", () => sql`select count(*) from screen_images union all select count(*) from screen_history`);
  await assert.rejects(
    as("tieline_reader", () => sql`update screen_snapshots set page_html = 'x' where repository_id = ${repositoryId}`),
    /permission denied/
  );
  await assert.rejects(as("tieline_planning_writer", () => sql`select 1 from screen_snapshots limit 1`), /permission denied/);

  // The schema refuses malformed refs, digests, and closed branches.
  for (const [kind, name, images, closed] of [
    ["pr", "abc", [], false],
    ["branch", "../escape", [], false],
    ["branch", "feature/x", ["not-a-digest"], false],
    ["branch", "feature/x", [], true],
    ["main", "trunk", [], false],
  ] as const) {
    await assert.rejects(
      sql`
        insert into screen_snapshots (repository_id, ref_kind, ref_name, head_commit, manifest, images, page_html, closed_at)
        values (${repositoryId}, ${kind}, ${name}, ${commit("4")}, '{}', ${[...images]}::text[], '', ${closed ? new Date() : null})`,
      /violates check constraint/,
      `${kind}/${name}`
    );
  }

  // Retention: pages, then history, then images nothing references.
  await as(PUBLISHER, () => repository.publishRef(repositoryId, { kind: "branch", name: "feature/old" }, snapshot([digest("d")], "<p>old</p>")));
  await as(PUBLISHER, () => repository.publishRef(repositoryId, { kind: "branch", name: "feature/fresh" }, snapshot([digest("e")], "<p>fresh</p>")));
  await as(PUBLISHER, () => repository.closePullRequest(repositoryId, "12"));
  await sql`
    update screen_snapshots set published_at = now() - interval '8 days'
    where repository_id = ${repositoryId} and ref_name = 'feature/old'`;
  await sql`
    update screen_snapshots set closed_at = now() - interval '25 hours'
    where repository_id = ${repositoryId} and ref_kind = 'pr'`;
  for (const character of ["1", "2", "3", "4"]) {
    await sql`
      insert into screen_history (repository_id, screen_key, digest, commit_sha)
      values (${repositoryId}, 'notes-list', ${digest(character)}, ${commit("5")})`;
  }
  const retention = { branchDays: 7, mainHistory: 2, closedGraceHours: 24 };
  const read: unknown[] = [];
  // main's page cannot be read: every screen's history is kept as if still shown.
  assert.deepEqual(
    await as(SYNC, () =>
      repository.pruneRefs(repositoryKey, repositoryId, retention, (manifest) => {
        read.push(manifest);
        return null;
      })
    ),
    { closed_pull_requests: 1, branches: 1, history: 3 }
  );
  assert.deepEqual(read, [{ schema_version: 3 }], "retention reads main's stored manifest");
  const history = async () =>
    (
      await sql<{ screen_key: string; digest: string }[]>`
        select screen_key, digest from screen_history where repository_id = ${repositoryId} order by screen_key, id`
    ).map((row) => [row.screen_key, row.digest]);
  assert.deepEqual(
    await history(),
    [
      ["notes-list", digest("2")],
      ["notes-list", digest("3")],
      ["notes-list", digest("4")],
      ["notes-list-empty", digest("b")],
    ],
    "each screen keeps its current image and the last two it replaced"
  );
  // main's page no longer shows notes-list-empty: its history goes, notes-list's stays.
  assert.deepEqual(
    await as(SYNC, () => repository.pruneRefs(repositoryKey, repositoryId, retention, () => ["notes-list"])),
    { closed_pull_requests: 0, branches: 0, history: 1 }
  );
  assert.deepEqual(
    await history(),
    [
      ["notes-list", digest("2")],
      ["notes-list", digest("3")],
      ["notes-list", digest("4")],
    ],
    "a screen main no longer shows keeps no history"
  );

  // Images: unreferenced and quiet past the grace period are deleted;
  // referenced, recently referenced, and failed removals are kept.
  await as(PUBLISHER, () =>
    repository.touchImages(
      repositoryKey,
      repositoryId,
      ["a", "b", "c", "d", "e", "2", "7", "8"].map((character) => ({ digest: digest(character), contentType: "image/png", byteSize: 10 })),
      []
    )
  );
  await sql`
    update screen_images set last_referenced_at = now() - interval '2 days'
    where repository_id = ${repositoryId} and digest <> ${digest("8")}`;
  const removed: string[][] = [];
  const pruned = await as(SYNC, () =>
    repository.pruneImages(repositoryKey, repositoryId, { graceHours: 24, limit: 10 }, async (digests) => {
      removed.push(digests);
      return {
        deleted: digests.filter((value) => value !== digest("7")),
        failed: digests.filter((value) => value === digest("7")).map((value) => ({ digest: value, detail: "HTTP 500" })),
      };
    })
  );
  // a: no page shows it any more; d: its branch expired. b, c (main), e
  // (fresh branch), and 2 (history) are referenced; 8 was just referenced.
  assert.deepEqual(removed, [[digest("7"), digest("a"), digest("d")].sort()]);
  assert.deepEqual(pruned.deleted.sort(), [digest("a"), digest("d")].sort());
  const remaining = await sql<{ digest: string }[]>`
    select digest from screen_images where repository_id = ${repositoryId} order by digest`;
  assert.deepEqual(
    remaining.map((row) => row.digest),
    [digest("2"), digest("7"), digest("8"), digest("b"), digest("c"), digest("e")].sort()
  );
  const touched = await sql<{ content_type: string; byte_size: number }[]>`
    select content_type, byte_size from screen_images where repository_id = ${repositoryId} and digest = ${digest("b")}`;
  assert.deepEqual(touched[0], { content_type: "image/png", byte_size: 10 });
  const audits = await sql<{ event_kind: string }[]>`
    select event_kind from audit_events
    where detail->>'repository' = ${repositoryKey}
    order by id`;
  assert.deepEqual(
    [...new Set(audits.map((row) => row.event_kind))].sort(),
    ["hosted_screen_images_pruned", "hosted_screens_main_published", "hosted_screens_refs_pruned"]
  );

  // The commands, end to end through the real queries: main publishes its
  // page, then a pull request that re-captured a screen publishes against it.
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const capture = (label: string): { bytes: Buffer; digest: string } => {
    const bytes = Buffer.concat([signature, Buffer.from(label)]);
    return { bytes, digest: createHash("sha256").update(bytes).digest("hex") };
  };
  const captureAs = (image: { bytes: Buffer; digest: string }): void => {
    workspace.write(
      ".tieline/screens/NOTES.yaml",
      `version: 1
capability: NOTES
screens:
  - key: notes-list
    title: Notes list
    route: /notes
    kind: page
    when: A member opens Notes.
    image:
      path: notes-list.png
      sha256: ${image.digest}
`
    );
    workspace.write(".tieline/captures/notes-list.png", "");
    writeFileSync(`${workspace.root}/.tieline/captures/notes-list.png`, image.bytes);
  };
  // The fixture is keyed acme-notes; key it like the repository synced here.
  for (const path of [".tieline/config.json", ".tieline/spec/notes.yaml"]) {
    workspace.write(path, readFileSync(`${workspace.root}/${path}`, "utf8").replaceAll(REPO_KEY, repositoryKey));
  }
  const before = capture("notes, on main");
  const after = capture("notes, on the branch");
  captureAs(before);
  const screenSettings = screenSettingsForRepository(workspace.root)!;
  assert.ok(screenSettings.hosted);
  const settings = { ...screenSettings, hosted: screenSettings.hosted };
  const store = new MemoryStore();
  await sql`update repository_sync_checkpoints set commit_sha = ${commit("6")} where repository_id = ${repositoryId}`;
  const mainResult = await as(SYNC, () =>
    publishMainScreens({
      root: workspace.root,
      repositoryKey,
      specDirectory: ".tieline/spec",
      manifest: compileContractManifest({ repositoryRoot: workspace.root, repositoryKey, specDirectory: ".tieline/spec" }),
      commit: commit("6"),
      settings,
      repository,
      store,
    })
  );
  assert.equal(mainResult.outcome, "published");
  assert.ok(store.objects.has(hostedImageKey(repositoryKey, before.digest)));
  const [published] = await sql<{ images: string[]; page_html: string }[]>`
    select images, page_html from screen_snapshots where repository_id = ${repositoryId} and ref_kind = 'main'`;
  assert.deepEqual(published!.images, [before.digest]);
  assert.ok(published!.page_html.includes(`images/${before.digest}`));

  captureAs(after);
  const { io, output } = captureIO();
  const code = await as(PUBLISHER, () =>
    runScreensPublishCommand({ repository: workspace.root, pullRequest: "31", json: true }, io, {
      repository: () => repository,
      store: () => store,
      close: async () => undefined,
      headCommit: () => commit("7"),
    })
  );
  assert.equal(code, 0, output());
  const result = JSON.parse(output()) as { images: { uploaded: number }; changes: { screens: Record<string, number> } };
  assert.equal(result.images.uploaded, 1);
  assert.deepEqual(result.changes.screens, { added: 0, changed: 1, removed: 0 });
  assert.ok(store.objects.has(hostedImageKey(repositoryKey, after.digest)));
  const [pullRequest] = await sql<{ head_commit: string; images: string[]; page_html: string }[]>`
    select head_commit, images, page_html from screen_snapshots
    where repository_id = ${repositoryId} and ref_kind = 'pr' and ref_name = '31'`;
  assert.equal(pullRequest!.head_commit, commit("7"));
  // The page shows main's image beside the branch's, so its snapshot keeps both from retention.
  assert.deepEqual(pullRequest!.images, [after.digest, before.digest].sort());
  assert.ok(pullRequest!.page_html.includes(`"before_image":{"src":"images/${before.digest}","label":"main"}`));

  // hosted check reads row-security membership and every table write from
  // the database itself, as login roles an operator might create.
  const suffix = Date.now().toString(36);
  const password = randomUUID();
  const checkRoles = { copied: `tieline_check_copied_${suffix}`, reader: `tieline_check_reader_${suffix}`, forger: `tieline_check_forger_${suffix}` };
  createdRoles.push(...Object.values(checkRoles));
  for (const role of Object.values(checkRoles)) await sql.unsafe(`create role ${role} login password '${password}'`);
  // The reader's grants copied by hand, without membership in tieline_reader.
  await sql.unsafe(`grant usage on schema public to ${checkRoles.copied}`);
  await sql.unsafe(`grant select on screen_snapshots, screen_images to ${checkRoles.copied}`);
  await sql.unsafe(`grant select (id, key) on repositories to ${checkRoles.copied}`);
  await sql.unsafe(`grant tieline_reader to ${checkRoles.reader}`);
  // The publisher, plus a write on append-only change history.
  await sql.unsafe(`grant tieline_capture_publisher to ${checkRoles.forger}`);
  await sql.unsafe(`grant insert on contract_change_events to ${checkRoles.forger}`);
  const stateOf = (role: string) => {
    const url = new URL(adminUrl);
    url.username = role;
    url.password = password;
    return DEFAULT_HOSTED_CHECK_DEPENDENCIES.database(url.toString(), repositoryKey);
  };
  const copied = await stateOf(checkRoles.copied);
  assert.equal(copied.privileges["SELECT on screen_snapshots"], true, "the copied grants are there");
  assert.equal(copied.readsPublishedRows, false, "but row security shows a non-member nothing");
  assert.deepEqual(copied.writes, []);
  const reader = await stateOf(checkRoles.reader);
  assert.equal(reader.readsPublishedRows, true);
  assert.equal(reader.writesPublishedRows, false);
  assert.deepEqual(reader.writes, []);
  const forger = await stateOf(checkRoles.forger);
  assert.equal(forger.writesPublishedRows, true);
  assert.equal(forger.writesMainRows, false);
  assert.deepEqual(forger.writes, [
    "INSERT on contract_change_events",
    "INSERT on screen_images",
    "UPDATE on screen_images",
    "INSERT on screen_snapshots",
    "UPDATE on screen_snapshots",
  ]);

  console.log("hosted screens integration passed");
} finally {
  for (const role of createdRoles) {
    await sql.unsafe(`drop owned by ${role}`);
    await sql.unsafe(`drop role ${role}`);
  }
  if (repositoryId) {
    await sql`delete from screen_snapshots where repository_id = ${repositoryId}`;
    await sql`delete from screen_history where repository_id = ${repositoryId}`;
    await sql`delete from screen_images where repository_id = ${repositoryId}`;
    await sql`delete from repository_sync_checkpoints where repository_id = ${repositoryId}`;
    await sql`delete from repositories where id = ${repositoryId}`;
  }
  workspace.cleanup();
  await sql.end({ timeout: 5 });
}
