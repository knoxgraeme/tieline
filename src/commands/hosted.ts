import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import postgres from "postgres";
import {
  hasObjectStoreCredentials,
  readObjectStoreSettings,
  S3ObjectStore,
  type ObjectStore,
} from "../adapters/object-store/s3.js";
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
// and the TIELINE_SCREENS_S3_* object storage variables in the site's environment.
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
   - \`TIELINE_SCREENS_S3_ENDPOINT\`, \`TIELINE_SCREENS_S3_REGION\`,
     \`TIELINE_SCREENS_S3_ACCESS_KEY_ID\`, and
     \`TIELINE_SCREENS_S3_SECRET_ACCESS_KEY\`: a credential that can only
     read the \`${input.bucket}\` bucket. Netlify reserves the \`AWS_*\`
     names for its functions' own AWS role.
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

/** Fails unless `path` is absent or a directory that is not a symbolic link. */
function assertPlainDirectory(root: string, path: string, allowMissing: boolean): boolean {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) return false;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(
      `'${relative(root, path)}' is a symbolic link or not a directory; hosted init writes only into plain directories inside the repository.`
    );
  }
  return true;
}

/**
 * What a site file holds now, or null when it does not exist, read without
 * following a symbolic link below the site directory: a link there could
 * point outside the repository.
 */
function plainFileContent(root: string, directory: string, name: string): string | null {
  const parts = name.split("/");
  let current = directory;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    if (!assertPlainDirectory(root, current, true)) return null;
  }
  const path = join(current, parts.at(-1)!);
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile()) {
    throw new Error(`'${relative(root, path)}' is a symbolic link or not a regular file; hosted init will not write through it.`);
  }
  return readFileSync(path, "utf8");
}

/**
 * Writes one site file without following a symbolic link: each directory on
 * the way is made, or checked, as a plain directory, and the file is created
 * exclusively, or replaced by renaming a file created exclusively beside it,
 * so neither lands wherever a link planted since the plan leads.
 */
function writeSiteFile(root: string, directory: string, name: string, content: string, replace: boolean): void {
  const parts = name.split("/");
  // The site directory itself was checked to resolve inside the repository;
  // check it again once it exists, then make each directory below it plainly.
  mkdirSync(directory, { recursive: true });
  if (!withinRepository(realpathSync(root), realpathSync(directory))) {
    throw new Error(`'${relative(root, directory)}' no longer resolves inside the repository; nothing more was written.`);
  }
  let current = directory;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    try {
      mkdirSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    assertPlainDirectory(root, current, false);
  }
  const path = join(current, parts.at(-1)!);
  if (!replace) {
    writeFileSync(path, content, { flag: "wx" });
    return;
  }
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { flag: "wx" });
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
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
    const existing = plainFileContent(root, directory, name);
    return {
      name,
      path: relative(root, path).split("\\").join("/"),
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
    writeSiteFile(root, directory, file.name, file.content, file.status === "replaced");
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
  /** Whether the role holds each privilege in `PUBLISHER_PRIVILEGES`, by its description. */
  privileges: Record<string, boolean>;
  /** Whether row security does not apply to the role: a superuser, BYPASSRLS, or the table's owner. */
  bypassesRowSecurity: boolean;
  /** When `main` was last published, if the role can read it. */
  main: { commit: string; publishedAt: Date } | null;
}

export interface HostedCheckDependencies {
  env: Record<string, string | undefined>;
  store(hosted: ScreensHostedConfig, env: Record<string, string | undefined>): ObjectStore;
  database(url: string, repositoryKey: string): Promise<HostedDatabaseState>;
  fetch: typeof fetch;
}

/**
 * What the capture publisher's role is granted (migration 0005), and what it
 * must not hold: a capture job can add images and write pull-request and
 * branch pages, but never delete, write history, change an image's record
 * beyond when it was last referenced, or escape the row security that keeps
 * it off main's page.
 */
export const PUBLISHER_PRIVILEGES: {
  required: ReadonlyArray<{ table: string; privilege: string; column?: string }>;
  forbidden: ReadonlyArray<{ table: string; privilege: string; column?: string }>;
} = {
  required: [
    { table: "screen_snapshots", privilege: "SELECT" },
    { table: "screen_snapshots", privilege: "INSERT" },
    { table: "screen_snapshots", privilege: "UPDATE", column: "page_html" },
    { table: "screen_images", privilege: "SELECT" },
    { table: "screen_images", privilege: "INSERT" },
    { table: "screen_images", privilege: "UPDATE", column: "last_referenced_at" },
    { table: "repositories", privilege: "SELECT", column: "key" },
  ],
  forbidden: [
    { table: "screen_snapshots", privilege: "DELETE" },
    { table: "screen_images", privilege: "DELETE" },
    { table: "screen_images", privilege: "UPDATE", column: "byte_size" },
    { table: "screen_history", privilege: "INSERT" },
    { table: "screen_history", privilege: "UPDATE" },
    { table: "screen_history", privilege: "DELETE" },
  ],
};

export function privilegeName(entry: { table: string; privilege: string; column?: string }): string {
  return `${entry.privilege} on ${entry.table}${entry.column ? ` (${entry.column})` : ""}`;
}

async function queryDatabase(url: string, repositoryKey: string): Promise<HostedDatabaseState> {
  const sql = postgres(url, { max: 1, connect_timeout: 10, idle_timeout: 5, prepare: false, onnotice: () => undefined });
  try {
    const [state] = await sql<{ user: string; ready: boolean }[]>`
      select current_user as user, to_regclass('public.screen_snapshots') is not null as ready`;
    if (!state?.ready) {
      return { user: state?.user ?? "unknown", ready: false, canRead: false, canWrite: false, privileges: {}, bypassesRowSecurity: false, main: null };
    }
    const [privileges] = await sql<{ can_read: boolean; can_write: boolean }[]>`
      select has_table_privilege('screen_snapshots', 'SELECT') as can_read,
             has_table_privilege('screen_snapshots', 'INSERT') as can_write`;
    const probed: Record<string, boolean> = {};
    for (const entry of [...PUBLISHER_PRIVILEGES.required, ...PUBLISHER_PRIVILEGES.forbidden]) {
      const [row] = entry.column
        ? await sql<{ granted: boolean }[]>`select has_column_privilege(${entry.table}, ${entry.column}, ${entry.privilege}) as granted`
        : await sql<{ granted: boolean }[]>`select has_table_privilege(${entry.table}, ${entry.privilege}) as granted`;
      probed[privilegeName(entry)] = row?.granted ?? false;
    }
    const [security] = await sql<{ bypasses: boolean }[]>`
      select (role.rolsuper or role.rolbypassrls
              or (pg_has_role(current_user, snapshots.relowner, 'USAGE') and not snapshots.relforcerowsecurity)) as bypasses
      from pg_roles role, pg_class snapshots
      where role.rolname = current_user and snapshots.oid = 'screen_snapshots'::regclass`;
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
      privileges: probed,
      bypassesRowSecurity: security?.bypasses ?? false,
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
  { variable: "DATABASE_URL_SCREENS_PUBLISH", needs: "publish" as const, purpose: "screens publish writes pull-request and branch pages" },
  { variable: "DATABASE_URL_SYNC", needs: "write" as const, purpose: "contract sync publishes main" },
];

/**
 * Why a credential is not the capture publisher's: privileges publishing
 * needs that it lacks, and ones a capture job must never hold. Empty when it
 * holds exactly what the publisher role is granted.
 */
export function publisherPrivilegeProblems(state: Pick<HostedDatabaseState, "privileges" | "bypassesRowSecurity">): string[] {
  const missing = PUBLISHER_PRIVILEGES.required.map(privilegeName).filter((name) => state.privileges[name] !== true);
  const excess = PUBLISHER_PRIVILEGES.forbidden.map(privilegeName).filter((name) => state.privileges[name] === true);
  return [
    ...(missing.length > 0 ? [`lacks ${missing.join(", ")}, which publishing needs`] : []),
    ...(excess.length > 0 ? [`holds ${excess.join(", ")}, which a capture job must not`] : []),
    ...(state.bypassesRowSecurity ? ["is not bound by row security, so it could write main's page"] : []),
  ];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function checkStorage(
  hosted: ScreensHostedConfig,
  repositoryKey: string,
  dependencies: HostedCheckDependencies
): Promise<HostedCheckResult> {
  if (!hasObjectStoreCredentials(dependencies.env)) {
    return { check: "storage", status: "skip", detail: "no object storage credentials are set (TIELINE_SCREENS_S3_* or AWS_*)" };
  }
  const key = `${repositoryKey}/tieline-check/${randomUUID()}`;
  let store: ObjectStore | null = null;
  // Set once the probe is written and cleared once it is deleted, so a check
  // that fails in between still removes it.
  let written = false;
  try {
    store = dependencies.store(hosted, dependencies.env);
    await store.put(key, Buffer.from("tieline hosted check\n"), "text/plain");
    written = true;
    if (!(await store.head(key))) throw new Error("a probe object just written could not be found");
    await store.delete(key);
    written = false;
    if (await store.head(key)) throw new Error("a probe object just deleted is still there");
    return {
      check: "storage",
      status: "pass",
      detail: `wrote, found, and deleted a probe object in bucket ${hosted.bucket}`,
    };
  } catch (error) {
    let cleanup = "";
    if (written && store) {
      try {
        await store.delete(key);
      } catch (deleteError) {
        cleanup = `; the probe object ${key} could not be deleted either (${message(deleteError)})`;
      }
    }
    return { check: "storage", status: "fail", detail: `${message(error)}${cleanup}` };
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
      const problems = role.needs === "publish" && state.ready ? publisherPrivilegeProblems(state) : [];
      results.push(
        !state.ready
          ? { check, status: "fail", detail: "the hosted screens tables are missing; run `tieline migrate`" }
          : problems.length > 0
            ? {
                check,
                status: "fail",
                detail: `${state.user} is not the capture publisher role: it ${problems.join("; ")}; use tieline_capture_publisher`,
              }
          : role.needs === "read" && state.canWrite
            ? {
                check,
                status: "fail",
                detail: `${state.user} can also write published screens; the hosted site must use the read-only reader role`,
              }
          : role.needs === "publish"
            ? { check, status: "pass", detail: `${state.user} can publish, and nothing more: ${role.purpose}` }
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

/** Most redirects the site check follows. */
export const SITE_CHECK_REDIRECTS = 5;
/** A path a host's or identity provider's login page uses. */
const LOGIN_PATH = /\/(?:log-?in|sign-?in|sso|sso-api|auth|oauth2?|authorize|cdn-cgi\/access)(?:[/?#.]|$)/i;

/**
 * Whether a redirect leads to a login: a login page's path, or an address
 * that carries the site's own address to return to once logged in. Any other
 * redirect, such as an alias to the canonical host or `/` to another page, is
 * followed and judged by where it ends.
 */
function looksLikeLogin(target: URL, site: URL): boolean {
  if (LOGIN_PATH.test(target.pathname)) return true;
  if (target.origin === site.origin) return false;
  return [...target.searchParams.values()].some((value) => {
    try {
      return new URL(value).origin === site.origin;
    } catch {
      return false;
    }
  });
}

/**
 * Asks the site for one path without logging in, following at most
 * `SITE_CHECK_REDIRECTS` redirects. The hosted site answering at any step
 * means the host let an anonymous visitor through; a 401 or 403, or a
 * redirect to a login, means its access control is on.
 */
async function checkSitePath(url: URL, path: string, dependencies: HostedCheckDependencies): Promise<{ status: HostedCheckStatus; detail: string }> {
  let target = new URL(path, url);
  for (let hop = 0; ; hop += 1) {
    const response = await dependencies.fetch(target, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    await response.body?.cancel().catch(() => undefined);
    const after = hop > 0 ? ` after ${hop} redirect(s), at ${target.host}${target.pathname}` : "";
    if (response.headers.has(HOSTED_SITE_HEADER)) {
      return { status: "fail", detail: `the site answered without a login (HTTP ${response.status})${after}; turn on the host's access control` };
    }
    if (response.status === 401 || response.status === 403) {
      return { status: "pass", detail: `asks for a login (HTTP ${response.status})${after}` };
    }
    if (response.status < 300 || response.status >= 400) {
      return {
        status: "fail",
        detail: `HTTP ${response.status}${after} came from something other than the hosted site or a login; check the URL and the deployment`,
      };
    }
    const location = response.headers.get("location");
    let next: URL;
    try {
      if (!location) throw new Error("no location");
      next = new URL(location, target);
    } catch {
      return { status: "fail", detail: `HTTP ${response.status}${after} redirects without a usable location` };
    }
    if (next.protocol !== "https:" && next.protocol !== "http:") {
      return { status: "fail", detail: `HTTP ${response.status}${after} redirects to a ${next.protocol} address` };
    }
    if (looksLikeLogin(next, url)) {
      return { status: "pass", detail: `redirects to a login at ${next.host}${next.pathname} (HTTP ${response.status})` };
    }
    if (hop + 1 > SITE_CHECK_REDIRECTS) {
      return { status: "fail", detail: `more than ${SITE_CHECK_REDIRECTS} redirects without reaching a login or the hosted site` };
    }
    target = next;
  }
}

/** Asks the site for a page and an image without logging in. */
async function checkSite(url: URL, dependencies: HostedCheckDependencies): Promise<HostedCheckResult[]> {
  const results: HostedCheckResult[] = [];
  for (const { path, label } of [
    { path: "/", label: "/" },
    { path: `/images/${"0".repeat(64)}`, label: "/images/<digest>" },
  ]) {
    const check = `site ${label}`;
    try {
      results.push({ check, ...(await checkSitePath(url, path, dependencies)) });
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
