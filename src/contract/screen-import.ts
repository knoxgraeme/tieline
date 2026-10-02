import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { Document, isMap, isSeq, parseDocument, type YAMLSeq } from "yaml";
import { z, type ZodIssue } from "zod";
import { isSameFile, isStillFile, readFileWithin, type BoundedRead } from "./bounded-read.js";
import { withinRepository } from "./paths.js";
import { stableKeySchema } from "./schema.js";
import {
  screenEntrySchema,
  screenImagePathSchema,
  screenImageSchema,
  SCREEN_LIMITS,
  listScreenCatalogFiles,
  realDestination,
  validateScreenCatalogDocuments,
  type ScreenCatalogDocument,
  type ScreenCatalogSource,
  type ScreenEntry,
  type ScreenImage,
  type CatalogWalkLimits,
  type ScreenSettings,
} from "./screen-catalog.js";

/**
 * Bounds on an import file. Its contents come from an external capture tool,
 * so the file is size-checked on the open descriptor while it is read, and the
 * entry count is checked before any entry is parsed.
 */
export const SCREEN_IMPORT_LIMITS = {
  fileBytes: 16 * 1024 * 1024,
  entries: SCREEN_LIMITS.screens,
  reportedIssues: 20,
  /** Largest screenshot the importer will read to record its digest. */
  captureBytes: 25 * 1024 * 1024,
  /** Most screenshot bytes one import may read, across distinct files. */
  captureTotalBytes: 4 * 1024 * 1024 * 1024,
} as const;

export class ScreenImportError extends Error {
  readonly issues: string[];

  constructor(summary: string, issues: string[] = []) {
    const shown = issues.slice(0, SCREEN_IMPORT_LIMITS.reportedIssues);
    const hidden = issues.length - shown.length;
    super(
      [
        summary,
        ...shown.map((issue) => `- ${issue}`),
        ...(hidden > 0 ? [`- (and ${hidden} more)`] : []),
      ].join("\n")
    );
    this.name = "ScreenImportError";
    this.issues = issues;
  }
}

/**
 * `readFileWithin`, failing with import errors: a file that cannot be opened,
 * is not a regular file, or is over `maxBytes` stops the import.
 */
function readBoundedFile(
  path: string,
  maxBytes: number,
  label: string,
  options: {
    /** Replaces the default message when the file is over `maxBytes`. */
    tooLargeMessage?: string;
    /** Confirms the opened file is the one the caller validated. */
    verify?: (opened: Stats) => boolean;
  } = {}
): Buffer {
  const name = `${label[0]!.toUpperCase()}${label.slice(1)}`;
  let read: BoundedRead;
  try {
    read = readFileWithin(path, maxBytes, options.verify);
  } catch (error) {
    throw new ScreenImportError(
      `Cannot open ${label} '${path}': ${error instanceof Error ? error.message : String(error)}`
    );
  }
  switch (read.status) {
    case "read":
      return read.bytes;
    case "not_file":
      throw new ScreenImportError(`${name} '${path}' is not a file.`);
    case "too_large":
      throw new ScreenImportError(
        options.tooLargeMessage ?? `${name} '${path}' is larger than the ${maxBytes}-byte limit.`
      );
    case "changed":
      throw new ScreenImportError(`${name} '${path}' changed while it was being read; import again.`);
  }
}

export function readScreenImportFile(
  path: string,
  maxBytes: number = SCREEN_IMPORT_LIMITS.fileBytes
): unknown {
  const bytes = readBoundedFile(path, maxBytes, "screen import file");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ScreenImportError(`Screen import file '${path}' is not valid UTF-8.`);
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    throw new ScreenImportError(
      `Screen import file '${path}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * One import entry: a catalog entry plus the capability it belongs to. Optional
 * fields follow merge semantics on re-import: omitted keeps the catalog's
 * current value, `null` removes it, and a value replaces it. `image` also
 * accepts a bare string as shorthand for `{ "path": ... }`.
 */
const screenImportEntrySchema = screenEntrySchema.extend({
  capability: stableKeySchema,
  group: screenEntrySchema.shape.group.unwrap().nullable().optional(),
  applies_to: screenEntrySchema.shape.applies_to.unwrap().nullable().optional(),
  copy: screenEntrySchema.shape.copy.unwrap().nullable().optional(),
  image: z
    .union([
      screenImagePathSchema.transform((path): ScreenImage => ({ path })),
      screenImageSchema,
    ])
    .nullable()
    .optional(),
});

export type ScreenImportEntry = z.infer<typeof screenImportEntrySchema>;

function describeIssue(index: number, key: unknown, issue: ZodIssue): string {
  const label =
    typeof key === "string" && key.length <= 160 ? ` (${JSON.stringify(key)})` : "";
  const field = issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
  return `screens[${index}]${label}${field}: ${issue.message}`;
}

/**
 * Parses an import document: either a bare array of entries, or
 * `{ "version": 1, "screens": [...] }`. Every entry is validated before
 * anything is planned, and every problem is reported, not only the first.
 */
export function parseScreenImport(value: unknown): ScreenImportEntry[] {
  let entries: unknown[];
  if (Array.isArray(value)) {
    entries = value;
  } else if (value !== null && typeof value === "object") {
    const envelope = value as Record<string, unknown>;
    const unexpected = Object.keys(envelope).filter(
      (key) => key !== "version" && key !== "screens"
    );
    if (envelope.version !== 1 || !Array.isArray(envelope.screens) || unexpected.length > 0) {
      throw new ScreenImportError(
        'A screen import must be a JSON array of screen entries or an object of exactly { "version": 1, "screens": [...] }.'
      );
    }
    entries = envelope.screens;
  } else {
    throw new ScreenImportError(
      "A screen import must be a JSON array of screen entries."
    );
  }
  if (entries.length > SCREEN_IMPORT_LIMITS.entries) {
    throw new ScreenImportError(
      `The screen import holds ${entries.length} entries; the limit is ${SCREEN_IMPORT_LIMITS.entries}.`
    );
  }
  const issues: string[] = [];
  const parsed: ScreenImportEntry[] = [];
  const seen = new Map<string, number>();
  entries.forEach((entry, index) => {
    const key =
      entry !== null && typeof entry === "object"
        ? (entry as Record<string, unknown>).key
        : undefined;
    const result = screenImportEntrySchema.safeParse(entry);
    if (!result.success) {
      issues.push(...result.error.issues.map((issue) => describeIssue(index, key, issue)));
      return;
    }
    const first = seen.get(result.data.key);
    if (first !== undefined) {
      issues.push(
        `screens[${index}] (${JSON.stringify(result.data.key)}): duplicate key; first used by screens[${first}]`
      );
      return;
    }
    seen.set(result.data.key, index);
    parsed.push(result.data);
  });
  if (issues.length > 0) {
    throw new ScreenImportError(
      `The screen import is invalid (${issues.length} issue(s)); nothing was written.`,
      issues
    );
  }
  return parsed;
}

/** A catalog file as the importer found it. */
export interface CurrentScreenCatalogFile {
  source: ScreenCatalogSource;
  document: ScreenCatalogDocument;
}

export interface ScreenImportOptions {
  repositoryRoot: string;
  settings: ScreenSettings;
  /** Capabilities the contract declares. */
  capabilityKeys: ReadonlySet<string>;
  /** Remove catalog entries the input omits, within the input's capabilities. */
  prune: boolean;
  /** Skip entries for undeclared capabilities instead of refusing the import. */
  skipUnknownCapabilities: boolean;
  /**
   * Digests a screenshot by its captures-relative path. Called only for
   * screens the import actually accepts, after merging, so a path kept from
   * the catalog is re-read like a new one.
   */
  digestScreenshot?: CaptureDigester["digest"];
  /**
   * The directory entries the catalog walk read (`ScreenCatalogSources`), of
   * every kind. Each file the import creates adds one.
   */
  catalogEntries: number;
  /**
   * The bounds the loader's catalog walk enforces on entries, files, and
   * bytes, so an import never writes a catalog that every later command
   * refuses. Defaults to the walk's own.
   */
  catalogLimits?: Pick<CatalogWalkLimits, "entries" | "files" | "fileBytes" | "totalBytes">;
}

export type ScreenImportFileStatus = "created" | "updated" | "unchanged";

export interface PlannedScreenCatalogFile {
  /** Repository-relative, `/`-separated. */
  path: string;
  absolutePath: string;
  status: ScreenImportFileStatus;
  content: string;
  /** The file's content before the import, or null when the import creates it. */
  original: string | null;
}

export interface ScreenImportPlan {
  entries: number;
  created: string[];
  updated: string[];
  moved: Array<{ key: string; from: string; to: string }>;
  unchanged: string[];
  pruned: string[];
  skipped_unknown_capability: Array<{ key: string; capability: string }>;
  files: PlannedScreenCatalogFile[];
  /**
   * Where the catalog was read from, and the bounds the plan was validated
   * against, to list it again the same way before writing.
   */
  catalog: {
    repositoryRoot: string;
    settings: ScreenSettings;
    limits: Pick<CatalogWalkLimits, "entries" | "files" | "fileBytes" | "totalBytes">;
  };
}

function portable(path: string): string {
  return path.split(sep).join("/");
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).sort(([left], [right]) =>
            left.localeCompare(right)
          )
        )
      : entry
  );
}

/** Resolves one optional field: omitted keeps, null clears, a value replaces. */
function mergedField<T>(imported: T | null | undefined, current: T | undefined): T | undefined {
  if (imported === null) return undefined;
  return imported === undefined ? current : imported;
}

function sameLocator(left: ScreenImage, right: ScreenImage): boolean {
  return "path" in left
    ? "path" in right && left.path === right.path
    : "url" in right && left.url === right.url;
}

/**
 * Merges the image like any optional field, except that an imported locator
 * without a digest keeps the reviewed digest of the same locator. A missing
 * digest only means this machine could not read the screenshot, which says
 * nothing about whether the picture changed.
 */
function mergedImage(
  imported: ScreenImage | null | undefined,
  current: ScreenImage | undefined
): ScreenImage | undefined {
  const image = mergedField(imported, current);
  if (!image || image.sha256 !== undefined || current?.sha256 === undefined) return image;
  return sameLocator(image, current) ? { ...image, sha256: current.sha256 } : image;
}

/**
 * Re-reads the merged entry's screenshot unless the input supplied its digest,
 * so a re-capture is recorded even when the input repeats or omits the path.
 * When the file is not on disk the merged entry keeps what merging decided.
 */
function withCurrentDigest(
  merged: ScreenEntry,
  imported: ScreenImportEntry,
  digest: CaptureDigester["digest"] | undefined
): ScreenEntry {
  const image = merged.image;
  if (!digest || !image || !("path" in image) || imported.image?.sha256 !== undefined) {
    return merged;
  }
  const sha256 = digest(image.path, merged.key);
  return sha256 === undefined ? merged : { ...merged, image: { path: image.path, sha256 } };
}

/** A catalog entry in the field order the catalog documents use. */
function catalogEntry(imported: ScreenImportEntry, current: ScreenEntry | undefined): ScreenEntry {
  const group = mergedField(imported.group, current?.group);
  const appliesTo = mergedField(imported.applies_to, current?.applies_to);
  const copy = mergedField(imported.copy, current?.copy);
  const image = mergedImage(imported.image, current?.image);
  return {
    key: imported.key,
    title: imported.title,
    ...(group === undefined ? {} : { group }),
    route: imported.route,
    kind: imported.kind,
    when: imported.when,
    ...(appliesTo === undefined ? {} : { applies_to: appliesTo }),
    ...(copy === undefined || copy.length === 0 ? {} : { copy }),
    ...(image === undefined ? {} : { image }),
  };
}

interface EditableCatalog {
  capability: string;
  path: string;
  absolutePath: string;
  document: Document;
  sequence: YAMLSeq;
  original: string | null;
  entries: Map<string, ScreenEntry>;
}

/**
 * The position of a screen in its file. Keys are compared trimmed, the way the
 * catalog schema reads them; a key the YAML does not hold is a contradiction
 * between the parsed catalog and its source and stops the import rather than
 * editing the wrong entry.
 */
function entryIndex(catalog: EditableCatalog, key: string): number {
  const index = catalog.sequence.items.findIndex((item) => {
    if (!isMap(item)) return false;
    const value: unknown = item.get("key");
    return typeof value === "string" && value.trim() === key;
  });
  if (index < 0) {
    throw new ScreenImportError(
      `Screen '${key}' could not be located in '${catalog.path}'; nothing was written.`
    );
  }
  return index;
}

/**
 * Works out every change an import makes without touching the disk. The result
 * is validated as a whole catalog before it is returned, so `applyScreenImport`
 * only ever writes a catalog that would load.
 */
export function planScreenImport(
  imported: ScreenImportEntry[],
  current: CurrentScreenCatalogFile[],
  options: ScreenImportOptions
): ScreenImportPlan {
  const root = resolve(options.repositoryRoot);
  const unknown = imported.filter(
    (entry) => !options.capabilityKeys.has(entry.capability)
  );
  if (unknown.length > 0 && !options.skipUnknownCapabilities) {
    const capabilities = [...new Set(unknown.map((entry) => entry.capability))].sort();
    throw new ScreenImportError(
      `${unknown.length} screen(s) name capabilities the contract does not declare; nothing was written. Add the capabilities to the spec first, or pass --skip-unknown-capabilities to import the rest.`,
      capabilities.map(
        (capability) =>
          `unknown capability '${capability}': ${unknown
            .filter((entry) => entry.capability === capability)
            .map((entry) => entry.key)
            .slice(0, 5)
            .join(", ")}${
            unknown.filter((entry) => entry.capability === capability).length > 5 ? ", …" : ""
          }`
      )
    );
  }
  const accepted = imported.filter((entry) =>
    options.capabilityKeys.has(entry.capability)
  );

  const catalogs = new Map<string, EditableCatalog>();
  const location = new Map<string, string>();
  for (const { source, document } of current) {
    const parsed = parseDocument(source.content);
    const sequence = parsed.get("screens", true);
    if (!isSeq(sequence)) {
      throw new ScreenImportError(
        `Screen catalog '${source.path}' has no 'screens' list to update.`
      );
    }
    catalogs.set(document.capability, {
      capability: document.capability,
      path: source.path,
      absolutePath: source.absolutePath,
      document: parsed,
      sequence,
      original: source.content,
      entries: new Map(document.screens.map((entry) => [entry.key, entry])),
    });
    for (const entry of document.screens) location.set(entry.key, document.capability);
  }

  const catalogFor = (capability: string): EditableCatalog => {
    const existing = catalogs.get(capability);
    if (existing) return existing;
    const absolutePath = resolve(options.settings.catalogDirectory, `${capability}.yaml`);
    if (!withinRepository(options.settings.catalogDirectory, absolutePath)) {
      throw new ScreenImportError(
        `Capability '${capability}' cannot name a catalog file inside '${options.settings.catalogPath}'.`
      );
    }
    let present: boolean;
    try {
      // The path itself, link or not: anything there is in the way.
      lstatSync(absolutePath);
      present = true;
    } catch (error) {
      if (!isMissing(error)) {
        throw new ScreenImportError(
          `Cannot create the screen catalog for '${capability}': '${portable(relative(root, absolutePath))}' cannot be checked (${message(error)}).`
        );
      }
      present = false;
    }
    if (present) {
      throw new ScreenImportError(
        `Cannot create the screen catalog for '${capability}': '${portable(relative(root, absolutePath))}' already exists and is not that capability's catalog.`
      );
    }
    const document = new Document({ version: 1, capability, screens: [] });
    const sequence = document.get("screens", true);
    if (!isSeq(sequence)) {
      throw new ScreenImportError(`Could not build a screen catalog for '${capability}'.`);
    }
    const created: EditableCatalog = {
      capability,
      path: portable(relative(root, absolutePath)),
      absolutePath,
      document,
      sequence,
      original: null,
      entries: new Map(),
    };
    catalogs.set(capability, created);
    return created;
  };

  const plan: ScreenImportPlan = {
    entries: imported.length,
    created: [],
    updated: [],
    moved: [],
    unchanged: [],
    pruned: [],
    skipped_unknown_capability: unknown.map((entry) => ({
      key: entry.key,
      capability: entry.capability,
    })),
    files: [],
    catalog: {
      repositoryRoot: root,
      settings: options.settings,
      limits: options.catalogLimits ?? {
        entries: SCREEN_LIMITS.catalogEntries,
        files: SCREEN_LIMITS.catalogFiles,
        fileBytes: SCREEN_LIMITS.catalogFileBytes,
        totalBytes: SCREEN_LIMITS.catalogTotalBytes,
      },
    },
  };
  const touched = new Set<string>();

  for (const entry of accepted) {
    const previousCapability = location.get(entry.key);
    const previous = previousCapability
      ? catalogs.get(previousCapability)?.entries.get(entry.key)
      : undefined;
    const merged = withCurrentDigest(
      catalogEntry(entry, previous),
      entry,
      options.digestScreenshot
    );
    const target = catalogFor(entry.capability);
    if (previousCapability !== undefined && previousCapability !== entry.capability) {
      const source = catalogs.get(previousCapability)!;
      source.sequence.items.splice(entryIndex(source, entry.key), 1);
      source.entries.delete(entry.key);
      touched.add(source.capability);
      plan.moved.push({ key: entry.key, from: previousCapability, to: entry.capability });
    }
    if (previous !== undefined && previousCapability === entry.capability) {
      if (stableJson(previous) === stableJson(merged)) {
        plan.unchanged.push(entry.key);
        continue;
      }
      target.sequence.items[entryIndex(target, entry.key)] = target.document.createNode(merged);
      plan.updated.push(entry.key);
    } else {
      target.sequence.items.push(target.document.createNode(merged));
      if (previous === undefined) plan.created.push(entry.key);
    }
    target.entries.set(entry.key, merged);
    location.set(entry.key, entry.capability);
    touched.add(entry.capability);
  }

  if (options.prune) {
    const kept = new Set(accepted.map((entry) => entry.key));
    for (const capability of new Set(accepted.map((entry) => entry.capability))) {
      const catalog = catalogs.get(capability)!;
      for (const key of [...catalog.entries.keys()]) {
        if (kept.has(key)) continue;
        catalog.sequence.items.splice(entryIndex(catalog, key), 1);
        catalog.entries.delete(key);
        plan.pruned.push(key);
        touched.add(capability);
      }
    }
  }

  const issues: string[] = [];
  const outputs = [...catalogs.values()].map((catalog) => {
    const content = touched.has(catalog.capability)
      ? catalog.document.toString()
      : (catalog.original ?? catalog.document.toString());
    return { catalog, content };
  });
  // The loader refuses oversized files, and a catalog with too many files or
  // bytes overall, before parsing anything, so an import must not write one:
  // it would succeed here and fail every later command. The outputs are every
  // catalog file there will be, since the existing catalog validated whole.
  const limits = plan.catalog.limits;
  let totalBytes = 0;
  for (const { catalog, content } of outputs) {
    const bytes = Buffer.byteLength(content);
    totalBytes += bytes;
    if (bytes > limits.fileBytes) {
      issues.push(
        `${catalog.path}: the catalog would be ${bytes} bytes; the limit is ${limits.fileBytes}`
      );
    }
  }
  if (outputs.length > limits.files) {
    issues.push(
      `the catalog would hold ${outputs.length} files; the limit is ${limits.files}`
    );
  }
  if (totalBytes > limits.totalBytes) {
    issues.push(
      `the catalog would hold ${totalBytes} bytes; the limit is ${limits.totalBytes}`
    );
  }
  // Every new catalog file is written at the top of the catalog directory.
  const entries =
    options.catalogEntries + outputs.filter(({ catalog }) => catalog.original === null).length;
  if (entries > limits.entries) {
    issues.push(
      `the catalog directory would hold ${entries} entries; the limit is ${limits.entries}`
    );
  }
  validateScreenCatalogDocuments(
    outputs.map(({ catalog, content }) => ({
      path: catalog.path,
      document: parseDocument(content).toJS(),
    })),
    options.capabilityKeys,
    issues
  );
  if (issues.length > 0) {
    throw new ScreenImportError(
      "The imported catalog would not validate; nothing was written.",
      issues
    );
  }
  plan.files = outputs
    .map(({ catalog, content }) => ({
      path: catalog.path,
      absolutePath: catalog.absolutePath,
      status:
        catalog.original === null
          ? ("created" as const)
          : content === catalog.original
            ? ("unchanged" as const)
            : ("updated" as const),
      content,
      original: catalog.original,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return plan;
}

/**
 * The writes `applyScreenImport` performs, injectable for tests. Its checks
 * that a catalog file is still as expected read the real file system.
 */
export interface ScreenImportFileSystem {
  mkdirSync(path: string, options: { recursive: true }): void;
  /**
   * Creates a new file, failing with `EEXIST` when anything — including a
   * symbolic link, even a dangling one — is already at the path, so a scratch
   * write can never land wherever a planted link leads.
   */
  createFileSync(path: string, content: string): void;
  renameSync(from: string, to: string): void;
  rmSync(path: string, options: { force: true }): void;
}

export const NODE_FILE_SYSTEM: ScreenImportFileSystem = {
  mkdirSync: (path, options) => {
    mkdirSync(path, options);
  },
  createFileSync: (path, content) => writeFileSync(path, content, { flag: "wx" }),
  renameSync: (from, to) => renameSync(from, to),
  rmSync: (path, options) => rmSync(path, options),
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function capturesMoved(settings: ScreenSettings, now: string): ScreenImportError {
  return new ScreenImportError(
    `The captures directory '${settings.capturesPath}' now resolves to '${now}', not to '${settings.realCapturesDirectory}' where it was validated; nothing was written. Import again.`
  );
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** The real path of `path`, or null when nothing is there; other failures throw. */
function realPathIfPresent(path: string): string | null {
  try {
    return realpathSync(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function alreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "EEXIST";
}

/**
 * How the file at `path` no longer holds `expected` (null: no file), or null
 * when it still does. Nothing past `expected`'s length is read.
 */
function changedFrom(path: string, expected: string | null): string | null {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
      return `could not be checked (${message(error)})`;
    }
    return expected === null ? null : "was removed";
  }
  if (expected === null) return "was created";
  if (!stat.isFile()) return "is no longer a regular file";
  const bytes = Buffer.byteLength(expected);
  if (stat.size !== bytes) return "was edited";
  try {
    return readBoundedFile(path, bytes, "screen catalog file").toString("utf8") === expected
      ? null
      : "was edited";
  } catch (error) {
    return `could not be checked (${message(error)})`;
  }
}

/**
 * Writes the files a plan changes as one unit. Every new file is staged
 * beside its target first, so a failure while staging writes nothing. Each
 * staged file then replaces its target by rename; if a rename fails, the files
 * already replaced are restored to their previous content (or removed, if the
 * import created them), so the catalog is never left half-applied — a screen
 * moved between files is never duplicated or lost. If restoring itself fails,
 * the error names every file that still needs restoring from git. Staging and
 * restore files are created exclusively: anything already at one of their
 * paths, such as a planted symbolic link, stops the write and is left alone.
 *
 * A plan is only as current as the files it read. Once everything is staged,
 * every catalog file the plan read, changed or not, must still hold what it
 * read, or nothing is written: an edit or a concurrent import made meanwhile
 * is never silently overwritten or merged into a catalog that no longer
 * validates.
 * Likewise, a rollback only restores a file that still holds what this import
 * wrote. The check and the replacements are not atomic together, so a write
 * landing in between can still be lost; the window is kept as short as this
 * process can make it.
 */
export function applyScreenImport(
  plan: ScreenImportPlan,
  fileSystem: ScreenImportFileSystem = NODE_FILE_SYSTEM
): void {
  const changed = plan.files.filter((file) => file.status !== "unchanged");
  const staged: Array<{ file: PlannedScreenCatalogFile; temporary: string }> = [];
  // Cleanup never throws: a temporary file that cannot be removed is reported,
  // and never stops the restoration that matters more.
  const discardStaged = (from: number): string[] => {
    const leftovers: string[] = [];
    for (const { temporary } of staged.slice(from)) {
      try {
        fileSystem.rmSync(temporary, { force: true });
      } catch (error) {
        leftovers.push(`${temporary} (${message(error)})`);
      }
    }
    return leftovers;
  };
  try {
    for (const file of changed) {
      fileSystem.mkdirSync(dirname(file.absolutePath), { recursive: true });
      const temporary = `${file.absolutePath}.${process.pid}.tmp`;
      try {
        fileSystem.createFileSync(temporary, file.content);
      } catch (error) {
        // A file this import created but could not fill is its own to remove;
        // whatever was already at the path is not.
        if (!alreadyExists(error)) staged.push({ file, temporary });
        throw error;
      }
      staged.push({ file, temporary });
    }
  } catch (error) {
    const leftovers = discardStaged(0);
    throw new ScreenImportError(
      `Could not stage the screen catalog files (${message(error)}); nothing was written${
        leftovers.length > 0 ? ", but some staged files could not be removed" : ""
      }.`,
      leftovers.map((leftover) => `staged file left behind: ${leftover}`)
    );
  }

  // Every planned file, not only the changed ones: an edit to a file this
  // import leaves alone can still break the catalog as a whole, for example
  // by adding a key the import is adding elsewhere.
  const stale = plan.files.flatMap((file) => {
    const change = changedFrom(file.absolutePath, file.original);
    return change === null ? [] : [`${file.path} ${change} after the import read it`];
  });
  // A catalog file created meanwhile is in no plan, so the catalog is listed
  // again: a new file could add a key the import adds, or cross a bound. The
  // staged files are in the directory now. One that will replace an existing
  // file disappears on rename, so the entry bound allows for it; one that
  // creates a catalog stays as a new entry, so it counts like any other.
  const known = new Set(plan.files.map((file) => file.absolutePath));
  const replacing = staged.filter(({ file }) => file.original !== null).length;
  const listing = listScreenCatalogFiles(plan.catalog.repositoryRoot, plan.catalog.settings, {
    ...plan.catalog.limits,
    entries: plan.catalog.limits.entries + replacing,
  });
  if (listing.issue !== undefined) {
    stale.push(`the catalog could not be listed again: ${listing.issue}`);
  }
  for (const path of listing.paths) {
    if (!known.has(path)) {
      const shown = relative(resolve(plan.catalog.repositoryRoot), path).split(sep).join("/");
      stale.push(`${shown} was created after the import read it`);
    }
  }
  // The catalog directory was validated by where it really resolves. A
  // directory swapped for a link since then would send every write, staged
  // or final, wherever it leads, so each target's directory must still
  // resolve inside the validated one. (Node cannot rename relative to an open
  // directory, so this is checked here, as close to the writes as it can be.)
  const validated = plan.catalog.settings.realCatalogDirectory;
  for (const { file } of staged) {
    let directory: string | null;
    try {
      directory = realPathIfPresent(dirname(file.absolutePath));
    } catch (error) {
      stale.push(`${file.path} could not be checked (${message(error)})`);
      continue;
    }
    if (directory === null || !withinRepository(validated, directory)) {
      stale.push(`${file.path} now resolves outside the screen catalog directory`);
    }
  }
  // The staged copies sit at predictable paths, and the import lock does not
  // keep other processes out, so each must still be a regular file holding
  // exactly what this import staged before it is installed.
  for (const { file, temporary } of staged) {
    const change = changedFrom(temporary, file.content);
    if (change !== null) stale.push(`${file.path}: its staged copy ${change} before it was installed`);
  }
  if (stale.length > 0) {
    const leftovers = discardStaged(0);
    throw new ScreenImportError(
      "The screen catalog changed after the import read it, so nothing was written. Run the import again.",
      [...stale, ...leftovers.map((leftover) => `staged file left behind: ${leftover}`)]
    );
  }

  const replaced: PlannedScreenCatalogFile[] = [];
  for (const [index, { file, temporary }] of staged.entries()) {
    try {
      fileSystem.renameSync(temporary, file.absolutePath);
      replaced.push(file);
      // Renamed by path, so what landed is checked against the plan: a staged
      // copy changed between the check above and the rename is caught here.
      // Whether that content came through the rename or from a writer just
      // after it cannot be told apart, so the rollback below leaves it in
      // place and names it, as it does any file changed since it was written.
      const installed = changedFrom(file.absolutePath, file.content);
      if (installed !== null) {
        throw new Error(`the installed file ${installed} on its way in`);
      }
    } catch (error) {
      // Restore first, then clean up, so a cleanup failure cannot prevent it.
      const unrestored: string[] = [];
      for (const done of replaced.reverse()) {
        // Another writer's change since this import replaced the file is
        // theirs to keep; restoring the stale original would discard it.
        const change = changedFrom(done.absolutePath, done.content);
        if (change !== null) {
          unrestored.push(`${done.path} (${change} after this import wrote it; left as it is)`);
          continue;
        }
        try {
          if (done.original === null) {
            fileSystem.rmSync(done.absolutePath, { force: true });
          } else {
            const restore = `${done.absolutePath}.${process.pid}.restore`;
            try {
              fileSystem.createFileSync(restore, done.original);
            } catch (createError) {
              // A copy this rollback created but could not fill is its own to
              // remove, as with staged files; one already there is not.
              if (!alreadyExists(createError)) {
                try {
                  fileSystem.rmSync(restore, { force: true });
                } catch (cleanupError) {
                  unrestored.push(`${restore} (restore copy left behind: ${message(cleanupError)})`);
                }
              }
              throw createError;
            }
            try {
              fileSystem.renameSync(restore, done.absolutePath);
            } catch (renameError) {
              // The restore copy is this rollback's own: it must not stay as
              // a stray entry in the catalog directory. One that no longer
              // holds what was written there is not ours to remove.
              const change = changedFrom(restore, done.original);
              if (change !== null) {
                unrestored.push(`${restore} (restore copy ${change}; left as it is)`);
              } else {
                try {
                  fileSystem.rmSync(restore, { force: true });
                } catch (cleanupError) {
                  unrestored.push(`${restore} (restore copy left behind: ${message(cleanupError)})`);
                }
              }
              throw renameError;
            }
          }
        } catch (restoreError) {
          unrestored.push(`${done.path} (${message(restoreError)})`);
        }
      }
      const leftovers = discardStaged(index);
      throw new ScreenImportError(
        unrestored.length === 0
          ? `Writing '${file.path}' failed (${message(error)}); the ${replaced.length} file(s) already written were restored, so the catalog is unchanged.`
          : `Writing '${file.path}' failed (${message(error)}), and restoring the files already written also failed. Restore them from git before importing again.`,
        [
          ...unrestored,
          ...leftovers.map((leftover) => `staged file left behind: ${leftover}`),
        ]
      );
    }
  }
}

export interface CaptureDigester {
  /** The screenshot's digest, or undefined when it is not on disk. */
  digest(path: string, key: string): string | undefined;
  /** Screens whose screenshot was digested. */
  readonly computed: number;
  /** Screens whose screenshot is not in the captures directory. */
  readonly missing: readonly string[];
  /** Bytes read so far, across distinct files. */
  readonly bytesRead: number;
}

/**
 * Digests screenshots from the captures directory for one import. Each
 * distinct file is read once, however many entries name it; each is bounded
 * by `fileBytes`, and all of them together by `totalBytes`, so an untrusted
 * import cannot make the command read an unbounded amount of data. A path that
 * resolves outside the captures directory — through a symbolic link, say — is
 * refused rather than read. A missing file is reported, not fatal: screenshots
 * are git-ignored and often absent on the machine that imports.
 */
export function createCaptureDigester(
  settings: ScreenSettings,
  limits: { fileBytes: number; totalBytes: number } = {
    fileBytes: SCREEN_IMPORT_LIMITS.captureBytes,
    totalBytes: SCREEN_IMPORT_LIMITS.captureTotalBytes,
  }
): CaptureDigester {
  // Resolved on first use, so an import that names no screenshots never
  // touches the captures directory. Only a missing path means "no capture";
  // any other failure to resolve one is an error, never a silent "missing",
  // which would keep a stale reviewed digest unremarked.
  let realCaptures: string | null | undefined;
  const capturesRoot = (): string | null => {
    if (realCaptures === undefined) {
      try {
        realCaptures = realPathIfPresent(settings.capturesDirectory);
      } catch (error) {
        throw new ScreenImportError(
          `The captures directory '${settings.capturesPath}' cannot be read: ${message(error)}`
        );
      }
      // Containment is judged against the directory the settings validated.
      if (realCaptures !== null && realCaptures !== settings.realCapturesDirectory) {
        throw capturesMoved(settings, realCaptures);
      }
    }
    return realCaptures;
  };
  const digests = new Map<string, string>();
  const missing: string[] = [];
  let computed = 0;
  let bytesRead = 0;
  return {
    digest(path, key) {
      const target = resolve(settings.capturesDirectory, path);
      const root = capturesRoot();
      let real: string | null = null;
      if (root !== null) {
        try {
          real = realPathIfPresent(target);
        } catch (error) {
          throw new ScreenImportError(
            `Screenshot '${path}' for screen '${key}' cannot be read: ${message(error)}`
          );
        }
      }
      if (root === null || real === null) {
        missing.push(key);
        return undefined;
      }
      if (!withinRepository(root, real)) {
        throw new ScreenImportError(
          `Screenshot '${path}' for screen '${key}' resolves outside the captures directory '${settings.capturesPath}'.`
        );
      }
      let sha256 = digests.get(real);
      if (sha256 === undefined) {
        // The read itself is bounded by what is left of the total, so a file
        // that would cross it is refused from its size, not read first.
        const remaining = limits.totalBytes - bytesRead;
        // The validated real path is what is read, and the opened file must
        // still be it, so a link swapped in after the containment check
        // cannot redirect the read outside the captures directory.
        const bytes = readBoundedFile(real, Math.min(limits.fileBytes, remaining), "screenshot", {
          ...(remaining < limits.fileBytes
            ? {
                tooLargeMessage: `The screenshots this import references exceed the ${limits.totalBytes}-byte total it may read; import in smaller batches.`,
              }
            : {}),
          verify: (opened) => isStillFile(real, opened),
        });
        bytesRead += bytes.length;
        sha256 = createHash("sha256").update(bytes).digest("hex");
        digests.set(real, sha256);
      }
      computed += 1;
      return sha256;
    },
    get computed() {
      return computed;
    },
    get missing() {
      return missing;
    },
    get bytesRead() {
      return bytesRead;
    },
  };
}

/** The lock an import holds, in the Tieline workspace directory. */
export const SCREEN_IMPORT_LOCK = "screens-import.lock";

/**
 * Runs `work` holding the screen import lock: a file created exclusively in
 * the Tieline workspace and removed afterwards. The stale-plan check in
 * `applyScreenImport` sees only the files one import changes, so two imports
 * writing different files could still break the catalog as a whole — the same
 * key created in two capability files. Holding the lock from reading the
 * catalog to replacing it runs imports one at a time. A second import fails at
 * once rather than waiting, and a lock left by an interrupted import is never
 * taken over automatically: the file names its process and start time, for a
 * person to judge before deleting it.
 */
export function withScreenImportLock<T>(
  repositoryRoot: string,
  settings: ScreenSettings,
  work: () => T,
  workspaceDirectory = resolve(repositoryRoot, ".tieline")
): T {
  // Created in the workspace where the settings validated it, through the
  // same anchored creation as the captures .gitignore, so a workspace swapped
  // for a link since cannot receive it.
  const lockPath = resolve(settings.realWorkspaceDirectory, SCREEN_IMPORT_LOCK);
  const shown = relative(resolve(repositoryRoot), resolve(workspaceDirectory, SCREEN_IMPORT_LOCK))
    .split(sep)
    .join("/");
  const lock = createInValidatedDirectory(
    settings.realWorkspaceDirectory,
    SCREEN_IMPORT_LOCK,
    `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`
  );
  if (lock.status === "exists") {
    throw new ScreenImportError(
      `Another screen import is in progress: '${shown}' exists. If no import is running (one may have been interrupted), delete that file and import again.`
    );
  }
  // Only the lock this import created is removed, wherever the path leads now.
  const release = (): string | null => {
    try {
      removeIfSameFile(lockPath, lock.file);
      return null;
    } catch (error) {
      return message(error);
    }
  };
  let result: T;
  try {
    result = work();
  } catch (error) {
    // The import's own failure is the one to report; a lock that also could
    // not be removed is added to it, since it blocks the next import.
    const failure = release();
    if (failure === null) throw error;
    const combined = new ScreenImportError(message(error), [
      `the import lock '${shown}' could not be removed (${failure}); delete it before importing again`,
    ]);
    combined.cause = error;
    throw combined;
  }
  const failure = release();
  if (failure !== null) {
    throw new ScreenImportError(
      `The import was written, but its lock '${shown}' could not be removed (${failure}). Delete it before importing again.`
    );
  }
  return result;
}

/**
 * `exists`: the captures `.gitignore` already ignores everything in it.
 * `unverified`: something is at that path, but Tieline cannot confirm it
 * ignores everything — a file with other rules, or not a regular file — and
 * leaves it for the repository rather than editing it.
 * `not_managed`: the captures directory is outside `.tieline/`.
 */
export type CapturesIgnoreStatus = "created" | "exists" | "unverified" | "not_managed";

const CAPTURES_GITIGNORE =
  "# Screenshots referenced by the Tieline screen catalog are not committed.\n*\n!.gitignore\n";
const CAPTURES_GITIGNORE_MAX_BYTES = 64 * 1024;
const MATCH_ALL_PATTERNS = new Set(["*", "/*", "**", "/**"]);
const SELF_INCLUDE_PATTERNS = new Set(["!.gitignore", "!/.gitignore"]);

/**
 * True when a `.gitignore` ignores every path below its directory: it has a
 * match-all rule and re-includes nothing but itself. Any other negation could
 * let screenshots be committed, so it is not treated as ignoring everything;
 * other positive rules only ignore more and do not matter.
 */
export function gitignoreIgnoresEverything(content: string): boolean {
  let matchAll = false;
  for (const raw of content.split("\n")) {
    const line = raw.trimEnd();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.startsWith("!")) {
      if (!SELF_INCLUDE_PATTERNS.has(line)) return false;
    } else if (MATCH_ALL_PATTERNS.has(line)) {
      matchAll = true;
    }
  }
  return matchAll;
}

/**
 * Screenshots are never committed by default. When the captures directory is
 * inside `.tieline/` (the default), it gets a `.gitignore` that ignores
 * everything in it. A directory configured elsewhere is the repository's to
 * manage: writing `*` into, say, a source directory would hide real files.
 * An existing `.gitignore` is never edited, only checked.
 */
export function ensureCapturesIgnored(
  repositoryRoot: string,
  settings: ScreenSettings,
  workspaceDirectory = resolve(repositoryRoot, ".tieline")
): CapturesIgnoreStatus {
  return prepareCapturesIgnore(repositoryRoot, settings, workspaceDirectory).status;
}

/**
 * `ensureCapturesIgnored`, also able to undo what it created — the ignore
 * file and any directories made for it — when the import it prepares for is
 * refused, so a refused import leaves nothing behind.
 */
export function prepareCapturesIgnore(
  repositoryRoot: string,
  settings: ScreenSettings,
  workspaceDirectory = resolve(repositoryRoot, ".tieline"),
  /** Writes the ignore file's content; injectable so tests can make it fail. */
  write?: (descriptor: number, content: string) => void
): { status: CapturesIgnoreStatus; undo: () => string[] } {
  const nothing = (status: CapturesIgnoreStatus) => ({ status, undo: (): string[] => [] });
  // Judged, and written, where the directory really resolves: a captures path
  // under `.tieline/` that links to, say, `src/` must not get a match-all
  // ignore file that would hide new source files from Git. And only where it
  // resolved when the settings validated it: a link swapped in since, even to
  // another directory inside `.tieline/` such as the spec, is refused.
  const directory = realDestination(settings.capturesDirectory);
  if (directory !== settings.realCapturesDirectory) {
    throw capturesMoved(settings, directory);
  }
  const workspace = realDestination(workspaceDirectory);
  if (directory === workspace || !withinRepository(workspace, directory)) {
    return nothing("not_managed");
  }
  const ignorePath = resolve(directory, ".gitignore");
  // Inspect the path itself, not what it points at: a symbolic link here, even
  // a dangling one, would make a write land wherever it leads.
  let existing: ReturnType<typeof lstatSync> | undefined;
  try {
    existing = lstatSync(ignorePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error;
    existing = undefined;
  }
  if (existing) {
    if (!existing.isFile()) return nothing("unverified");
    let content: Buffer;
    try {
      content = readBoundedFile(ignorePath, CAPTURES_GITIGNORE_MAX_BYTES, "captures .gitignore");
    } catch (error) {
      // Unreadable or oversized: reported as unverified rather than trusted.
      if (error instanceof ScreenImportError) return nothing("unverified");
      throw error;
    }
    return nothing(gitignoreIgnoresEverything(content.toString("utf8")) ? "exists" : "unverified");
  }
  const firstMade = mkdirSync(directory, { recursive: true });
  let created: ReturnType<typeof createInValidatedDirectory>;
  try {
    created = createInValidatedDirectory(directory, ".gitignore", CAPTURES_GITIGNORE, write);
  } catch (error) {
    // The directories just made for the file go with it, or a captures
    // directory inside the catalog could keep the catalog over its bound.
    const leftovers = removeMadeDirectories(directory, firstMade);
    if (leftovers.length === 0) throw error;
    const combined = new ScreenImportError(
      message(error),
      leftovers.map((leftover) => `left behind by the captures ignore step: ${leftover}`)
    );
    combined.cause = error;
    throw combined;
  }
  if (created.status === "exists") return nothing("unverified");
  const file = created.file;
  return {
    status: "created",
    undo: () => {
      const leftovers: string[] = [];
      try {
        removeIfSameFile(ignorePath, file);
      } catch (error) {
        leftovers.push(`${ignorePath} (${message(error)})`);
      }
      leftovers.push(...removeMadeDirectories(directory, firstMade));
      return leftovers;
    },
  };
}

/**
 * Removes the directories `mkdirSync(directory, { recursive: true })` made,
 * deepest first up to `firstMade`; one that is no longer empty is someone
 * else's now and stays, named in what is returned.
 */
function removeMadeDirectories(directory: string, firstMade: string | undefined): string[] {
  if (firstMade === undefined) return [];
  for (let current = directory; ; current = dirname(current)) {
    try {
      rmdirSync(current);
    } catch (error) {
      return [`${current} (${message(error)})`];
    }
    if (current === resolve(firstMade)) return [];
  }
}

/**
 * Writes a planned import: the captures ignore file first, so that if it
 * cannot be made nothing has been written, then the catalog. If the catalog
 * is refused, what the ignore step created is undone too — notably a new
 * captures directory inside the catalog, which would count against the
 * catalog's entry bound and leave it unreadable.
 */
export function writeScreenImport(
  repositoryRoot: string,
  settings: ScreenSettings,
  plan: ScreenImportPlan,
  fileSystem: ScreenImportFileSystem = NODE_FILE_SYSTEM
): CapturesIgnoreStatus {
  const ignore = prepareCapturesIgnore(repositoryRoot, settings);
  try {
    applyScreenImport(plan, fileSystem);
  } catch (error) {
    const leftovers = ignore.undo();
    if (leftovers.length === 0) throw error;
    const combined = new ScreenImportError(
      message(error),
      leftovers.map((leftover) => `left behind by the captures ignore step: ${leftover}`)
    );
    combined.cause = error;
    throw combined;
  }
  return ignore.status;
}

/**
 * Creates `name` in `directory`, a validated real path, so that its content
 * can only ever land there. The file is created exclusively (never through a
 * link at its own path) and empty; only once it is confirmed to sit in
 * `directory` is the content written, through the same descriptor, which no
 * later swap of a parent directory can redirect. If a parent was swapped
 * before the file was created, the empty file is removed from wherever it
 * landed and the creation is refused. `exists`: something is already there.
 */
export function createInValidatedDirectory(
  directory: string,
  name: string,
  content: string,
  /** Writes the content; injectable so tests can make it fail. */
  write: (descriptor: number, content: string) => void = (descriptor, text) =>
    writeFileSync(descriptor, text)
): { status: "created"; file: Stats } | { status: "exists" } {
  const path = resolve(directory, name);
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx");
  } catch (error) {
    if (alreadyExists(error)) return { status: "exists" };
    throw error;
  }
  let created: Stats;
  try {
    created = fstatSync(descriptor);
    let landed: boolean;
    try {
      landed = realPathIfPresent(dirname(path)) === directory && isSameFile(statSync(path), created);
    } catch {
      landed = false;
    }
    if (!landed) {
      removeIfSameFile(path, created);
      throw new ScreenImportError(
        `'${directory}' changed while '${name}' was being created in it, so nothing was written there. Import again.`
      );
    }
    try {
      write(descriptor, content);
    } catch (error) {
      // An empty or partial file must not stay: a stale lock would block every
      // later import, and a partial ignore file would never be repaired.
      try {
        removeIfSameFile(path, created);
      } catch (cleanupError) {
        throw new ScreenImportError(
          `Writing '${name}' in '${directory}' failed (${message(error)}), and the partial file could not be removed (${message(cleanupError)}); delete it.`
        );
      }
      throw error;
    }
  } finally {
    closeSync(descriptor);
  }
  return { status: "created", file: created };
}

/** Removes `path` only if it is still the file this process created. */
function removeIfSameFile(path: string, created: Stats): void {
  const current = lstatSync(path, { throwIfNoEntry: false });
  if (current && isSameFile(current, created)) rmSync(path, { force: true });
}
