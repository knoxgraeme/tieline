/**
 * Opt-in check of the S3 client against a real S3-compatible server that
 * verifies signatures, such as a local SeaweedFS or MinIO:
 *
 *   TIELINE_S3_TEST_ENDPOINT=http://127.0.0.1:8333 \
 *   TIELINE_S3_TEST_ACCESS_KEY_ID=... TIELINE_S3_TEST_SECRET_ACCESS_KEY=... \
 *   npx tsx tests/integration/object-store-s3.ts
 *
 * It creates and empties a disposable bucket, so it refuses any endpoint
 * that is not on a loopback host. It is not part of `npm run check`, which
 * must not need a storage server.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  ObjectStoreError,
  readObjectStoreSettings,
  S3ObjectStore,
  signRequest,
} from "../../src/adapters/object-store/s3.js";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const endpoint = process.env.TIELINE_S3_TEST_ENDPOINT ?? "";
if (!endpoint || !LOOPBACK.has(new URL(endpoint).hostname)) {
  console.error("TIELINE_S3_TEST_ENDPOINT must name a disposable S3-compatible server on a loopback host.");
  process.exit(1);
}
const env = {
  AWS_ENDPOINT_URL_S3: endpoint,
  AWS_REGION: process.env.TIELINE_S3_TEST_REGION ?? "us-east-1",
  AWS_ACCESS_KEY_ID: process.env.TIELINE_S3_TEST_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.TIELINE_S3_TEST_SECRET_ACCESS_KEY,
};
const bucket = `tieline-test-${Date.now()}`;
const settings = readObjectStoreSettings(env, bucket);
const store = new S3ObjectStore(settings);

/** Bucket setup and teardown, which the client itself never needs. */
async function bucketRequest(method: "PUT" | "DELETE"): Promise<void> {
  const path = `/${bucket}`;
  const url = new URL(path, settings.endpoint);
  const headers = signRequest(
    { method, host: url.host, path, headers: {}, payloadHash: createHash("sha256").update("").digest("hex") },
    settings,
    new Date()
  );
  const response = await fetch(url, { method, headers });
  await response.body?.cancel();
  assert.ok(response.ok, `${method} bucket: HTTP ${response.status}`);
}

await bucketRequest("PUT");
const image = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("acme notes")]);
const keys = ["acme-notes/sha256/abc", "acme notes/it's (1)*+=~.png"];
try {
  for (const key of keys) {
    assert.equal(await store.head(key), false, `${key} starts absent`);
    await store.put(key, image, "image/png");
    assert.equal(await store.head(key), true, `${key} exists after put`);
  }
  const forged = new S3ObjectStore({ ...settings, secretAccessKey: "not-the-secret" });
  await assert.rejects(forged.head(keys[0]!), (error: unknown) => error instanceof ObjectStoreError && error.status === 403);
  for (const key of keys) {
    await store.delete(key);
    assert.equal(await store.head(key), false, `${key} is gone after delete`);
    await store.delete(key);
  }
  console.log(`object store check passed against ${endpoint}`);
} finally {
  for (const key of keys) await store.delete(key).catch(() => undefined);
  await bucketRequest("DELETE");
}
