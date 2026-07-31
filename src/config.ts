export type EmbeddingProvider =
  | "local"
  | "openai"
  | "supabase-edge"
  | "hash";
export const EMBEDDING_DIMENSION = 384;

export interface Config {
  dbUrl: string | undefined;
  dbWriteUrl: string | undefined;
  dbSyncUrl: string | undefined;
  dbAdminUrl: string | undefined;
  transport: "http" | "stdio";
  port: number;
  httpHost: string;
  httpAllowedOrigins: string[];
  httpTrustProxy: boolean;
  embeddingProvider: EmbeddingProvider;
  embeddingModel: string | undefined;
  embeddingBaseUrl: string | undefined;
  embeddingApiKey: string | undefined;
  embeddingRequestDimensions: boolean;
  supabaseUrl: string | undefined;
  supabaseAnonKey: string | undefined;
  localEmbedderRoot: string | undefined;
  characterLimit: number;
}

function boundedNumber(
  name: string,
  value: string | undefined,
  fallback: number,
  options: { min: number; max: number; integer?: boolean }
): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed) ||
    parsed < options.min ||
    parsed > options.max ||
    (options.integer && !Number.isInteger(parsed))
  ) {
    throw new Error(
      `Invalid ${name} '${value}'. Must be a${options.integer ? "n integer" : " number"} between ${options.min} and ${options.max}.`
    );
  }
  return parsed;
}

function enabled(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1"
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawProvider = env.EMBEDDING_PROVIDER?.trim();
  const validProviders: EmbeddingProvider[] = [
    "local",
    "openai",
    "supabase-edge",
    "hash",
  ];
  if (
    rawProvider &&
    !validProviders.includes(rawProvider as EmbeddingProvider)
  ) {
    throw new Error(
      `Invalid EMBEDDING_PROVIDER '${rawProvider}'. Must be one of: ${validProviders.join(", ")}.`
    );
  }
  const hasSupabaseCredentials = Boolean(
    env.SUPABASE_URL && env.SUPABASE_ANON_KEY
  );
  const embeddingProvider =
    (rawProvider as EmbeddingProvider | undefined) ??
    (hasSupabaseCredentials ? "supabase-edge" : "local");

  const httpHost = env.HTTP_HOST?.trim() || "127.0.0.1";
  const httpAllowedOrigins = (env.HTTP_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const httpTrustProxy = enabled(env.HTTP_TRUST_PROXY);
  if (
    !isLoopbackHost(httpHost) &&
    (!httpTrustProxy || httpAllowedOrigins.length === 0)
  ) {
    throw new Error(
      "Refusing non-loopback HTTP_HOST without HTTP_TRUST_PROXY=true and at least one HTTP_ALLOWED_ORIGINS entry. Remote HTTP must run behind an authenticated TLS gateway."
    );
  }

  return {
    dbUrl: env.DATABASE_URL,
    dbWriteUrl: env.DATABASE_URL_WRITE,
    dbSyncUrl: env.DATABASE_URL_SYNC,
    dbAdminUrl: env.DATABASE_URL_ADMIN,
    transport: env.TRANSPORT === "http" ? "http" : "stdio",
    port: boundedNumber("PORT", env.PORT, 3000, {
      min: 1,
      max: 65_535,
      integer: true,
    }),
    httpHost,
    httpAllowedOrigins,
    httpTrustProxy,
    embeddingProvider,
    embeddingModel: env.EMBEDDING_MODEL,
    embeddingBaseUrl: env.EMBEDDING_BASE_URL,
    embeddingApiKey: env.EMBEDDING_API_KEY,
    embeddingRequestDimensions:
      env.EMBEDDING_REQUEST_DIMENSIONS !== "false" &&
      env.EMBEDDING_REQUEST_DIMENSIONS !== "0",
    supabaseUrl: env.SUPABASE_URL,
    supabaseAnonKey: env.SUPABASE_ANON_KEY,
    localEmbedderRoot: env.TIELINE_LOCAL_EMBEDDER_ROOT,
    characterLimit: boundedNumber(
      "CHARACTER_LIMIT",
      env.CHARACTER_LIMIT,
      25_000,
      { min: 1_000, max: 1_000_000, integer: true }
    ),
  };
}

export let config = loadConfig();

export function reloadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  config = loadConfig(env);
  return config;
}
