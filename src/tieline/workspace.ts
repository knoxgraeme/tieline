import { createHash } from "node:crypto";
import {
  existsSync,
  realpathSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";

export const TIELINE_DIRECTORY = ".tieline";
export const TIELINE_CONFIG_FILE = "config.json";
export const TIELINE_CONTEXT_FILE = "product-context.md";
export const TIELINE_COVERAGE_FILE = "coverage.json";
export const TIELINE_DRAFT_FILE = "stories.draft.json";
export const TIELINE_DRAFTS_DIR = "drafts";
export const TIELINE_HANDOFF_FILE = "AGENT_HANDOFF.md";
export const TIELINE_MCP_FILE = "mcp.json";

const contextSourceSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["description", "website", "local"]),
  location: z.string().min(1).nullish(),
  content: z.string().min(1).nullish(),
  allow_external_fetch: z.boolean().default(false),
});

export const tielineCoverageSchema = z.object({
  version: z.literal(1),
  status: z.enum(["not_started", "in_progress", "complete"]),
  repo: z.string().min(1),
  product_context_checksum: z.string().regex(/^[a-f0-9]{64}$/).nullish(),
  taxonomy_reused: z.boolean().default(false),
  dedup_checked: z.boolean().default(false),
  areas_examined: z.array(z.unknown()).default([]),
  routes_examined: z.array(z.unknown()).default([]),
  stories_proposed: z.number().int().nonnegative().default(0),
  mapped_areas: z.array(z.unknown()).default([]),
  uncertain_areas: z.array(z.unknown()).default([]),
  unmapped_candidates: z.array(z.unknown()).default([]),
  invalid_code_paths: z.array(z.unknown()).default([]),
  notes: z.array(z.unknown()).default([]),
});

export const tielineConfigSchema = z.object({
  version: z.literal(1),
  product: z.object({
    name: z.string().min(1),
    repo_name: z.string().min(1),
  }),
  repository: z.object({
    root: z.string().min(1).default(".."),
    source_roots: z.array(z.string()).min(1),
    ignore: z.array(z.string()),
  }),
  context: z.object({
    sources: z.array(contextSourceSchema),
    approved_at: z.string().nullish(),
    approved_checksum: z.string().nullish(),
  }),
  runtime: z.object({
    embedding_provider: z.enum(["local", "openai", "supabase-edge", "hash"]),
    database_mode: z.enum(["local", "existing", "offline"]).default("offline"),
    approval_mode: z.enum(["production", "all", "off"]).default("production"),
    profile_id: z.string().min(1).nullish(),
    setup_completed_at: z.string().min(1).nullish(),
  }),
  files: z.object({
    product_context: z.string().min(1),
    coverage: z.string().min(1),
    draft: z.string().min(1),
    // Workspaces created before sharded drafting omit this and pick up the default.
    drafts_dir: z.string().min(1).default(TIELINE_DRAFTS_DIR),
    agent_handoff: z.string().min(1),
    mcp_config: z.string().min(1).default(TIELINE_MCP_FILE),
  }),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

export type TielineConfig = z.infer<typeof tielineConfigSchema>;
export type TielineContextSource = z.infer<typeof contextSourceSchema>;

export interface TielineWorkspace {
  directory: string;
  root: string;
  configPath: string;
  config: TielineConfig;
  contextPath: string;
  coveragePath: string;
  draftPath: string;
  draftsDirPath: string;
  handoffPath: string;
  mcpConfigPath: string;
}

function resolveWorkspaceFile(directory: string, path: string): string {
  const resolved = resolve(directory, path);
  const rel = relative(directory, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Tieline file '${path}' escapes ${directory}.`);
  }
  return resolved;
}

export function workspaceFromConfig(configPath: string): TielineWorkspace {
  const directory = dirname(configPath);
  const config = tielineConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));
  return {
    directory,
    root: resolve(directory, config.repository.root),
    configPath,
    config,
    contextPath: resolveWorkspaceFile(directory, config.files.product_context),
    coveragePath: resolveWorkspaceFile(directory, config.files.coverage),
    draftPath: resolveWorkspaceFile(directory, config.files.draft),
    draftsDirPath: resolveWorkspaceFile(directory, config.files.drafts_dir),
    handoffPath: resolveWorkspaceFile(directory, config.files.agent_handoff),
    mcpConfigPath: resolveWorkspaceFile(directory, config.files.mcp_config),
  };
}

/** Find the nearest .tieline/config.json from a repository path or an artifact path. */
export function findTielineWorkspace(startPath: string): TielineWorkspace | null {
  let current = resolve(startPath);
  if (existsSync(current) && !statSync(current).isDirectory()) current = dirname(current);

  while (true) {
    const directConfig =
      current.endsWith(`${sep}${TIELINE_DIRECTORY}`)
        ? resolve(current, TIELINE_CONFIG_FILE)
        : resolve(current, TIELINE_DIRECTORY, TIELINE_CONFIG_FILE);
    if (existsSync(directConfig)) return workspaceFromConfig(directConfig);
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function writeTielineConfig(workspace: TielineWorkspace): void {
  workspace.config.updated_at = new Date().toISOString();
  writeFileSync(workspace.configPath, `${JSON.stringify(workspace.config, null, 2)}\n`);
}

export function productContextChecksum(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export function currentProductContextChecksum(workspace: TielineWorkspace): string | null {
  if (!existsSync(workspace.contextPath)) return null;
  return productContextChecksum(readFileSync(workspace.contextPath, "utf8"));
}

export function readProductContextStatus(workspace: TielineWorkspace): "draft" | "approved" | "missing" {
  if (!existsSync(workspace.contextPath)) return "missing";
  const body = readFileSync(workspace.contextPath, "utf8");
  return /^status:\s*approved\s*$/m.test(body) ? "approved" : "draft";
}

export function approveProductContext(workspace: TielineWorkspace): string {
  if (!existsSync(workspace.contextPath)) {
    throw new Error(`Product context not found: ${workspace.contextPath}`);
  }
  const now = new Date().toISOString();
  let body = readFileSync(workspace.contextPath, "utf8");
  if (!/^status:\s*(draft|approved)\s*$/m.test(body)) {
    throw new Error("product-context.md must have a frontmatter 'status: draft' field.");
  }
  body = body.replace(/^status:\s*(draft|approved)\s*$/m, "status: approved");
  if (/^approved_at:/m.test(body)) {
    body = body.replace(/^approved_at:.*$/m, `approved_at: ${now}`);
  } else {
    body = body.replace(/^status:\s*approved\s*$/m, `status: approved\napproved_at: ${now}`);
  }
  writeFileSync(workspace.contextPath, body);
  const checksum = productContextChecksum(body);
  workspace.config.context.approved_at = now;
  workspace.config.context.approved_checksum = checksum;
  writeTielineConfig(workspace);
  return checksum;
}

export function productContextApprovalState(
  workspace: TielineWorkspace
): "missing" | "draft" | "approved" | "stale" {
  const status = readProductContextStatus(workspace);
  if (status !== "approved") return status;
  const current = currentProductContextChecksum(workspace);
  if (!workspace.config.context.approved_checksum || current !== workspace.config.context.approved_checksum) {
    return "stale";
  }
  return "approved";
}

export function resolveWorkspaceRepo(workspace: TielineWorkspace | null, envRepo?: string): string | undefined {
  if (!workspace) return envRepo;
  const workspaceRepo = workspace.config.product.repo_name;
  if (envRepo && envRepo !== workspaceRepo) {
    throw new Error(
      `REPO_NAME '${envRepo}' conflicts with .tieline repository '${workspaceRepo}'. ` +
        "Use one stable repository identity before importing."
    );
  }
  return workspaceRepo;
}

export function validateWorkspaceEmbeddingProvider(
  workspace: TielineWorkspace | null,
  currentProvider: string
): void {
  if (!workspace) return;
  const initializedProvider = workspace.config.runtime.embedding_provider;
  if (initializedProvider !== currentProvider) {
    throw new Error(
      `Embedding provider '${currentProvider}' differs from the Tieline workspace provider ` +
        `'${initializedProvider}'. Import and retrieval must share one vector space. ` +
        "If this is an intentional pre-import change, update .tieline/config.json first."
    );
  }
}

export function validateWorkspaceCodePaths(workspace: TielineWorkspace, codePaths: string[]): void {
  const invalid: string[] = [];
  const realRoot = realpathSync(workspace.root);
  for (const path of new Set(codePaths)) {
    if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
      invalid.push(`${path} (must be repository-relative)`);
      continue;
    }
    const resolved = resolve(workspace.root, path);
    const rel = relative(workspace.root, resolved);
    if (rel === ".." || rel.startsWith(`..${sep}`) || !existsSync(resolved) || !statSync(resolved).isFile()) {
      invalid.push(path);
      continue;
    }
    const realRel = relative(realRoot, realpathSync(resolved));
    if (realRel === ".." || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) invalid.push(path);
  }
  if (invalid.length > 0) {
    throw new Error(
      `Approved stories contain ${invalid.length} invalid code path(s): ${invalid.slice(0, 10).join(", ")}` +
        (invalid.length > 10 ? ` (+${invalid.length - 10} more)` : "")
    );
  }
}

export function validateWorkspaceImport(
  workspace: TielineWorkspace,
  payload: {
    import_source?: string | null;
    product_context_checksum?: string | null;
    stories: Array<{ code_paths: string[] }>;
  }
): void {
  const approval = productContextApprovalState(workspace);
  if (approval !== "approved") {
    throw new Error(
      `Tieline product context is '${approval}'. A human must approve the current profile with ` +
        "`tieline context approve` before import."
    );
  }
  const repo = workspace.config.product.repo_name;
  if (payload.import_source !== repo) {
    throw new Error(
      `Tieline import_source must be the configured repository '${repo}', got ` +
        `'${payload.import_source ?? "(missing)"}'.`
    );
  }
  const currentChecksum = currentProductContextChecksum(workspace);
  if (!payload.product_context_checksum || payload.product_context_checksum !== currentChecksum) {
    throw new Error(
      "Story draft was not generated from the currently approved product context. " +
        "Regenerate it using context.approved_checksum from .tieline/config.json."
    );
  }
  if (!existsSync(workspace.coveragePath)) {
    throw new Error("Tieline coverage report is missing; finish the repository analysis before import.");
  }
  const coverage = tielineCoverageSchema.parse(
    JSON.parse(readFileSync(workspace.coveragePath, "utf8"))
  );
  if (
    coverage.status !== "complete" ||
    coverage.repo !== workspace.config.product.repo_name ||
    coverage.product_context_checksum !== currentChecksum
  ) {
    throw new Error(
      "Tieline coverage is not complete for the current repository/product context. " +
        "Finish .tieline/coverage.json before import."
    );
  }
  validateWorkspaceCodePaths(workspace, payload.stories.flatMap((story) => story.code_paths));
}
