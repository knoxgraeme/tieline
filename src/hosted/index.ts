/**
 * `tieline/hosted`: the hosted screens site for a host's function runtime.
 *
 *   import { createHostedScreensSite } from "tieline/hosted";
 *   export default createHostedScreensSite({ repository: "acme-notes", bucket: "acme-screens" });
 *
 * The site reads with the database reader role (`DATABASE_URL`) and with
 * object storage credentials that need only read access
 * (`TIELINE_SCREENS_S3_*`, or `AWS_*` where the host does not reserve them).
 * Nothing is
 * opened until the first request, so a missing setting is reported on the
 * page instead of failing the deployment.
 */
import postgres, { type Sql } from "postgres";
import { readObjectStoreSettings, S3ObjectStore } from "../adapters/object-store/s3.js";
import { PostgresHostedScreensReader } from "../adapters/postgres/hosted-screens-repository.js";
import { createHostedScreensHandler, HOSTED_SITE_HEADER } from "./handler.js";

export {
  createHostedScreensHandler,
  HOSTED_SITE_HEADER,
  HOSTED_SITE_LIMITS,
  type HostedSiteOptions,
  type HostedSiteStores,
} from "./handler.js";

export interface HostedScreensSiteOptions {
  /** The repository key the screens were published under. */
  repository: string;
  /** The bucket that holds the images. */
  bucket: string;
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Overrides the largest response body the host allows. */
  responseBytes?: number;
}

const REPOSITORY_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

function readerUrl(env: Record<string, string | undefined>): string {
  const url = env.DATABASE_URL?.trim() ?? "";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("DATABASE_URL must hold the Tieline reader role's Postgres connection string.");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must be a postgres:// connection string.");
  }
  return url;
}

export function createHostedScreensSite(options: HostedScreensSiteOptions): (request: Request) => Promise<Response> {
  let handler: ((request: Request) => Promise<Response>) | null = null;
  let sql: Sql | null = null;
  return async (request) => {
    if (!handler) {
      try {
        if (!REPOSITORY_KEY.test(options.repository)) {
          throw new Error(`'${options.repository}' is not a repository key.`);
        }
        const env = options.env ?? process.env;
        const objects = new S3ObjectStore(readObjectStoreSettings(env, options.bucket));
        sql ??= postgres(readerUrl(env), { max: 1, idle_timeout: 20, connect_timeout: 10, prepare: false });
        const connection = sql;
        const reader = new PostgresHostedScreensReader(() => connection);
        handler = createHostedScreensHandler({
          repositoryKey: options.repository,
          stores: { pages: reader, images: reader, objects },
          ...(options.responseBytes === undefined ? {} : { responseBytes: options.responseBytes }),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`tieline hosted: ${message}`);
        return new Response(`Tieline hosted screens are not configured: ${message}\n`, {
          status: 500,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "x-content-type-options": "nosniff",
            "cache-control": "private, no-store",
            [HOSTED_SITE_HEADER]: "1",
          },
        });
      }
    }
    return handler(request);
  };
}
