/**
 * A small client for S3-compatible object storage (Neon Object Storage, AWS
 * S3, Cloudflare R2, MinIO): Signature Version 4 over `fetch`, path-style
 * addressing, and only the operations hosted screens use. It needs no SDK,
 * because those operations are three signed requests with no streaming,
 * multipart, or pagination.
 */
import { createHash, createHmac } from "node:crypto";

export interface ObjectStoreSettings {
  /** Service origin, for example `https://<host>`; the bucket is a path segment. */
  endpoint: URL;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string | null;
}

/** Reading objects, which only the hosted site needs. */
export interface ObjectReader {
  /** The object's bytes, or null when it does not exist; refuses one larger than `maxBytes`. */
  get(key: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array | null>;
  /** A URL that fetches `key` without credentials until it expires. */
  presignGet(key: string, expiresSeconds: number): string;
}

export interface ObjectStore {
  /** Whether `key` exists. */
  head(key: string, signal?: AbortSignal): Promise<boolean>;
  /** Stores `body` at `key`; the store verifies the body against its signed digest. */
  put(key: string, body: Uint8Array, contentType: string, signal?: AbortSignal): Promise<void>;
  /** Deletes `key`; a key that does not exist is not an error. */
  delete(key: string, signal?: AbortSignal): Promise<void>;
}

export class ObjectStoreError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly key: string
  ) {
    super(message);
    this.name = "ObjectStoreError";
  }
}

export const OBJECT_STORE_LIMITS = {
  /** Longest a single request may take. */
  requestTimeoutMs: 30_000,
  /** Attempts for a request that failed on the network or with a 5xx or 429. */
  attempts: 3,
  /** Delay before the second attempt; each later one waits four times longer. */
  firstBackoffMs: 250,
  /** Most error-body bytes read for a message. */
  errorBodyBytes: 2_048,
} as const;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ACCESS_KEY = /^[A-Za-z0-9+/=._-]{1,256}$/;
const SERVICE = "s3";
const UNSIGNED_EMPTY = createHash("sha256").update("").digest("hex");

type Environment = Record<string, string | undefined>;

/** Whether `bucket` is a valid S3 bucket name. */
export function isBucketName(bucket: string): boolean {
  return BUCKET.test(bucket) && !bucket.includes("..");
}

/**
 * Reads the object store from the standard AWS variables, which Neon's
 * storage credentials also use: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
 * optional `AWS_SESSION_TOKEN`, `AWS_REGION` (or `AWS_DEFAULT_REGION`), and
 * `AWS_ENDPOINT_URL_S3` (or `AWS_ENDPOINT_URL`). Without an endpoint the AWS
 * S3 endpoint for the region is used. The endpoint must use HTTPS, except on
 * a loopback host, so credentials and images never cross the network in
 * clear text.
 */
export function readObjectStoreSettings(env: Environment, bucket: string): ObjectStoreSettings {
  if (!isBucketName(bucket)) throw new Error(`'${bucket}' is not a valid bucket name.`);
  const accessKeyId = env.AWS_ACCESS_KEY_ID?.trim() ?? "";
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY?.trim() ?? "";
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must hold the object storage credentials for hosted screens."
    );
  }
  if (!ACCESS_KEY.test(accessKeyId) || secretAccessKey.length > 256) {
    throw new Error("AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY is malformed.");
  }
  const region = (env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "").trim();
  if (!REGION.test(region)) {
    throw new Error("AWS_REGION must name the object storage region (for example aws-us-east-2).");
  }
  const rawEndpoint = (env.AWS_ENDPOINT_URL_S3 ?? env.AWS_ENDPOINT_URL ?? "").trim();
  let endpoint: URL;
  try {
    endpoint = new URL(rawEndpoint || `https://s3.${region}.amazonaws.com`);
  } catch {
    throw new Error("AWS_ENDPOINT_URL_S3 is not a valid URL.");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("AWS_ENDPOINT_URL_S3 must not carry credentials, a query, or a fragment.");
  }
  if (endpoint.pathname !== "/") {
    throw new Error("AWS_ENDPOINT_URL_S3 must be an origin without a path; the bucket is added as one.");
  }
  if (
    endpoint.protocol !== "https:" &&
    !(endpoint.protocol === "http:" && LOOPBACK_HOSTS.has(endpoint.hostname))
  ) {
    throw new Error("AWS_ENDPOINT_URL_S3 must use https (plain http is allowed only on a loopback host).");
  }
  const sessionToken = env.AWS_SESSION_TOKEN?.trim() || null;
  if (sessionToken !== null && sessionToken.length > 4_096) {
    throw new Error("AWS_SESSION_TOKEN is malformed.");
  }
  return { endpoint, region, bucket, accessKeyId, secretAccessKey, sessionToken };
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** RFC 3986 encoding, which S3 signs: everything but unreserved characters. */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

export interface SignableRequest {
  method: string;
  /** Host header value, with a port only when it is not the scheme's default. */
  host: string;
  /** The already-encoded request path. */
  path: string;
  /** Headers to sign besides `host`, `x-amz-date`, and `x-amz-content-sha256`. */
  headers: Record<string, string>;
  payloadHash: string;
}

/**
 * Signs a request with AWS Signature Version 4 and returns every header to
 * send, `authorization` included. Requests carry no query string.
 */
export function signRequest(
  request: SignableRequest,
  credentials: Pick<ObjectStoreSettings, "accessKeyId" | "secretAccessKey" | "sessionToken" | "region">,
  now: Date
): Record<string, string> {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value.trim()])
    ),
    host: request.host,
    "x-amz-content-sha256": request.payloadHash,
    "x-amz-date": amzDate,
    ...(credentials.sessionToken ? { "x-amz-security-token": credentials.sessionToken } : {}),
  };
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    request.method,
    request.path,
    "",
    ...names.map((name) => `${name}:${headers[name]!.replace(/\s+/g, " ")}`),
    "",
    signedHeaders,
    request.payloadHash,
  ].join("\n");
  const scope = `${date}/${credentials.region}/${SERVICE}/aws4_request`;
  const signature = sign(credentials, date, ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n"));
  const { host: _host, ...sent } = headers;
  return {
    ...sent,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function sign(
  credentials: Pick<ObjectStoreSettings, "secretAccessKey" | "region">,
  date: string,
  stringToSign: string
): string {
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, date), credentials.region), SERVICE),
    "aws4_request"
  );
  return createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
}

/**
 * A presigned GET URL (Signature Version 4 in the query string), valid for
 * `expiresSeconds` from `now`. Only the host header is signed, so the URL
 * works from any client until it expires.
 */
export function presignGetUrl(
  endpoint: URL,
  path: string,
  credentials: Pick<ObjectStoreSettings, "accessKeyId" | "secretAccessKey" | "sessionToken" | "region">,
  now: Date,
  expiresSeconds: number
): string {
  if (!Number.isInteger(expiresSeconds) || expiresSeconds < 1 || expiresSeconds > 604_800) {
    throw new Error("A presigned URL must expire within 1 second to 7 days.");
  }
  const url = new URL(path, endpoint);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${credentials.region}/${SERVICE}/aws4_request`;
  const query: Array<[string, string]> = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${credentials.accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(expiresSeconds)],
    ...(credentials.sessionToken ? ([["X-Amz-Security-Token", credentials.sessionToken]] as Array<[string, string]>) : []),
    ["X-Amz-SignedHeaders", "host"],
  ];
  const canonicalQuery = query
    .map(([name, value]) => `${encodeSegment(name)}=${encodeSegment(value)}`)
    .sort()
    .join("&");
  const canonicalRequest = ["GET", path, canonicalQuery, `host:${url.host}`, "", "host", "UNSIGNED-PAYLOAD"].join("\n");
  const signature = sign(credentials, date, ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n"));
  return `${url.origin}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

async function errorDetail(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length < OBJECT_STORE_LIMITS.errorBodyBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const text = Buffer.concat(chunks).toString("utf8").slice(0, OBJECT_STORE_LIMITS.errorBodyBytes);
  const code = /<Code>([^<]{1,100})<\/Code>/.exec(text)?.[1];
  return code ? ` (${code})` : "";
}

function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

function wait(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolveWait, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveWait();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface S3ObjectStoreOptions {
  fetch?: typeof fetch;
  now?: () => Date;
  /** Backoff before a retry; injectable so tests need not wait. */
  sleep?: (milliseconds: number, signal: AbortSignal | undefined) => Promise<void>;
}

export class S3ObjectStore implements ObjectStore, ObjectReader {
  private readonly fetch: typeof fetch;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number, signal: AbortSignal | undefined) => Promise<void>;

  constructor(
    private readonly settings: ObjectStoreSettings,
    options: S3ObjectStoreOptions = {}
  ) {
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? wait;
  }

  async head(key: string, signal?: AbortSignal): Promise<boolean> {
    return (await this.sendAndDiscard("HEAD", key, null, {}, signal, [200, 404])) === 200;
  }

  async put(key: string, body: Uint8Array, contentType: string, signal?: AbortSignal): Promise<void> {
    await this.sendAndDiscard("PUT", key, body, { "content-type": contentType }, signal, [200]);
  }

  async delete(key: string, signal?: AbortSignal): Promise<void> {
    await this.sendAndDiscard("DELETE", key, null, {}, signal, [200, 204, 404]);
  }

  async get(key: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array | null> {
    const response = await this.send("GET", key, null, {}, signal, [200, 404]);
    if (response.status === 404 || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maxBytes) {
          throw new ObjectStoreError(`Object '${key}' is larger than ${maxBytes} bytes.`, response.status, key);
        }
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return Buffer.concat(chunks, length);
  }

  presignGet(key: string, expiresSeconds: number): string {
    return presignGetUrl(this.settings.endpoint, this.objectPath(key), this.settings, this.now(), expiresSeconds);
  }

  private objectPath(key: string): string {
    if (key.length === 0 || key.length > 1_024 || key.startsWith("/")) {
      throw new ObjectStoreError(`Object key '${key}' is not valid.`, null, key);
    }
    return `/${encodeSegment(this.settings.bucket)}/${key.split("/").map(encodeSegment).join("/")}`;
  }

  private async sendAndDiscard(
    method: "HEAD" | "PUT" | "DELETE",
    key: string,
    body: Uint8Array | null,
    headers: Record<string, string>,
    signal: AbortSignal | undefined,
    accepted: readonly number[]
  ): Promise<number> {
    const response = await this.send(method, key, body, headers, signal, accepted);
    await response.body?.cancel().catch(() => undefined);
    return response.status;
  }

  /** Sends a signed request, retrying, and returns an accepted response with its body unread. */
  private async send(
    method: "GET" | "HEAD" | "PUT" | "DELETE",
    key: string,
    body: Uint8Array | null,
    headers: Record<string, string>,
    signal: AbortSignal | undefined,
    accepted: readonly number[]
  ): Promise<Response> {
    const path = this.objectPath(key);
    const url = new URL(path, this.settings.endpoint);
    const payloadHash = body ? sha256Hex(body) : UNSIGNED_EMPTY;
    let lastFailure = "";
    for (let attempt = 1; attempt <= OBJECT_STORE_LIMITS.attempts; attempt += 1) {
      if (attempt > 1) {
        await this.sleep(OBJECT_STORE_LIMITS.firstBackoffMs * 4 ** (attempt - 2), signal);
      }
      const signed = signRequest(
        { method, host: url.host, path, headers, payloadHash },
        this.settings,
        this.now()
      );
      const timeout = AbortSignal.timeout(OBJECT_STORE_LIMITS.requestTimeoutMs);
      let response: Response;
      try {
        response = await this.fetch(url, {
          method,
          headers: signed,
          ...(body ? { body } : {}),
          redirect: "error",
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        lastFailure = error instanceof Error ? error.message : String(error);
        continue;
      }
      if (accepted.includes(response.status)) return response;
      const detail = await errorDetail(response);
      lastFailure = `HTTP ${response.status}${detail}`;
      if (!retryable(response.status)) {
        throw new ObjectStoreError(
          `Object storage ${method} '${key}' failed: ${lastFailure}.`,
          response.status,
          key
        );
      }
    }
    throw new ObjectStoreError(
      `Object storage ${method} '${key}' failed after ${OBJECT_STORE_LIMITS.attempts} attempts: ${lastFailure}.`,
      null,
      key
    );
  }
}
