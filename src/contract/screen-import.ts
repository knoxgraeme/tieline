import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
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
  validateScreenCatalogDocuments,
  type ScreenCatalogDocument,
  type ScreenCatalogSource,
  type ScreenEntry,
  type ScreenImage,
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
 * Reads at most `maxBytes` bytes. The limit is enforced on the bytes actually
 * read, not only on the size reported before reading, so a file that grows
 * while it is read cannot exceed it.
 */
export function readScreenImportFile(
  path: string,
  maxBytes: number = SCREEN_IMPORT_LIMITS.fileBytes
): unknown {
  let descriptor: number;
  try {
    descriptor = openSync(path, "r");
  } catch (error) {
    throw new ScreenImportError(
      `Cannot open screen import file '${path}': ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const chunks: Buffer[] = [];
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new ScreenImportError(`Screen import '${path}' is not a file.`);
    }
    const tooLarge = (): ScreenImportError =>
      new ScreenImportError(
        `Screen import file '${path}' is larger than the ${maxBytes}-byte limit.`
      );
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
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
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
}

export type ScreenImportFileStatus = "created" | "updated" | "unchanged";

export interface PlannedScreenCatalogFile {
  /** Repository-relative, `/`-separated. */
  path: string;
  absolutePath: string;
  status: ScreenImportFileStatus;
  content: string;
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

/** A catalog entry in the field order the catalog documents use. */
function catalogEntry(imported: ScreenImportEntry, current: ScreenEntry | undefined): ScreenEntry {
  const group = mergedField(imported.group, current?.group);
  const appliesTo = mergedField(imported.applies_to, current?.applies_to);
  const copy = mergedField(imported.copy, current?.copy);
  const image = mergedField(imported.image, current?.image);
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
    const merged = catalogEntry(entry, previous);
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
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return plan;
}

/**
 * Writes the files a plan changes, each through a temporary file and a rename
 * so a reader never sees a half-written catalog file.
 */
export function applyScreenImport(plan: ScreenImportPlan): void {
  for (const file of plan.files) {
    if (file.status === "unchanged") continue;
    mkdirSync(dirname(file.absolutePath), { recursive: true });
    const temporary = `${file.absolutePath}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, file.content);
      renameSync(temporary, file.absolutePath);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }
}

export type CapturesIgnoreStatus = "created" | "exists" | "not_managed";

/**
 * Screenshots are never committed by default. When the captures directory is
 * inside `.tieline/` (the default), it gets a `.gitignore` that ignores
 * everything in it. A directory configured elsewhere is the repository's to
 * manage: writing `*` into, say, a source directory would hide real files.
 */
export function ensureCapturesIgnored(
  repositoryRoot: string,
  settings: ScreenSettings,
  workspaceDirectory = resolve(repositoryRoot, ".tieline")
): CapturesIgnoreStatus {
  const directory = settings.capturesDirectory;
  if (directory === workspaceDirectory || !withinRepository(workspaceDirectory, directory)) {
    return "not_managed";
  }
  const ignorePath = resolve(directory, ".gitignore");
  if (existsSync(ignorePath)) return "exists";
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    ignorePath,
    "# Screenshots referenced by the Tieline screen catalog are not committed.\n*\n!.gitignore\n"
  );
  return "created";
}
