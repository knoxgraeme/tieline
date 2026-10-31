import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { TIEPOINT_PACKAGE_SPEC } from "../package-metadata.js";
import {
  replaceRenamedMcpServer,
  type RenamedMcpServerOutcome,
} from "./mcp-config.js";
import {
  profileIdForWorkspace,
  profilePath,
  storedProfileSchema,
  writeProfileFile,
} from "./profile.js";
import {
  findProjectSkillInstalls,
  type ProjectSkillInstall,
  type SkillAgentId,
} from "./skill-install.js";
import {
  findTiepointWorkspace,
  TIEPOINT_CONFIG_FILE,
  TIEPOINT_DIRECTORY,
  workspaceFromConfig,
  writeTiepointConfig,
  type TiepointWorkspace,
} from "./workspace.js";

/*
 * Upgrade support for repositories set up under this package's earlier name,
 * `tieline`. Only `tiepoint init` upgrades; every other command refuses an
 * un-upgraded workspace rather than reading the earlier names.
 */
const LEGACY_NAME = "tieline";
export const LEGACY_DIRECTORY = ".tieline";
const LEGACY_ENV_PREFIX = "TIELINE_";
const RENAMED_PROFILE_ENV_KEYS: Readonly<Record<string, string>> = {
  TIELINE_LOCAL_EMBEDDER_ROOT: "TIEPOINT_LOCAL_EMBEDDER_ROOT",
};
/** Repository files that commonly invoke the CLI or name the skill, server, or workspace. */
const MENTION_FILES = [
  ".gitignore",
  "AGENTS.md",
  "CLAUDE.md",
  "package.json",
  ".claude/settings.json",
  ".claude/settings.local.json",
];
const WORKFLOW_DIRECTORY = ".github/workflows";
const MAX_SCANNED_WORKFLOWS = 200;
const MAX_SCANNED_FILE_BYTES = 1024 * 1024;

export interface LegacyWorkspaceUpgrade {
  /** Repository root that owns the moved workspace. */
  root: string;
  topologyCommitted: boolean;
}

export interface LegacyProfileMigration {
  /** Profile moved out of, or rewritten within, the earlier configuration home. */
  movedProfile: { from: string; to: string } | null;
  /** Earlier profile left in place, with the reason it was not moved. */
  retainedProfile: { path: string; reason: string } | null;
}

export function legacyConfigHome(env: NodeJS.ProcessEnv): string {
  return resolve(
    env.TIELINE_CONFIG_HOME ||
      (env.XDG_CONFIG_HOME
        ? resolve(env.XDG_CONFIG_HOME, LEGACY_NAME)
        : process.platform === "win32" && env.APPDATA
          ? resolve(env.APPDATA, LEGACY_NAME)
          : resolve(homedir(), ".config", LEGACY_NAME))
  );
}

/**
 * The nearest directory at or above `startPath` holding an earlier workspace,
 * or null when a tiepoint workspace is reached first.
 */
export function findLegacyWorkspaceOwner(startPath: string): string | null {
  let current = resolve(startPath);
  if (existsSync(current) && !statSync(current).isDirectory()) {
    current = dirname(current);
  }
  if (
    current.endsWith(`${sep}${LEGACY_DIRECTORY}`) ||
    current.endsWith(`${sep}${TIEPOINT_DIRECTORY}`)
  ) {
    current = dirname(current);
  }
  while (true) {
    if (existsSync(resolve(current, LEGACY_DIRECTORY, TIEPOINT_CONFIG_FILE))) {
      return current;
    }
    if (existsSync(resolve(current, TIEPOINT_DIRECTORY, TIEPOINT_CONFIG_FILE))) {
      return null;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Fails commands that would otherwise run without the earlier workspace's contract. */
export function rejectLegacyWorkspace(startPath: string): void {
  const owner = findLegacyWorkspaceOwner(startPath);
  if (owner === null) return;
  throw new Error(
    `${resolve(owner, LEGACY_DIRECTORY)} was created by tieline, this package's earlier name. ` +
      `Run \`npx -y ${TIEPOINT_PACKAGE_SPEC} init ${owner}\` to upgrade it to ${TIEPOINT_DIRECTORY}/ ` +
      "(in a non-interactive shell, add --yes --agent <id>, or --skip-skill-install)."
  );
}

/** The tiepoint workspace at or above `startPath`; an un-upgraded tieline workspace fails. */
export function findWorkspaceRejectingLegacy(
  startPath: string
): TiepointWorkspace | null {
  const workspace = findTiepointWorkspace(startPath);
  if (!workspace) rejectLegacyWorkspace(startPath);
  return workspace;
}

function renamedIgnoreEntry(entry: string): string {
  return entry.replace(/(^|\/)\.tieline(?=\/|$)/g, `$1${TIEPOINT_DIRECTORY}`);
}

/**
 * Moves this clone's profile out of the earlier configuration home. It runs on
 * every init, not only when `.tieline/` moves, because every clone and worktree
 * has its own profile, including clones that pull an already-upgraded
 * workspace. A custom TIELINE_CONFIG_HOME becomes this run's
 * TIEPOINT_CONFIG_HOME, so the profile stays in the directory the user chose
 * and init's advice to rename that variable stays correct.
 */
export function migrateLegacyProfile(
  workspace: TiepointWorkspace,
  env: NodeJS.ProcessEnv
): LegacyProfileMigration {
  if (!env.TIEPOINT_CONFIG_HOME && env.TIELINE_CONFIG_HOME) {
    env.TIEPOINT_CONFIG_HOME = env.TIELINE_CONFIG_HOME;
  }
  const profileId = profileIdForWorkspace(workspace);
  const to = profilePath(profileId, env);
  const from = resolve(legacyConfigHome(env), "profiles", `${profileId}.json`);
  const none = { movedProfile: null, retainedProfile: null };
  const retained = (reason: string) => ({
    movedProfile: null,
    retainedProfile: { path: from, reason },
  });
  if (!existsSync(from)) return none;
  if (from !== to && existsSync(to)) {
    return retained(`a tiepoint profile already exists at ${to}`);
  }
  const stat = statSync(from);
  if (!stat.isFile() || stat.size > MAX_SCANNED_FILE_BYTES) {
    return retained("it is not a regular profile file");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(from, "utf8"));
  } catch {
    return retained("it is not valid JSON");
  }
  const parsed = storedProfileSchema.safeParse(raw);
  if (!parsed.success) return retained("it is not a valid profile");
  const renamedKeys = Object.keys(parsed.data.env).filter(
    (key) => key in RENAMED_PROFILE_ENV_KEYS
  );
  // A profile already rewritten in place is the current profile, not a legacy one.
  if (from === to && renamedKeys.length === 0) return none;
  writeProfileFile(to, {
    ...parsed.data,
    env: Object.fromEntries(
      Object.entries(parsed.data.env).map(([key, value]) => [
        RENAMED_PROFILE_ENV_KEYS[key] ?? key,
        value,
      ])
    ),
  });
  if (from !== to) unlinkSync(from);
  return { movedProfile: { from, to }, retainedProfile: null };
}

/**
 * Moves an earlier `.tieline/` workspace to `.tiepoint/`. The earlier
 * configuration is validated before anything moves, so a broken workspace
 * stays untouched.
 */
export function upgradeLegacyWorkspace(
  startPath: string
): LegacyWorkspaceUpgrade | null {
  const owner = findLegacyWorkspaceOwner(startPath);
  if (owner === null) return null;
  const legacyDirectory = resolve(owner, LEGACY_DIRECTORY);
  const directory = resolve(owner, TIEPOINT_DIRECTORY);
  if (existsSync(resolve(directory, TIEPOINT_CONFIG_FILE))) {
    throw new Error(
      `Both ${legacyDirectory} and ${directory} exist. Keep the workspace you use, remove the other, and rerun init.`
    );
  }
  if (existsSync(directory)) {
    throw new Error(
      `${directory} exists without a config, usually derived files (review.html, the topology cache) left by an upgraded branch. ` +
        "If this branch predates the upgrade, merge or rebase onto the upgraded branch instead; " +
        `otherwise remove ${directory} and rerun init.`
    );
  }
  const legacy = workspaceFromConfig(
    resolve(legacyDirectory, TIEPOINT_CONFIG_FILE)
  );
  renameSync(legacyDirectory, directory);

  const configPath = resolve(directory, TIEPOINT_CONFIG_FILE);
  const { config } = workspaceFromConfig(configPath);
  const ignore = config.repository.ignore.map(renamedIgnoreEntry);
  if (ignore.some((entry, index) => entry !== config.repository.ignore[index])) {
    writeTiepointConfig(configPath, {
      ...config,
      repository: { ...config.repository, ignore },
    });
  }
  return {
    root: legacy.root,
    topologyCommitted: config.topology_mode === "committed",
  };
}

export function replaceLegacyMcpServers(root: string): RenamedMcpServerOutcome {
  return replaceRenamedMcpServer(root, {
    serverName: LEGACY_NAME,
    packageName: LEGACY_NAME,
  });
}

export function findLegacySkillInstalls(root: string): ProjectSkillInstall[] {
  return findProjectSkillInstalls(root, LEGACY_NAME);
}

/** Removes earlier skills only for agents that now have the tiepoint skill. */
export function removeReplacedLegacySkills(
  root: string,
  installs: readonly ProjectSkillInstall[],
  replacedAgents: readonly SkillAgentId[]
): string[] {
  const replaced = new Set(replacedAgents);
  return installs
    .filter((install) => replaced.has(install.agentId))
    .map((install) => {
      rmSync(resolve(root, install.path), { recursive: true, force: true });
      return install.path;
    });
}

export function legacyEnvironmentKeys(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((key) => key.startsWith(LEGACY_ENV_PREFIX))
    .sort();
}

/** Repository files that still mention tieline and may need a manual update. */
export function filesMentioningLegacyName(root: string): string[] {
  const candidates = [...MENTION_FILES];
  const workflows = resolve(root, WORKFLOW_DIRECTORY);
  if (existsSync(workflows) && statSync(workflows).isDirectory()) {
    candidates.push(
      ...readdirSync(workflows)
        .filter((name) => /\.ya?ml$/i.test(name))
        .sort()
        .slice(0, MAX_SCANNED_WORKFLOWS)
        .map((name) => `${WORKFLOW_DIRECTORY}/${name}`)
    );
  }
  return candidates.filter((path) => {
    const file = resolve(root, path);
    if (!existsSync(file)) return false;
    const stat = statSync(file);
    return (
      stat.isFile() &&
      stat.size <= MAX_SCANNED_FILE_BYTES &&
      /\btieline\b/i.test(readFileSync(file, "utf8"))
    );
  });
}
