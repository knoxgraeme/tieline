import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  ObjectStoreError,
  presignGetUrl,
  readObjectStoreSettings,
  S3ObjectStore,
  type ObjectStore,
} from "../../../src/adapters/object-store/s3.js";
import type { HostedImage, HostedPage } from "../../../src/adapters/postgres/hosted-screens-repository.js";
import {
  DEFAULT_HOSTED_DIRECTORY,
  PUBLISHER_PRIVILEGES,
  privilegeName,
  runHostedCheckCommand,
  runHostedInitCommand,
  SITE_CHECK_REDIRECTS,
  type HostedCheckDependencies,
  type HostedDatabaseState,
} from "../../../src/commands/hosted.js";
import { renderPublishSummary, SCREENS_COMMENT_MARKER } from "../../../src/commands/screens-hosting.js";
import { parseRequestedRef, type HostedRef } from "../../../src/contract/hosted-ref.js";
import { createHostedScreensHandler, HOSTED_SITE_HEADER, HOSTED_SITE_LIMITS } from "../../../src/hosted/handler.js";
import { createHostedScreensSite } from "../../../src/hosted/index.js";
import { TIELINE_VERSION } from "../../../src/package-metadata.js";
import { report, test } from "../../support/harness.js";
import { captureIO, createScreensWorkspace, REPO_KEY, type ScreensWorkspace } from "../../support/screen-fixtures.js";

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("notes list")]);
const DIGEST = sha256(PNG);
const BUCKET = "acme-screens";
const workspaces: ScreensWorkspace[] = [];

function hostedWorkspace(hosted: unknown = { enabled: true, bucket: BUCKET }): ScreensWorkspace {
  const ws = createScreensWorkspace({ screens: { enabled: true, hosted } });
  workspaces.push(ws);
  return ws;
}

/** The stores the site reads, in memory, recording what was asked. */
function siteStores(options: { pages?: Record<string, string>; images?: Record<string, HostedImage>; objects?: Record<string, Uint8Array> } = {}) {
  const calls: string[] = [];
  return {
    calls,
    stores: {
      pages: {
        async page(repositoryKey: string, ref: { kind: "main" } | HostedRef): Promise<HostedPage | null> {
          const name = ref.kind === "main" ? "main" : `${ref.kind}/${ref.name}`;
          calls.push(`page ${repositoryKey} ${name}`);
          const html = options.pages?.[name];
          return html === undefined ? null : { html, headCommit: "a".repeat(40), publishedAt: new Date(0) };
        },
      },
      images: {
        async image(repositoryKey: string, digest: string): Promise<HostedImage | null> {
          calls.push(`image ${repositoryKey} ${digest.slice(0, 8)}`);
          return options.images?.[digest] ?? null;
        },
      },
      objects: {
        async get(key: string, maxBytes: number): Promise<Uint8Array | null> {
          calls.push(`get ${key} ${maxBytes}`);
          return options.objects?.[key] ?? null;
        },
        presignGet(key: string, expiresSeconds: number): string {
          calls.push(`presign ${key} ${expiresSeconds}`);
          return `https://storage.example.test/${key}?signed`;
        },
      },
    },
  };
}

const request = (path: string, init: RequestInit = {}): Request => new Request(`https://screens.example.test${path}`, init);

console.log("hosted site: pages");

await test("parses requested refs: main by default, pr-<n>, or a branch", () => {
  assert.deepEqual(parseRequestedRef(null), { kind: "main" });
  assert.deepEqual(parseRequestedRef(""), { kind: "main" });
  assert.deepEqual(parseRequestedRef("main"), { kind: "main" });
  assert.deepEqual(parseRequestedRef("pr-42"), { kind: "pr", name: "42" });
  assert.deepEqual(parseRequestedRef("feature/notes"), { kind: "branch", name: "feature/notes" });
  for (const value of ["../etc", "a..b", "x/", "x.lock", "<script>", "x".repeat(201)]) {
    assert.equal(parseRequestedRef(value), null, value);
  }
  // pr-0 is not a pull request number, so it can only be a branch name.
  assert.deepEqual(parseRequestedRef("pr-0"), { kind: "branch", name: "pr-0" });
});

await test("serves a ref's stored page, gzipped when accepted, with a strict policy", async () => {
  const { stores, calls } = siteStores({ pages: { main: "<h1>main</h1>", "pr/42": "<h1>pr 42</h1>", "branch/feature/x": "<h1>x</h1>" } });
  const handle = createHostedScreensHandler({ repositoryKey: REPO_KEY, stores });

  const main = await handle(request("/"));
  assert.equal(main.status, 200);
  assert.equal(await main.text(), "<h1>main</h1>");
  assert.equal(main.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(main.headers.get(HOSTED_SITE_HEADER), "1");
  assert.equal(main.headers.get("x-content-type-options"), "nosniff");
  assert.equal(main.headers.get("x-frame-options"), "DENY");
  assert.equal(main.headers.get("cache-control"), "private, no-store");
  assert.match(main.headers.get("content-security-policy")!, /^default-src 'none'; script-src 'unsafe-inline';.*frame-ancestors 'none'$/);
  assert.equal(main.headers.get("content-encoding"), null);

  const gzipped = await handle(request("/?ref=pr-42", { headers: { "accept-encoding": "br, gzip;q=0.8" } }));
  assert.equal(gzipped.headers.get("content-encoding"), "gzip");
  assert.equal(gunzipSync(Buffer.from(await gzipped.arrayBuffer())).toString("utf8"), "<h1>pr 42</h1>");
  const refused = await handle(request("/?ref=pr-42", { headers: { "accept-encoding": "gzip;q=0, deflate" } }));
  assert.equal(refused.headers.get("content-encoding"), null);

  assert.equal(await (await handle(request("/?ref=feature/x"))).text(), "<h1>x</h1>");
  assert.deepEqual(calls, [`page ${REPO_KEY} main`, `page ${REPO_KEY} pr/42`, `page ${REPO_KEY} pr/42`, `page ${REPO_KEY} branch/feature/x`]);
});

await test("answers unpublished refs, bad refs, other paths, and other methods without touching storage", async () => {
  const { stores, calls } = siteStores();
  const handle = createHostedScreensHandler({ repositoryKey: REPO_KEY, stores });
  const missing = await handle(request("/?ref=pr-7"));
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), "Nothing is published for pr-7.\n");
  assert.equal((await handle(request("/?ref=a..b"))).status, 400);
  assert.equal((await handle(request("/review.html"))).status, 404);
  assert.equal((await handle(request("/images/not-a-digest"))).status, 404);
  const post = await handle(request("/", { method: "POST", body: "x" }));
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");
  assert.deepEqual(calls, [`page ${REPO_KEY} pr/7`]);
});

await test("refuses a page too large for the host's response limit", async () => {
  const lines: string[] = [];
  // Hash output does not compress, so even gzipped the page is too large.
  const random = Buffer.concat(Array.from({ length: 200 }, (_, index) => createHash("sha256").update(String(index)).digest())).toString("base64");
  const { stores } = siteStores({ pages: { main: random } });
  const handle = createHostedScreensHandler({ repositoryKey: REPO_KEY, stores, responseBytes: 1_024, log: (line) => lines.push(line) });
  const response = await handle(request("/", { headers: { "accept-encoding": "gzip" } }));
  assert.equal(response.status, 502);
  assert.match(lines[0]!, /the page for main is \d+ bytes, over this host's 1024-byte response limit/);
});

console.log("hosted site: images");

await test("serves an image only while its bytes still match its digest", async () => {
  const key = `${REPO_KEY}/sha256/${DIGEST}`;
  const record = { contentType: "image/png", byteSize: PNG.byteLength };
  const good = siteStores({ images: { [DIGEST]: record }, objects: { [key]: PNG } });
  const image = await createHostedScreensHandler({ repositoryKey: REPO_KEY, stores: good.stores })(request(`/images/${DIGEST}`));
  assert.equal(image.status, 200);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal(image.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.equal(image.headers.get("cache-control"), "private, max-age=31536000, immutable");
  assert.deepEqual(good.calls, [`image ${REPO_KEY} ${DIGEST.slice(0, 8)}`, `get ${key} ${PNG.byteLength}`]);

  const lines: string[] = [];
  const tampered = siteStores({ images: { [DIGEST]: record }, objects: { [key]: Buffer.from("replaced bytes") } });
  const refused = await createHostedScreensHandler({ repositoryKey: REPO_KEY, stores: tampered.stores, log: (line) => lines.push(line) })(
    request(`/images/${DIGEST}`)
  );
  assert.equal(refused.status, 502);
  assert.match(lines[0]!, /does not match its digest; it was not served/);

  const unrecorded = siteStores({ objects: { [key]: PNG } });
  assert.equal((await createHostedScreensHandler({ repositoryKey: REPO_KEY, stores: unrecorded.stores })(request(`/images/${DIGEST}`))).status, 404);
  assert.deepEqual(unrecorded.calls, [`image ${REPO_KEY} ${DIGEST.slice(0, 8)}`], "an image no publish recorded is never fetched");

  const gone = siteStores({ images: { [DIGEST]: record } });
  assert.equal((await createHostedScreensHandler({ repositoryKey: REPO_KEY, stores: gone.stores })(request(`/images/${DIGEST}`))).status, 404);
});

await test("redirects an image too large to send to a link that lasts a minute, once its bytes are checked", async () => {
  const key = `${REPO_KEY}/sha256/${DIGEST}`;
  const image = { contentType: "image/png", byteSize: PNG.byteLength };
  // A response limit smaller than the image stands in for a 4 MB one.
  const { stores, calls } = siteStores({ images: { [DIGEST]: image }, objects: { [key]: PNG } });
  const response = await createHostedScreensHandler({ repositoryKey: REPO_KEY, stores, responseBytes: 8 })(request(`/images/${DIGEST}`));
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), `https://storage.example.test/${key}?signed`);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(calls.filter((call) => !call.startsWith("image")), [`get ${key} ${PNG.byteLength}`, `presign ${key} 60`]);

  // Bytes replaced in the bucket are refused, large or not: no link is handed out.
  const lines: string[] = [];
  const tampered = siteStores({ images: { [DIGEST]: image }, objects: { [key]: Buffer.from("replaced bytes, same length") } });
  const refused = await createHostedScreensHandler({ repositoryKey: REPO_KEY, stores: tampered.stores, responseBytes: 8, log: (line) => lines.push(line) })(
    request(`/images/${DIGEST}`)
  );
  assert.equal(refused.status, 502);
  assert.equal(refused.headers.get("location"), null);
  assert.ok(!tampered.calls.some((call) => call.startsWith("presign")));
  assert.match(lines.join("\n"), /does not match its digest/);
});

await test("reports a store failure as unavailable, logging the cause but not sending it", async () => {
  const lines: string[] = [];
  const { stores } = siteStores();
  stores.pages.page = async () => {
    throw new Error("connect ECONNREFUSED 10.0.0.5:5432");
  };
  const response = await createHostedScreensHandler({ repositoryKey: REPO_KEY, stores, log: (line) => lines.push(line) })(request("/"));
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /ECONNREFUSED/);
  assert.match(lines[0]!, /ECONNREFUSED/);
});

await test("the packaged site reports missing settings on the page instead of failing to load", async () => {
  const site = createHostedScreensSite({ repository: REPO_KEY, bucket: BUCKET, env: { DATABASE_URL: "postgres://reader@db.example.test/tieline" } });
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...values: unknown[]) => errors.push(values);
  try {
    const response = await site(request("/"));
    assert.equal(response.status, 500);
    assert.equal(response.headers.get(HOSTED_SITE_HEADER), "1");
    assert.match(await response.text(), /not configured: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY/);
    const noDatabase = createHostedScreensSite({
      repository: REPO_KEY,
      bucket: BUCKET,
      env: { AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: "secret", AWS_REGION: "us-east-1" },
    });
    assert.match(await (await noDatabase(request("/"))).text(), /DATABASE_URL must hold the Tieline reader role's/);
    const badKey = createHostedScreensSite({ repository: "../x", bucket: BUCKET, env: {} });
    assert.match(await (await badKey(request("/"))).text(), /'\.\.\/x' is not a repository key/);
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 3);
});

console.log("hosted site: object storage reads");

await test("presigns GET URLs exactly as AWS Signature Version 4 specifies", () => {
  // The query-string authentication example from the AWS documentation.
  assert.equal(
    presignGetUrl(
      new URL("https://examplebucket.s3.amazonaws.com"),
      "/test.txt",
      { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", sessionToken: null, region: "us-east-1" },
      new Date("2013-05-24T00:00:00Z"),
      86_400
    ),
    "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"
  );
  assert.throws(
    () => presignGetUrl(new URL("https://s.example.test"), "/b/k", { accessKeyId: "a", secretAccessKey: "b", sessionToken: null, region: "r" }, new Date(), 0),
    /expire within/
  );
});

await test("reads an object within a bound and treats a missing one as absent", async () => {
  const responses = [new Response(PNG, { status: 200 }), new Response(null, { status: 404 }), new Response(Buffer.alloc(64), { status: 200 })];
  const store = new S3ObjectStore(
    readObjectStoreSettings({ AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: "secret", AWS_REGION: "us-east-1", AWS_ENDPOINT_URL_S3: "https://storage.example.test" }, BUCKET),
    { fetch: (async () => responses.shift()!) as typeof fetch }
  );
  assert.deepEqual(Buffer.from((await store.get("acme-notes/sha256/x", 1_024))!), PNG);
  assert.equal(await store.get("acme-notes/sha256/x", 1_024), null);
  await assert.rejects(store.get("acme-notes/sha256/x", 32), (error: unknown) => error instanceof ObjectStoreError && /larger than 32 bytes/.test(error.message));
  assert.match(store.presignGet("acme-notes/sha256/x", 60), /^https:\/\/storage\.example\.test\/acme-screens\/acme-notes\/sha256\/x\?X-Amz-Algorithm=AWS4-HMAC-SHA256&.*X-Amz-Expires=60&X-Amz-SignedHeaders=host&X-Amz-Signature=[a-f0-9]{64}$/);
});

console.log("hosted site: init");

await test("writes a self-contained Netlify site for the repository's bucket", () => {
  const ws = hostedWorkspace();
  const { io, output } = captureIO();
  assert.equal(runHostedInitCommand({ repository: ws.root, host: "netlify" }, io), 0);
  const directory = `${ws.root}/${DEFAULT_HOSTED_DIRECTORY}`;
  const fn = readFileSync(`${directory}/functions/screens.mjs`, "utf8");
  assert.match(fn, /import \{ createHostedScreensSite \} from "tieline\/hosted";/);
  assert.match(fn, /createHostedScreensSite\(\{"repository":"acme-notes","bucket":"acme-screens"\}\)/);
  assert.match(fn, /export const config = \{ path: \["\/", "\/images\/\*"\] \};/);
  assert.deepEqual(JSON.parse(readFileSync(`${directory}/package.json`, "utf8")).dependencies, { tieline: TIELINE_VERSION });
  assert.match(readFileSync(`${directory}/netlify.toml`, "utf8"), /\[functions\]\n  directory = "functions"/);
  assert.equal(readFileSync(`${directory}/public/robots.txt`, "utf8"), "User-agent: *\nDisallow: /\n");
  const readme = readFileSync(`${directory}/README.md`, "utf8");
  assert.match(readme, /Turn on the site's access control/);
  assert.match(readme, /TIELINE_SCREENS_S3_ACCESS_KEY_ID/);
  assert.doesNotMatch(readme, /`AWS_ACCESS_KEY_ID`/, "Netlify refuses the AWS_* names, so the README never asks for them");
  assert.match(output(), /created   \.tieline\/hosted\/functions\/screens\.mjs/);

  const again = captureIO();
  assert.equal(runHostedInitCommand({ repository: ws.root, host: "netlify", json: true }, again.io), 0);
  assert.ok((JSON.parse(again.output()) as { files: Array<{ status: string }> }).files.every((file) => file.status === "unchanged"));
});

await test("leaves edited files alone unless forced, and stays inside the repository", () => {
  const ws = hostedWorkspace();
  const { io } = captureIO();
  runHostedInitCommand({ repository: ws.root, host: "netlify", directory: "site" }, io);
  writeFileSync(`${ws.root}/site/netlify.toml`, "# edited\n");
  assert.throws(() => runHostedInitCommand({ repository: ws.root, host: "netlify", directory: "site" }, io), /site\/netlify\.toml.*--force/);
  assert.equal(readFileSync(`${ws.root}/site/netlify.toml`, "utf8"), "# edited\n");
  assert.equal(runHostedInitCommand({ repository: ws.root, host: "netlify", directory: "site", force: true }, io), 0);
  assert.notEqual(readFileSync(`${ws.root}/site/netlify.toml`, "utf8"), "# edited\n");

  for (const directory of ["../outside", "/tmp/site", "."]) {
    assert.throws(() => runHostedInitCommand({ repository: ws.root, host: "netlify", directory }, io), /inside the repository/, directory);
  }
  symlinkSync(tmpdir(), `${ws.root}/linked`);
  assert.throws(() => runHostedInitCommand({ repository: ws.root, host: "netlify", directory: "linked/site" }, io), /inside the repository/);
  assert.throws(() => runHostedInitCommand({ repository: ws.root, host: "vercel" }, io), /--host vercel is not supported/);
  const off = hostedWorkspace({ enabled: false, bucket: BUCKET });
  assert.throws(() => runHostedInitCommand({ repository: off.root, host: "netlify" }, io), /Hosted screens are not enabled/);
  assert.ok(!existsSync(`${off.root}/${DEFAULT_HOSTED_DIRECTORY}`));
});

await test("never writes the site through a symbolic link inside its directory", () => {
  const ws = hostedWorkspace();
  const { io } = captureIO();
  const outside = mkdtempSync(resolve(tmpdir(), "tieline-hosted-outside-"));
  try {
    // A link where a site subdirectory goes: refused before anything is written.
    mkdirSync(`${ws.root}/site`, { recursive: true });
    symlinkSync(outside, `${ws.root}/site/functions`);
    assert.throws(() => runHostedInitCommand({ repository: ws.root, host: "netlify", directory: "site" }, io), /site\/functions' is a symbolic link or not a directory/);
    assert.deepEqual(readdirSync(outside), [], "nothing was written outside the repository");
    assert.equal(existsSync(`${ws.root}/site/netlify.toml`), false, "and nothing inside either");

    // A link where a site file goes: refused even with --force.
    rmSync(`${ws.root}/site/functions`);
    writeFileSync(`${outside}/victim.txt`, "keep me\n");
    symlinkSync(`${outside}/victim.txt`, `${ws.root}/site/netlify.toml`);
    assert.throws(
      () => runHostedInitCommand({ repository: ws.root, host: "netlify", directory: "site", force: true }, io),
      /site\/netlify\.toml' is a symbolic link or not a regular file/
    );
    assert.equal(readFileSync(`${outside}/victim.txt`, "utf8"), "keep me\n");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

console.log("hosted site: check");

class ProbeStore implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly calls: string[] = [];
  constructor(
    private readonly failure: string | null = null,
    private readonly headFailure: string | null = null
  ) {}
  async head(key: string): Promise<boolean> {
    this.calls.push("head");
    if (this.headFailure) throw new ObjectStoreError(this.headFailure, 403, key);
    return this.objects.has(key);
  }
  async put(key: string, body: Uint8Array): Promise<void> {
    this.calls.push("put");
    if (this.failure) throw new ObjectStoreError(this.failure, 403, key);
    this.objects.set(key, body);
  }
  async delete(key: string): Promise<void> {
    this.calls.push("delete");
    this.objects.delete(key);
  }
}

function checkDependencies(options: {
  env?: Record<string, string | undefined>;
  store?: ProbeStore;
  databases?: Record<string, HostedDatabaseState | Error>;
  site?: Record<string, Response>;
}): HostedCheckDependencies & { requested: string[] } {
  const requested: string[] = [];
  return {
    requested,
    env: options.env ?? {},
    store: () => options.store ?? new ProbeStore(),
    async database(url) {
      const state = options.databases?.[url];
      if (!state) throw new Error(`unexpected database ${url}`);
      if (state instanceof Error) throw state;
      return state;
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      requested.push(`${url.pathname} ${init?.redirect}`);
      const path = url.pathname.startsWith("/images/") ? "/images" : url.pathname;
      return options.site?.[`${url.host}${path}`] ?? options.site?.[path] ?? new Response(null, { status: 404 });
    }) as typeof fetch,
  };
}

/** What each role holds, from the publisher's point of view: granted, refused, or everything. */
function privilegesOf(kind: "reader" | "publisher" | "sync"): Record<string, boolean> {
  const all = [...PUBLISHER_PRIVILEGES.required, ...PUBLISHER_PRIVILEGES.forbidden];
  return Object.fromEntries(
    all.map((entry) => [
      privilegeName(entry),
      kind === "sync" ? true : kind === "publisher" ? PUBLISHER_PRIVILEGES.required.includes(entry) : entry.privilege === "SELECT",
    ])
  );
}

const READY = (user: string, canWrite: boolean, kind: "reader" | "publisher" | "sync" = canWrite ? "publisher" : "reader"): HostedDatabaseState => ({
  user,
  ready: true,
  canRead: true,
  canWrite,
  privileges: privilegesOf(kind),
  bypassesRowSecurity: false,
  main: { commit: "c".repeat(40), publishedAt: new Date("2026-10-01T00:00:00Z") },
});

await test("passes when the bucket round-trips, each credential can do its job, and the site asks for a login", async () => {
  const ws = hostedWorkspace({ enabled: true, bucket: BUCKET, site_url: "https://screens.example.test" });
  const store = new ProbeStore();
  const dependencies = checkDependencies({
    env: {
      AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
      AWS_SECRET_ACCESS_KEY: "secret",
      DATABASE_URL: "postgres://reader",
      DATABASE_URL_SCREENS_PUBLISH: "postgres://publisher",
    },
    store,
    databases: { "postgres://reader": READY("tieline_reader", false), "postgres://publisher": READY("tieline_capture_publisher", true) },
    site: {
      "/": new Response("Log in", { status: 401 }),
      "/images": new Response(null, { status: 302, headers: { location: "https://app.netlify.com/login" } }),
    },
  });
  const { io, output } = captureIO();
  assert.equal(await runHostedCheckCommand({ repository: ws.root }, io, dependencies), 0);
  assert.deepEqual(store.calls, ["put", "head", "delete", "head"]);
  assert.equal(store.objects.size, 0, "the probe is deleted");
  assert.deepEqual(dependencies.requested, ["/ manual", `/images/${"0".repeat(64)} manual`]);
  assert.match(output(), /pass  storage: wrote, found, and deleted a probe object in bucket acme-screens/);
  assert.match(output(), /pass  database DATABASE_URL: tieline_reader can read: the hosted site reads published pages/);
  assert.match(output(), /pass  database DATABASE_URL_SCREENS_PUBLISH: tieline_capture_publisher can publish, and nothing more/);
  assert.match(output(), /skip  database DATABASE_URL_SYNC: not set/);
  assert.match(output(), /pass  site \/: asks for a login \(HTTP 401\)/);
  assert.match(output(), /pass  site \/images\/<digest>: redirects to a login at app\.netlify\.com\/login \(HTTP 302\)/);
  assert.match(output(), /note  main was last published at 2026-10-01T00:00:00\.000Z \(commit cccccccccccc\)/);
});

await test("fails when the site serves anonymous visitors, storage refuses, or a role has the wrong privileges", async () => {
  const ws = hostedWorkspace();
  const dependencies = checkDependencies({
    env: {
      AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
      AWS_SECRET_ACCESS_KEY: "secret",
      DATABASE_URL: "postgres://writer",
      DATABASE_URL_SCREENS_PUBLISH: "postgres://publisher",
      DATABASE_URL_SYNC: "postgres://sync",
    },
    store: new ProbeStore("Object storage PUT failed: HTTP 403 (AccessDenied)."),
    databases: {
      "postgres://writer": READY("tieline_capture_publisher", true),
      "postgres://publisher": READY("tieline_reader", false),
      "postgres://sync": new Error("password authentication failed for user \"tieline_repository_sync\""),
    },
    site: {
      "/": new Response("<h1>notes</h1>", { status: 200, headers: { [HOSTED_SITE_HEADER]: "1" } }),
      "/images": new Response(null, { status: 404, headers: { [HOSTED_SITE_HEADER]: "1" } }),
    },
  });
  const { io, output } = captureIO();
  assert.equal(await runHostedCheckCommand({ repository: ws.root, url: "https://screens.example.test", json: true }, io, dependencies), 1);
  const result = JSON.parse(output()) as { passed: boolean; results: Array<{ check: string; status: string; detail: string }> };
  assert.equal(result.passed, false);
  const byCheck = new Map(result.results.map((entry) => [entry.check, entry]));
  assert.match(byCheck.get("storage")!.detail, /AccessDenied/);
  assert.match(byCheck.get("database DATABASE_URL")!.detail, /tieline_capture_publisher can also write published screens; the hosted site must use the read-only reader role/);
  assert.match(
    byCheck.get("database DATABASE_URL_SCREENS_PUBLISH")!.detail,
    /tieline_reader is not the capture publisher role: it lacks INSERT on screen_snapshots, UPDATE on screen_snapshots \(page_html\), INSERT on screen_images, UPDATE on screen_images \(last_referenced_at\), which publishing needs/
  );
  assert.match(byCheck.get("database DATABASE_URL_SYNC")!.detail, /password authentication failed/);
  assert.match(byCheck.get("site /")!.detail, /answered without a login \(HTTP 200\); turn on the host's access control/);
  assert.equal(byCheck.get("site /images/<digest>")!.status, "fail", "even a 404 from the site means it let an anonymous visitor in");
});

await test("accepts only the publisher role for publishing: not more, not less", async () => {
  const ws = hostedWorkspace();
  const check = async (state: HostedDatabaseState) => {
    const { io, output } = captureIO();
    const dependencies = checkDependencies({ env: { DATABASE_URL_SCREENS_PUBLISH: "postgres://p" }, databases: { "postgres://p": state } });
    const code = await runHostedCheckCommand({ repository: ws.root, json: true }, io, dependencies);
    return { code, detail: (JSON.parse(output()) as { results: Array<{ check: string; detail: string }> }).results.find((entry) => entry.check === "database DATABASE_URL_SCREENS_PUBLISH")!.detail };
  };
  assert.equal((await check(READY("tieline_capture_publisher", true))).code, 0);
  // The sync role can write too, but it can also delete and write main and its history.
  const sync = await check(READY("tieline_repository_sync", true, "sync"));
  assert.equal(sync.code, 1);
  assert.match(sync.detail, /holds DELETE on screen_snapshots, DELETE on screen_images, UPDATE on screen_images \(byte_size\), INSERT on screen_history, UPDATE on screen_history, DELETE on screen_history, which a capture job must not/);
  // A role that can only insert cannot replace a page it published before.
  const insertOnly = READY("inserter", true);
  insertOnly.privileges = { ...insertOnly.privileges, [privilegeName({ table: "screen_snapshots", privilege: "UPDATE", column: "page_html" })]: false };
  assert.match((await check(insertOnly)).detail, /lacks UPDATE on screen_snapshots \(page_html\), which publishing needs/);
  // Exactly the grants, but row security does not bind it: it could write main.
  const owner = { ...READY("table_owner", true), bypassesRowSecurity: true };
  assert.match((await check(owner)).detail, /is not bound by row security, so it could write main's page/);
});

await test("follows redirects to see whether the site ends at a login or at itself", async () => {
  const ws = hostedWorkspace();
  const run = async (site: Record<string, Response>) => {
    const { io, output } = captureIO();
    await runHostedCheckCommand({ repository: ws.root, url: "https://screens.example.test", json: true }, io, checkDependencies({ site }));
    return new Map((JSON.parse(output()) as { results: Array<{ check: string; status: string; detail: string }> }).results.map((entry) => [entry.check, entry]));
  };
  const answered = new Response("<h1>notes</h1>", { status: 200, headers: { [HOSTED_SITE_HEADER]: "1" } });
  // An alias redirected to the canonical host, which serves the page: not protected.
  const alias = await run({
    "screens.example.test/": new Response(null, { status: 301, headers: { location: "https://canonical.example.test/" } }),
    "canonical.example.test/": answered,
    "/images": new Response(null, { status: 401 }),
  });
  assert.equal(alias.get("site /")!.status, "fail");
  assert.match(alias.get("site /")!.detail, /answered without a login \(HTTP 200\) after 1 redirect\(s\), at canonical\.example\.test\//);
  // A redirect to a login that returns here, as identity providers do: protected.
  const login = await run({
    "/": new Response(null, {
      status: 302,
      headers: { location: `https://id.example.test/start?return_to=${encodeURIComponent("https://screens.example.test/")}` },
    }),
    "/images": new Response(null, { status: 302, headers: { location: "https://id.example.test/cdn-cgi/access/login/screens" } }),
  });
  assert.equal(login.get("site /")!.status, "pass");
  assert.match(login.get("site /")!.detail, /redirects to a login at id\.example\.test\/start \(HTTP 302\)/);
  assert.equal(login.get("site /images/<digest>")!.status, "pass");
  // A redirect to some other public page is not a login.
  const elsewhere = await run({
    "/": new Response(null, { status: 302, headers: { location: "https://www.example.test/" } }),
    "www.example.test/": new Response("<h1>Welcome</h1>", { status: 200 }),
    "/images": new Response(null, { status: 403 }),
  });
  assert.equal(elsewhere.get("site /")!.status, "fail");
  assert.match(elsewhere.get("site /")!.detail, /HTTP 200 after 1 redirect\(s\), at www\.example\.test\/ came from something other than the hosted site or a login/);
  // Redirects are bounded.
  const loop = await run({
    "/": new Response(null, { status: 302, headers: { location: "/" } }),
    "/images": new Response(null, { status: 401 }),
  });
  assert.match(loop.get("site /")!.detail, new RegExp(`more than ${SITE_CHECK_REDIRECTS} redirects`));
});

await test("deletes the storage probe when a check fails after writing it", async () => {
  const ws = hostedWorkspace();
  const store = new ProbeStore(null, "Object storage HEAD failed: HTTP 403 (AccessDenied).");
  const { io, output } = captureIO();
  const dependencies = checkDependencies({ env: { AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: "secret" }, store });
  assert.equal(await runHostedCheckCommand({ repository: ws.root }, io, dependencies), 1);
  assert.deepEqual(store.calls, ["put", "head", "delete"]);
  assert.equal(store.objects.size, 0, "the probe was removed even though the check failed");
  assert.match(output(), /fail  storage: Object storage HEAD failed: HTTP 403 \(AccessDenied\)\./);
});

await test("skips what this environment cannot check and refuses an http site URL", async () => {
  const ws = hostedWorkspace();
  const { io, output } = captureIO();
  assert.equal(await runHostedCheckCommand({ repository: ws.root }, io, checkDependencies({})), 0);
  assert.match(output(), /skip  storage: no object storage credentials are set \(TIELINE_SCREENS_S3_\* or AWS_\*\)/);
  assert.match(output(), /skip  site: pass --url or set screens.hosted.site_url/);
  await assert.rejects(runHostedCheckCommand({ repository: ws.root, url: "http://screens.example.test" }, io, checkDependencies({})), /must use https/);
  const unknown = checkDependencies({ site: { "/": new Response("hello", { status: 200 }) } });
  const site = captureIO();
  assert.equal(await runHostedCheckCommand({ repository: ws.root, url: "https://other.example.test" }, site.io, unknown), 1);
  assert.match(site.output(), /fail  site \/: HTTP 200 came from something other than the hosted site or a login/);
});

console.log("hosted site: pull-request comment");

await test("summarizes a publish for the pull-request comment, linking to the page when the site is known", () => {
  const changes = {
    base: "main",
    base_has_manifest: true,
    records: [
      { kind: "story" as const, stable_id: "NOTES-001", story_stable_id: "NOTES-001", title: "t", status: "changed" as const, aspects: ["content" as const] },
    ],
    screens: [
      { stable_id: "a", capability: "NOTES", title: "a", status: "added" as const, aspects: [] },
      { stable_id: "b", capability: "NOTES", title: "b", status: "changed" as const, aspects: ["image" as const] },
    ],
  };
  const summary = renderPublishSummary({ label: "pr-42", commit: "d".repeat(40), siteUrl: "https://screens.example.test", comparison: { changes } });
  assert.equal(
    summary,
    `${SCREENS_COMMENT_MARKER}\n### Screens\n\nChanges against \`main\`: Stories: 1 changed · screens: 1 new, 1 changed.\n\n[Open the review of pr-42](https://screens.example.test/?ref=pr-42) · published at \`dddddddddddd\`\n`
  );
  assert.match(
    renderPublishSummary({ label: "feature/x", commit: "d".repeat(40), siteUrl: null, comparison: { changes: { ...changes, records: [], screens: [] } } }),
    /No changes against `main`\.\n\npublished at/
  );
  assert.match(
    renderPublishSummary({ label: "pr-1", commit: "d".repeat(40), siteUrl: null, comparison: { base: "main", unavailable: "`injected`" } }),
    /are not shown: main has not been published yet/
  );
});

for (const ws of workspaces) ws.cleanup();
report();
