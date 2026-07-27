import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import postgres from "postgres";
import type { EmbeddingProvider, StoryApprovalMode } from "../config.js";
import { migrateDatabase } from "../commands/migrate.js";
import type { TielineWorkspace } from "./workspace.js";
import { writeTielineConfig } from "./workspace.js";
import { tielineConfigHome, writeWorkspaceProfile } from "./profile.js";

export type DatabaseMode = "local" | "existing" | "offline";

export interface SetupIO {
  write(message: string): void;
}

export interface SetupOptions {
  workspace: TielineWorkspace;
  databaseMode: DatabaseMode;
  embeddingProvider: EmbeddingProvider;
  approvalMode: StoryApprovalMode;
  installLocalEmbedder: boolean;
  skipMigrate: boolean;
  env: NodeJS.ProcessEnv;
  io: SetupIO;
  dependencies?: Partial<SetupDependencies>;
}

interface LocalDatabase {
  ownerUrl: string;
  container: string;
}

export interface SetupDependencies {
  installLocalEmbedder(env: NodeJS.ProcessEnv, io: SetupIO): Promise<string>;
  startLocalDatabase(
    workspace: TielineWorkspace,
    env: NodeJS.ProcessEnv,
    io: SetupIO
  ): Promise<LocalDatabase>;
  migrateDatabase(dbUrl: string): Promise<void>;
  provisionLocalRoles(ownerUrl: string): Promise<Record<string, string>>;
}

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => resolveResult({ code: code ?? 1, stdout, stderr }));
  });
}

function credential(length = 24): string {
  return randomBytes(length).toString("base64url");
}

function withDatabaseRole(ownerUrl: string, username: string, password: string): string {
  const url = new URL(ownerUrl);
  url.username = username;
  url.password = password;
  return url.toString();
}

/**
 * Ask the OS for a free loopback TCP port, then release it so Docker can bind it.
 *
 * We choose the host port explicitly and publish `127.0.0.1:<port>:5432` rather
 * than letting Docker auto-assign via `127.0.0.1::5432`. The auto-assign form
 * requires reading the mapping back with `docker port` / NetworkSettings.Ports,
 * which Docker Desktop can leave EMPTY even when the container is up (observed on
 * Docker Desktop 28.x) — and the auto-assigned port also changes on every restart.
 * An explicit port is deterministic, survives restarts, and never needs the
 * unreliable read-back path. There is a small TOCTOU window between releasing the
 * port and Docker binding it; if lost, `docker run` fails loudly rather than
 * silently, which the caller surfaces.
 */
async function findFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolvePort(port) : reject(new Error("Could not allocate a local port."))));
    });
  });
}

async function waitForPostgres(url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 2 });
    try {
      await sql`select 1`;
      await sql.end({ timeout: 1 });
      return;
    } catch (error) {
      lastError = error;
      await sql.end({ timeout: 1 }).catch(() => undefined);
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    }
  }
  throw new Error(
    `Local PostgreSQL did not become ready within 60 seconds: ${String(lastError)}\n` +
      "The container may be running while 127.0.0.1 cannot reach its published port. This is usually " +
      "Docker Desktop's port forwarding being wedged (fully quit and reopen Docker Desktop), or a VPN / " +
      "loopback tool intercepting the connection. As an alternative, re-run with `--database existing` " +
      "against any Postgres 16 + pgvector connection string."
  );
}

async function provisionLocalRoles(ownerUrl: string): Promise<Record<string, string>> {
  const reader = credential();
  const writer = credential();
  const approver = credential();
  const sql = postgres(ownerUrl, { max: 1, prepare: false });
  try {
    await sql`alter role mcp_reader with login password ${reader}`;
    await sql`alter role mcp_writer with login password ${writer}`;
    await sql`alter role mcp_approver with login password ${approver}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
  return {
    DATABASE_URL: withDatabaseRole(ownerUrl, "mcp_reader", reader),
    DATABASE_URL_INGEST: ownerUrl,
    DATABASE_URL_WRITE: withDatabaseRole(ownerUrl, "mcp_writer", writer),
    DATABASE_URL_APPROVAL: withDatabaseRole(ownerUrl, "mcp_approver", approver),
  };
}

async function startLocalDatabase(workspace: TielineWorkspace, env: NodeJS.ProcessEnv, io: SetupIO) {
  const profileSuffix = (workspace.config.runtime.profile_id || "workspace").slice(-12);
  const container = `tieline-postgres-${workspace.config.product.repo_name.slice(0, 28)}-${profileSuffix}`;
  const version = await runProcess("docker", ["version", "--format", "{{.Server.Version}}"], env);
  if (version.code !== 0) {
    throw new Error("Docker is not available or its daemon is not running. Choose --database existing or --offline.");
  }
  const inspect = await runProcess("docker", ["inspect", "-f", "{{.State.Running}}", container], env);
  if (inspect.code === 0) {
    if (env.DATABASE_URL_INGEST) {
      if (inspect.stdout.trim() !== "true") {
        const restarted = await runProcess("docker", ["start", container], env);
        if (restarted.code !== 0) {
          throw new Error(`Could not restart local PostgreSQL container '${container}': ${restarted.stderr.trim()}`);
        }
      }
      let configured: URL;
      try {
        configured = new URL(env.DATABASE_URL_INGEST);
      } catch {
        throw new Error(`The saved owner credential for local container '${container}' is not a valid URL.`);
      }
      const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(configured.hostname);
      if (!loopback || configured.pathname !== "/tieline") {
        throw new Error(
          `Local container '${container}' exists, but DATABASE_URL_INGEST does not identify its mapped Tieline database. ` +
            "Restore the private workspace profile instead of reusing an unrelated credential."
        );
      }
      // The container was published on an explicit host port, so the saved URL's
      // port stays valid across restarts. Verify it is actually reachable rather
      // than re-reading the mapping from Docker (which can be unreliable).
      io.write(`Reusing local PostgreSQL container '${container}'.\n`);
      await waitForPostgres(env.DATABASE_URL_INGEST);
      return { ownerUrl: env.DATABASE_URL_INGEST, container };
    }
    throw new Error(
      `Docker container '${container}' already exists, but its owner credential is unavailable. ` +
        "Restore the workspace profile, remove/rename that container, or use --database existing."
    );
  }

  const ownerPassword = credential();
  const hostPort = await findFreePort();
  io.write(`Starting dedicated PostgreSQL + pgvector container '${container}' on 127.0.0.1:${hostPort}...\n`);
  const started = await runProcess(
    "docker",
    [
      "run",
      "-d",
      "--name",
      container,
      "--label",
      `dev.tieline.repository=${workspace.config.product.repo_name}`,
      "--env",
      "POSTGRES_PASSWORD",
      "--env",
      "POSTGRES_DB=tieline",
      "--publish",
      `127.0.0.1:${hostPort}:5432`,
      "--volume",
      `${container}-data:/var/lib/postgresql/data`,
      "pgvector/pgvector:pg16",
    ],
    { ...env, POSTGRES_PASSWORD: ownerPassword }
  );
  if (started.code !== 0) throw new Error(`Could not start local PostgreSQL: ${started.stderr.trim()}`);
  const ownerUrl = `postgresql://postgres:${encodeURIComponent(ownerPassword)}@127.0.0.1:${hostPort}/tieline`;
  await waitForPostgres(ownerUrl);
  return { ownerUrl, container };
}

function localEmbedderAvailable(root: string): boolean {
  try {
    createRequire(resolve(root, "package.json")).resolve("@huggingface/transformers");
    return true;
  } catch {
    return false;
  }
}

async function installLocalEmbedder(env: NodeJS.ProcessEnv, io: SetupIO): Promise<string> {
  const root = resolve(tielineConfigHome(env), "runtime");
  if (localEmbedderAvailable(root)) return root;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const packagePath = resolve(root, "package.json");
  if (!existsSync(packagePath)) {
    writeFileSync(packagePath, `${JSON.stringify({ private: true }, null, 2)}\n`, { mode: 0o600 });
  }
  io.write("Installing the optional local embedding runtime (this is a large download)...\n");
  const installed = await runProcess(
    "npm",
    ["install", "--prefix", root, "--save-exact", "@huggingface/transformers"],
    env
  );
  if (installed.code !== 0) throw new Error(`Local embedding runtime installation failed: ${installed.stderr.trim()}`);
  if (!localEmbedderAvailable(root)) throw new Error("npm completed but the local embedding runtime cannot be resolved.");
  return root;
}

function validateEmbeddingConfiguration(provider: EmbeddingProvider, env: NodeJS.ProcessEnv): void {
  if (provider === "supabase-edge" && (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY)) {
    throw new Error("supabase-edge embeddings require SUPABASE_URL and SUPABASE_ANON_KEY.");
  }
}

export async function configureWorkspaceRuntime(options: SetupOptions): Promise<{ profilePath: string }> {
  const { workspace, env, io } = options;
  const dependencies: SetupDependencies = {
    installLocalEmbedder,
    startLocalDatabase,
    migrateDatabase: (dbUrl) => migrateDatabase(dbUrl),
    provisionLocalRoles,
    ...options.dependencies,
  };
  env.DATABASE_URL ||= env.SUPABASE_DB_URL;
  env.DATABASE_URL_INGEST ||= env.SUPABASE_DB_URL_INGEST;
  env.DATABASE_URL_WRITE ||= env.SUPABASE_DB_URL_WRITE;
  env.EMBEDDING_PROVIDER = options.embeddingProvider;
  env.STORY_APPROVAL_MODE = options.approvalMode;
  validateEmbeddingConfiguration(options.embeddingProvider, env);

  workspace.config.runtime.database_mode = options.databaseMode;
  workspace.config.runtime.embedding_provider = options.embeddingProvider;
  workspace.config.runtime.approval_mode = options.approvalMode;
  workspace.config.runtime.setup_completed_at = null;
  writeTielineConfig(workspace);

  if (options.embeddingProvider === "local" && options.installLocalEmbedder) {
    env.TIELINE_LOCAL_EMBEDDER_ROOT = await dependencies.installLocalEmbedder(env, io);
  }

  if (options.databaseMode === "existing") {
    if (!env.DATABASE_URL_INGEST && !env.SUPABASE_DB_URL_INGEST) {
      throw new Error(
        "Existing database setup requires DATABASE_URL_INGEST in the environment. " +
          "Tieline will copy it into the private profile; credentials are never accepted as CLI arguments."
      );
    }
    writeWorkspaceProfile(workspace, env);
    if (!options.skipMigrate) {
      io.write("Applying packaged Tieline migrations to the configured database...\n");
      await dependencies.migrateDatabase(env.DATABASE_URL_INGEST || env.SUPABASE_DB_URL_INGEST!);
    }
  } else if (options.databaseMode === "local") {
    const local = await dependencies.startLocalDatabase(workspace, env, io);
    env.DATABASE_URL_INGEST = local.ownerUrl;
    writeWorkspaceProfile(workspace, env);
    if (!options.skipMigrate) {
      io.write("Applying packaged Tieline migrations to the local database...\n");
      await dependencies.migrateDatabase(local.ownerUrl);
      Object.assign(env, await dependencies.provisionLocalRoles(local.ownerUrl));
    } else {
      env.DATABASE_URL_INGEST = local.ownerUrl;
    }
  }

  workspace.config.runtime.setup_completed_at = new Date().toISOString();
  writeTielineConfig(workspace);
  const profileEnv = options.databaseMode === "offline" ? { ...env } : env;
  if (options.databaseMode === "offline") {
    for (const key of [
      "DATABASE_URL",
      "DATABASE_URL_INGEST",
      "DATABASE_URL_WRITE",
      "DATABASE_URL_APPROVAL",
      "SUPABASE_DB_URL",
      "SUPABASE_DB_URL_INGEST",
      "SUPABASE_DB_URL_WRITE",
    ]) {
      delete profileEnv[key];
    }
  }
  const stored = writeWorkspaceProfile(workspace, profileEnv, env);
  return { profilePath: stored.path };
}
