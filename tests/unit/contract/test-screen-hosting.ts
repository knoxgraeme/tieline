import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  hasObjectStoreCredentials,
  ObjectStoreError,
  OBJECT_STORE_LIMITS,
  readObjectStoreSettings,
  S3ObjectStore,
  signRequest,
  type ObjectStore,
} from "../../../src/adapters/object-store/s3.js";
import type {
  HostedImagePruneResult,
  HostedImageRow,
  HostedRefPruneResult,
  HostedRetention,
  HostedSnapshotInput,
  MainPublishResult,
  StoredHostedSnapshot,
} from "../../../src/adapters/postgres/hosted-screens-repository.js";
import {
  publishMainScreens,
  runScreensCloseCommand,
  runScreensPruneCommand,
  runScreensPublishCommand,
  shownImages,
  type HostedScreensDependencies,
  type HostedScreensRepository,
  type HostedSettings,
} from "../../../src/commands/screens-hosting.js";
import { readScreensConfig } from "../../../src/config.js";
import {
  compileContractManifest,
  parseStoredContractManifest,
  storedContractManifest,
  type ContractManifest,
} from "../../../src/contract/manifest.js";
import type { ReviewComparison, ScreenChangeAspect } from "../../../src/contract/review-changes.js";
import { screenSettingsForRepository, type ScreenSettings } from "../../../src/contract/screen-catalog.js";
import {
  changedScreenImages,
  HOSTED_SCREEN_LIMITS,
  hostedImageKey,
  hostedImageReferences,
  parseHostedRef,
  readLocalHostedImage,
  screenImageDigests,
  sniffImageType,
} from "../../../src/contract/screen-hosting.js";
import type { HostedRef } from "../../../src/contract/screen-hosting.js";
import { renderHostedReviewPage, writeWorkspaceReviewPage } from "../../../src/tieline/review.js";
import { parse as parseYaml } from "yaml";
import { report, test } from "../../support/harness.js";
import {
  captureIO,
  createScreensWorkspace,
  REPO_KEY,
  SHARING_CATALOG_YAML,
  type ScreensWorkspace,
} from "../../support/screen-fixtures.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const COMMIT = "a".repeat(40);
const BUCKET = "acme-screens";
const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const png = (label: string): Buffer => Buffer.concat([PNG, Buffer.from(label)]);

const workspaces: ScreensWorkspace[] = [];

const LIST_IMAGE = png("notes-list");
const EMPTY_IMAGE = png("notes-list-empty");
const OLD_LIST_IMAGE = png("notes-list, before");

function catalogYaml(listDigest = sha256(LIST_IMAGE)): string {
  return `version: 1
capability: NOTES
screens:
  - key: notes-list
    title: Notes list
    route: /notes
    kind: page
    when: A member opens Notes.
    image:
      path: notes-list.png
      sha256: ${listDigest}
  - key: notes-list-empty
    title: Notes list, no notes yet
    route: /notes
    kind: state
    when: A member without notes opens Notes.
    image:
      path: notes-list-empty.png
      sha256: ${sha256(EMPTY_IMAGE)}
  - key: note-saved-toast
    title: Note saved
    route: /notes/:noteId
    kind: toast
    when: A member saves a note.
    not_captured:
      reason: unstable
      detail: The toast disappears before the screenshot.
`;
}

/** Acme Notes with hosted screens on, both screenshots captured. */
function hostedWorkspace(options: { hosted?: unknown; images?: boolean } = {}): ScreensWorkspace {
  const ws = createScreensWorkspace({
    screens: {
      enabled: true,
      ...(options.hosted === undefined
        ? { hosted: { enabled: true, bucket: BUCKET, retention: { branch_days: 7, main_history: 2 } } }
        : options.hosted === null
          ? {}
          : { hosted: options.hosted }),
    },
    catalog: {
      ".tieline/screens/NOTES.yaml": catalogYaml(),
      ".tieline/screens/SHARING.yaml": SHARING_CATALOG_YAML,
    },
  });
  workspaces.push(ws);
  if (options.images !== false) {
    writeImage(ws, "notes-list.png", LIST_IMAGE);
    writeImage(ws, "notes-list-empty.png", EMPTY_IMAGE);
  }
  return ws;
}

/** Writes a screenshot's bytes; the workspace's `write` creates the directory. */
function writeImage(ws: ScreensWorkspace, name: string, bytes: Buffer): void {
  ws.write(`.tieline/captures/${name}`, "");
  writeFileSync(`${ws.root}/.tieline/captures/${name}`, bytes);
}

function settingsOf(ws: ScreensWorkspace): ScreenSettings {
  const settings = screenSettingsForRepository(ws.root);
  assert.ok(settings);
  return settings;
}

function hostedSettingsOf(ws: ScreensWorkspace): HostedSettings {
  const settings = settingsOf(ws);
  assert.ok(settings.hosted);
  return { ...settings, hosted: settings.hosted };
}

function manifestOf(ws: ScreensWorkspace): ContractManifest {
  return compileContractManifest({ repositoryRoot: ws.root, repositoryKey: REPO_KEY, specDirectory: ".tieline/spec" });
}

/** An in-memory bucket that records every request. */
class FakeStore implements ObjectStore {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  readonly calls: string[] = [];
  failPut: string | null = null;
  failDelete = new Set<string>();

  async head(key: string): Promise<boolean> {
    this.calls.push(`head ${key}`);
    return this.objects.has(key);
  }

  async get(key: string, maxBytes: number): Promise<Uint8Array | null> {
    this.calls.push(`get ${key}`);
    const object = this.objects.get(key);
    if (object && object.bytes.byteLength > maxBytes) {
      throw new ObjectStoreError(`Object storage GET '${key}' is larger than ${maxBytes} bytes.`, 200, key);
    }
    return object?.bytes ?? null;
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    this.calls.push(`put ${key}`);
    if (this.failPut === key) throw new ObjectStoreError(`Object storage PUT '${key}' failed: HTTP 403 (AccessDenied).`, 403, key);
    this.objects.set(key, { bytes: body, contentType });
  }

  async delete(key: string): Promise<void> {
    this.calls.push(`delete ${key}`);
    if (this.failDelete.has(key)) throw new ObjectStoreError(`Object storage DELETE '${key}' failed: HTTP 500.`, 500, key);
    this.objects.delete(key);
  }
}

/** An in-memory stand-in for the Postgres repository. */
class FakeRepository implements HostedScreensRepository {
  readonly calls: string[] = [];
  readonly images = new Map<string, HostedImageRow>();
  readonly snapshots = new Map<string, HostedSnapshotInput & { closed: boolean }>();
  repository: string | null = "repository-id";
  main: StoredHostedSnapshot | null = null;
  mainResult: MainPublishResult = { outcome: "published", history_added: 1 };
  pruneCandidates: string[] = [];
  lastRetention: HostedRetention | null = null;
  /** What the prune's reading of main's page returned, as the database would call it. */
  lastMainScreenKeys: readonly string[] | null | undefined = undefined;
  lastScreenImages: ReadonlyMap<string, string> | null = null;

  async repositoryId(key: string): Promise<string | null> {
    this.calls.push(`repositoryId ${key}`);
    return this.repository;
  }

  async snapshot(_repositoryId: string, kind: string, name: string): Promise<StoredHostedSnapshot | null> {
    this.calls.push(`snapshot ${kind}/${name}`);
    return kind === "main" ? this.main : null;
  }

  async touchImages(
    _repositoryKey: string,
    _repositoryId: string,
    local: readonly HostedImageRow[],
    referenced: readonly string[]
  ): Promise<void> {
    this.calls.push(`touch ${local.length} local of ${referenced.length}`);
    for (const row of local) this.images.set(row.digest, row);
  }

  async publishRef(_repositoryId: string, ref: HostedRef, snapshot: HostedSnapshotInput): Promise<void> {
    this.calls.push(`publish ${ref.kind}/${ref.name}`);
    this.snapshots.set(`${ref.kind}/${ref.name}`, { ...snapshot, closed: false });
  }

  async closePullRequest(_repositoryId: string, number: string): Promise<boolean> {
    this.calls.push(`close ${number}`);
    const snapshot = this.snapshots.get(`pr/${number}`);
    if (!snapshot || snapshot.closed) return false;
    snapshot.closed = true;
    return true;
  }

  async publishMain(
    _repositoryKey: string,
    _repositoryId: string,
    snapshot: HostedSnapshotInput,
    screenImages: ReadonlyMap<string, string>
  ): Promise<MainPublishResult> {
    this.calls.push("publishMain");
    this.lastScreenImages = screenImages;
    if (this.mainResult.outcome === "published") this.snapshots.set("main/main", { ...snapshot, closed: false });
    return this.mainResult;
  }

  async pruneRefs(
    _repositoryKey: string,
    _repositoryId: string,
    retention: HostedRetention,
    mainScreenKeys: (manifest: unknown) => readonly string[] | null
  ): Promise<HostedRefPruneResult> {
    this.calls.push("pruneRefs");
    this.lastRetention = retention;
    this.lastMainScreenKeys = this.main ? mainScreenKeys(this.main.manifest) : null;
    return { closed_pull_requests: 1, branches: 2, history: 3 };
  }

  async pruneImages(
    _repositoryKey: string,
    _repositoryId: string,
    options: { graceHours: number; limit: number },
    remove: (digests: string[]) => Promise<HostedImagePruneResult>
  ): Promise<HostedImagePruneResult> {
    this.calls.push(`pruneImages grace=${options.graceHours} limit=${options.limit}`);
    return remove(this.pruneCandidates);
  }
}

function dependencies(repository: FakeRepository, store: FakeStore): HostedScreensDependencies & { closed: () => number } {
  let closed = 0;
  return {
    repository: () => repository,
    store: () => store,
    close: async () => {
      closed += 1;
    },
    headCommit: () => COMMIT,
    closed: () => closed,
  };
}

const imageKey = (bytes: Buffer): string => hostedImageKey(REPO_KEY, sha256(bytes));

function embeddedScreens(page: string): Array<{
  key: string;
  image: { src: string; label: string } | null;
  before_image?: { src: string; label: string };
}> {
  const match = /<script type="application\/json" id="screen-data">([\s\S]*?)<\/script>/.exec(page);
  assert.ok(match, "the page embeds its screen data");
  return (JSON.parse(match[1]!) as { screens: ReturnType<typeof embeddedScreens> }).screens;
}

console.log("hosted screens: configuration");

await test("leaves hosting off unless the hosted block enables it, and applies retention defaults", () => {
  assert.equal(readScreensConfig({ screens: { enabled: true } })?.hosted, null);
  assert.equal(
    readScreensConfig({ screens: { enabled: true, hosted: { enabled: false, bucket: BUCKET } } })?.hosted,
    null
  );
  assert.deepEqual(readScreensConfig({ screens: { enabled: true, hosted: { enabled: true, bucket: BUCKET } } })?.hosted, {
    bucket: BUCKET,
    site_url: null,
    retention: { branch_days: 14, main_history: 5 },
  });
  assert.equal(
    readScreensConfig({ screens: { enabled: true, hosted: { enabled: true, bucket: BUCKET, site_url: "https://screens.example.test/" } } })
      ?.hosted?.site_url,
    "https://screens.example.test"
  );
  assert.deepEqual(
    readScreensConfig({
      screens: { enabled: true, hosted: { enabled: true, bucket: BUCKET, retention: { branch_days: 3, main_history: 0 } } },
    })?.hosted?.retention,
    { branch_days: 3, main_history: 0 }
  );
});

await test("rejects an invalid bucket, out-of-range retention, and unknown hosted fields", () => {
  for (const hosted of [
    { enabled: true },
    { enabled: true, bucket: "Acme_Screens" },
    { enabled: true, bucket: "a" },
    { enabled: true, bucket: "acme..screens" },
    { enabled: true, bucket: BUCKET, retention: { branch_days: 0 } },
    { enabled: true, bucket: BUCKET, retention: { branch_days: 366 } },
    { enabled: true, bucket: BUCKET, retention: { main_history: -1 } },
    { enabled: true, bucket: BUCKET, retention: { main_history: 101 } },
    { enabled: true, bucket: BUCKET, endpoint: "https://storage.example.test" },
    { enabled: true, bucket: BUCKET, site_url: "http://screens.example.test" },
    { enabled: true, bucket: BUCKET, site_url: "https://user:pass@screens.example.test" },
    { enabled: true, bucket: BUCKET, site_url: "https://screens.example.test/?ref=main" },
  ]) {
    assert.throws(() => readScreensConfig({ screens: { enabled: true, hosted } }), /screens\.hosted/, JSON.stringify(hosted));
  }
});

console.log("hosted screens: object storage");

const STORE_ENV = {
  AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
  AWS_SECRET_ACCESS_KEY: "secret-example-key",
  AWS_REGION: "aws-us-east-2",
  AWS_ENDPOINT_URL_S3: "https://storage.example.test",
};

await test("signs requests exactly as AWS Signature Version 4 specifies", () => {
  // The GET Object example from the AWS Signature Version 4 documentation.
  const headers = signRequest(
    {
      method: "GET",
      host: "examplebucket.s3.amazonaws.com",
      path: "/test.txt",
      headers: { Range: "bytes=0-9" },
      payloadHash: sha256(""),
    },
    {
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      sessionToken: null,
      region: "us-east-1",
    },
    new Date("2013-05-24T00:00:00Z")
  );
  assert.equal(
    headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
  );
  assert.equal(headers["x-amz-date"], "20130524T000000Z");
  assert.equal(headers.host, undefined, "fetch sends the host itself");
});

await test("reads the store from the standard AWS variables and refuses unsafe endpoints", () => {
  const settings = readObjectStoreSettings(STORE_ENV, BUCKET);
  assert.equal(settings.endpoint.href, "https://storage.example.test/");
  assert.equal(settings.region, "aws-us-east-2");
  assert.equal(settings.sessionToken, null);
  assert.equal(
    readObjectStoreSettings({ ...STORE_ENV, AWS_ENDPOINT_URL_S3: undefined, AWS_REGION: "us-east-1" }, BUCKET).endpoint.href,
    "https://s3.us-east-1.amazonaws.com/"
  );
  assert.equal(
    readObjectStoreSettings({ ...STORE_ENV, AWS_ENDPOINT_URL_S3: "http://127.0.0.1:8333" }, BUCKET).endpoint.href,
    "http://127.0.0.1:8333/"
  );
  for (const [env, pattern] of [
    [{ ...STORE_ENV, AWS_ENDPOINT_URL_S3: "http://storage.example.test" }, /must use https/],
    [{ ...STORE_ENV, AWS_ENDPOINT_URL_S3: "https://user:pass@storage.example.test" }, /credentials/],
    [{ ...STORE_ENV, AWS_ENDPOINT_URL_S3: "https://storage.example.test/prefix" }, /without a path/],
    [{ ...STORE_ENV, AWS_ENDPOINT_URL_S3: "not a url" }, /not a valid URL/],
    [{ ...STORE_ENV, AWS_SECRET_ACCESS_KEY: "" }, /AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY/],
    [{ ...STORE_ENV, AWS_REGION: "" }, /AWS_REGION/],
  ] as const) {
    assert.throws(() => readObjectStoreSettings(env, BUCKET), pattern);
  }
  assert.throws(() => readObjectStoreSettings(STORE_ENV, "Not A Bucket"), /not a valid bucket name/);
});

await test("reads only the TIELINE_SCREENS_S3_* settings when any is set, so a host's own AWS role never mixes in", () => {
  // What AWS Lambda, under Netlify or Vercel functions, sets for the function's own role.
  const lambda = {
    AWS_ACCESS_KEY_ID: "ASIALAMBDAROLE",
    AWS_SECRET_ACCESS_KEY: "lambda-secret",
    AWS_SESSION_TOKEN: "lambda-session",
    AWS_REGION: "us-east-1",
  };
  const settings = readObjectStoreSettings(
    {
      ...lambda,
      TIELINE_SCREENS_S3_ENDPOINT: "https://br-example.storage.c-1.us-east-2.aws.neon.tech",
      TIELINE_SCREENS_S3_REGION: "us-east-2",
      TIELINE_SCREENS_S3_ACCESS_KEY_ID: "nak_live_example",
      TIELINE_SCREENS_S3_SECRET_ACCESS_KEY: "nsk_live_example",
    },
    BUCKET
  );
  assert.equal(settings.accessKeyId, "nak_live_example");
  assert.equal(settings.secretAccessKey, "nsk_live_example");
  assert.equal(settings.region, "us-east-2");
  assert.equal(settings.sessionToken, null, "Lambda's session token is not sent with Tieline's credentials");
  assert.equal(settings.endpoint.href, "https://br-example.storage.c-1.us-east-2.aws.neon.tech/");
  assert.throws(
    () => readObjectStoreSettings({ ...lambda, TIELINE_SCREENS_S3_ENDPOINT: "https://storage.example.test" }, BUCKET),
    /TIELINE_SCREENS_S3_ACCESS_KEY_ID and TIELINE_SCREENS_S3_SECRET_ACCESS_KEY must hold/,
    "an incomplete Tieline set never falls back to the host's AWS role"
  );
  assert.equal(hasObjectStoreCredentials(lambda), true);
  assert.equal(hasObjectStoreCredentials({ ...lambda, TIELINE_SCREENS_S3_REGION: "us-east-2" }), false);
  assert.equal(hasObjectStoreCredentials({}), false);
});

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
}

function fakeFetch(responses: Array<Response | Error>): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: init?.headers as Record<string, string>,
      body: (init?.body as Uint8Array | undefined) ?? null,
    });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function storeWith(responses: Array<Response | Error>, sleeps: number[] = []): { store: S3ObjectStore; calls: FetchCall[] } {
  const { fetch: fetchImpl, calls } = fakeFetch(responses);
  return {
    store: new S3ObjectStore(readObjectStoreSettings(STORE_ENV, BUCKET), {
      fetch: fetchImpl,
      now: () => new Date("2026-10-02T12:00:00Z"),
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    }),
    calls,
  };
}

await test("puts an object path-style with its signed body digest and checks existence with HEAD", async () => {
  const body = png("put");
  const { store, calls } = storeWith([
    new Response(null, { status: 200 }),
    new Response(null, { status: 200 }),
    new Response(null, { status: 404 }),
  ]);
  await store.put("acme-notes/sha256/abc", body, "image/png");
  assert.equal(await store.head("acme-notes/sha256/abc"), true);
  assert.equal(await store.head("acme-notes/sha256/def"), false);
  const put = calls[0]!;
  assert.equal(put.url, "https://storage.example.test/acme-screens/acme-notes/sha256/abc");
  assert.equal(put.method, "PUT");
  assert.equal(put.headers["x-amz-content-sha256"], sha256(body));
  assert.equal(put.headers["content-type"], "image/png");
  assert.equal(put.headers["x-amz-date"], "20261002T120000Z");
  assert.match(
    put.headers.authorization!,
    /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261002\/aws-us-east-2\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/
  );
  assert.equal(put.body, body);
  assert.equal(calls[1]!.method, "HEAD");
  assert.equal(calls[1]!.headers["x-amz-content-sha256"], sha256(""));
});

await test("encodes key segments the way S3 signs them", async () => {
  const { store, calls } = storeWith([new Response(null, { status: 200 })]);
  await store.head("acme notes/it's (1)*");
  assert.equal(calls[0]!.url, "https://storage.example.test/acme-screens/acme%20notes/it%27s%20%281%29%2A");
});

await test("treats deleting a missing object as done", async () => {
  const { store } = storeWith([new Response(null, { status: 204 }), new Response(null, { status: 404 })]);
  await store.delete("acme-notes/sha256/abc");
  await store.delete("acme-notes/sha256/abc");
});

await test("retries a 5xx or a network failure with backoff, then succeeds", async () => {
  const sleeps: number[] = [];
  const { store, calls } = storeWith(
    [new Response("<Error><Code>SlowDown</Code></Error>", { status: 503 }), new TypeError("fetch failed"), new Response(null, { status: 200 })],
    sleeps
  );
  assert.equal(await store.head("acme-notes/sha256/abc"), true);
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [OBJECT_STORE_LIMITS.firstBackoffMs, OBJECT_STORE_LIMITS.firstBackoffMs * 4]);
});

await test("stops after the attempt limit with the last failure", async () => {
  const { store, calls } = storeWith([
    new Response(null, { status: 500 }),
    new Response(null, { status: 502 }),
    new Response("<Error><Code>InternalError</Code></Error>", { status: 500 }),
  ]);
  await assert.rejects(store.put("acme-notes/sha256/abc", png("x"), "image/png"), (error: unknown) => {
    assert.ok(error instanceof ObjectStoreError);
    assert.match(error.message, /failed after 3 attempts: HTTP 500 \(InternalError\)/);
    return true;
  });
  assert.equal(calls.length, OBJECT_STORE_LIMITS.attempts);
});

await test("fails at once on a client error, naming the store's error code", async () => {
  const { store, calls } = storeWith([new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 })]);
  await assert.rejects(store.head("acme-notes/sha256/abc"), /HEAD 'acme-notes\/sha256\/abc' failed: HTTP 403 \(AccessDenied\)/);
  assert.equal(calls.length, 1);
});

await test("stops retrying when the caller aborts", async () => {
  const controller = new AbortController();
  const { fetch: fetchImpl, calls } = fakeFetch([new TypeError("fetch failed")]);
  const store = new S3ObjectStore(readObjectStoreSettings(STORE_ENV, BUCKET), {
    fetch: fetchImpl,
    sleep: async () => {
      controller.abort(new Error("stopped"));
      throw new Error("stopped");
    },
  });
  await assert.rejects(store.head("acme-notes/sha256/abc", controller.signal), /stopped/);
  assert.equal(calls.length, 1);
});

await test("refuses object keys it could not address", async () => {
  const { store, calls } = storeWith([]);
  await assert.rejects(store.head(""), /not valid/);
  await assert.rejects(store.head("/absolute"), /not valid/);
  await assert.rejects(store.head("k".repeat(1_025)), /not valid/);
  assert.equal(calls.length, 0);
});

console.log("hosted screens: images and refs");

await test("recognizes image types by signature and never accepts SVG", () => {
  assert.equal(sniffImageType(png("x")), "image/png");
  assert.equal(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImageType(Buffer.from("GIF89a....")), "image/gif");
  assert.equal(sniffImageType(Buffer.from("RIFF\x00\x00\x00\x00WEBPVP8 ", "latin1")), "image/webp");
  assert.equal(sniffImageType(Buffer.from("\x00\x00\x00\x1cftypavif", "latin1")), "image/avif");
  assert.equal(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), null);
  assert.equal(sniffImageType(Buffer.from([0x89, 0x50])), null);
});

await test("parses the ref a publish targets and keeps main out of reach", () => {
  assert.deepEqual(parseHostedRef({ pullRequest: "123" }), { kind: "pr", name: "123" });
  assert.deepEqual(parseHostedRef({ branch: "feature/notes-empty" }), { kind: "branch", name: "feature/notes-empty" });
  for (const [input, pattern] of [
    [{}, /exactly one/],
    [{ pullRequest: "1", branch: "x" }, /exactly one/],
    [{ pullRequest: "0" }, /pull request number/],
    [{ pullRequest: "12a" }, /pull request number/],
    [{ branch: "main" }, /contract sync/],
    [{ branch: "master" }, /contract sync/],
    [{ branch: "pr-12" }, /reads \?ref=pr-12 as a pull request/],
    [{ branch: "../etc" }, /not a branch name/],
    [{ branch: "a..b" }, /not a branch name/],
    [{ branch: "trailing/" }, /not a branch name/],
    [{ branch: "x".repeat(201) }, /not a branch name/],
  ] as const) {
    assert.throws(() => parseHostedRef(input), pattern, JSON.stringify(input));
  }
});

await test("collects each captured image once, skipping URLs and screens without a digest", () => {
  const ws = hostedWorkspace();
  // A second screen showing the same picture shares its image.
  ws.write(
    ".tieline/screens/NOTES.yaml",
    `${catalogYaml()}  - key: notes-list-copy
    title: Notes list again
    route: /notes
    kind: page
    when: A member opens Notes twice.
    image:
      path: notes-list.png
      sha256: ${sha256(LIST_IMAGE)}
`
  );
  assert.deepEqual(
    hostedImageReferences(manifestOf(ws)),
    [
      { digest: sha256(LIST_IMAGE), path: "notes-list.png", screens: ["notes-list", "notes-list-copy"] },
      { digest: sha256(EMPTY_IMAGE), path: "notes-list-empty.png", screens: ["notes-list-empty"] },
    ].sort((left, right) => left.digest.localeCompare(right.digest))
  );
  ws.write(".tieline/screens/NOTES.yaml", catalogYaml());
  assert.deepEqual(
    [...screenImageDigests(manifestOf(ws))].sort(),
    [
      ["notes-list", sha256(LIST_IMAGE)],
      ["notes-list-empty", sha256(EMPTY_IMAGE)],
    ].sort()
  );
});

await test("reads a captured image only when it is the one the catalog names", () => {
  const ws = hostedWorkspace();
  const settings = settingsOf(ws);
  const [reference] = hostedImageReferences(manifestOf(ws)).filter((entry) => entry.screens.includes("notes-list"));
  const read = readLocalHostedImage(settings, reference!);
  assert.equal(read.status, "ok");
  assert.equal(read.status === "ok" && read.image.contentType, "image/png");

  writeFileSync(`${ws.root}/.tieline/captures/notes-list.png`, png("recaptured since"));
  const stale = readLocalHostedImage(settings, reference!);
  assert.equal(stale.status, "unusable");
  assert.match(stale.status === "unusable" ? stale.detail : "", /not the image the catalog records/);

  // Even when the digest matches, an SVG is refused.
  const svg = Buffer.from("<svg/>");
  writeFileSync(`${ws.root}/.tieline/captures/notes-list.png`, svg);
  const refused = readLocalHostedImage(settings, { ...reference!, digest: sha256(svg) });
  assert.equal(refused.status, "unusable");
  assert.match(refused.status === "unusable" ? refused.detail : "", /never serve SVG/);

  ws.remove(".tieline/captures/notes-list.png");
  assert.equal(readLocalHostedImage(settings, reference!).status, "missing");
});

await test("records a history row only for screens whose image changed", () => {
  assert.deepEqual(
    changedScreenImages(
      new Map([
        ["notes-list", "a"],
        ["notes-list-empty", "b"],
        ["removed", "c"],
      ]),
      new Map([
        ["notes-list-empty", "b2"],
        ["notes-list", "a"],
        ["new-screen", "d"],
      ])
    ),
    [
      { key: "new-screen", digest: "d" },
      { key: "notes-list-empty", digest: "b2" },
    ]
  );
});

await test("stores a manifest as one value and reads it back with the manifest schemas", () => {
  const manifest = manifestOf(hostedWorkspace());
  const stored = storedContractManifest(manifest);
  assert.deepEqual(parseStoredContractManifest(stored, "test"), manifest);
  assert.throws(
    () => parseStoredContractManifest({ ...(stored as object), capabilities: [] }, "main's hosted snapshot"),
    /stored contract manifest 'main's hosted snapshot'/
  );
  assert.throws(() => parseStoredContractManifest({ ...(stored as object), injected: true }, "x"), /not a valid contract manifest part/);
});

console.log("hosted screens: publishing");

await test("publishes a pull request: records images, uploads what the bucket lacks, then replaces the page", async () => {
  const ws = hostedWorkspace();
  const repository = new FakeRepository();
  const store = new FakeStore();
  store.objects.set(imageKey(EMPTY_IMAGE), { bytes: EMPTY_IMAGE, contentType: "image/png" });
  // main showed an older notes list.
  const mainManifest = JSON.parse(
    JSON.stringify(storedContractManifest(manifestOf(ws))).replace(sha256(LIST_IMAGE), sha256(OLD_LIST_IMAGE))
  ) as unknown;
  repository.main = { headCommit: "b".repeat(40), manifest: mainManifest, publishedAt: new Date() };
  const deps = dependencies(repository, store);
  const { io, output } = captureIO();

  assert.equal(await runScreensPublishCommand({ repository: ws.root, pullRequest: "42", json: true }, io, deps), 0);
  const result = JSON.parse(output()) as Record<string, unknown>;
  assert.equal(result.published, true);
  assert.equal(result.ref, "pr-42");
  assert.deepEqual(result.images, { referenced: 2, uploaded: 1, already_stored: 1, repaired: 0, missing: [] });
  assert.deepEqual((result.changes as { screens: unknown }).screens, { added: 0, changed: 1, removed: 0 });

  // Images are recorded as referenced before the bucket is checked, and the
  // page is replaced only after every image is stored.
  assert.deepEqual(repository.calls, [
    `repositoryId ${REPO_KEY}`,
    "snapshot main/main",
    "touch 2 local of 2",
    "publish pr/42",
  ]);
  assert.deepEqual(store.calls.filter((call) => call.startsWith("put")), [`put ${imageKey(LIST_IMAGE)}`]);
  assert.deepEqual(store.objects.get(imageKey(LIST_IMAGE))?.contentType, "image/png");
  assert.equal(deps.closed(), 1);

  const snapshot = repository.snapshots.get("pr/42")!;
  assert.equal(snapshot.headCommit, COMMIT);
  // The page shows main's older notes list beside the new one, so the
  // snapshot keeps it from retention too, though this publish stores only its own.
  assert.deepEqual(snapshot.images, [sha256(LIST_IMAGE), sha256(EMPTY_IMAGE), sha256(OLD_LIST_IMAGE)].sort());
  const screens = embeddedScreens(snapshot.pageHtml);
  const list = screens.find((screen) => screen.key === "notes-list")!;
  assert.deepEqual(list.image, { src: `images/${sha256(LIST_IMAGE)}`, label: "notes-list.png" });
  assert.deepEqual(list.before_image, { src: `images/${sha256(OLD_LIST_IMAGE)}`, label: "main" });
  const empty = screens.find((screen) => screen.key === "notes-list-empty")!;
  assert.equal(empty.before_image, undefined, "an unchanged screen shows no before image");
  // The detail figures are display: grid, which would override `hidden`.
  assert.match(snapshot.pageHtml, /\.detail-before\[hidden\] \{ display: none; \}/);
  assert.deepEqual(
    screens.find((screen) => screen.key === "notes-share-denied")!.image,
    { src: "https://images.example.test/share-denied.png", label: "https://images.example.test/share-denied.png" },
    "an image given by URL is shown as given"
  );
  assert.ok(!snapshot.pageHtml.includes(".tieline/captures"), "a hosted page never points at the captures directory");
});

await test("stores again an image the bucket holds with other bytes, when the captures directory has it", async () => {
  const ws = hostedWorkspace();
  const repository = new FakeRepository();
  const store = new FakeStore();
  // The list's key holds other bytes; the empty state's holds its own.
  store.objects.set(imageKey(LIST_IMAGE), { bytes: Buffer.from("overwritten"), contentType: "image/png" });
  store.objects.set(imageKey(EMPTY_IMAGE), { bytes: EMPTY_IMAGE, contentType: "image/png" });
  const { io, output } = captureIO();
  assert.equal(await runScreensPublishCommand({ repository: ws.root, pullRequest: "7", json: true }, io, dependencies(repository, store)), 0);
  const result = JSON.parse(output()) as { images: Record<string, unknown> };
  assert.deepEqual(result.images, { referenced: 2, uploaded: 0, already_stored: 1, repaired: 1, missing: [] });
  assert.deepEqual(Buffer.from(store.objects.get(imageKey(LIST_IMAGE))!.bytes), LIST_IMAGE);
  // Both were read back, and only the wrong one was stored again.
  assert.deepEqual(store.calls.filter((call) => call.startsWith("get")).sort(), [`get ${imageKey(EMPTY_IMAGE)}`, `get ${imageKey(LIST_IMAGE)}`].sort());
  assert.deepEqual(store.calls.filter((call) => call.startsWith("put")), [`put ${imageKey(LIST_IMAGE)}`]);

  // Without a local copy there is nothing to repair from, so a stored image
  // is only checked to exist; the site refuses bytes that do not match.
  const bare = hostedWorkspace({ images: false });
  const bareStore = new FakeStore();
  bareStore.objects.set(imageKey(LIST_IMAGE), { bytes: Buffer.from("overwritten"), contentType: "image/png" });
  bareStore.objects.set(imageKey(EMPTY_IMAGE), { bytes: EMPTY_IMAGE, contentType: "image/png" });
  assert.equal(await runScreensPublishCommand({ repository: bare.root, pullRequest: "8", json: true }, captureIO().io, dependencies(new FakeRepository(), bareStore)), 0);
  assert.deepEqual(bareStore.calls.filter((call) => call.startsWith("get") || call.startsWith("put")), []);
});

await test("publishes when a screenshot is not on disk but the bucket already holds it", async () => {
  const ws = hostedWorkspace();
  ws.remove(".tieline/captures/notes-list.png");
  writeFileSync(`${ws.root}/.tieline/captures/notes-list-empty.png`, png("a stale capture"));
  const repository = new FakeRepository();
  const store = new FakeStore();
  store.objects.set(imageKey(LIST_IMAGE), { bytes: LIST_IMAGE, contentType: "image/png" });
  store.objects.set(imageKey(EMPTY_IMAGE), { bytes: EMPTY_IMAGE, contentType: "image/png" });
  const { io, output } = captureIO();
  assert.equal(await runScreensPublishCommand({ repository: ws.root, branch: "feature/empty-state" }, io, dependencies(repository, store)), 0);
  assert.match(output(), /Published feature\/empty-state at aaaaaaaaaaaa: 2 image\(s\), 0 uploaded and 2 already stored\./);
  assert.match(output(), /Changes against main are not shown: main has not been published yet/);
  assert.ok(repository.calls.includes("touch 0 local of 2"));
  assert.ok(repository.snapshots.has("branch/feature/empty-state"));
});

await test("publishes nothing when an image is neither in the bucket nor usable on disk", async () => {
  const ws = hostedWorkspace();
  ws.remove(".tieline/captures/notes-list.png");
  writeFileSync(`${ws.root}/.tieline/captures/notes-list-empty.png`, png("a stale capture"));
  const repository = new FakeRepository();
  const store = new FakeStore();
  const { io, output } = captureIO();
  assert.equal(await runScreensPublishCommand({ repository: ws.root, pullRequest: "7" }, io, dependencies(repository, store)), 1);
  assert.match(output(), /Nothing was published for pr-7: 2 image\(s\) are not in the bucket/);
  assert.match(output(), /missing  [a-f0-9]{12} \(notes-list\): not in the bucket, and \.tieline\/captures\/notes-list\.png does not exist/);
  assert.match(output(), /\(notes-list-empty\): not in the bucket, and .*not the image the catalog records/);
  assert.ok(!repository.calls.some((call) => call.startsWith("publish")), "no page is published");
  assert.ok(!store.calls.some((call) => call.startsWith("put")));
});

await test("fails without publishing when an upload fails, after every request settles", async () => {
  const ws = hostedWorkspace();
  const repository = new FakeRepository();
  const store = new FakeStore();
  store.failPut = imageKey(LIST_IMAGE);
  const deps = dependencies(repository, store);
  const { io } = captureIO();
  await assert.rejects(runScreensPublishCommand({ repository: ws.root, pullRequest: "8" }, io, deps), /HTTP 403 \(AccessDenied\)/);
  assert.equal(store.calls.filter((call) => call.startsWith("put")).length, 2, "the other upload still ran to completion");
  assert.ok(!repository.calls.some((call) => call.startsWith("publish")));
  assert.equal(deps.closed(), 1, "connections are closed on failure");
});

await test("refuses to publish when hosting is off, the repository was never synced, or the commit is not a full SHA", async () => {
  const { io } = captureIO();
  const off = hostedWorkspace({ hosted: null });
  await assert.rejects(
    runScreensPublishCommand({ repository: off.root, pullRequest: "1" }, io, dependencies(new FakeRepository(), new FakeStore())),
    /Hosted screens are not enabled/
  );
  const disabled = hostedWorkspace({ hosted: { enabled: false, bucket: BUCKET } });
  await assert.rejects(
    runScreensPublishCommand({ repository: disabled.root, pullRequest: "1" }, io, dependencies(new FakeRepository(), new FakeStore())),
    /Hosted screens are not enabled/
  );
  const ws = hostedWorkspace();
  const unsynced = new FakeRepository();
  unsynced.repository = null;
  const deps = dependencies(unsynced, new FakeStore());
  await assert.rejects(runScreensPublishCommand({ repository: ws.root, pullRequest: "1" }, io, deps), /never been synced/);
  assert.equal(deps.closed(), 1);
  await assert.rejects(
    runScreensPublishCommand({ repository: ws.root, pullRequest: "1", commit: "abc123" }, io, dependencies(new FakeRepository(), new FakeStore())),
    /full commit SHA/
  );
});

await test("shows the comparison as unavailable when main's stored manifest cannot be read", async () => {
  const ws = hostedWorkspace();
  const repository = new FakeRepository();
  repository.main = { headCommit: "b".repeat(40), manifest: { schema_version: 99 }, publishedAt: new Date() };
  const { io, output } = captureIO();
  assert.equal(await runScreensPublishCommand({ repository: ws.root, pullRequest: "9", json: true }, io, dependencies(repository, new FakeStore())), 0);
  assert.match(
    (JSON.parse(output()) as { changes: { unavailable: string } }).changes.unavailable,
    /main's published manifest cannot be read/
  );
});

await test("closes a published pull request once", async () => {
  const ws = hostedWorkspace();
  const repository = new FakeRepository();
  repository.snapshots.set("pr/42", { headCommit: COMMIT, manifest: {}, images: [], pageHtml: "", closed: false });
  const deps = dependencies(repository, new FakeStore());
  const first = captureIO();
  assert.equal(await runScreensCloseCommand({ repository: ws.root, pullRequest: "42" }, first.io, deps), 0);
  assert.match(first.output(), /Marked pr-42 closed; `tieline screens prune` deletes its page after 24 hours\./);
  const second = captureIO();
  assert.equal(await runScreensCloseCommand({ repository: ws.root, pullRequest: "42", json: true }, second.io, deps), 0);
  assert.deepEqual(JSON.parse(second.output()), { ref: "pr-42", closed: false });
  assert.equal(deps.closed(), 2);
});

console.log("hosted screens: main and retention");

await test("publishes main without a comparison and passes each screen's image for history", async () => {
  const ws = hostedWorkspace();
  const repository = new FakeRepository();
  const store = new FakeStore();
  const result = await publishMainScreens({
    root: ws.root,
    repositoryKey: REPO_KEY,
    specDirectory: ".tieline/spec",
    manifest: manifestOf(ws),
    commit: COMMIT,
    settings: hostedSettingsOf(ws),
    repository,
    store,
  });
  assert.equal(result.outcome, "published");
  assert.deepEqual(result.outcome === "published" && result.images, { referenced: 2, uploaded: 2, already_stored: 0, repaired: 0, missing: [] });
  assert.deepEqual(
    [...repository.lastScreenImages!].sort(),
    [
      ["notes-list", sha256(LIST_IMAGE)],
      ["notes-list-empty", sha256(EMPTY_IMAGE)],
    ].sort()
  );
  const page = repository.snapshots.get("main/main")!.pageHtml;
  assert.ok(embeddedScreens(page).every((screen) => screen.before_image === undefined));
});

await test("does not publish main when an image is missing, the commit is not a full SHA, or sync moved on", async () => {
  const ws = hostedWorkspace({ images: false });
  const input = {
    root: ws.root,
    repositoryKey: REPO_KEY,
    specDirectory: ".tieline/spec",
    manifest: manifestOf(ws),
    commit: COMMIT,
    settings: hostedSettingsOf(ws),
    store: new FakeStore(),
  };
  const missing = new FakeRepository();
  const failed = await publishMainScreens({ ...input, repository: missing });
  assert.equal(failed.outcome, "failed");
  assert.match(failed.outcome === "failed" ? failed.reason : "", /2 image\(s\) main shows are not in the bucket/);
  assert.ok(!missing.calls.includes("publishMain"));

  const short = await publishMainScreens({ ...input, commit: "HEAD", repository: new FakeRepository() });
  assert.match(short.outcome === "failed" ? short.reason : "", /full commit SHA/);

  const store = new FakeStore();
  store.objects.set(imageKey(LIST_IMAGE), { bytes: LIST_IMAGE, contentType: "image/png" });
  store.objects.set(imageKey(EMPTY_IMAGE), { bytes: EMPTY_IMAGE, contentType: "image/png" });
  const moved = new FakeRepository();
  moved.mainResult = { outcome: "superseded", synced_commit: "c".repeat(40) };
  assert.deepEqual(await publishMainScreens({ ...input, store, repository: moved }), {
    outcome: "superseded",
    commit: COMMIT,
    synced_commit: "c".repeat(40),
  });
});

await test("prunes with the configured retention and keeps images it could not delete", async () => {
  const ws = hostedWorkspace();
  const repository = new FakeRepository();
  const store = new FakeStore();
  repository.pruneCandidates = ["d".repeat(64), "e".repeat(64)];
  store.failDelete.add(hostedImageKey(REPO_KEY, "e".repeat(64)));
  const { io, output } = captureIO();
  assert.equal(await runScreensPruneCommand({ repository: ws.root }, io, dependencies(repository, store)), 1);
  assert.deepEqual(repository.lastRetention, { branchDays: 7, mainHistory: 2, closedGraceHours: 24 });
  assert.ok(repository.calls.includes("pruneImages grace=24 limit=1000"));
  assert.match(output(), /1 closed pull request\(s\), 2 expired branch\(es\), 3 history row\(s\), and 1 unreferenced image\(s\)/);
  assert.match(output(), /kept  eeeeeeeeeeee: Object storage DELETE .* HTTP 500/);
  assert.match(output(), /retried by the next prune/);

  repository.pruneCandidates = ["d".repeat(64)];
  const clean = captureIO();
  assert.equal(await runScreensPruneCommand({ repository: ws.root, json: true }, clean.io, dependencies(repository, store)), 0);
  assert.deepEqual(JSON.parse(clean.output()), {
    complete: true,
    refs: { closed_pull_requests: 1, branches: 2, history: 3 },
    images: { deleted: 1, failed: [] },
  });
});

await test("tells retention which screens main's page shows, and keeps all history when it cannot read the page", async () => {
  const ws = hostedWorkspace();
  const repository = new FakeRepository();
  const store = new FakeStore();
  repository.main = { headCommit: "b".repeat(40), manifest: storedContractManifest(manifestOf(ws)), publishedAt: new Date() };
  assert.equal(await runScreensPruneCommand({ repository: ws.root }, captureIO().io, dependencies(repository, store)), 0);
  // Every screen main shows counts, with a hosted image or not.
  assert.deepEqual(
    [...(repository.lastMainScreenKeys ?? [])].sort(),
    ["note-saved-toast", "notes-list", "notes-list-empty", "notes-share-denied"]
  );
  // An unreadable page says nothing about which screens are gone.
  repository.main = { headCommit: "b".repeat(40), manifest: { schema_version: "nonsense" }, publishedAt: new Date() };
  const unreadable = captureIO();
  assert.equal(await runScreensPruneCommand({ repository: ws.root }, unreadable.io, dependencies(repository, store)), 0);
  assert.equal(repository.lastMainScreenKeys, null);
  assert.match(unreadable.output(), /Kept the history of screens main may no longer show, because main's page could not be read: /);
  const json = captureIO();
  assert.equal(await runScreensPruneCommand({ repository: ws.root, json: true }, json.io, dependencies(repository, store)), 0);
  assert.match((JSON.parse(json.output()) as { main_unreadable: string }).main_unreadable, /main's hosted snapshot/);
});

console.log("hosted screens: the local page is unchanged");

await test("counts main's images beside changed screens toward the page's image limit", () => {
  const changed = (aspects: ScreenChangeAspect[]): ReviewComparison => ({
    changes: {
      base: "main",
      base_has_manifest: true,
      records: [],
      screens: [{ stable_id: "a", capability: "NOTES", title: "A", status: "changed", aspects }],
    },
  });
  const own = Array.from({ length: HOSTED_SCREEN_LIMITS.images }, (_, index) => index.toString(16).padStart(64, "0"));
  const base = new Map([["a", "f".repeat(64)]]);
  const current = new Map([["a", own[0]]]);
  // Only an image change shows main's image beside it.
  assert.equal(shownImages(own, changed(["text"]), base, current).length, HOSTED_SCREEN_LIMITS.images);
  assert.equal(shownImages(own.slice(1), changed(["image"]), base, current).at(-1), "f".repeat(64));
  assert.throws(
    () => shownImages(own, changed(["image"]), base, current),
    new RegExp(`shows ${HOSTED_SCREEN_LIMITS.images + 1} distinct images, counting main's beside changed screens; hosted screens publish at most ${HOSTED_SCREEN_LIMITS.images}`)
  );
});

await test("keeps the local review page pointing at the captures directory, with no before image", () => {
  const ws = hostedWorkspace();
  writeWorkspaceReviewPage(ws.root, REPO_KEY, ".tieline/spec");
  const page = readFileSync(`${ws.root}/.tieline/review.html`, "utf8");
  const list = embeddedScreens(page).find((screen) => screen.key === "notes-list")!;
  assert.deepEqual(list.image, { src: "captures/notes-list.png", label: "notes-list.png" });
  assert.equal(list.before_image, undefined);
});

await test("leaves an http image out of a hosted page, whose policy allows only https images", () => {
  const ws = hostedWorkspace();
  ws.write(".tieline/screens/SHARING.yaml", SHARING_CATALOG_YAML.replace("https://images.example.test/share-denied.png", "http://images.example.test/share-denied.png"));
  const hostedPage = renderHostedReviewPage({
    root: ws.root,
    repositoryKey: REPO_KEY,
    specDirectory: ".tieline/spec",
    hosted: { served: new Set(), base: new Map(), baseLabel: "main" },
  });
  // Shown as a screen without a picture, not as a broken image.
  assert.equal(embeddedScreens(hostedPage).find((screen) => screen.key === "notes-share-denied")!.image, null);
  // The local page, with no such policy, still shows it.
  writeWorkspaceReviewPage(ws.root, REPO_KEY, ".tieline/spec");
  const local = readFileSync(`${ws.root}/.tieline/review.html`, "utf8");
  assert.deepEqual(embeddedScreens(local).find((screen) => screen.key === "notes-share-denied")!.image, {
    src: "http://images.example.test/share-denied.png",
    label: "http://images.example.test/share-denied.png",
  });
});

await test("syncs main's tip in the example workflow, so a skipped or out-of-order run cannot wedge it", () => {
  const workflow = parseYaml(readFileSync("docs/examples/screens-hosted-main.yml", "utf8")) as {
    concurrency: { group: string; "cancel-in-progress": boolean };
    jobs: { sync: { steps: Array<{ uses?: string; with?: Record<string, unknown>; run?: string }> } };
  };
  // One sync at a time, never cancelled half-way.
  assert.deepEqual(workflow.concurrency, { group: "screens-main", "cancel-in-progress": false });
  const steps = workflow.jobs.sync.steps;
  // Each run checks out main as it is when it starts, not the push that
  // queued it: GitHub may skip pending runs or run them out of order.
  assert.deepEqual(steps.find((step) => step.uses?.startsWith("actions/checkout"))?.with, { ref: "main", "fetch-depth": 0 });
  // An exact previous-commit guard would fail every run after a skipped or
  // reordered one, so the example does not pass one.
  const syncs = steps.filter((step) => step.run?.includes("contract sync"));
  assert.equal(syncs.length, 2);
  assert.ok(syncs.every((step) => !step.run!.includes("--expected-previous-commit")));
});

await test("publishes from a workflow the default branch owns, never from one a pull request can change", () => {
  type Step = { if?: string; uses?: string; with?: Record<string, unknown>; run?: string; "working-directory"?: string; env?: Record<string, string> };
  type Job = { needs?: string; if?: string; environment?: string; permissions?: Record<string, string>; outputs?: Record<string, string>; steps: Step[] };
  type Workflow = { name: string; on: Record<string, unknown>; permissions: Record<string, string>; jobs: Record<string, Job> };
  const read = (file: string) => parseYaml(readFileSync(`docs/examples/${file}`, "utf8")) as Workflow;
  const capture = read("screens-hosted.yml");
  const publishing = read("screens-hosted-publish.yml");
  const main = read("screens-hosted-main.yml");

  // A pull_request workflow comes from the pull request's branch, which can
  // rewrite it, so it holds no secret and no write access.
  assert.deepEqual(Object.keys(capture.on), ["pull_request"]);
  assert.deepEqual(capture.permissions, { contents: "read" });
  assert.ok(!JSON.stringify(capture).includes("secrets."), "the capture workflow holds no credentials");
  const captureSteps = capture.jobs.capture!.steps;
  assert.equal(captureSteps[0]!.with?.ref, "${{ github.event.pull_request.head.sha }}", "captures the commit publishing reads");
  assert.ok(captureSteps.some((step) => step.run?.includes("screens capture --changed") && step.run.includes("--verify")));
  const upload = captureSteps.find((step) => step.uses?.startsWith("actions/upload-artifact"))!;
  // .tieline is a hidden directory, which upload-artifact skips by default.
  assert.equal(upload.with?.["include-hidden-files"], true);
  assert.equal(upload.if, "github.event.pull_request.head.repo.full_name == github.repository", "forks hand nothing on");

  // Publishing runs on workflow_run and pull_request_target, which GitHub
  // reads from the default branch, after a capture by that workflow's name.
  assert.deepEqual(publishing.on, {
    workflow_run: { workflows: [capture.name], types: ["completed"] },
    pull_request_target: { types: ["closed"] },
  });
  assert.deepEqual(publishing.permissions, { contents: "read" });
  // Every job that holds a secret runs in the environment the default branch alone can use.
  for (const workflow of [publishing, main]) {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      if (JSON.stringify(job).includes("secrets.")) assert.equal(job.environment, "hosted-screens", `${workflow.name}: ${name}`);
    }
  }
  const { resolve: resolveJob, publish, close } = publishing.jobs;
  // Only a successful capture of the repository's own branch is published,
  // for the pull request the API names, never one the artifact names.
  assert.match(resolveJob!.if!, /workflow_run\.conclusion == 'success'/);
  assert.match(resolveJob!.if!, /head_repository\.full_name == github\.repository/);
  assert.match(resolveJob!.steps[0]!.run!, /gh api -X GET .*pulls/);
  assert.match(resolveJob!.steps[0]!.run!, /select\(\.head\.sha == /);
  assert.equal(publish!.needs, "resolve");
  assert.deepEqual(publish!.permissions, { contents: "read", actions: "read", "pull-requests": "write" });
  // Tieline from the default branch; the pull request checked out apart, as data.
  const checkouts = publish!.steps.filter((step) => step.uses?.startsWith("actions/checkout"));
  assert.deepEqual(
    checkouts.map((step) => [step.with?.path, step.with?.ref]),
    [
      ["trusted", undefined],
      ["pull-request", "${{ github.event.workflow_run.head_sha }}"],
    ]
  );
  const commands = publish!.steps.filter((step) => step.run);
  assert.ok(commands.length >= 2 && commands.every((step) => step["working-directory"] === "trusted"), "every command runs the default branch's install");
  const publishStep = commands.find((step) => step.run!.includes("screens publish"))!;
  assert.match(publishStep.run!, /--repository \.\.\/pull-request /);
  assert.equal(publishStep.env?.PULL_REQUEST, "${{ needs.resolve.outputs.number }}");
  const download = publish!.steps.find((step) => step.uses?.startsWith("actions/download-artifact"))!;
  assert.equal(download.with?.["run-id"], "${{ github.event.workflow_run.id }}");
  assert.equal(download.with?.path, "pull-request/.tieline/captures");
  // Closing checks out only the base branch.
  assert.deepEqual(
    close!.steps.filter((step) => step.uses?.startsWith("actions/checkout")).map((step) => step.with?.ref),
    ["${{ github.event.pull_request.base.ref }}"]
  );
});

for (const ws of workspaces) ws.cleanup();
report();
