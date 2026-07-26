import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, relative, resolve } from "node:path";
import {
  resolveEmbeddingProvider,
  runInitPreflight,
  type PreflightCheck,
} from "./preflight.js";
import { workspaceProfileId } from "./profile.js";
import {
  TIELINE_CONFIG_FILE,
  TIELINE_CONTEXT_FILE,
  TIELINE_COVERAGE_FILE,
  TIELINE_DIRECTORY,
  TIELINE_DRAFTS_DIR,
  TIELINE_DRAFT_FILE,
  TIELINE_HANDOFF_FILE,
  TIELINE_MCP_FILE,
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
const SOURCE_ROOT_CANDIDATES = ["src", "app", "apps", "packages", "lib", "web", "frontend", "backend"];

export interface InitWorkspaceOptions {
  targetPath: string;
  productName: string;
  repoName: string;
  description?: string;
  contextLocations?: string[];
  sourceRoots?: string[];
  ignore?: string[];
  force?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: string;
  databaseMode?: "local" | "existing" | "offline";
  approvalMode?: "production" | "all" | "off";
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
  if (!slug) throw new Error("Repository name must contain at least one letter or number.");
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
      // A malformed package.json should not prevent onboarding a non-Node repository.
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

function normalizeRepositoryPath(targetPath: string, candidate: string): string {
  const absolute = resolve(targetPath, candidate);
  const rel = relative(targetPath, absolute).replaceAll("\\", "/") || ".";
  if (rel === ".." || rel.startsWith("../")) {
    throw new Error(`Repository path '${candidate}' escapes the target repository.`);
  }
  return rel;
}

function normalizeSourceRoots(targetPath: string, roots: string[]): string[] {
  return roots.map((root) => {
    const normalized = normalizeRepositoryPath(targetPath, root);
    const absolute = resolve(targetPath, normalized);
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
      throw new Error(`Source root does not exist or is not a directory: ${root}`);
    }
    return normalized;
  });
}

function buildContextSources(
  targetPath: string,
  description: string | undefined,
  locations: string[]
): TielineContextSource[] {
  const sources: TielineContextSource[] = [];
  if (description?.trim()) {
    sources.push({
      id: `source-${sources.length + 1}`,
      type: "description",
      content: description.trim(),
      location: null,
      allow_external_fetch: false,
    });
  }
  for (const raw of locations.map((value) => value.trim()).filter(Boolean)) {
    const website = /^https?:\/\//i.test(raw);
    let location = raw;
    if (!website) {
      const absolute = resolve(targetPath, raw);
      if (!existsSync(absolute)) {
        throw new Error(`Context source does not exist: ${raw}`);
      }
      location = absolute.startsWith(`${resolve(targetPath)}/`)
        ? relative(targetPath, absolute).replaceAll("\\", "/")
        : absolute;
    }
    sources.push({
      id: `source-${sources.length + 1}`,
      type: website ? "website" : "local",
      location,
      content: null,
      allow_external_fetch: website,
    });
  }
  return sources;
}

function renderProductContext(
  productName: string,
  repoName: string,
  sources: TielineContextSource[],
  now: string
): string {
  const description = sources.find((source) => source.type === "description")?.content;
  const sourceLines = sources.length
    ? sources.map((source) => {
        if (source.type === "description") return `- ${source.id}: description supplied during init`;
        return `- ${source.id}: ${source.type} — ${source.location}`;
      })
    : ["- No explicit sources supplied; start with repository README/docs and ask the user for context."];
  return `---
version: 1
status: draft
approved_at:
product_name: ${JSON.stringify(productName)}
repo_name: ${JSON.stringify(repoName)}
created_at: ${now}
---

# ${productName} product context

> Draft. The agent must refine this profile with the user and supplied sources. Do not begin the
> full backfill until the human confirms it and \`tieline context approve\` records that approval.

## What the product does

${description || "_Agent: synthesize a concise description from the supplied sources and user conversation._"}

## Primary users and actors

_Agent: identify the people who directly use or are affected by the product._

## Main user outcomes

_Agent: describe the jobs and outcomes users seek, in their language._

## Product vocabulary

_Agent: list canonical terms and definitions that should shape section, actor, and entity names._

## Known product areas

_Agent: capture user-recognizable areas; treat these as orientation, not a mandatory story hierarchy._

## Boundaries and non-goals

_Agent: record what this product/repository does not own so infrastructure is not mistaken for a feature._

## Sources

${sourceLines.join("\n")}

## Assumptions and unresolved questions

_Agent: record uncertainty explicitly and resolve material questions with the human before approval._
`;
}

function renderAgentHandoff(productName: string, repoName: string): string {
  return `# Agent handoff: onboard ${productName}

You are onboarding repository \`${repoName}\` into the Tieline user-story map. Work from this
repository root and keep all generated onboarding artifacts inside \`.tieline/\`.

## Phase 1 — understand the product

1. Read \`.tieline/config.json\` and every allowed context source.
2. For website sources, read only relevant product/features/help pages. Marketing establishes
   vocabulary and intended outcomes; it is not proof that a feature is shipped.
3. Read repository README/docs and inspect navigation/routes enough to challenge the supplied context.
4. Complete \`.tieline/product-context.md\`: product purpose, actors, outcomes, vocabulary, areas,
   boundaries, source provenance, and unresolved questions.
5. Present the profile to the human. Do not approve it yourself. After explicit confirmation, run:

   \`tieline context approve . --yes\`

## Phase 2 — map the existing product

1. Read the approved checksum from \`.tieline/config.json\`.
2. If a story database is available, reuse \`schema://taxonomy\` vocabulary and run \`find_related\`
   before adding each candidate. If unavailable, continue offline and record that dedup is pending.
3. Infer sections from user-visible navigation, routes, pages, and feature boundaries.
4. Write one story per user-facing behavior. Shipped behavior is \`production\`; marketing-only or
   unverified behavior is not a production story.
5. Use only repository-relative code paths that exist. Record stable \`_review.id\` values and concrete
   provenance. Empty areas are preferable to invented stories.
6. **Draft one product area at a time into its own shard**, \`.tieline/drafts/<area>.draft.json\`.
   Finish and save each shard before starting the next: a shard is a checkpoint, so an interrupted
   session keeps every area already written. Shard files use the draft shape below.
7. Update \`.tieline/coverage.json\` with areas/routes examined, mapped and uncertain areas, unmapped
   candidates, path-validation issues, and whether taxonomy/dedup checks ran. Set \`status\` to
   \`complete\` and \`product_context_checksum\` to the approved checksum when the analysis pass ends.
8. Merge the shards into the canonical draft:

   \`tieline merge .\`

   Merge namespaces each \`_review.id\` as \`<shard>/<id>\`, preserves review decisions already made,
   and refuses to write on a section or id collision. Rerun it after regenerating any shard.
9. Present the merged draft and coverage summary to the human. Do not import before story approval.

## Draft shape

Both shard files and \`.tieline/stories.draft.json\` use this shape. Each story is the exact import
contract plus a \`_review\` sidecar the importer strips.

\`\`\`json
{
  "version": 1,
  "mode": "backfill",
  "repo": "${repoName}",
  "product_context_checksum": "<the approved 64-character checksum>",
  "sections": [
    {
      "section_key": "project-sharing",
      "section_name": "Project Sharing",
      "routes": ["/projects/:id/sharing"]
    }
  ],
  "stories": [
    {
      "story_key": null,
      "section_key": "project-sharing",
      "title": "Invite a teammate to a project",
      "story_text": "As a member, I want to invite a teammate so that we can collaborate.",
      "actor": "member",
      "status": "production",
      "entity_slugs": ["project", "invitation"],
      "code_paths": ["src/projects/InviteMember.ts"],
      "_review": { "id": "d-0001", "state": "pending", "comment": "", "confidence": 0.85 }
    }
  ]
}
\`\`\`

\`status\` is one of production, qa, in_progress, in_review, idea, feature_request, cancelled — use
\`production\` only for shipped behavior. \`_review.id\` need only be unique inside its own shard.
Leave \`story_key\` null for new stories; it is minted on import.

## Review and import

Review with the installed Tieline CLI:

\`tieline review /absolute/path/to/repository/.tieline/stories.draft.json\`

Then import approved stories with:

\`tieline import /absolute/path/to/repository/.tieline/stories.draft.json --batch-size 50\`

The importer will reject stale/unapproved product context, incomplete coverage, conflicting
repository or embedding identity, and missing/escaping code paths for Tieline-managed drafts.
`;
}

function initialCoverage(repoName: string, now: string): object {
  return {
    version: 1,
    status: "not_started",
    repo: repoName,
    product_context_checksum: null,
    generated_at: now,
    taxonomy_reused: false,
    dedup_checked: false,
    areas_examined: [],
    routes_examined: [],
    stories_proposed: 0,
    mapped_areas: [],
    uncertain_areas: [],
    unmapped_candidates: [],
    invalid_code_paths: [],
    notes: [],
  };
}

function initialDraft(repoName: string, now: string): object {
  return {
    version: 1,
    mode: "backfill",
    repo: repoName,
    product_context_checksum: null,
    generated_at: now,
    sections: [],
    stories: [],
  };
}

function renderMcpConfig(repositoryRoot: string): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        tieline: {
          command: "tieline",
          args: ["serve"],
          env: { TIELINE_WORKSPACE: repositoryRoot },
        },
      },
    },
    null,
    2
  )}\n`;
}

export function writeWorkspaceMcpConfig(workspace: TielineWorkspace): void {
  writeFileSync(workspace.mcpConfigPath, renderMcpConfig(workspace.root));
}

export function initWorkspace(options: InitWorkspaceOptions): InitWorkspaceResult {
  const targetPath = resolve(options.targetPath);
  if (!existsSync(targetPath) || !statSync(targetPath).isDirectory()) {
    throw new Error(`Target repository does not exist or is not a directory: ${targetPath}`);
  }
  const productName = options.productName.trim();
  if (!productName) throw new Error("Product name is required.");
  const repoName = slugifyRepoName(options.repoName);
  const existing = findTielineWorkspace(targetPath);
  const provider = resolveEmbeddingProvider(options.env ?? process.env);
  const preflight = runInitPreflight(targetPath, provider, options.env ?? process.env);
  if (existing && existing.root === targetPath && !options.force) {
    return { created: false, workspace: existing, preflight };
  }

  const sourceRoots = normalizeSourceRoots(
    targetPath,
    options.sourceRoots?.length ? options.sourceRoots : detectSourceRoots(targetPath)
  );
  const now = options.now ?? new Date().toISOString();
  const directory = resolve(targetPath, TIELINE_DIRECTORY);
  mkdirSync(directory, { recursive: true });
  // One draft per product area lands here; `tieline merge` folds them into the
  // canonical draft. .gitkeep so the shard directory survives a fresh clone.
  const draftsDirectory = resolve(directory, TIELINE_DRAFTS_DIR);
  mkdirSync(draftsDirectory, { recursive: true });
  writeFileSync(resolve(draftsDirectory, ".gitkeep"), "");
  if (options.force) {
    for (const stalePath of [
      resolve(directory, `${TIELINE_DRAFT_FILE}.import-report.json`),
      resolve(directory, "stories.locked.json"),
    ]) {
      if (existsSync(stalePath)) unlinkSync(stalePath);
    }
  }
  const sources = buildContextSources(targetPath, options.description, options.contextLocations ?? []);
  const config: TielineConfig = {
    version: 1,
    product: { name: productName, repo_name: repoName },
    repository: {
      root: "..",
      source_roots: sourceRoots,
      ignore: [...new Set(options.ignore?.length ? options.ignore : DEFAULT_IGNORE)],
    },
    context: { sources, approved_at: null, approved_checksum: null },
    runtime: {
      embedding_provider: provider,
      database_mode: options.databaseMode ?? "offline",
      approval_mode: options.approvalMode ?? "production",
      profile_id: workspaceProfileId(repoName, targetPath),
      setup_completed_at: null,
    },
    files: {
      product_context: TIELINE_CONTEXT_FILE,
      coverage: TIELINE_COVERAGE_FILE,
      draft: TIELINE_DRAFT_FILE,
      drafts_dir: TIELINE_DRAFTS_DIR,
      agent_handoff: TIELINE_HANDOFF_FILE,
      mcp_config: TIELINE_MCP_FILE,
    },
    created_at: now,
    updated_at: now,
  };

  const configPath = resolve(directory, TIELINE_CONFIG_FILE);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(resolve(directory, TIELINE_CONTEXT_FILE), renderProductContext(productName, repoName, sources, now));
  writeFileSync(resolve(directory, TIELINE_COVERAGE_FILE), `${JSON.stringify(initialCoverage(repoName, now), null, 2)}\n`);
  writeFileSync(resolve(directory, TIELINE_DRAFT_FILE), `${JSON.stringify(initialDraft(repoName, now), null, 2)}\n`);
  writeFileSync(resolve(directory, TIELINE_HANDOFF_FILE), renderAgentHandoff(productName, repoName));
  const workspace = workspaceFromConfig(configPath);
  writeWorkspaceMcpConfig(workspace);

  return { created: true, workspace, preflight };
}
