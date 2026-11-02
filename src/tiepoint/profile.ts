import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { TiepointWorkspace } from "./workspace.js";
import { findTiepointWorkspace } from "./workspace.js";

export const DATABASE_PROFILE_ENV_KEYS = [
  "DATABASE_URL",
  "DATABASE_URL_WRITE",
  "DATABASE_URL_SYNC",
  "DATABASE_URL_ADMIN",
] as const;

export const PRIVILEGED_DATABASE_PROFILE_ENV_KEYS = [
  "DATABASE_URL_SYNC",
  "DATABASE_URL_ADMIN",
] as const;

const PROFILE_ENV_KEYS = [
  ...DATABASE_PROFILE_ENV_KEYS,
  "EMBEDDING_PROVIDER",
  "EMBEDDING_MODEL",
  "EMBEDDING_BASE_URL",
  "EMBEDDING_API_KEY",
  "EMBEDDING_REQUEST_DIMENSIONS",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "TIEPOINT_LOCAL_EMBEDDER_ROOT",
] as const;

const MCP_PROFILE_ENV_KEYS = PROFILE_ENV_KEYS.filter(
  (key) =>
    !PRIVILEGED_DATABASE_PROFILE_ENV_KEYS.includes(
      key as (typeof PRIVILEGED_DATABASE_PROFILE_ENV_KEYS)[number]
    )
);

const embeddingProviderSchema = z.enum([
  "local",
  "openai",
  "supabase-edge",
  "hash",
]);

const runtimeStateSchema = z
  .object({
    database_mode: z.enum(["local", "existing", "offline"]),
    embedding_provider: embeddingProviderSchema,
    setup_completed_at: z.string().min(1).nullable(),
  })
  .strict();

export const storedProfileSchema = z.object({
  version: z.literal(1),
  profile_id: z.string().min(1),
  repository_root: z.string().min(1),
  repo_name: z.string().min(1),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  runtime: runtimeStateSchema.optional(),
  env: z.record(z.string()),
});

export type TiepointRuntimeState = z.infer<typeof runtimeStateSchema>;
export type TiepointProfile = Omit<
  z.infer<typeof storedProfileSchema>,
  "runtime"
> & {
  runtime: TiepointRuntimeState;
};

export function tiepointConfigHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(
    env.TIEPOINT_CONFIG_HOME ||
      (env.XDG_CONFIG_HOME
        ? resolve(env.XDG_CONFIG_HOME, "tiepoint")
        : process.platform === "win32" && env.APPDATA
          ? resolve(env.APPDATA, "tiepoint")
          : resolve(homedir(), ".config", "tiepoint"))
  );
}

function workspaceProfileId(repoName: string, repositoryRoot: string): string {
  const fingerprint = createHash("sha256").update(resolve(repositoryRoot)).digest("hex").slice(0, 12);
  return `${repoName}-${fingerprint}`;
}

export function profilePath(profileId: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(profileId)) throw new Error("Invalid Tiepoint profile id.");
  return resolve(tiepointConfigHome(env), "profiles", `${profileId}.json`);
}

export function profileIdForWorkspace(workspace: TiepointWorkspace): string {
  return workspaceProfileId(
    workspace.config.product.repo_name,
    workspace.root
  );
}

function selectProfileEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const key of PROFILE_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) selected[key] = value;
  }
  return selected;
}

export function writeWorkspaceProfile(
  workspace: TiepointWorkspace,
  sourceEnv: NodeJS.ProcessEnv,
  runtime: TiepointRuntimeState,
  pathEnv: NodeJS.ProcessEnv = sourceEnv
): { path: string; profile: TiepointProfile } {
  const id = profileIdForWorkspace(workspace);
  const path = profilePath(id, pathEnv);
  const now = new Date().toISOString();
  let createdAt = now;
  if (existsSync(path)) {
    try {
      createdAt = storedProfileSchema.parse(
        JSON.parse(readFileSync(path, "utf8"))
      ).created_at;
    } catch {
      // Replace an invalid profile rather than merging unknown or unsafe fields.
    }
  }
  const profile: TiepointProfile = {
    version: 1,
    profile_id: id,
    repository_root: workspace.root,
    repo_name: workspace.config.product.repo_name,
    created_at: createdAt,
    updated_at: now,
    runtime,
    env: selectProfileEnvironment(sourceEnv),
  };
  writeProfileFile(path, profile);
  return { path, profile };
}

/** Writes a profile atomically, readable only by the current user. */
export function writeProfileFile(
  path: string,
  profile: z.infer<typeof storedProfileSchema>
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function readWorkspaceProfile(
  workspace: TiepointWorkspace,
  env: NodeJS.ProcessEnv = process.env
): { path: string; profile: TiepointProfile } | null {
  const path = profilePath(profileIdForWorkspace(workspace), env);
  if (!existsSync(path)) return null;
  const stored = storedProfileSchema.parse(
    JSON.parse(readFileSync(path, "utf8"))
  );
  const configuredProvider = embeddingProviderSchema.safeParse(
    stored.env.EMBEDDING_PROVIDER
  );
  const profile: TiepointProfile = {
    ...stored,
    runtime:
      stored.runtime ??
      {
        database_mode: workspace.config.runtime.default_database_mode,
        embedding_provider: configuredProvider.success
          ? configuredProvider.data
          : workspace.config.runtime.default_embedding_provider,
        setup_completed_at: null,
      },
  };
  if (resolve(profile.repository_root) !== resolve(workspace.root)) {
    throw new Error(`Tiepoint profile '${path}' belongs to a different repository root.`);
  }
  if (profile.repo_name !== workspace.config.product.repo_name) {
    throw new Error(`Tiepoint profile '${path}' belongs to a different repository identity.`);
  }
  return { path, profile };
}

/** Load a workspace profile without overriding explicit process/host environment values. */
export function loadWorkspaceProfile(
  startPath: string,
  env: NodeJS.ProcessEnv = process.env,
  allowedKeys: readonly string[] = PROFILE_ENV_KEYS
): { path: string; profile: TiepointProfile; loaded: string[] } | null {
  const workspace = findTiepointWorkspace(startPath);
  if (!workspace) return null;
  const stored = readWorkspaceProfile(workspace, env);
  if (!stored) return null;
  const loaded: string[] = [];
  for (const [key, value] of Object.entries(stored.profile.env)) {
    if (!PROFILE_ENV_KEYS.includes(key as (typeof PROFILE_ENV_KEYS)[number])) continue;
    if (!allowedKeys.includes(key)) continue;
    if (env[key] === undefined || env[key] === "") {
      env[key] = value;
      loaded.push(key);
    }
  }
  return { ...stored, loaded };
}

export function removePrivilegedDatabaseEnvironment(
  env: NodeJS.ProcessEnv
): void {
  for (const key of PRIVILEGED_DATABASE_PROFILE_ENV_KEYS) {
    delete env[key];
  }
}

export function loadWorkspaceProfileForCommand(
  command: string,
  startPath: string,
  env: NodeJS.ProcessEnv = process.env
): { path: string; profile: TiepointProfile; loaded: string[] } | null {
  if (command !== "serve") {
    return loadWorkspaceProfile(startPath, env);
  }
  removePrivilegedDatabaseEnvironment(env);
  return loadWorkspaceProfile(startPath, env, MCP_PROFILE_ENV_KEYS);
}
