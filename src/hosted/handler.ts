/**
 * The hosted screens site, as a standard `Request` → `Response` handler that
 * any host can wrap. It serves only what publishing stored: a ref's review
 * page at `/?ref=<ref>` (`main` by default), and the images those pages show
 * at `/images/<digest>`, each checked against its digest before it is sent.
 * It writes nothing and never logs a visitor in: the host's own access
 * control must stand in front of it.
 */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { ObjectReader } from "../adapters/object-store/s3.js";
import type { HostedImage, HostedPage } from "../adapters/postgres/hosted-screens-repository.js";
import { hostedRefLabel, parseRequestedRef, type HostedRef } from "../contract/hosted-ref.js";

export const HOSTED_SITE_LIMITS = {
  /**
   * Largest response body sent; a bigger image is redirected to a
   * short-lived link instead. Netlify functions return at most 6 MB.
   */
  responseBytes: 4 * 1024 * 1024,
  /** Largest image read from the bucket, the bound publishing applies. */
  imageBytes: 25 * 1024 * 1024,
  /** How long a redirect link to a large image works. */
  presignedSeconds: 60,
  /** Longest a request waits on the bucket. */
  storeTimeoutMs: 8_000,
} as const;

/** Every response carries this header, so `tieline hosted check` can tell the site answered. */
export const HOSTED_SITE_HEADER = "x-tieline-hosted";

export interface HostedSiteStores {
  pages: { page(repositoryKey: string, ref: { kind: "main" } | HostedRef): Promise<HostedPage | null> };
  images: { image(repositoryKey: string, digest: string): Promise<HostedImage | null> };
  objects: Pick<ObjectReader, "get" | "presignGet">;
}

export interface HostedSiteOptions {
  repositoryKey: string;
  stores: HostedSiteStores;
  /** Overrides `HOSTED_SITE_LIMITS.responseBytes` for hosts with other limits. */
  responseBytes?: number;
  /** Where failures are reported; the host's function log by default. */
  log?: (message: string) => void;
}

// The review page is self-contained: inline script and style, images from
// this site or the https URLs a catalog names.
const PAGE_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const IMAGE_DIGEST = /^\/images\/([a-f0-9]{64})$/;

function headers(extra: Record<string, string>): Headers {
  return new Headers({
    [HOSTED_SITE_HEADER]: "1",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "cache-control": "private, no-store",
    ...extra,
  });
}

function text(status: number, message: string, extra: Record<string, string> = {}): Response {
  return new Response(`${message}\n`, {
    status,
    headers: headers({
      "content-type": "text/plain; charset=utf-8",
      "content-security-policy": "default-src 'none'",
      ...extra,
    }),
  });
}

/** Whether the visitor accepts gzip: listed, and not with `q=0`. */
function acceptsGzip(request: Request): boolean {
  return (request.headers.get("accept-encoding") ?? "").split(",").some((entry) => {
    const [name, ...parameters] = entry.split(";").map((part) => part.trim().toLowerCase());
    const quality = parameters.find((parameter) => parameter.startsWith("q="));
    return name === "gzip" && (quality === undefined || Number(quality.slice(2)) > 0);
  });
}

export function createHostedScreensHandler(options: HostedSiteOptions): (request: Request) => Promise<Response> {
  const responseBytes = options.responseBytes ?? HOSTED_SITE_LIMITS.responseBytes;
  const log = options.log ?? ((message: string) => console.error(message));
  const { stores, repositoryKey } = options;

  async function page(request: Request, url: URL): Promise<Response> {
    const ref = parseRequestedRef(url.searchParams.get("ref"));
    if (!ref) return text(400, "That is not a ref hosted screens publish: use main, pr-<number>, or a branch name.");
    const stored = await stores.pages.page(repositoryKey, ref);
    const label = ref.kind === "main" ? "main" : hostedRefLabel(ref);
    if (!stored) return text(404, `Nothing is published for ${label}.`);
    const raw = Buffer.from(stored.html, "utf8");
    const gzip = acceptsGzip(request);
    const body = gzip ? gzipSync(raw) : raw;
    if (body.byteLength > responseBytes) {
      log(`tieline hosted: the page for ${label} is ${body.byteLength} bytes, over this host's ${responseBytes}-byte response limit.`);
      return text(502, `The page for ${label} is too large for this host to send.`);
    }
    return new Response(body, {
      status: 200,
      headers: headers({
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": PAGE_POLICY,
        "content-length": String(body.byteLength),
        vary: "accept-encoding",
        ...(gzip ? { "content-encoding": "gzip" } : {}),
      }),
    });
  }

  async function image(digest: string): Promise<Response> {
    const record = await stores.images.image(repositoryKey, digest);
    if (!record) return text(404, "No published image has that digest.");
    const key = `${repositoryKey}/sha256/${digest}`;
    const bytes = await stores.objects.get(
      key,
      Math.min(record.byteSize, HOSTED_SITE_LIMITS.imageBytes),
      AbortSignal.timeout(HOSTED_SITE_LIMITS.storeTimeoutMs)
    );
    if (!bytes) return text(404, "The image is not in the bucket.");
    // Anyone holding the bucket's write credentials could replace the bytes,
    // so they are sent only when they are still the image the digest names.
    if (createHash("sha256").update(bytes).digest("hex") !== digest) {
      log(`tieline hosted: the stored image ${digest} does not match its digest; it was not served.`);
      return text(502, "The stored image does not match its digest.");
    }
    if (bytes.byteLength > responseBytes) {
      // Too large to send through the host. The bytes were just checked
      // against the digest, so hand the visitor, who already passed the
      // host's access check, a link to them that works for a minute. Only a
      // replacement within that minute could still get through.
      return new Response(null, {
        status: 302,
        headers: headers({ location: stores.objects.presignGet(key, HOSTED_SITE_LIMITS.presignedSeconds) }),
      });
    }
    return new Response(bytes, {
      status: 200,
      headers: headers({
        "content-type": record.contentType,
        "content-length": String(bytes.byteLength),
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": "private, max-age=31536000, immutable",
      }),
    });
  }

  return async (request) => {
    if (request.method !== "GET") return text(405, "Only GET is supported.", { allow: "GET" });
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return text(400, "The request URL is not valid.");
    }
    try {
      if (url.pathname === "/") return await page(request, url);
      const digest = IMAGE_DIGEST.exec(url.pathname)?.[1];
      if (digest) return await image(digest);
      return text(404, "Not found.");
    } catch (error) {
      log(`tieline hosted: ${error instanceof Error ? error.message : String(error)}`);
      return text(502, "The hosted screens store is unavailable. Try again shortly.");
    }
  };
}
