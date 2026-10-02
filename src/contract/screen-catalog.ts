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
import { readScreensConfig } from "../config.js";
import { readFileWithin, type BoundedRead } from "./bounded-read.js";
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

/**
 * Why an image path cannot be used, or null. Paths are relative to the
 * configured captures directory, so anything that could name a file outside it,
 * or be read as a URL by a browser, is refused.
 */
export function screenImagePathProblem(value: string): string | null {
  if (CONTROL_CHARACTERS.test(value)) return "must not contain control characters";
  if (value.includes("\\")) return "must use '/' as the path separator";
  if (value.startsWith("/")) return "must be relative to the captures directory";
  if (value.includes(":")) return "must be a relative path, not a URL or drive path";
  if (value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    return "must not contain empty, '.', or '..' segments";
  }
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
    capture: reservedField("capture", "capture fingerprints"),
  })
  .strict();

/** One catalog file: the screens of exactly one capability. */
export const screenCatalogDocumentSchema = z
  .object({
    version: z.literal(1),
    capability: stableKeySchema,
    screens: z.array(screenEntrySchema).max(SCREEN_LIMITS.screens),
  })
  .strict();

export type ScreenImage = z.infer<typeof screenImageSchema>;
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
  /** Absolute captures directory. */
  capturesDirectory: string;
  /** Catalog directory relative to the repository root, `/`-separated. */
  catalogPath: string;
  /** Captures directory relative to the repository root, `/`-separated. */
  capturesPath: string;
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
  // the other. The spec directory is the configured one, as commands use it.
  const files = (parsed as { files?: { spec_directory?: unknown; manifest?: unknown } } | null)
    ?.files;
  const specSetting =
    typeof files?.spec_directory === "string" ? files.spec_directory : "spec";
  const realSpec = realDestination(resolve(workspace, specSetting));
  if (withinRepository(realSpec, realCatalog) || withinRepository(realCatalog, realSpec)) {
    throw new Error(
      `Invalid screens configuration: the catalog directory '${config.catalog_directory}' and the spec directory '${specSetting}' overlap. Every YAML file below the spec directory is read as a contract document, and every one below the catalog as a screen catalog, so each must be outside the other.`
    );
  }
  // The captures directory is git-ignored wholesale, so it must not hold
  // anything Tieline commits: the spec, the compiled manifest, or the code
  // topology would silently drop out of commits.
  const manifestSetting = typeof files?.manifest === "string" ? files.manifest : "manifest";
  const committed: Array<{ label: string; setting: string; noun: string; real: string }> = [
    { label: "spec directory", setting: specSetting, noun: "spec", real: realSpec },
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
  if (withinRepository(realSpec, realCaptures)) {
    throw new Error(
      `Invalid screens configuration: the captures directory '${config.captures_directory}' is inside the spec directory '${specSetting}', where every YAML file is read as a contract document; keep screenshots outside it.`
    );
  }
  return {
    catalogDirectory,
    realCatalogDirectory: realCatalog,
    capturesDirectory,
    catalogPath: portable(relative(root, catalogDirectory)),
    capturesPath: portable(relative(root, capturesDirectory)) || ".",
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
        } else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
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
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return "missing";
    return {
      issue: `screen catalog '${settings.catalogPath}' cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** The bounded walk of an existing catalog directory, past any captures in it. */
function walkCatalogDirectory(
  root: string,
  settings: ScreenSettings,
  limits: CatalogWalkLimits
): ReturnType<typeof catalogYamlFiles> {
  const directory = settings.catalogDirectory;
  // The captures directory may sit inside the catalog. Its screenshots are not
  // catalog files, and walking them would spend the walk's bounds on images.
  // The walk never follows links, so a directory it reaches really is the
  // same path below the catalog's real path.
  const realDirectory = realpathSync(directory);
  const realCaptures = realDestination(settings.capturesDirectory);
  const capturesInCatalog =
    realCaptures !== realDirectory && withinRepository(realDirectory, realCaptures)
      ? resolve(directory, relative(realDirectory, realCaptures))
      : undefined;
  return catalogYamlFiles(
    directory,
    limits,
    (absolutePath) => portable(relative(root, absolutePath)),
    capturesInCatalog
  );
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
    : { paths: walk.files };
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
  for (const absolutePath of walk.files) {
    const path = portable(relative(root, absolutePath));
    const remaining = limits.totalBytes - totalBytes;
    let read: BoundedRead;
    try {
      read = readFileWithin(absolutePath, Math.min(limits.fileBytes, remaining));
    } catch (error) {
      issues.push(
        `${path}: screen catalog file cannot be read: ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }
    if (read.status === "not_file" || read.status === "changed") {
      issues.push(`${path}: screen catalog file is no longer a regular file`);
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
    const content = read.bytes.toString("utf8");
    try {
      sources.push({ path, absolutePath, content, document: parse(content) });
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
