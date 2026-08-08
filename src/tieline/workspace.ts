import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { selectorConfigSchema } from "../config.js";

export const TIELINE_DIRECTORY = ".tieline";
export const TIELINE_CONFIG_FILE = "config.json";
export const TIELINE_SPEC_DIRECTORY = "spec";
/**
 * The compiled manifest is a directory, not a file: an index for the
 * repository-level fields and one file per capability.
 */
export const TIELINE_MANIFEST_DIRECTORY = "manifest";

const contextSourceSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(["description", "website", "local"]),
    location: z.string().min(1).nullable(),
    content: z.string().min(1).nullable(),
    allow_external_fetch: z.boolean(),
  })
  .strict();

export const tielineConfigSchema = z
  .object({
    version: z.literal(1),
    product: z
      .object({
        name: z.string().min(1),
        repo_name: z.string().min(1),
      })
      .strict(),
    repository: z
      .object({
        root: z.string().min(1),
        source_roots: z.array(z.string()).min(1),
        ignore: z.array(z.string()),
      })
      .strict(),
    context: z
      .object({
        sources: z.array(contextSourceSchema),
      })
      .strict(),
    runtime: z
      .object({
        default_embedding_provider: z.enum([
          "local",
          "openai",
          "supabase-edge",
          "hash",
        ]),
        default_database_mode: z.enum(["local", "existing", "offline"]),
      })
      .strict(),
    files: z
      .object({
        spec_directory: z.string().min(1),
        manifest: z.string().min(1),
      })
      .strict(),
    // Optional so existing configurations stay valid. The block is read
    // independently by readSelectorConfig; it is declared here only so a
    // repository that declares selector kinds still loads its workspace.
    selectors: selectorConfigSchema.optional(),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
  })
  .strict();

export type TielineConfig = z.infer<typeof tielineConfigSchema>;
export type TielineContextSource = z.infer<typeof contextSourceSchema>;

export interface TielineWorkspace {
  directory: string;
  root: string;
  configPath: string;
  config: TielineConfig;
  specDirectoryPath: string;
  /** Directory holding the compiled manifest, not a single file. */
  manifestPath: string;
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
  const config = tielineConfigSchema.parse(
    JSON.parse(readFileSync(configPath, "utf8"))
  );
  return {
    directory,
    root: resolve(directory, config.repository.root),
    configPath,
    config,
    specDirectoryPath: resolveWorkspaceFile(
      directory,
      config.files.spec_directory
    ),
    manifestPath: resolveWorkspaceFile(directory, config.files.manifest),
  };
}

export function findTielineWorkspace(
  startPath: string
): TielineWorkspace | null {
  let current = resolve(startPath);
  if (existsSync(current) && !statSync(current).isDirectory()) {
    current = dirname(current);
  }
  while (true) {
    const configPath = current.endsWith(`${sep}${TIELINE_DIRECTORY}`)
      ? resolve(current, TIELINE_CONFIG_FILE)
      : resolve(current, TIELINE_DIRECTORY, TIELINE_CONFIG_FILE);
    if (existsSync(configPath)) return workspaceFromConfig(configPath);
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function writeTielineConfig(
  configPath: string,
  config: TielineConfig
): void {
  config.updated_at = new Date().toISOString();
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}
