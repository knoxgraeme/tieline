import {
  existsSync,
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
import { readScreensConfig } from "../config.js";
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
  imagePathChars: 500,
  imageUrlChars: 2_048,
  testPathChars: 500,
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
    image: screenImageSchema.optional(),
    scene: reservedField("scene", "the script that reaches a screen"),
    capture: screenCaptureSchema.optional(),
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
export type ScreenEntry = z.infer<typeof screenEntrySchema>;
export type ScreenCatalogDocument = z.infer<typeof screenCatalogDocumentSchema>;

/** Where a repository that enabled screens keeps its catalog and captures. */
export interface ScreenSettings {
  /** Absolute catalog directory. */
  catalogDirectory: string;
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
 * The repository's screen settings, or null when the feature is off. Like
 * `selectorVocabularyForRepository`, a missing or unparseable config means the
 * feature is off, while a malformed `screens` block throws.
 */
export function screenSettingsForRepository(
  repositoryRoot: string,
  configPath = ".tieline/config.json"
): ScreenSettings | null {
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
  // outside the checkout. Judge both by where they really resolve.
  const realWorkspace = realpathSync(workspace);
  const realCatalog = realDestination(catalogDirectory);
  if (realCatalog === realWorkspace || !withinRepository(realWorkspace, realCatalog)) {
    throw new Error(
      `Invalid 'screens.catalog_directory' '${config.catalog_directory}': it resolves to '${realCatalog}' through a symbolic link, outside '${portable(relative(root, workspace))}'.`
    );
  }
  const realCaptures = realDestination(capturesDirectory);
  if (!withinRepository(realpathSync(root), realCaptures)) {
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
  // Committed ARIA snapshots are written by capture, so the text directory is
  // judged like the catalog: inside `.tieline/` by where it really resolves,
  // apart from the catalog (whose loader reads every YAML file in it), and
  // outside the git-ignored captures directory.
  const textDirectory = resolve(workspace, config.text_directory);
  const realText = realDestination(textDirectory);
  const textProblem =
    textDirectory === workspace || !withinRepository(workspace, textDirectory)
      ? `the text directory must be a directory inside '${portable(relative(root, workspace))}'`
      : realText === realWorkspace || !withinRepository(realWorkspace, realText)
        ? `it resolves to '${realText}' through a symbolic link, outside '${portable(relative(root, workspace))}'`
        : withinRepository(realCatalog, realText) || withinRepository(realText, realCatalog)
          ? "the text directory must not overlap the screen catalog, whose loader reads every YAML file in it"
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
    capturesDirectory,
    textDirectory,
    catalogPath: portable(relative(root, catalogDirectory)),
    capturesPath: portable(relative(root, capturesDirectory)) || ".",
    textPath: portable(relative(root, textDirectory)),
    sceneTests: config.capture.tests,
  };
}

export interface ScreenCatalogSource {
  /** Repository-relative, `/`-separated. */
  path: string;
  absolutePath: string;
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
  displayPath: (absolutePath: string) => string
): { files: Array<{ path: string; size: number }>; issue?: string } {
  const files: Array<{ path: string; size: number }> = [];
  let entries = 0;
  let totalBytes = 0;
  const pending: Array<{ path: string; depth: number }> = [{ path: directory, depth: 0 }];
  while (pending.length > 0) {
    const { path: current, depth } = pending.pop()!;
    // Read entries one at a time, so the entry budget bounds memory too: a
    // directory holding millions of entries is never materialized at once.
    const handle = opendirSync(current);
    try {
      let entry: Dirent | null;
      while ((entry = handle.readSync()) !== null) {
        entries += 1;
        if (entries > limits.entries) {
          return { files, issue: `the screen catalog holds more than ${limits.entries} directory entries` };
        }
        const path = resolve(current, entry.name);
        if (entry.isDirectory()) {
          if (depth + 1 > limits.depth) {
            return {
              files,
              issue: `${displayPath(path)}: the screen catalog is nested deeper than ${limits.depth} directories`,
            };
          }
          pending.push({ path, depth: depth + 1 });
        } else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
          const size = statSync(path).size;
          if (files.length + 1 > limits.files) {
            return { files, issue: `the screen catalog holds more than ${limits.files} YAML files` };
          }
          totalBytes += Math.min(size, limits.fileBytes + 1);
          if (totalBytes > limits.totalBytes) {
            return { files, issue: `the screen catalog holds more than ${limits.totalBytes} bytes of YAML` };
          }
          files.push({ path, size });
        }
      }
    } finally {
      handle.closeSync();
    }
  }
  return { files: files.sort((left, right) => left.path.localeCompare(right.path)) };
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
  const directory = settings.catalogDirectory;
  if (!existsSync(directory)) return { sources: [], issues: [], complete: true };
  if (!statSync(directory).isDirectory()) {
    return {
      sources: [],
      issues: [`screen catalog '${settings.catalogPath}' is not a directory`],
      complete: false,
    };
  }
  const sources: ScreenCatalogSource[] = [];
  const issues: string[] = [];
  const walk = catalogYamlFiles(directory, limits, (absolutePath) =>
    portable(relative(root, absolutePath))
  );
  // A walk that hit a bound reports only that: validating a truncated
  // catalog would add misleading issues (unknown screens, missing files).
  if (walk.issue) return { sources: [], issues: [walk.issue], complete: false };
  for (const { path: absolutePath, size } of walk.files) {
    const path = portable(relative(root, absolutePath));
    if (size > limits.fileBytes) {
      issues.push(`${path}: screen catalog file is ${size} bytes; the limit is ${limits.fileBytes}`);
      continue;
    }
    const content = readFileSync(absolutePath, "utf8");
    try {
      sources.push({ path, absolutePath, content, document: parse(content) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      issues.push(`${path}: invalid YAML: ${message}`);
    }
  }
  return { sources, issues, complete: true };
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
