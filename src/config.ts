/**
 * Central configuration. All env reads happen here so the rest of the code
 * depends on a typed config object, not process.env.
 */

// Selectable embedding backend. `local` runs gte-small in-process (default;
// needs an explicit `npm install @huggingface/transformers`, kept out of the
// base install so images stay lean); `openai` calls any OpenAI-compatible
// /embeddings endpoint; `supabase-edge` keeps back-compat with existing Supabase
// deployments; `hash` is an offline dev/test fallback only.
export type EmbeddingProvider = "local" | "openai" | "supabase-edge" | "hash";
export type StoryApprovalMode = "production" | "all" | "off";
export const EMBEDDING_DIMENSION = 384;

export interface FusionWeights {
  vector: number;
  entity: number;
  path: number;
}

export interface Config {
  // Database
  dbUrl: string | undefined;
  dbUrlIngest: string | undefined;
  // Write connection — the least-privilege mcp_writer role (RLS-constrained to
  // feature_request stories). Separate from the read path on purpose; if unset,
  // the write tools refuse to run.
  dbWriteUrl: string | undefined;
  // Human decision/auto-allow connection. This role can execute only the
  // lifecycle decision functions and is never used by ordinary MCP writes.
  dbApprovalUrl: string | undefined;

  storyApprovalMode: StoryApprovalMode;

  // Optional repository identity for non-Tieline, single-repository writes.
  // Tieline-managed imports take this identity from their workspace.
  repo: string | undefined;

  // Transport
  transport: "http" | "stdio";
  port: number;
  httpHost: string;
  httpAllowedOrigins: string[];
  httpTrustProxy: boolean;

  // Embeddings
  embeddingProvider: EmbeddingProvider;
  // Model id (provider-specific default applied in embeddings.ts):
  // local -> "Xenova/gte-small", openai -> "text-embedding-3-small".
  embeddingModel: string | undefined;
  // openai provider: base URL of the OpenAI-compatible endpoint + optional key.
  embeddingBaseUrl: string | undefined;
  embeddingApiKey: string | undefined;
  // openai provider: send the `dimensions` request param (only text-embedding-3+
  // and some compatible endpoints support it; others reject it). Opt-in.
  embeddingRequestDimensions: boolean;
  // supabase-edge provider (back-compat): project URL + anon key.
  supabaseUrl: string | undefined;
  supabaseAnonKey: string | undefined;
  // Optional per-user runtime installed by `tieline init`; kept outside the
  // globally installed Tieline package and the versioned workspace.
  localEmbedderRoot: string | undefined;

  // Retrieval tuning
  candidatePoolSize: number;
  findRelatedMinVectorScore: number;
  findRelatedMinStructuralScore: number;
  // find_help (semantic search over help articles)
  helpCandidatePoolSize: number;
  helpMinScore: number;

  // Fusion weights per mode. Each weight set is normalized to sum 1 at use.
  weights: {
    semantic: FusionWeights;
    structural: FusionWeights;
    blended: FusionWeights;
  };

  // Response guard.
  characterLimit: number;

  // Opt-in: register the MCP App (review_stories tool + ui:// resource) for
  // hosts that support MCP Apps. Off by default so the base tool surface is
  // unchanged for hosts that don't.
  enableReviewApp: boolean;

  // Elevated bulk-authoring MCP tool. CLI/local review remain available without
  // this; off by default so a runtime server never exposes ingest accidentally.
  enableImportTool: boolean;

  // Opt-in: register the section-coupling graph MCP App (explore_graph tool +
  // ui:// resource). Read-only — unlike the review app it never writes, so it is
  // safe to enable on the hosted retrieval-only deploy. Off by default.
  enableGraphApp: boolean;
}

function boundedNumber(
  name: string,
  value: string | undefined,
  fallback: number,
  options: { min: number; max: number; integer?: boolean }
): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (
    !Number.isFinite(n) ||
    n < options.min ||
    n > options.max ||
    (options.integer === true && !Number.isInteger(n))
  ) {
    const kind = options.integer ? "integer" : "number";
    throw new Error(
      `Invalid ${name} '${value}'. Must be a ${kind} between ${options.min} and ${options.max}.`
    );
  }
  return n;
}

function enabled(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Embedding provider resolution:
  //  - explicit EMBEDDING_PROVIDER always wins.
  //  - else, if Supabase edge-function creds are present (SUPABASE_URL +
  //    SUPABASE_ANON_KEY), default to `supabase-edge`. This is BACK-COMPAT: the
  //    original Supabase-bound deployment embedded via the edge function, so an
  //    existing deploy that doesn't set EMBEDDING_PROVIDER keeps working exactly
  //    as before instead of silently switching to `local` (whose
  //    @huggingface/transformers package isn't in the base install).
  //  - else default to `local` (in-process gte-small) for fresh open-source
  //    installs with no external service. `local` needs an explicit
  //    `npm install @huggingface/transformers`; a lean hosted deploy should set
  //    EMBEDDING_PROVIDER=openai or supabase-edge.
  const rawProvider = env.EMBEDDING_PROVIDER?.trim();
  const validProviders: EmbeddingProvider[] = ["local", "openai", "supabase-edge", "hash"];
  if (rawProvider && !validProviders.includes(rawProvider as EmbeddingProvider)) {
    throw new Error(
      `Invalid EMBEDDING_PROVIDER '${rawProvider}'. Must be one of: ${validProviders.join(", ")}.`
    );
  }
  // An empty/whitespace value is treated as unset (falls through to the
  // supabase-edge back-compat default below, then local).
  const explicitProvider = rawProvider ? (rawProvider as EmbeddingProvider) : undefined;
  const hasSupabaseEdgeCreds = Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY);
  const provider: EmbeddingProvider =
    explicitProvider || (hasSupabaseEdgeCreds ? "supabase-edge" : "local");

  const rawApprovalMode = env.STORY_APPROVAL_MODE?.trim() || "production";
  if (!(["production", "all", "off"] as const).includes(rawApprovalMode as StoryApprovalMode)) {
    throw new Error(
      `Invalid STORY_APPROVAL_MODE '${rawApprovalMode}'. Must be one of: production, all, off.`
    );
  }

  // Generic DATABASE_URL is the primary name (any Postgres + pgvector host).
  // The legacy SUPABASE_DB_URL* names are still accepted as a fallback so
  // existing deployments keep working for one release.
  const dbUrl = env.DATABASE_URL || env.SUPABASE_DB_URL;
  const port = boundedNumber("PORT", env.PORT, 3000, { min: 1, max: 65535, integer: true });
  const httpHost = env.HTTP_HOST?.trim() || "127.0.0.1";
  const httpAllowedOrigins = (env.HTTP_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const httpTrustProxy = enabled(env.HTTP_TRUST_PROXY);
  if (!isLoopbackHost(httpHost) && (!httpTrustProxy || httpAllowedOrigins.length === 0)) {
    throw new Error(
      "Refusing non-loopback HTTP_HOST without HTTP_TRUST_PROXY=true and at least one HTTP_ALLOWED_ORIGINS entry. Remote HTTP must run behind an authenticated TLS gateway."
    );
  }

  return {
    dbUrl,
    dbUrlIngest: env.DATABASE_URL_INGEST || env.SUPABASE_DB_URL_INGEST,
    dbWriteUrl: env.DATABASE_URL_WRITE || env.SUPABASE_DB_URL_WRITE,
    dbApprovalUrl: env.DATABASE_URL_APPROVAL,
    storyApprovalMode: rawApprovalMode as StoryApprovalMode,

    // Tieline workspaces carry their own stable identity. REPO_NAME is only the
    // explicit fallback for standalone writes outside a workspace.
    repo: env.REPO_NAME,

    // Default to stdio for MCP hosts. HTTP is opt-in via TRANSPORT=http or
    // `tieline serve --http`.
    transport: env.TRANSPORT === "http" ? "http" : "stdio",
    port,
    httpHost,
    httpAllowedOrigins,
    httpTrustProxy,

    embeddingProvider: provider,
    // The storage contract is fixed at 384 dimensions. A width change is a
    // deliberate schema migration plus full re-embed, never an env toggle.
    embeddingModel: env.EMBEDDING_MODEL,
    embeddingBaseUrl: env.EMBEDDING_BASE_URL,
    embeddingApiKey: env.EMBEDDING_API_KEY,
    embeddingRequestDimensions:
      env.EMBEDDING_REQUEST_DIMENSIONS !== "false" && env.EMBEDDING_REQUEST_DIMENSIONS !== "0",
    supabaseUrl: env.SUPABASE_URL,
    supabaseAnonKey: env.SUPABASE_ANON_KEY,
    localEmbedderRoot: env.TIELINE_LOCAL_EMBEDDER_ROOT,

    candidatePoolSize: boundedNumber("CANDIDATE_POOL_SIZE", env.CANDIDATE_POOL_SIZE, 50, {
      min: 1,
      max: 1000,
      integer: true,
    }),
    findRelatedMinVectorScore: boundedNumber(
      "FIND_RELATED_MIN_VECTOR_SCORE",
      env.FIND_RELATED_MIN_VECTOR_SCORE,
      0.8,
      { min: 0, max: 1 }
    ),
    findRelatedMinStructuralScore: boundedNumber(
      "FIND_RELATED_MIN_STRUCTURAL_SCORE",
      env.FIND_RELATED_MIN_STRUCTURAL_SCORE,
      0.01,
      { min: 0, max: 1 }
    ),
    // Over-fetch from the HNSW gate so post-KNN product_area/audience filters
    // still have candidates to trim from.
    helpCandidatePoolSize: boundedNumber("HELP_CANDIDATE_POOL_SIZE", env.HELP_CANDIDATE_POOL_SIZE, 50, {
      min: 1,
      max: 1000,
      integer: true,
    }),
    // gte-small runs a high cosine baseline (~0.73-0.78 even off-domain); real
    // help matches sit at ~0.87+. 0.80 cleanly separates signal from noise.
    helpMinScore: boundedNumber("HELP_MIN_SCORE", env.HELP_MIN_SCORE, 0.8, { min: 0, max: 1 }),

    weights: {
      // pure conceptual similarity
      semantic: { vector: 1.0, entity: 0.0, path: 0.0 },
      // code in -> lean on code-path overlap; a function body embeds poorly vs prose
      structural: { vector: 0.15, entity: 0.25, path: 0.6 },
      // sensible default for a naive agent
      blended: { vector: 0.5, entity: 0.25, path: 0.25 },
    },

    characterLimit: boundedNumber("CHARACTER_LIMIT", env.CHARACTER_LIMIT, 25000, {
      min: 1000,
      max: 1_000_000,
      integer: true,
    }),

    enableReviewApp: enabled(env.ENABLE_REVIEW_APP),
    enableImportTool: enabled(env.ENABLE_IMPORT_TOOL),
    enableGraphApp: enabled(env.ENABLE_GRAPH_APP),
  };
}

export let config = loadConfig();

/** Reload the live configuration binding after the CLI discovers a workspace profile. */
export function reloadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  config = loadConfig(env);
  return config;
}
