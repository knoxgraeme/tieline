import { z } from "zod";

export type EmbeddingProvider =
  | "local"
  | "openai"
  | "supabase-edge"
  | "hash";
export const EMBEDDING_DIMENSION = 384;

/**
 * Repository-declared selector kinds.
 *
 * Contract link selectors use a closed core vocabulary (`function`, `method`,
 * `class`, `type`, `const`) that this codebase can actually resolve to a symbol.
 * That core is rarely the most natural way to say what an acceptance criterion
 * is about: a criterion usually lands on a route, a CLI command, or a tool
 * rather than on a function. A repository therefore declares the extra kinds it
 * uses here, and validation stays closed against core plus these — an
 * undeclared kind is an error, so `func:` cannot quietly mint a second identity
 * namespace beside `function:`.
 *
 * `resolvable` defaults to false. A declared kind normally addresses something
 * the source-scanning regexes cannot see, and claiming otherwise would
 * manufacture "symbol is missing" findings out of a heuristic's blind spot.
 *
 * This block lives in `.tieline/config.json` alongside the repository's other
 * settings and is read leniently: unrelated keys are ignored, and a config with
 * no `selectors` block yields an empty declaration list, so every existing
 * config stays valid.
 */
export const selectorKindDeclarationSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .regex(
        /^[A-Za-z][A-Za-z0-9_-]*$/,
        "must start with a letter and contain only letters, digits, '_' or '-'"
      ),
    resolvable: z.boolean().default(false),
    description: z.string().trim().min(1).optional(),
  })
  .strict();

export const selectorConfigSchema = z
  .object({
    kinds: z.array(selectorKindDeclarationSchema).default([]),
  })
  .strict();

export type SelectorKindDeclarationConfig = z.infer<
  typeof selectorKindDeclarationSchema
>;
export type SelectorConfig = z.infer<typeof selectorConfigSchema>;

const EMPTY_SELECTOR_CONFIG: SelectorConfig = { kinds: [] };

/**
 * Reads the `selectors` block out of an already-parsed `.tieline/config.json`
 * value. Takes `unknown` on purpose so it does not couple to the workspace
 * config schema: the declared-kind vocabulary is additive, and a checkout whose
 * config predates it must keep loading.
 */
export function readSelectorConfig(configValue: unknown): SelectorConfig {
  if (configValue === null || typeof configValue !== "object") {
    return EMPTY_SELECTOR_CONFIG;
  }
  const block = (configValue as Record<string, unknown>).selectors;
  if (block === undefined || block === null) return EMPTY_SELECTOR_CONFIG;
  const parsed = selectorConfigSchema.safeParse(block);
  if (!parsed.success) {
    throw new Error(
      `Invalid 'selectors' block in Tieline configuration: ${parsed.error.issues
        .map(
          (issue) =>
            `${["selectors", ...issue.path].join(".")}: ${issue.message}`
        )
        .join("; ")}`
    );
  }
  return parsed.data;
}

/**
 * The optional Screens feature.
 *
 * Screens catalogue the user-visible states of an application beside the
 * Stories they show. Like declared selector kinds, the feature is opt-in and
 * lives in `.tieline/config.json`: a repository without a `screens` block, or
 * with `enabled: false`, compiles, checks, reviews, and syncs exactly as it did
 * before the feature existed, and its catalog directory is never read.
 *
 * Every directory is relative to the `.tieline/` directory, matching
 * `files.spec_directory`. The catalog is reviewed YAML and must stay inside
 * `.tieline/`, as must the text directory that holds the committed ARIA
 * snapshots of captured screens; the captures directory holds git-ignored
 * screenshots and may sit anywhere inside the repository. Defaults are applied
 * when the block is read, not when it is parsed, so rewriting a workspace
 * config never adds them.
 */
const screensDirectorySchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine(
    (value) => !value.includes("\\") && !value.startsWith("/") && !/^[A-Za-z]:/.test(value),
    "must be a relative POSIX path"
  );

/**
 * A repository-relative path pattern: `*` matches within one path segment and
 * `**` across any number of segments, none included (see `screenPathPattern`).
 * Patterns are read from reviewed configuration but still bounded, and may not
 * climb out of the repository.
 */
const screensPathPatternSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !value.startsWith("/") &&
      !/^[A-Za-z]:/.test(value) &&
      !value.split("/").some((segment) => segment === ".."),
    "must be a repository-relative POSIX path pattern without '..' segments"
  );

/**
 * How screens are captured. `tests` names the files whose `@screen:<key>` tags
 * link catalog entries to the Playwright tests that capture them; when it is
 * omitted, files named like Playwright tests (`*.spec.ts`, `*.test.ts`,
 * `*.screens.ts`, and their JavaScript forms) are read. `global_paths` names
 * files whose change may affect every screen (themes, layouts, global styles,
 * translations), so a branch that touches one re-captures them all.
 * `playwright_config` and `project` choose the Playwright configuration file
 * and the one project that captures (one viewport per screen), and
 * `timeout_minutes` bounds a whole capture run. `pages` names the files that
 * define pages, so a page no screen claims is reported. `generated_scenes`
 * names the file `tieline screens scenes` writes, with a scene for each
 * catalogued page no other test captures, and the agent-written `setup`
 * module that signs in, seeds data, and fills in route parameters.
 */
const screensCaptureConfigSchema = z
  .object({
    tests: z.array(screensPathPatternSchema).min(1).max(50).optional(),
    global_paths: z.array(screensPathPatternSchema).max(50).optional(),
    playwright_config: screensPathPatternSchema
      .refine((value) => !value.includes("*"), "must name a file, not a pattern")
      .optional(),
    project: z.string().trim().min(1).max(120).optional(),
    timeout_minutes: z.number().int().min(1).max(240).optional(),
    pages: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(241)
          .refine(
            (value) => screensPathPatternSchema.safeParse(value.replace(/^!/, "")).success,
            "must be a repository-relative POSIX path pattern without '..' segments, optionally starting with '!'"
          )
      )
      .min(1)
      .max(50)
      .optional(),
    generated_scenes: z
      .object({
        file: screensPathPatternSchema.refine((value) => !value.includes("*"), "must name a file, not a pattern"),
        setup: screensPathPatternSchema
          .refine((value) => !value.includes("*"), "must name a file, not a pattern")
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Hosted screens. When enabled, `tieline screens publish` stores a pull
 * request's or branch's review page and the images it shows, and repository
 * sync does the same for `main`. Images go to the S3-compatible `bucket`,
 * whose endpoint and credentials come from the environment, never from this
 * file. `site_url` is the deployed site, used to link to a published page.
 * `retention` bounds what is kept: branches not published for `branch_days`
 * are deleted, and `main` keeps the last `main_history` images each screen
 * replaced.
 */
const screensHostedConfigSchema = z
  .object({
    enabled: z.boolean(),
    bucket: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, "must be a valid S3 bucket name")
      .refine((value) => !value.includes(".."), "must be a valid S3 bucket name"),
    site_url: z
      .string()
      .trim()
      .max(200)
      .refine((value) => {
        try {
          const url = new URL(value);
          return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
        } catch {
          return false;
        }
      }, "must be the hosted site's https URL, without credentials, a query, or a fragment")
      .optional(),
    retention: z
      .object({
        branch_days: z.number().int().min(1).max(365).optional(),
        main_history: z.number().int().min(0).max(100).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const screensConfigSchema = z
  .object({
    enabled: z.boolean(),
    catalog_directory: screensDirectorySchema.optional(),
    captures_directory: screensDirectorySchema.optional(),
    text_directory: screensDirectorySchema.optional(),
    capture: screensCaptureConfigSchema.optional(),
    hosted: screensHostedConfigSchema.optional(),
  })
  .strict();

export type ScreensConfigBlock = z.infer<typeof screensConfigSchema>;

export const DEFAULT_SCREENS_CATALOG_DIRECTORY = "screens";
export const DEFAULT_SCREENS_CAPTURES_DIRECTORY = "captures";
export const DEFAULT_SCREENS_TEXT_DIRECTORY = "screen-text";

export interface ScreensCaptureConfig {
  /** Scene test file patterns; null means the Playwright naming defaults. */
  tests: string[] | null;
  /** Path patterns whose change selects every screen for capture. */
  global_paths: string[];
  /** Repository-relative Playwright configuration; null lets Playwright find it. */
  playwright_config: string | null;
  /** The Playwright project that captures; null runs the configuration's projects. */
  project: string | null;
  /** Longest a capture run may take before it is stopped. */
  timeout_minutes: number;
  /**
   * Patterns for the files that define pages; `!` excludes. Every matching
   * file must be claimed by some screen's `paths`. Empty means not checked.
   */
  pages: string[];
  /** The generated page scenes file and its setup module; null when not used. */
  generated_scenes: { file: string; setup: string | null } | null;
}

export const DEFAULT_SCREENS_CAPTURE_TIMEOUT_MINUTES = 30;
export const DEFAULT_SCREENS_BRANCH_DAYS = 14;
export const DEFAULT_SCREENS_MAIN_HISTORY = 5;

export interface ScreensHostedConfig {
  bucket: string;
  /** The deployed site, without a trailing slash, for links; null when not set. */
  site_url: string | null;
  retention: {
    /** Days a branch's page is kept after its last publish. */
    branch_days: number;
    /** Replaced `main` images kept per screen. */
    main_history: number;
  };
}

export interface ScreensConfig {
  /** Catalog directory relative to `.tieline/`. */
  catalog_directory: string;
  /** Screenshot directory relative to `.tieline/`. */
  captures_directory: string;
  /** Committed ARIA snapshot directory relative to `.tieline/`. */
  text_directory: string;
  capture: ScreensCaptureConfig;
  /** Null unless hosted screens are enabled. */
  hosted: ScreensHostedConfig | null;
}

/**
 * Reads the `screens` block out of an already-parsed `.tieline/config.json`
 * value. Returns null when the feature is off — no block, or `enabled: false` —
 * which is the normal case. A malformed block throws for the same reason a
 * malformed `selectors` block does: a repository that tried to opt in and got
 * it wrong must not silently run with the feature off.
 */
export function readScreensConfig(configValue: unknown): ScreensConfig | null {
  if (configValue === null || typeof configValue !== "object") return null;
  const block = (configValue as Record<string, unknown>).screens;
  if (block === undefined || block === null) return null;
  const parsed = screensConfigSchema.safeParse(block);
  if (!parsed.success) {
    throw new Error(
      `Invalid 'screens' block in Tieline configuration: ${parsed.error.issues
        .map(
          (issue) => `${["screens", ...issue.path].join(".")}: ${issue.message}`
        )
        .join("; ")}`
    );
  }
  if (!parsed.data.enabled) return null;
  return {
    catalog_directory:
      parsed.data.catalog_directory ?? DEFAULT_SCREENS_CATALOG_DIRECTORY,
    captures_directory:
      parsed.data.captures_directory ?? DEFAULT_SCREENS_CAPTURES_DIRECTORY,
    text_directory:
      parsed.data.text_directory ?? DEFAULT_SCREENS_TEXT_DIRECTORY,
    capture: {
      tests: parsed.data.capture?.tests ?? null,
      global_paths: parsed.data.capture?.global_paths ?? [],
      playwright_config: parsed.data.capture?.playwright_config ?? null,
      project: parsed.data.capture?.project ?? null,
      timeout_minutes:
        parsed.data.capture?.timeout_minutes ?? DEFAULT_SCREENS_CAPTURE_TIMEOUT_MINUTES,
      pages: parsed.data.capture?.pages ?? [],
      generated_scenes: parsed.data.capture?.generated_scenes
        ? {
            file: parsed.data.capture.generated_scenes.file,
            setup: parsed.data.capture.generated_scenes.setup ?? null,
          }
        : null,
    },
    hosted: parsed.data.hosted?.enabled
      ? {
          bucket: parsed.data.hosted.bucket,
          site_url: parsed.data.hosted.site_url?.replace(/\/+$/, "") ?? null,
          retention: {
            branch_days:
              parsed.data.hosted.retention?.branch_days ?? DEFAULT_SCREENS_BRANCH_DAYS,
            main_history:
              parsed.data.hosted.retention?.main_history ?? DEFAULT_SCREENS_MAIN_HISTORY,
          },
        }
      : null,
  };
}

export interface Config {
  dbUrl: string | undefined;
  dbWriteUrl: string | undefined;
  dbSyncUrl: string | undefined;
  dbAdminUrl: string | undefined;
  dbScreensPublishUrl: string | undefined;
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

function isLoopbackHost(host: string): boolean {
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
    dbScreensPublishUrl: env.DATABASE_URL_SCREENS_PUBLISH,
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
