import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import postgres from "postgres";
import { readObjectStoreSettings, S3ObjectStore, type ObjectStore } from "../adapters/object-store/s3.js";
import type { ScreensHostedConfig } from "../config.js";
import { withinRepository } from "../contract/paths.js";
import { realDestination, screenSettingsForRepository } from "../contract/screen-catalog.js";
import { HOSTED_SITE_HEADER } from "../hosted/handler.js";
import { TIELINE_VERSION } from "../package-metadata.js";
import { escapeTerminalText, resolveCommandContext, type CommandIO } from "./shared.js";

const NOT_ENABLED =
  'Hosted screens are not enabled for this repository. Add "hosted": { "enabled": true, "bucket": "<bucket>" } to the screens block of .tieline/config.json to opt in.';

function hostedConfig(root: string): ScreensHostedConfig {
  const settings = screenSettingsForRepository(root);
  if (!settings?.hosted) throw new Error(NOT_ENABLED);
  return settings.hosted;
}

export const DEFAULT_HOSTED_DIRECTORY = ".tieline/hosted";

/** The files of a Netlify site that serves hosted screens, by path within its directory. */
export function netlifySiteFiles(input: { repositoryKey: string; bucket: string; version: string }): Map<string, string> {
  return new Map([
    [
      "netlify.toml",
      `# Tieline hosted screens, written by \`tieline hosted init --host netlify\`.
# Create a Netlify site from this repository with this directory as its base
# directory. The site holds no data: it reads published pages and screenshots
# when they are requested, so publishing never redeploys it.

[build]
  publish = "public"
  command = "echo 'Nothing to build: the site serves published screens.'"

[functions]
  directory = "functions"
  node_bundler = "esbuild"
`,
    ],
    [
      "package.json",
      `${JSON.stringify(
        {
          private: true,
          type: "module",
          description: "Tieline hosted screens site, written by `tieline hosted init --host netlify`.",
          dependencies: { tieline: input.version },
        },
        null,
        2
      )}\n`,
    ],
    [
      "functions/screens.mjs",
      `// Tieline hosted screens, written by \`tieline hosted init --host netlify\`.
// Serves the review pages and screenshots that \`tieline screens publish\` and
// \`tieline contract sync\` stored. Set DATABASE_URL (the Tieline reader role)
// and the AWS_* object storage variables in the site's environment.
import { createHostedScreensSite } from "tieline/hosted";

export default createHostedScreensSite(${JSON.stringify({ repository: input.repositoryKey, bucket: input.bucket })});

export const config = { path: ["/", "/images/*"] };
`,
    ],
    ["public/robots.txt", "User-agent: *\nDisallow: /\n"],
    [
      "README.md",
      `# Hosted screens

This directory is a Netlify site that serves this repository's published
screens: \`main\` at \`/\`, and a pull request or branch at \`/?ref=pr-<number>\`
or \`/?ref=<branch>\`. It was written by \`tieline hosted init --host netlify\`.

1. In Netlify, add a site from this repository and set its base directory to
   this directory.
2. Set the site's environment variables:
   - \`DATABASE_URL\`: the Tieline reader role's connection string;
   - \`AWS_ENDPOINT_URL_S3\`, \`AWS_REGION\`, \`AWS_ACCESS_KEY_ID\`, and
     \`AWS_SECRET_ACCESS_KEY\`: credentials that can read the
     \`${input.bucket}\` bucket.
3. Turn on the site's access control (Visitor access or password
   protection). Tieline does not log visitors in; everyone who can reach the
   site can read every published page.
4. Run \`tieline hosted check --url <site URL>\` and confirm that the site
   asks for a login.
`,
    ],
  ]);
}

export interface HostedInitOptions {
  repository?: string;
  host: string;
  directory?: string;
  force?: boolean;
  json?: boolean;
}

/**
 * `tieline hosted init --host netlify`: writes a small, self-contained
 * Netlify site into a directory of the repository. Files that already exist
 * with other content are left alone unless `force` is set.
 */
export function runHostedInitCommand(options: HostedInitOptions, io: CommandIO): number {
  if (options.host !== "netlify") {
    throw new Error(`--host ${options.host} is not supported; hosted screens support netlify.`);
  }
  const { root, repositoryKey } = resolveCommandContext(options);
  const hosted = hostedConfig(root);
  const directorySetting = options.directory ?? DEFAULT_HOSTED_DIRECTORY;
  if (isAbsolute(directorySetting) || directorySetting.split(/[\\/]/).includes("..")) {
    throw new Error(`--directory '${directorySetting}' must be a path inside the repository.`);
  }
  const directory = resolve(root, directorySetting);
  if (directory === root || !withinRepository(realpathSync(root), realDestination(directory))) {
    throw new Error(`--directory '${directorySetting}' must be a directory inside the repository.`);
  }
  const files = netlifySiteFiles({ repositoryKey, bucket: hosted.bucket, version: TIELINE_VERSION });
  const plan = [...files].map(([name, content]) => {
    const path = resolve(directory, name);
    const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
    return {
      path: relative(root, path).split("\\").join("/"),
      absolutePath: path,
      content,
      status: existing === null ? ("created" as const) : existing === content ? ("unchanged" as const) : ("replaced" as const),
    };
  });
  const conflicts = plan.filter((file) => file.status === "replaced");
  if (conflicts.length > 0 && !options.force) {
    throw new Error(
      `These files already exist with other content: ${conflicts.map((file) => file.path).join(", ")}. Pass --force to replace them.`
    );
  }
  for (const file of plan) {
    if (file.status === "unchanged") continue;
    mkdirSync(dirname(file.absolutePath), { recursive: true });
    writeFileSync(file.absolutePath, file.content);
  }
  if (options.json) {
    io.write(`${JSON.stringify({ host: "netlify", files: plan.map(({ path, status }) => ({ path, status })) }, null, 2)}\n`);
    return 0;
  }
  for (const file of plan) io.write(`  ${file.status.padEnd(9)} ${escapeTerminalText(file.path)}\n`);
  io.write(
    `Wrote a Netlify site for hosted screens. Next: create a Netlify site with base directory ${escapeTerminalText(
      relative(root, directory)
    )}, set its environment, turn on its access control, and run \`tieline hosted check --url <site URL>\` (see its README.md).\n`
  );
  return 0;
}

export type HostedCheckStatus = "pass" | "fail" | "skip";

export interface HostedCheckResult {
  check: string;
  status: HostedCheckStatus;
  detail: string;
}

export interface HostedDatabaseState {
  user: string;
  ready: boolean;
  canRead: boolean;
  canWrite: boolean;
  /** When `main` was last published, if the role can read it. */
  main: { commit: string; publishedAt: Date } | null;
}

export interface HostedCheckDependencies {
  env: Record<string, string | undefined>;
  store(hosted: ScreensHostedConfig, env: Record<string, string | undefined>): ObjectStore;
  database(url: string, repositoryKey: string): Promise<HostedDatabaseState>;
  fetch: typeof fetch;
}

async function queryDatabase(url: string, repositoryKey: string): Promise<HostedDatabaseState> {
  const sql = postgres(url, { max: 1, connect_timeout: 10, idle_timeout: 5, prepare: false, onnotice: () => undefined });
  try {
    const [state] = await sql<{ user: string; ready: boolean }[]>`
      select current_user as user, to_regclass('public.screen_snapshots') is not null as ready`;
    if (!state?.ready) return { user: state?.user ?? "unknown", ready: false, canRead: false, canWrite: false, main: null };
    const [privileges] = await sql<{ can_read: boolean; can_write: boolean }[]>`
      select has_table_privilege('screen_snapshots', 'SELECT') as can_read,
             has_table_privilege('screen_snapshots', 'INSERT') as can_write`;
    let main: HostedDatabaseState["main"] = null;
    if (privileges?.can_read) {
      const rows = await sql<{ head_commit: string; published_at: Date }[]>`
        select snapshot.head_commit, snapshot.published_at
        from screen_snapshots snapshot
        join repositories repository on repository.id = snapshot.repository_id
        where repository.key = ${repositoryKey} and snapshot.ref_kind = 'main'`;
      main = rows[0] ? { commit: rows[0].head_commit, publishedAt: rows[0].published_at } : null;
    }
    return {
      user: state.user,
      ready: true,
      canRead: privileges?.can_read ?? false,
      canWrite: privileges?.can_write ?? false,
      main,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export const DEFAULT_HOSTED_CHECK_DEPENDENCIES: HostedCheckDependencies = {
  env: process.env,
  store: (hosted, env) => new S3ObjectStore(readObjectStoreSettings(env, hosted.bucket)),
  database: queryDatabase,
  fetch: (input, init) => fetch(input, init),
};

const DATABASE_ROLES = [
  { variable: "DATABASE_URL", needs: "read" as const, purpose: "the hosted site reads published pages" },
  { variable: "DATABASE_URL_SCREENS_PUBLISH", needs: "write" as const, purpose: "screens publish writes pull-request and branch pages" },
  { variable: "DATABASE_URL_SYNC", needs: "write" as const, purpose: "contract sync publishes main" },
];

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function checkStorage(
  hosted: ScreensHostedConfig,
  repositoryKey: string,
  dependencies: HostedCheckDependencies
): Promise<HostedCheckResult> {
  if (!dependencies.env.AWS_ACCESS_KEY_ID || !dependencies.env.AWS_SECRET_ACCESS_KEY) {
    return { check: "storage", status: "skip", detail: "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not set" };
  }
  try {
    const store = dependencies.store(hosted, dependencies.env);
    const key = `${repositoryKey}/tieline-check/${randomUUID()}`;
    await store.put(key, Buffer.from("tieline hosted check\n"), "text/plain");
    if (!(await store.head(key))) throw new Error("a probe object just written could not be found");
    await store.delete(key);
    if (await store.head(key)) throw new Error("a probe object just deleted is still there");
    return {
      check: "storage",
      status: "pass",
      detail: `wrote, found, and deleted a probe object in bucket ${hosted.bucket}`,
    };
  } catch (error) {
    return { check: "storage", status: "fail", detail: message(error) };
  }
}

async function checkDatabases(
  repositoryKey: string,
  dependencies: HostedCheckDependencies
): Promise<{ results: HostedCheckResult[]; main: HostedDatabaseState["main"] | undefined }> {
  const results: HostedCheckResult[] = [];
  let main: HostedDatabaseState["main"] | undefined;
  for (const role of DATABASE_ROLES) {
    const url = dependencies.env[role.variable];
    const check = `database ${role.variable}`;
    if (!url) {
      results.push({ check, status: "skip", detail: "not set" });
      continue;
    }
    try {
      const state = await dependencies.database(url, repositoryKey);
      const allowed = role.needs === "read" ? state.canRead : state.canWrite;
      if (state.canRead && main === undefined) main = state.main;
      results.push(
        !state.ready
          ? { check, status: "fail", detail: "the hosted screens tables are missing; run `tieline migrate`" }
          : role.needs === "read" && state.canWrite
            ? {
                check,
                status: "fail",
                detail: `${state.user} can also write published screens; the hosted site must use the read-only reader role`,
              }
          : allowed
            ? { check, status: "pass", detail: `${state.user} can ${role.needs}: ${role.purpose}` }
            : { check, status: "fail", detail: `${state.user} cannot ${role.needs} published screens, but ${role.purpose}` }
      );
    } catch (error) {
      results.push({ check, status: "fail", detail: message(error) });
    }
  }
  return { results, main };
}

/**
 * Asks the site for a page and an image without logging in. A response the
 * hosted site answered itself means the host let an anonymous visitor
 * through; a login prompt or redirect means its access control is on.
 */
async function checkSite(url: URL, dependencies: HostedCheckDependencies): Promise<HostedCheckResult[]> {
  const results: HostedCheckResult[] = [];
  for (const { path, label } of [
    { path: "/", label: "/" },
    { path: `/images/${"0".repeat(64)}`, label: "/images/<digest>" },
  ]) {
    const check = `site ${label}`;
    try {
      const response = await dependencies.fetch(new URL(path, url), {
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      await response.body?.cancel().catch(() => undefined);
      if (response.headers.has(HOSTED_SITE_HEADER)) {
        results.push({
          check,
          status: "fail",
          detail: `the site answered without a login (HTTP ${response.status}); turn on the host's access control`,
        });
      } else if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) {
        results.push({ check, status: "pass", detail: `asks for a login (HTTP ${response.status})` });
      } else {
        results.push({
          check,
          status: "fail",
          detail: `HTTP ${response.status} came from something other than the hosted site or a login; check the URL and the deployment`,
        });
      }
    } catch (error) {
      results.push({ check, status: "fail", detail: message(error) });
    }
  }
  return results;
}

export interface HostedCheckOptions {
  repository?: string;
  url?: string;
  json?: boolean;
}

/**
 * `tieline hosted check`: proves hosted screens are wired up with the
 * credentials in this environment. It writes, finds, and deletes a probe
 * object in the bucket; checks that each database credential set can do what
 * its job needs; and, given the site's URL, that the site asks visitors to
 * log in. A credential that is not set is skipped, not failed.
 */
export async function runHostedCheckCommand(
  options: HostedCheckOptions,
  io: CommandIO,
  dependencies: HostedCheckDependencies = DEFAULT_HOSTED_CHECK_DEPENDENCIES
): Promise<number> {
  const { root, repositoryKey } = resolveCommandContext(options);
  const hosted = hostedConfig(root);
  const siteSetting = options.url ?? hosted.site_url;
  let site: URL | null = null;
  if (siteSetting) {
    try {
      site = new URL(siteSetting);
    } catch {
      throw new Error(`'${siteSetting}' is not a URL.`);
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(site.hostname);
    if (site.protocol !== "https:" && !(site.protocol === "http:" && loopback)) {
      throw new Error("The site URL must use https.");
    }
  }
  const results = [await checkStorage(hosted, repositoryKey, dependencies)];
  const databases = await checkDatabases(repositoryKey, dependencies);
  results.push(...databases.results);
  if (site) results.push(...(await checkSite(site, dependencies)));
  else results.push({ check: "site", status: "skip", detail: "pass --url or set screens.hosted.site_url to check access control" });
  const passed = results.every((result) => result.status !== "fail");
  const main =
    databases.main === undefined
      ? null
      : databases.main
        ? `main was last published at ${databases.main.publishedAt.toISOString()} (commit ${databases.main.commit.slice(0, 12)})`
        : "main has not been published yet; `tieline contract sync` on main publishes it";
  if (options.json) {
    io.write(`${JSON.stringify({ passed, repository: repositoryKey, bucket: hosted.bucket, results, main }, null, 2)}\n`);
    return passed ? 0 : 1;
  }
  io.write(`Hosted screens check for ${escapeTerminalText(repositoryKey)} (bucket ${hosted.bucket}):\n`);
  for (const result of results) {
    io.write(`  ${result.status.padEnd(4)}  ${result.check}: ${escapeTerminalText(result.detail)}\n`);
  }
  if (main) io.write(`  note  ${main}\n`);
  return passed ? 0 : 1;
}
