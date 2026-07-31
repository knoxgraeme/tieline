import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, relative, resolve } from "node:path";
import {
  resolveEmbeddingProvider,
  runInitPreflight,
  type PreflightCheck,
} from "./preflight.js";
import {
  TIELINE_CONFIG_FILE,
  TIELINE_DIRECTORY,
  TIELINE_MANIFEST_FILE,
  TIELINE_MCP_FILE,
  TIELINE_SPEC_DIRECTORY,
  findTielineWorkspace,
  type TielineConfig,
  type TielineContextSource,
  type TielineWorkspace,
  workspaceFromConfig,
} from "./workspace.js";

const DEFAULT_IGNORE = [
  ".git",
  ".tieline",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "vendor",
  ".next",
  "tmp",
];
const SOURCE_ROOT_CANDIDATES = [
  "src",
  "app",
  "apps",
  "packages",
  "lib",
  "web",
  "frontend",
  "backend",
  "cmd",
  "internal",
  "pkg",
  "crates",
  "services",
  "functions",
];

export interface InitWorkspaceOptions {
  targetPath: string;
  productName: string;
  repoName: string;
  description?: string;
  contextLocations?: string[];
  sourceRoots?: string[];
  ignore?: string[];
  env?: NodeJS.ProcessEnv;
  now?: string;
  databaseMode?: "local" | "existing" | "offline";
}

export interface InitWorkspaceResult {
  created: boolean;
  workspace: TielineWorkspace;
  preflight: PreflightCheck[];
}

export function slugifyRepoName(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) {
    throw new Error(
      "Repository name must contain at least one letter or number."
    );
  }
  return slug;
}

export function detectProductName(targetPath: string): string {
  const packagePath = resolve(targetPath, "package.json");
  if (existsSync(packagePath)) {
    try {
      const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as {
        productName?: unknown;
        displayName?: unknown;
        name?: unknown;
      };
      for (const value of [pkg.productName, pkg.displayName, pkg.name]) {
        if (typeof value === "string" && value.trim()) return value.trim();
      }
    } catch {
      // Non-Node repositories and malformed package metadata can still initialize.
    }
  }
  return basename(resolve(targetPath));
}

export function detectSourceRoots(targetPath: string): string[] {
  const roots = SOURCE_ROOT_CANDIDATES.filter((candidate) => {
    const path = resolve(targetPath, candidate);
    return existsSync(path) && statSync(path).isDirectory();
  });
  return roots.length > 0 ? roots : ["."];
}

function normalizedPath(targetPath: string, candidate: string): string {
  const absolute = resolve(targetPath, candidate);
  const rel = relative(targetPath, absolute).replaceAll("\\", "/") || ".";
  if (rel === ".." || rel.startsWith("../")) {
    throw new Error(`Repository path '${candidate}' escapes the target.`);
  }
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    throw new Error(`Source root does not exist: ${candidate}`);
  }
  return rel;
}

function contextSources(
  targetPath: string,
  description: string | undefined,
  locations: string[]
): TielineContextSource[] {
  const sources: TielineContextSource[] = [];
  if (description?.trim()) {
    sources.push({
      id: `source-${sources.length + 1}`,
      type: "description",
      location: null,
      content: description.trim(),
      allow_external_fetch: false,
    });
  }
  for (const location of locations.map((value) => value.trim()).filter(Boolean)) {
    const website = /^https?:\/\//i.test(location);
    if (!website && !existsSync(resolve(targetPath, location))) {
      throw new Error(`Context source does not exist: ${location}`);
    }
    sources.push({
      id: `source-${sources.length + 1}`,
      type: website ? "website" : "local",
      location: website
        ? location
        : relative(targetPath, resolve(targetPath, location)).replaceAll(
            "\\",
            "/"
          ),
      content: null,
      allow_external_fetch: website,
    });
  }
  return sources;
}

function renderMcpConfig(): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        tieline: {
          command: "tieline",
          args: ["serve"],
          env: { TIELINE_WORKSPACE: "." },
        },
      },
    },
    null,
    2
  )}\n`;
}

export function writeWorkspaceMcpConfig(
  workspace: TielineWorkspace
): void {
  writeFileSync(
    workspace.mcpConfigPath,
    renderMcpConfig()
  );
}

export function initWorkspace(
  options: InitWorkspaceOptions
): InitWorkspaceResult {
  const targetPath = resolve(options.targetPath);
  if (!existsSync(targetPath) || !statSync(targetPath).isDirectory()) {
    throw new Error(`Target repository is not a directory: ${targetPath}`);
  }
  const existing = findTielineWorkspace(targetPath);
  const provider = resolveEmbeddingProvider(options.env ?? process.env);
  const preflight = runInitPreflight(
    targetPath,
    provider,
    options.env ?? process.env
  );
  if (existing && existing.root === targetPath) {
    return { created: false, workspace: existing, preflight };
  }

  const productName = options.productName.trim();
  if (!productName) throw new Error("Product name is required.");
  const repoName = slugifyRepoName(options.repoName);
  const sourceRoots = (
    options.sourceRoots?.length
      ? options.sourceRoots
      : detectSourceRoots(targetPath)
  ).map((root) => normalizedPath(targetPath, root));
  const now = options.now ?? new Date().toISOString();
  const directory = resolve(targetPath, TIELINE_DIRECTORY);
  mkdirSync(resolve(directory, TIELINE_SPEC_DIRECTORY), {
    recursive: true,
  });
  const config: TielineConfig = {
    version: 1,
    product: { name: productName, repo_name: repoName },
    repository: {
      root: "..",
      source_roots: sourceRoots,
      ignore: [
        ...new Set(options.ignore?.length ? options.ignore : DEFAULT_IGNORE),
      ],
    },
    context: {
      sources: contextSources(
        targetPath,
        options.description,
        options.contextLocations ?? []
      ),
    },
    runtime: {
      default_embedding_provider: provider,
      default_database_mode: options.databaseMode ?? "offline",
    },
    files: {
      spec_directory: TIELINE_SPEC_DIRECTORY,
      manifest: TIELINE_MANIFEST_FILE,
      mcp_config: TIELINE_MCP_FILE,
    },
    created_at: now,
    updated_at: now,
  };
  const configPath = resolve(directory, TIELINE_CONFIG_FILE);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const workspace = workspaceFromConfig(configPath);
  writeWorkspaceMcpConfig(workspace);
  return { created: true, workspace, preflight };
}
