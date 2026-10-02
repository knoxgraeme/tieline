import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { Document, isMap, isSeq, parseDocument, type YAMLSeq } from "yaml";
import { z, type ZodIssue } from "zod";
import { withinRepository } from "./paths.js";
import { stableKeySchema } from "./schema.js";
import {
  screenEntrySchema,
  screenImagePathSchema,
  screenImageSchema,
  SCREEN_LIMITS,
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
 * Reads a regular file of at most `maxBytes` bytes. The limit is enforced on
 * the bytes actually read, not only on the size reported before reading, so a
 * file that grows while it is read cannot exceed it.
 */
function readBoundedFile(path: string, maxBytes: number, label: string): Buffer {
  let descriptor: number;
  try {
    descriptor = openSync(path, "r");
  } catch (error) {
    throw new ScreenImportError(
      `Cannot open ${label} '${path}': ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const chunks: Buffer[] = [];
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new ScreenImportError(`${label[0]!.toUpperCase()}${label.slice(1)} '${path}' is not a file.`);
    }
    const tooLarge = (): ScreenImportError =>
      new ScreenImportError(`${label[0]!.toUpperCase()}${label.slice(1)} '${path}' is larger than the ${maxBytes}-byte limit.`);
    if (stat.size > maxBytes) throw tooLarge();
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    for (;;) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      total += read;
      if (total > maxBytes) throw tooLarge();
      chunks.push(Buffer.from(buffer.subarray(0, read)));
    }
  } finally {
    closeSync(descriptor);
  }
  return Buffer.concat(chunks);
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
    if (existsSync(absolutePath)) {
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
  const limits = options.catalogLimits ?? {
    entries: SCREEN_LIMITS.catalogEntries,
    files: SCREEN_LIMITS.catalogFiles,
    fileBytes: SCREEN_LIMITS.catalogFileBytes,
    totalBytes: SCREEN_LIMITS.catalogTotalBytes,
  };
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
            fileSystem.createFileSync(restore, done.original);
            fileSystem.renameSync(restore, done.absolutePath);
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
  const realCaptures = existsSync(settings.capturesDirectory)
    ? realpathSync(settings.capturesDirectory)
    : null;
  const digests = new Map<string, string>();
  const missing: string[] = [];
  let computed = 0;
  let bytesRead = 0;
  return {
    digest(path, key) {
      const target = resolve(settings.capturesDirectory, path);
      if (!realCaptures || !existsSync(target)) {
        missing.push(key);
        return undefined;
      }
      const real = realpathSync(target);
      if (!withinRepository(realCaptures, real)) {
        throw new ScreenImportError(
          `Screenshot '${path}' for screen '${key}' resolves outside the captures directory '${settings.capturesPath}'.`
        );
      }
      let sha256 = digests.get(real);
      if (sha256 === undefined) {
        const bytes = readBoundedFile(target, limits.fileBytes, "screenshot");
        if (bytesRead + bytes.length > limits.totalBytes) {
          throw new ScreenImportError(
            `The screenshots this import references exceed the ${limits.totalBytes}-byte total it may read; import in smaller batches.`
          );
        }
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
  work: () => T,
  workspaceDirectory = resolve(repositoryRoot, ".tieline")
): T {
  const lockPath = resolve(workspaceDirectory, SCREEN_IMPORT_LOCK);
  const shown = relative(resolve(repositoryRoot), lockPath).split(sep).join("/");
  try {
    // Exclusive creation never follows a link planted at the path.
    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`,
      { flag: "wx" }
    );
  } catch (error) {
    if (alreadyExists(error)) {
      throw new ScreenImportError(
        `Another screen import is in progress: '${shown}' exists. If no import is running (one may have been interrupted), delete that file and import again.`
      );
    }
    throw error;
  }
  const release = (): string | null => {
    try {
      rmSync(lockPath, { force: true });
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
  // Judged, and written, where the directory really resolves: a captures path
  // under `.tieline/` that links to, say, `src/` must not get a match-all
  // ignore file that would hide new source files from Git.
  const directory = realDestination(settings.capturesDirectory);
  const workspace = realDestination(workspaceDirectory);
  if (directory === workspace || !withinRepository(workspace, directory)) {
    return "not_managed";
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
    if (!existing.isFile()) return "unverified";
    let content: Buffer;
    try {
      content = readBoundedFile(ignorePath, CAPTURES_GITIGNORE_MAX_BYTES, "captures .gitignore");
    } catch (error) {
      // Unreadable or oversized: reported as unverified rather than trusted.
      if (error instanceof ScreenImportError) return "unverified";
      throw error;
    }
    return gitignoreIgnoresEverything(content.toString("utf8")) ? "exists" : "unverified";
  }
  mkdirSync(directory, { recursive: true });
  try {
    // Exclusive creation never follows a link that appears in the meantime.
    writeFileSync(ignorePath, CAPTURES_GITIGNORE, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "EEXIST") return "unverified";
    throw error;
  }
  return "created";
}
