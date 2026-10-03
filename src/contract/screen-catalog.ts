import {
  lstatSync,
  opendirSync,
  readFileSync,
  realpathSync,
  statSync,
  type Dirent,
} from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { z, type ZodIssue } from "zod";
import { readScreensConfig, type ScreensHostedConfig } from "../config.js";
import { isStillFile, readFileWithin, type BoundedRead } from "./bounded-read.js";
import { withinRepository } from "./paths.js";
import { applicabilitySchema, stableKeySchema } from "./schema.js";

/**
 * The user-visible states a screen catalog can describe. Closed on purpose: the
 * review page groups and filters by kind, and a later capture phase decides how
 * to reach a screen from it, so an unknown kind is an authoring error rather
 * than a new category.
 */
export const SCREEN_KINDS = [
  "page",
  "state",
  "dialog",
  "drawer",
  "toast",
  "inline-error",
  "error-page",
  "redirect",
  "loading",
] as const;
export type ScreenKind = (typeof SCREEN_KINDS)[number];

/**
 * Bounds for every catalog field. The catalog is reviewed repository content,
 * but most of it arrives through `tieline screens import` from an external
 * capture tool, so each field is bounded where it is parsed rather than trusted
 * to be reasonable. The totals are sized for a large web application (about a
 * thousand screens) with an order of magnitude of headroom.
 */
export const SCREEN_LIMITS = {
  titleChars: 200,
  groupChars: 120,
  routeChars: 500,
  whenChars: 500,
  copyItems: 50,
  copyChars: 500,
  pathPatterns: 20,
  pathPatternChars: 240,
  imagePathChars: 500,
  imageUrlChars: 2_048,
  testPathChars: 500,
  notCapturedDetailChars: 500,
  applicabilityDimensions: 16,
  applicabilityValues: 32,
  applicabilityChars: 120,
  screens: 10_000,
  catalogFileBytes: 4 * 1024 * 1024,
  /** Bounds on walking the catalog directory, checked during the walk. */
  catalogDepth: 8,
  catalogEntries: 10_000,
  catalogFiles: 1_000,
  catalogTotalBytes: 64 * 1024 * 1024,
} as const;

const IMAGE_EXTENSION = /\.(?:png|jpe?g|webp|gif|avif|svg)$/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function boundedText(max: number) {
  return z.string().trim().min(1).max(max);
}

function boundedLine(max: number) {
  return boundedText(max).refine(
    (value) => !/[\r\n]/.test(value),
    "must be a single line"
  );
}

function relativePathProblem(value: string, base: string): string | null {
  if (CONTROL_CHARACTERS.test(value)) return "must not contain control characters";
  if (value.includes("\\")) return "must use '/' as the path separator";
  if (value.startsWith("/")) return `must be relative to ${base}`;
  if (value.includes(":")) return "must be a relative path, not a URL or drive path";
  if (value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    return "must not contain empty, '.', or '..' segments";
  }
  return null;
}

/**
 * Why an image path cannot be used, or null. Paths are relative to the
 * configured captures directory, so anything that could name a file outside it,
 * or be read as a URL by a browser, is refused.
 */
export function screenImagePathProblem(value: string): string | null {
  const problem = relativePathProblem(value, "the captures directory");
  if (problem) return problem;
  if (!IMAGE_EXTENSION.test(value)) {
    return "must name a .png, .jpg, .jpeg, .webp, .gif, .avif, or .svg file";
  }
  return null;
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

export const screenImagePathSchema = boundedText(SCREEN_LIMITS.imagePathChars).superRefine(
  (value, ctx) => {
    const problem = screenImagePathProblem(value);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  }
);

const screenImageUrlSchema = boundedText(SCREEN_LIMITS.imageUrlChars).refine(
  isHttpUrl,
  "must be an absolute http or https URL"
);

/**
 * The SHA-256 of a screenshot's bytes. Screenshots are not committed, so this
 * digest is what puts a re-captured image into the reviewed diff: the catalog
 * changes exactly when the picture does.
 */
export const screenImageDigestSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "must be a lowercase hex SHA-256 digest");

/**
 * Where a screenshot of the screen can be found. Images are never committed by
 * default: `path` names a file inside the git-ignored captures directory, and
 * `url` names an image hosted elsewhere. Either may be absent at render time,
 * and every view falls back to a placeholder. `sha256`, when known, records
 * which bytes were reviewed.
 */
export const screenImageSchema = z.union([
  z
    .object({ path: screenImagePathSchema, sha256: screenImageDigestSchema.optional() })
    .strict(),
  z
    .object({ url: screenImageUrlSchema, sha256: screenImageDigestSchema.optional() })
    .strict(),
]);

/**
 * Why a repository-relative file path cannot be recorded, or null. Used for
 * paths a capture writes into the catalog, which reviewers and later commands
 * read back as locations inside the repository.
 */
export function repositoryFilePathProblem(value: string): string | null {
  return relativePathProblem(value, "the repository root");
}

/**
 * What a Tieline capture recorded about a screen, written by
 * `tieline screens capture` and committed with the catalog:
 *
 * - `fingerprint`: the SHA-256 of the canonical capture settings (browser,
 *   viewport, fonts, and the rest), so digests are only compared like for like;
 * - `text_sha256`: the SHA-256 of the screen's committed ARIA snapshot;
 * - `test`: the repository-relative test file that captured it.
 */
export const screenCaptureSchema = z
  .object({
    fingerprint: screenImageDigestSchema,
    text_sha256: screenImageDigestSchema,
    test: boundedText(SCREEN_LIMITS.testPathChars).superRefine((value, ctx) => {
      const problem = repositoryFilePathProblem(value);
      if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
    }),
  })
  .strict();

/**
 * A repository-relative path pattern naming files that render a screen: `*`
 * matches within one path segment and `**` across segments, and a pattern also
 * covers everything beneath the path it matches.
 */
export const screenPathPatternSchema = boundedText(SCREEN_LIMITS.pathPatternChars).superRefine(
  (value, ctx) => {
    const problem = relativePathProblem(value, "the repository root");
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  }
);

/**
 * Why a screen is deliberately not captured. A screen is either captured or
 * says why not, so a catalog can account for every screen honestly:
 *
 * - `flag-off`: behind a feature flag that is off in the capture profile;
 * - `external`: on another site, such as a payment or sign-in provider;
 * - `unreachable`: no path in the app leads to it;
 * - `needs-real-trigger`: reaching it would mean faking a response, and no
 *   seeded data or test-only switch in the app makes it happen for real yet;
 * - `unstable`: its capture differs from run to run until it is fixed;
 * - `other`: explained in `detail`.
 */
export const SCREEN_NOT_CAPTURED_REASONS = [
  "flag-off",
  "external",
  "unreachable",
  "needs-real-trigger",
  "unstable",
  "other",
] as const;
export type ScreenNotCapturedReason = (typeof SCREEN_NOT_CAPTURED_REASONS)[number];

export const screenNotCapturedSchema = z
  .object({
    reason: z.enum(SCREEN_NOT_CAPTURED_REASONS),
    detail: boundedText(SCREEN_LIMITS.notCapturedDetailChars),
  })
  .strict();

/** The shared applicability schema, with bounds on its size. */
export const screenApplicabilitySchema = applicabilitySchema.superRefine((value, ctx) => {
  const dimensions = Object.entries(value);
  if (dimensions.length > SCREEN_LIMITS.applicabilityDimensions) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `must contain at most ${SCREEN_LIMITS.applicabilityDimensions} dimensions`,
    });
  }
  for (const [dimension, values] of dimensions) {
    if (dimension.length > SCREEN_LIMITS.applicabilityChars) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [dimension],
        message: `dimension names must contain at most ${SCREEN_LIMITS.applicabilityChars} characters`,
      });
    }
    if (values.length > SCREEN_LIMITS.applicabilityValues) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [dimension],
        message: `must contain at most ${SCREEN_LIMITS.applicabilityValues} values`,
      });
    }
    values.forEach((entry, index) => {
      if (entry.length > SCREEN_LIMITS.applicabilityChars) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [dimension, index],
          message: `values must contain at most ${SCREEN_LIMITS.applicabilityChars} characters`,
        });
      }
    });
  }
});

/**
 * A field name kept for a later phase. Accepting a value now would let
 * catalogs record data whose meaning is not yet defined, so any value is
 * refused with a message that says why.
 */
function reservedField(field: string, purpose: string) {
  return z
    .never({
      errorMap: () => ({
        message: `'${field}' is reserved for ${purpose} in a later Tieline release and must be omitted`,
      }),
    })
    .optional();
}

export const screenEntrySchema = z
  .object({
    key: stableKeySchema,
    title: boundedLine(SCREEN_LIMITS.titleChars),
    group: boundedLine(SCREEN_LIMITS.groupChars).optional(),
    route: boundedLine(SCREEN_LIMITS.routeChars),
    kind: z.enum(SCREEN_KINDS),
    when: boundedText(SCREEN_LIMITS.whenChars),
    applies_to: screenApplicabilitySchema.optional(),
    copy: z
      .array(boundedText(SCREEN_LIMITS.copyChars))
      .max(SCREEN_LIMITS.copyItems)
      .optional(),
    /**
     * Files that render the screen, usually its page or route file. Used only
     * to decide which screens a branch may have changed; shared components need
     * not be listed, because the code-topology blast radius follows them to the
     * files that use them.
     */
    paths: z
      .array(screenPathPatternSchema)
      .min(1)
      .max(SCREEN_LIMITS.pathPatterns)
      .optional(),
    image: screenImageSchema.optional(),
    scene: reservedField("scene", "the script that reaches a screen"),
    capture: screenCaptureSchema.optional(),
    not_captured: screenNotCapturedSchema.optional(),
  })
  .strict();

/**
 * A capture record describes a screenshot Tieline wrote into the captures
 * directory, so an entry that has one must locate that screenshot by path and
 * record its digest. Anything else would be a record of a picture nobody can
 * find or compare.
 */
const catalogScreenEntrySchema = screenEntrySchema.superRefine((entry, ctx) => {
  if (!entry.capture) return;
  if (entry.not_captured) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["not_captured"],
      message: "a screen with a capture record cannot also be marked not captured; remove one",
    });
  }
  if (!entry.image || !("path" in entry.image) || entry.image.sha256 === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["capture"],
      message: "a capture record requires an image path with its sha256",
    });
  }
});

/** One catalog file: the screens of exactly one capability. */
export const screenCatalogDocumentSchema = z
  .object({
    version: z.literal(1),
    capability: stableKeySchema,
    screens: z.array(catalogScreenEntrySchema).max(SCREEN_LIMITS.screens),
  })
  .strict();

export type ScreenImage = z.infer<typeof screenImageSchema>;
export type ScreenCapture = z.infer<typeof screenCaptureSchema>;
export type ScreenNotCaptured = z.infer<typeof screenNotCapturedSchema>;
export type ScreenEntry = z.infer<typeof screenEntrySchema>;
export type ScreenCatalogDocument = z.infer<typeof screenCatalogDocumentSchema>;

/** Where a repository that enabled screens keeps its catalog and captures. */
export interface ScreenSettings {
  /** Absolute catalog directory. */
  catalogDirectory: string;
  /**
   * Where the catalog directory really resolved when the settings were read
   * and validated; writers check it again before writing.
   */
  realCatalogDirectory: string;
  /** Where the captures directory really resolved when validated, likewise. */
  realCapturesDirectory: string;
  /** Where the Tieline workspace directory really resolved when validated. */
  realWorkspaceDirectory: string;
  /**
   * Whether the catalog directory existed when validated. One that existed
   * and is gone by the time it is read was deleted or swapped mid-command,
   * which is not the same as a repository with no catalog yet.
   */
  catalogExisted: boolean;
  /** Absolute captures directory. */
  capturesDirectory: string;
  /** Absolute directory of committed ARIA snapshots, one `<key>.yml` per screen. */
  textDirectory: string;
  /** Catalog directory relative to the repository root, `/`-separated. */
  catalogPath: string;
  /** Captures directory relative to the repository root, `/`-separated. */
  capturesPath: string;
  /** Text directory relative to the repository root, `/`-separated. */
  textPath: string;
  /** Scene test file patterns; null means the Playwright naming defaults. */
  sceneTests: string[] | null;
  /** Path patterns whose change selects every screen for capture. */
  globalPaths: string[];
  /** How a capture run starts Playwright. */
  capture: {
    /** Repository-relative Playwright configuration, or null for Playwright's default. */
    playwrightConfig: string | null;
    project: string | null;
    timeoutMinutes: number;
    /** Page file patterns, `!` excluding; empty when page coverage is not checked. */
    pages: string[];
    /**
     * Repository-relative paths of the generated page scenes file and its
     * setup module, or null when scenes are not generated.
     */
    generatedScenes: { file: string; setup: string | null } | null;
  };
  /** Where hosted screens are published; null unless hosting is enabled. */
  hosted: ScreensHostedConfig | null;
}

function portable(path: string): string {
  return path.split(sep).join("/");
}

/**
 * Where `path` really lands on disk: the real path of its nearest existing
 * ancestor plus the components not created yet. Symbolic links are followed,
 * and one that points nowhere is refused, because writing through it would
 * land wherever it is later made to point.
 */
export function realDestination(path: string): string {
  const pending: string[] = [];
  let current = path;
  for (;;) {
    let exists = true;
    try {
      lstatSync(current);
    } catch {
      exists = false;
    }
    if (exists) {
      try {
        return resolve(realpathSync(current), ...pending);
      } catch (error) {
        throw new Error(
          `'${current}' cannot be resolved: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    const parent = dirname(current);
    if (parent === current) return resolve(path);
    pending.unshift(basename(current));
    current = parent;
  }
}

/**
 * Where the committed code topology lives: `CODE_TOPOLOGY_DIRECTORY`, kept
 * here rather than imported so loading a screen catalog does not load the
 * topology indexer. The screens tests pin the two together.
 */
export const CODE_TOPOLOGY_PATH = ".tieline/topology";

/**
 * The repository's screen settings, or null when the feature is off. Like
 * `selectorVocabularyForRepository`, a missing or unparseable config means the
 * feature is off, while a malformed `screens` block throws.
 */
export function screenSettingsForRepository(
  repositoryRoot: string,
  options: {
    /**
     * The spec directory a command actually reads, repository-relative, when
     * `--spec` overrides the configured one; it is held to the same rules.
     */
    specDirectory?: string;
    configPath?: string;
  } = {}
): ScreenSettings | null {
  const configPath = options.configPath ?? ".tieline/config.json";
  const root = resolve(repositoryRoot);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(root, configPath), "utf8"));
  } catch {
    return null;
  }
  const config = readScreensConfig(parsed);
  if (!config) return null;
  const workspace = resolve(root, configPath, "..");
  const catalogDirectory = resolve(workspace, config.catalog_directory);
  const capturesDirectory = resolve(workspace, config.captures_directory);
  if (
    catalogDirectory === workspace ||
    !withinRepository(workspace, catalogDirectory)
  ) {
    throw new Error(
      `Invalid 'screens.catalog_directory' '${config.catalog_directory}': the screen catalog must be a directory inside '${portable(relative(root, workspace))}'.`
    );
  }
  if (!withinRepository(root, capturesDirectory)) {
    throw new Error(
      `Invalid 'screens.captures_directory' '${config.captures_directory}': the captures directory must stay inside the repository.`
    );
  }
  // The lexical checks above are not enough: a symbolic link anywhere on
  // either path could send catalog writes, or the captures .gitignore,
  // outside the checkout. Judge both by where they really resolve, starting
  // with the workspace itself: a catalog inside a workspace that links out
  // of the repository would be written outside it too.
  const realRoot = realpathSync(root);
  const realWorkspace = realpathSync(workspace);
  if (!withinRepository(realRoot, realWorkspace)) {
    throw new Error(
      `Invalid screens configuration: '${portable(relative(root, workspace))}' resolves to '${realWorkspace}' through a symbolic link, outside the repository, so the screen catalog would be written outside it.`
    );
  }
  const realCatalog = realDestination(catalogDirectory);
  if (realCatalog === realWorkspace || !withinRepository(realWorkspace, realCatalog)) {
    throw new Error(
      `Invalid 'screens.catalog_directory' '${config.catalog_directory}': it resolves to '${realCatalog}' through a symbolic link, outside '${portable(relative(root, workspace))}'.`
    );
  }
  const realCaptures = realDestination(capturesDirectory);
  if (!withinRepository(realRoot, realCaptures)) {
    throw new Error(
      `Invalid 'screens.captures_directory' '${config.captures_directory}': it resolves to '${realCaptures}' through a symbolic link, outside the repository.`
    );
  }
  // The captures directory is git-ignored wholesale, so a catalog inside it
  // would work locally but never be committed.
  if (withinRepository(realCaptures, realCatalog)) {
    throw new Error(
      `Invalid screens configuration: the catalog directory '${config.catalog_directory}' is inside the captures directory '${config.captures_directory}', which is git-ignored, so the catalog would never be committed.`
    );
  }
  // Every YAML file below the spec directory is read as a contract document,
  // and every one below the catalog as a screen catalog, so neither may hold
  // the other. Both the configured spec directory and, when a command
  // overrides it with `--spec`, the one it actually reads are held to that.
  const files = (parsed as { files?: { spec_directory?: unknown; manifest?: unknown } } | null)
    ?.files;
  const specSetting =
    typeof files?.spec_directory === "string" ? files.spec_directory : "spec";
  const realSpec = realDestination(resolve(workspace, specSetting));
  const specs = [{ setting: specSetting, real: realSpec }];
  if (options.specDirectory !== undefined) {
    const effective = realDestination(resolve(root, options.specDirectory));
    if (effective !== realSpec) specs.push({ setting: options.specDirectory, real: effective });
  }
  for (const spec of specs) {
    if (withinRepository(spec.real, realCatalog) || withinRepository(realCatalog, spec.real)) {
      throw new Error(
        `Invalid screens configuration: the catalog directory '${config.catalog_directory}' and the spec directory '${spec.setting}' overlap. Every YAML file below the spec directory is read as a contract document, and every one below the catalog as a screen catalog, so each must be outside the other.`
      );
    }
  }
  // The captures directory is git-ignored wholesale, so it must not hold
  // anything Tieline commits: the spec, the compiled manifest, or the code
  // topology would silently drop out of commits.
  const manifestSetting = typeof files?.manifest === "string" ? files.manifest : "manifest";
  const committed: Array<{ label: string; setting: string; noun: string; real: string }> = [
    ...specs.map((spec) => ({
      label: "spec directory",
      setting: spec.setting,
      noun: "spec",
      real: spec.real,
    })),
    {
      label: "manifest",
      setting: manifestSetting,
      noun: "manifest",
      real: realDestination(resolve(workspace, manifestSetting)),
    },
    {
      label: "code topology directory",
      setting: CODE_TOPOLOGY_PATH,
      noun: "code topology",
      real: realDestination(resolve(root, CODE_TOPOLOGY_PATH)),
    },
  ];
  for (const { label, setting, noun, real } of committed) {
    if (withinRepository(realCaptures, real)) {
      throw new Error(
        `Invalid screens configuration: the ${label} '${setting}' is inside the captures directory '${config.captures_directory}', which is git-ignored, so the ${noun} would never be committed.`
      );
    }
  }
  // Nor may screenshots sit inside the spec directory: the spec loader walks
  // all of it, so every capture directory would be read on every command, and
  // a YAML file among the captures would be loaded as a contract document.
  for (const spec of specs) {
    if (withinRepository(spec.real, realCaptures)) {
      throw new Error(
        `Invalid screens configuration: the captures directory '${config.captures_directory}' is inside the spec directory '${spec.setting}', where every YAML file is read as a contract document; keep screenshots outside it.`
      );
    }
  }
  // Committed ARIA snapshots are written by capture, so the text directory is
  // judged like the catalog: inside `.tieline/` by where it really resolves,
  // apart from the catalog and the spec (whose loaders read every YAML file
  // in them), and outside the git-ignored captures directory.
  const textDirectory = resolve(workspace, config.text_directory);
  const realText = realDestination(textDirectory);
  const textProblem =
    textDirectory === workspace || !withinRepository(workspace, textDirectory)
      ? `the text directory must be a directory inside '${portable(relative(root, workspace))}'`
      : realText === realWorkspace || !withinRepository(realWorkspace, realText)
        ? `it resolves to '${realText}' through a symbolic link, outside '${portable(relative(root, workspace))}'`
        : withinRepository(realCatalog, realText) || withinRepository(realText, realCatalog)
          ? "the text directory must not overlap the screen catalog, whose loader reads every YAML file in it"
          : specs.some((spec) => withinRepository(spec.real, realText) || withinRepository(realText, spec.real))
            ? "the text directory must not overlap the spec directory, whose loader reads every YAML file in it"
          : withinRepository(realCaptures, realText)
            ? "the text directory must not be inside the git-ignored captures directory"
            : null;
  if (textProblem) {
    throw new Error(
      `Invalid 'screens.text_directory' '${config.text_directory}': ${textProblem}.`
    );
  }
  return {
    catalogDirectory,
    realCatalogDirectory: realCatalog,
    capturesDirectory,
    textDirectory,
    realCapturesDirectory: realCaptures,
    realWorkspaceDirectory: realWorkspace,
    catalogExisted: pathExists(catalogDirectory),
    catalogPath: portable(relative(root, catalogDirectory)),
    capturesPath: portable(relative(root, capturesDirectory)) || ".",
    textPath: portable(relative(root, textDirectory)),
    sceneTests: config.capture.tests,
    globalPaths: config.capture.global_paths,
    capture: {
      playwrightConfig: config.capture.playwright_config,
      project: config.capture.project,
      timeoutMinutes: config.capture.timeout_minutes,
      pages: config.capture.pages,
      generatedScenes: config.capture.generated_scenes,
    },
    hosted: config.hosted,
  };
}

export interface ScreenCatalogSource {
  /** Repository-relative, `/`-separated. */
  path: string;
  absolutePath: string;
  /** Where the walk found the file and read it, below the validated catalog. */
  realPath: string;
  content: string;
  document: unknown;
}

export interface ScreenCatalogSources {
  sources: ScreenCatalogSource[];
  /** Files that could not be read or parsed; reported with validation issues. */
  issues: string[];
  /**
   * False when the walk stopped at a bound, so `sources` is not the whole
   * catalog and nothing should be resolved against it.
   */
  complete: boolean;
  /**
   * The directory entries the walk read, of every kind: the count its entry
   * bound applies to, which an import must not push past.
   */
  entries: number;
}

export interface CatalogWalkLimits {
  depth: number;
  entries: number;
  files: number;
  fileBytes: number;
  totalBytes: number;
}

const CATALOG_WALK_LIMITS: CatalogWalkLimits = {
  depth: SCREEN_LIMITS.catalogDepth,
  entries: SCREEN_LIMITS.catalogEntries,
  files: SCREEN_LIMITS.catalogFiles,
  fileBytes: SCREEN_LIMITS.catalogFileBytes,
  totalBytes: SCREEN_LIMITS.catalogTotalBytes,
};

/**
 * The catalog's YAML files, found by a bounded walk. Catalog content can
 * arrive in a pull request, so depth, directory entries examined, file count,
 * and total bytes are all checked while walking: a hostile tree stops the
 * walk with an issue instead of exhausting the stack, memory, or time. Symbolic
 * links are never followed.
 */
function catalogYamlFiles(
  directory: string,
  limits: CatalogWalkLimits,
  displayPath: (absolutePath: string) => string,
  skipDirectory?: string
): { files: string[]; entries: number; issue?: string } {
  // Only paths are collected: sizes are taken, and bounded, when each file is
  // read through its own descriptor, so a file cannot change between being
  // measured here and read there.
  const files: string[] = [];
  let entries = 0;
  const pending: Array<{ path: string; depth: number }> = [{ path: directory, depth: 0 }];
  while (pending.length > 0) {
    const { path: current, depth } = pending.pop()!;
    // Read entries one at a time, so the entry budget bounds memory too: a
    // directory holding millions of entries is never materialized at once.
    const handle = opendirSync(current);
    // Every path here is built from the validated real directory, so it must
    // still resolve to itself: a directory swapped for a link after it was
    // queued is not walked into, wherever the link leads.
    if (realpathSync(current) !== current) {
      handle.closeSync();
      return {
        files,
        entries,
        issue: `${displayPath(current)}: the screen catalog directory changed while it was walked`,
      };
    }
    try {
      let entry: Dirent | null;
      while ((entry = handle.readSync()) !== null) {
        entries += 1;
        if (entries > limits.entries) {
          return { files, entries, issue: `the screen catalog holds more than ${limits.entries} directory entries` };
        }
        const path = resolve(current, entry.name);
        if (entry.isDirectory()) {
          if (path === skipDirectory) continue;
          if (depth + 1 > limits.depth) {
            return {
              files,
              entries,
              issue: `${displayPath(path)}: the screen catalog is nested deeper than ${limits.depth} directories`,
            };
          }
          pending.push({ path, depth: depth + 1 });
        } else if (/\.ya?ml$/i.test(entry.name)) {
          // Links and special files are never followed, but a catalog-named
          // one is not silently skipped either: its screens would vanish
          // from the next compile without a word.
          if (!entry.isFile()) {
            return {
              files,
              entries,
              issue: `${displayPath(path)}: screen catalog file is not a regular file; symbolic links and special files are not read`,
            };
          }
          if (files.length + 1 > limits.files) {
            return { files, entries, issue: `the screen catalog holds more than ${limits.files} YAML files` };
          }
          files.push(path);
        }
      }
    } finally {
      handle.closeSync();
    }
  }
  return { files: files.sort((left, right) => left.localeCompare(right)), entries };
}

/** Whether anything is at `path`; only ENOENT means nothing is. */
function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code !== "ENOENT";
  }
}

/**
 * Whether the catalog directory exists. Only a missing path means an empty
 * catalog; any other failure to inspect it (an unsearchable parent, a file in
 * the way) is reported, never read as "no catalog", which would silently drop
 * every screen from the next compile.
 */
function catalogDirectoryState(settings: ScreenSettings): "missing" | "directory" | { issue: string } {
  try {
    return statSync(settings.catalogDirectory).isDirectory()
      ? "directory"
      : { issue: `screen catalog '${settings.catalogPath}' is not a directory` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      // Missing now but present when validated: removed or swapped for a
      // dangling link since, so the catalog cannot be read as empty.
      return settings.catalogExisted
        ? { issue: `screen catalog '${settings.catalogPath}' existed when the settings were read and is gone now` }
        : "missing";
    }
    return {
      issue: `screen catalog '${settings.catalogPath}' cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * The bounded walk of an existing catalog directory, past any captures in it.
 * Each file is given twice: `path` under the configured catalog directory,
 * which names it everywhere, and `real` under the validated real directory,
 * which is what gets read.
 */
function walkCatalogDirectory(
  root: string,
  settings: ScreenSettings,
  limits: CatalogWalkLimits
): { files: Array<{ path: string; real: string }>; entries: number; issue?: string } {
  const directory = settings.catalogDirectory;
  // Walked where the settings validated it, not through the configured path,
  // which a link swapped in since could send anywhere; a catalog that no
  // longer resolves there is not read at all.
  const realDirectory = realpathSync(directory);
  if (realDirectory !== settings.realCatalogDirectory) {
    return {
      files: [],
      entries: 0,
      issue: `screen catalog '${settings.catalogPath}' now resolves to '${realDirectory}', not to '${settings.realCatalogDirectory}' where it was validated`,
    };
  }
  const configured = (real: string): string => resolve(directory, relative(realDirectory, real));
  // The captures directory may sit inside the catalog. Its screenshots are not
  // catalog files, and walking them would spend the walk's bounds on images.
  // The walk never follows links, so a directory it reaches really is the
  // same path below the catalog's real path.
  // A captures directory moved since validation would make the walk skip the
  // wrong subtree, hiding catalog files or walking screenshots, so it is
  // refused like a moved catalog.
  const realCaptures = realDestination(settings.capturesDirectory);
  if (realCaptures !== settings.realCapturesDirectory) {
    return {
      files: [],
      entries: 0,
      issue: `captures directory '${settings.capturesPath}' now resolves to '${realCaptures}', not to '${settings.realCapturesDirectory}' where it was validated`,
    };
  }
  const capturesInCatalog =
    realCaptures !== realDirectory && withinRepository(realDirectory, realCaptures)
      ? realCaptures
      : undefined;
  const walk = catalogYamlFiles(
    realDirectory,
    limits,
    (real) => portable(relative(root, configured(real))),
    capturesInCatalog
  );
  return { ...walk, files: walk.files.map((real) => ({ path: configured(real), real })) };
}

/**
 * The catalog's YAML files, absolute and sorted, found by the same bounded
 * walk `readScreenCatalogSources` makes but without reading them. `limits`
 * override the walk's own, for a caller that validated against others or
 * knows of entries passing through, such as an import's staged files.
 */
export function listScreenCatalogFiles(
  repositoryRoot: string,
  settings: ScreenSettings,
  limits: Partial<CatalogWalkLimits> = {}
): { paths: string[]; issue?: string } {
  const state = catalogDirectoryState(settings);
  if (state === "missing") return { paths: [] };
  if (state !== "directory") return { paths: [], issue: state.issue };
  const walk = walkCatalogDirectory(resolve(repositoryRoot), settings, {
    ...CATALOG_WALK_LIMITS,
    ...limits,
  });
  return walk.issue
    ? { paths: [], issue: walk.issue }
    : { paths: walk.files.map((file) => file.path) };
}

/**
 * Reads every catalog YAML file. A missing catalog directory is an empty
 * catalog — the normal state of a repository that has just opted in — not an
 * error. Each file is size-checked before it is read.
 */
export function readScreenCatalogSources(
  repositoryRoot: string,
  settings: ScreenSettings,
  limits: CatalogWalkLimits = CATALOG_WALK_LIMITS
): ScreenCatalogSources {
  const root = resolve(repositoryRoot);
  const state = catalogDirectoryState(settings);
  if (state === "missing") return { sources: [], issues: [], complete: true, entries: 0 };
  if (state !== "directory") {
    return { sources: [], issues: [state.issue], complete: false, entries: 0 };
  }
  const sources: ScreenCatalogSource[] = [];
  const issues: string[] = [];
  const walk = walkCatalogDirectory(root, settings, limits);
  // A walk that hit a bound reports only that: validating a truncated
  // catalog would add misleading issues (unknown screens, missing files).
  if (walk.issue) {
    return { sources: [], issues: [walk.issue], complete: false, entries: walk.entries };
  }
  // Each file is read once, through one descriptor, bounded by the smaller
  // of the per-file limit and what is left of the total. An oversized file is
  // reported and counts as just over the per-file limit, so the rest are still
  // checked; crossing the total stops the read, like any other bound.
  const overTotal = (): ScreenCatalogSources => ({
    sources: [],
    issues: [`the screen catalog holds more than ${limits.totalBytes} bytes of YAML`],
    complete: false,
    entries: walk.entries,
  });
  let totalBytes = 0;
  for (const { path: absolutePath, real } of walk.files) {
    const path = portable(relative(root, absolutePath));
    const remaining = limits.totalBytes - totalBytes;
    let read: BoundedRead;
    try {
      // The opened file must be the regular file the walk found there, not a
      // link or file swapped in since, which could lead outside the catalog.
      read = readFileWithin(real, Math.min(limits.fileBytes, remaining), (opened) =>
        isStillFile(real, opened)
      );
    } catch (error) {
      issues.push(
        `${path}: screen catalog file cannot be read: ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }
    if (read.status === "not_file" || read.status === "changed") {
      issues.push(`${path}: screen catalog file changed after the catalog was walked; it is no longer the regular file found there`);
      continue;
    }
    if (read.status === "too_large") {
      if (read.size <= limits.fileBytes) return overTotal();
      issues.push(`${path}: screen catalog file is ${read.size} bytes; the limit is ${limits.fileBytes}`);
      totalBytes += limits.fileBytes + 1;
      if (totalBytes > limits.totalBytes) return overTotal();
      continue;
    }
    totalBytes += read.bytes.length;
    // Decoded strictly: lenient decoding would turn malformed bytes into
    // U+FFFD, so distinct files could validate, and hash, as the same text.
    // A byte order mark is kept, so the content is exactly what the file holds.
    let content: string;
    try {
      content = STRICT_UTF8.decode(read.bytes);
    } catch {
      issues.push(`${path}: screen catalog file is not valid UTF-8`);
      continue;
    }
    try {
      sources.push({ path, absolutePath, realPath: real, content, document: parse(content) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      issues.push(`${path}: invalid YAML: ${message}`);
    }
  }
  return { sources, issues, complete: true, entries: walk.entries };
}

export interface ScreenCatalogDocumentInput {
  path: string;
  document: unknown;
}

export interface ValidatedScreenCatalogFile {
  path: string;
  document: ScreenCatalogDocument;
}

export interface CataloguedScreen {
  capability: string;
  path: string;
  entry: ScreenEntry;
}

export interface ValidatedScreenCatalog {
  /** One per catalog file, in path order. */
  files: ValidatedScreenCatalogFile[];
  /** Every catalogued screen by key. */
  screens: ReadonlyMap<string, CataloguedScreen>;
  /**
   * Keys read leniently from files that failed validation. A link to one of
   * these is not reported as unknown: the file's own issue already explains
   * the failure, and repeating it once per link would bury it.
   */
  unvalidatedKeys: ReadonlySet<string>;
}

function lenientKeys(document: unknown): string[] {
  const screens =
    document !== null && typeof document === "object"
      ? (document as { screens?: unknown }).screens
      : undefined;
  if (!Array.isArray(screens)) return [];
  return screens.flatMap((entry: unknown) => {
    const key =
      entry !== null && typeof entry === "object"
        ? (entry as { key?: unknown }).key
        : undefined;
    return typeof key === "string" && key.trim().length > 0 ? [key.trim()] : [];
  });
}

function formatIssue(path: string, issue: ZodIssue): string {
  const field = issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
  return `${path}${field}: ${issue.message}`;
}

/**
 * Validates catalog files and the invariants that span them: screen keys are
 * unique across the catalog, a capability has at most one catalog file, and the
 * catalog stays within its size budget. When `capabilityKeys` is supplied, each
 * catalog must name a capability the contract declares.
 *
 * Issues are appended rather than thrown so a caller can report them beside the
 * contract's own issues in one failure.
 */
export function validateScreenCatalogDocuments(
  inputs: ScreenCatalogDocumentInput[],
  capabilityKeys: ReadonlySet<string> | undefined,
  issues: string[]
): ValidatedScreenCatalog {
  const files: ValidatedScreenCatalogFile[] = [];
  const screens = new Map<string, CataloguedScreen>();
  const unvalidatedKeys = new Set<string>();
  const capabilities = new Map<string, string>();
  for (const input of inputs) {
    const result = screenCatalogDocumentSchema.safeParse(input.document);
    if (!result.success) {
      issues.push(...result.error.issues.map((issue) => formatIssue(input.path, issue)));
      for (const key of lenientKeys(input.document)) unvalidatedKeys.add(key);
      continue;
    }
    const document = result.data;
    const claimedBy = capabilities.get(document.capability);
    if (claimedBy) {
      issues.push(
        `${input.path}: capability '${document.capability}' already has a screen catalog in ${claimedBy}; keep one catalog file per capability`
      );
      continue;
    }
    capabilities.set(document.capability, input.path);
    if (capabilityKeys && !capabilityKeys.has(document.capability)) {
      issues.push(
        `${input.path}: screen catalog names unknown capability '${document.capability}'`
      );
    }
    for (const entry of document.screens) {
      const existing = screens.get(entry.key);
      if (existing) {
        issues.push(
          `${input.path}: duplicate screen key '${entry.key}' already used in ${existing.path}`
        );
        continue;
      }
      screens.set(entry.key, {
        capability: document.capability,
        path: input.path,
        entry,
      });
    }
    files.push({ path: input.path, document });
  }
  if (screens.size > SCREEN_LIMITS.screens) {
    issues.push(
      `the screen catalog holds ${screens.size} screens; the limit is ${SCREEN_LIMITS.screens}`
    );
  }
  return { files, screens, unvalidatedKeys };
}

/**
 * Reads and validates the catalog without loading the whole contract, for
 * callers that need its keys even when the contract does not currently
 * compile. Pass the capabilities the spec declares to also reject catalogs
 * for undeclared capabilities.
 */
export function loadScreenCatalog(
  repositoryRoot: string,
  settings: ScreenSettings,
  capabilityKeys?: ReadonlySet<string>
): { catalog: ValidatedScreenCatalog; issues: string[] } {
  const read = readScreenCatalogSources(repositoryRoot, settings);
  const issues = [...read.issues];
  const catalog = validateScreenCatalogDocuments(read.sources, capabilityKeys, issues);
  return { catalog, issues };
}
