import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import {
  applicabilitySchema,
  codeTargetSchema,
  helpTargetSchema,
  linkProvenanceSchema,
  planningOriginSchema,
  scenarioSchema,
  testTargetSchema,
} from "./schema.js";
import type {
  AcceptanceCriterion,
  AcceptedStory,
  Applicability,
  Capability,
  ContractLink,
  ContractScenario,
} from "./schema.js";
import { loadAcceptedContractWithSources } from "./load.js";
import {
  repositoryEntryKindExactly,
  withinRepository,
  type RepositoryEntryInspection,
} from "./paths.js";

export const CONTRACT_MANIFEST_VERSION = 2 as const;

export interface ManifestInput {
  path: string;
  sha256: string;
}

export interface ManifestLink {
  relation: ContractLink["relation"];
  provenance: ContractLink["provenance"];
  target: ContractLink["target"];
  reviewed_content_hash: string | null;
  /**
   * Runtime-only measurement used by repository sync. It is deliberately
   * excluded from serialized manifests so reviewed evidence stays immutable.
   */
  current_content_hash?: string | null;
}

export interface ManifestScenario extends ContractScenario {
  stable_id: string;
  position: number;
}

export interface ManifestAcceptanceCriterion {
  stable_id: string;
  criterion: string;
  rationale: string | null;
  aliases: string[];
  applies_to: Applicability | null;
  position: number;
  supersedes: string | null;
  scenarios: ManifestScenario[];
  links: ManifestLink[];
  contract_hash: string;
}

export interface ManifestStory {
  stable_id: string;
  title: string;
  actor: string;
  goal: string;
  benefit: string;
  lifecycle: AcceptedStory["lifecycle"];
  aliases: string[];
  applies_to: Applicability | null;
  motivated_by: string[];
  supersedes: string | null;
  planning_origin: AcceptedStory["planning_origin"] | null;
  links: ManifestLink[];
  acceptance_criteria: ManifestAcceptanceCriterion[];
  contract_hash: string;
}

export interface ManifestCapability {
  stable_id: string;
  name: string;
  description: string;
  aliases: string[];
  applies_to: Applicability | null;
  supersedes: string | null;
  stories: ManifestStory[];
  contract_hash: string;
}

export interface ContractManifest {
  schema_version: typeof CONTRACT_MANIFEST_VERSION;
  repository: {
    key: string;
  };
  inputs: ManifestInput[];
  capabilities: ManifestCapability[];
}

/**
 * The manifest is stored as a directory, not a file: `index.json` for the
 * fields that belong to the repository as a whole, and one file per capability
 * named after its stable ID.
 *
 * The boundary is the one the specification already has — the accepted document
 * schema takes a single `capability`, so a capability is exactly one spec file —
 * and it is the boundary along which branches actually diverge. A single
 * generated file made two branches that touched unrelated capabilities conflict
 * with each other, and worse, let git line-merge two disjoint edits into a
 * manifest that parses but is not what the compiler would emit.
 */
export const CONTRACT_MANIFEST_INDEX_FILE = "index.json";

const SHARD_EXTENSION = ".json";

/**
 * Capability stable IDs that can name a file. `stableKeySchema` in the document
 * schema is already this narrow, so this rejects nothing a valid contract
 * contains; it is here so a manifest file name can never be built from a value
 * that escapes the manifest directory.
 */
const SHARD_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * One capability plus the spec file it was compiled from.
 *
 * Provenance travels with the capability rather than in the index, so adding or
 * removing a capability touches only its own file.
 */
export interface ContractManifestShard {
  input: ManifestInput;
  capability: ManifestCapability;
}

/**
 * A compiled manifest together with the spec file behind each capability.
 *
 * `ContractManifest` sorts `inputs` by path and `capabilities` by stable ID
 * independently, so the pairing between them does not survive in the manifest
 * itself. Writing needs it — every shard records its own source file — so
 * compilation hands it out here instead of widening the manifest type that
 * `check`, `sync`, and the coverage reports all consume.
 */
export interface CompiledContractManifest {
  manifest: ContractManifest;
  /** Spec file each capability came from, keyed by capability stable ID. */
  sources: ReadonlyMap<string, ManifestInput>;
}

/** What a write did to the manifest directory. */
export interface WrittenContractManifest {
  directory: string;
  /** File names written, relative to the manifest directory. */
  files: string[];
  /** Shard file names deleted because the contract no longer declares them. */
  removed: string[];
  bytes: number;
}

/**
 * What compilation does when a link names an artifact in this repository that
 * cannot be hashed — it is missing, is not a file, or resolves outside the
 * repository.
 *
 * `throw` refuses to produce a manifest at all. This is the gate: a manifest a
 * reviewer accepts must never record evidence for content that was not read.
 *
 * `omit_hash` records `reviewed_content_hash: null` for that one link and
 * compiles the rest. It exists so ADVISORY, READ-ONLY commands can describe the
 * drift instead of dying on it. A manifest compiled this way is a report, not
 * reviewed evidence: a null reviewed hash already means "not current" to
 * `linkFreshness`, so such a manifest must never be serialized to disk.
 */
export type UnhashableArtifactPolicy = "throw" | "omit_hash";

export interface CompileContractManifestOptions {
  repositoryRoot: string;
  repositoryKey: string;
  specDirectory?: string;
  /**
   * Defaults to `throw`, so every caller that does not opt in keeps refusing to
   * compile a manifest over evidence it could not read.
   */
  onUnhashableArtifact?: UnhashableArtifactPolicy;
}

/** The per-compilation state every link measurement needs. */
interface CompileContext {
  hashes: ArtifactHashResolver;
  repositoryKey: string;
  onUnhashableArtifact: UnhashableArtifactPolicy;
}

type ArtifactHashResult =
  | { status: "hashed"; hash: string }
  | { status: "missing" }
  | { status: "not_file" }
  | { status: "outside_repository" };

export interface ArtifactHashResolver {
  measure(path: string): ArtifactHashResult;
}

export interface CreateArtifactHashResolverOptions {
  entryInspection?: RepositoryEntryInspection;
}

export class ContractManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractManifestError";
  }
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function normalizedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizedJson(entry)])
    );
  }
  return value;
}

function missingPath(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

export function createArtifactHashResolver(
  repositoryRoot: string,
  options: CreateArtifactHashResolverOptions = {}
): ArtifactHashResolver {
  const root = resolve(repositoryRoot);
  const realRoot = realpathSync(root);
  const measured = new Map<string, ArtifactHashResult>();
  return {
    measure(path) {
      const cached = measured.get(path);
      if (cached) return cached;
      const targetPath = resolve(root, path);
      let result: ArtifactHashResult;
      try {
        const kind = repositoryEntryKindExactly(
          root,
          path,
          options.entryInspection
        );
        if (kind === "missing") {
          result = { status: "missing" };
        } else if (kind !== "file") {
          result = { status: "not_file" };
        } else {
          const realTarget = realpathSync(targetPath);
          result = !withinRepository(realRoot, realTarget)
            ? { status: "outside_repository" }
            : { status: "hashed", hash: sha256(readFileSync(realTarget)) };
        }
      } catch (error) {
        if (!missingPath(error)) throw error;
        result = { status: "missing" };
      }
      measured.set(path, result);
      return result;
    },
  };
}

export function attachCurrentArtifactHashes(
  manifest: ContractManifest,
  repositoryRoot: string
): ContractManifest {
  const root = resolve(repositoryRoot);
  const repositoryKey = manifest.repository.key;
  const hashes = createArtifactHashResolver(root);
  const attachLink = (link: ManifestLink): ManifestLink => ({
    ...link,
    target: { ...link.target },
    current_content_hash:
      link.target.kind === "help" ||
      link.target.repository !== repositoryKey
        ? null
        : (() => {
            const measured = hashes.measure(link.target.path);
            return measured.status === "hashed" ? measured.hash : null;
          })(),
  });
  return {
    ...manifest,
    repository: { ...manifest.repository },
    inputs: manifest.inputs.map((input) => ({ ...input })),
    capabilities: manifest.capabilities.map((capability) => ({
      ...capability,
      stories: capability.stories.map((story) => ({
        ...story,
        links: story.links.map(attachLink),
        acceptance_criteria: story.acceptance_criteria.map((criterion) => ({
          ...criterion,
          scenarios: criterion.scenarios.map((scenario) => ({ ...scenario })),
          links: criterion.links.map(attachLink),
        })),
      })),
    })),
  };
}

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const stableIdSchema = z.string().trim().min(1).max(160);
const nonEmptyTextSchema = z.string().trim().min(1);
const manifestLinkSchema = z.union([
  z
    .object({
      relation: z.enum(["implements", "enforces"]),
      provenance: linkProvenanceSchema,
      target: codeTargetSchema,
      reviewed_content_hash: hashSchema.nullable(),
    })
    .strict(),
  z
    .object({
      relation: z.literal("tests"),
      provenance: linkProvenanceSchema,
      target: testTargetSchema,
      reviewed_content_hash: hashSchema.nullable(),
    })
    .strict(),
  z
    .object({
      relation: z.literal("documents"),
      provenance: linkProvenanceSchema,
      target: helpTargetSchema,
      reviewed_content_hash: z.null(),
    })
    .strict(),
]);
const manifestScenarioSchema = scenarioSchema
  .extend({
    stable_id: stableIdSchema,
    position: z.number().int().nonnegative(),
  })
  .strict();
const manifestCriterionSchema = z
  .object({
    stable_id: stableIdSchema,
    criterion: nonEmptyTextSchema,
    rationale: nonEmptyTextSchema.nullable(),
    aliases: z.array(nonEmptyTextSchema),
    applies_to: applicabilitySchema.nullable(),
    position: z.number().int().nonnegative(),
    supersedes: stableIdSchema.nullable(),
    scenarios: z.array(manifestScenarioSchema),
    links: z.array(manifestLinkSchema),
    contract_hash: hashSchema,
  })
  .strict();
const manifestStorySchema = z
  .object({
    stable_id: stableIdSchema,
    title: nonEmptyTextSchema,
    actor: nonEmptyTextSchema,
    goal: nonEmptyTextSchema,
    benefit: nonEmptyTextSchema,
    lifecycle: z.enum(["in_progress", "production", "retired"]),
    aliases: z.array(nonEmptyTextSchema),
    applies_to: applicabilitySchema.nullable(),
    motivated_by: z.array(stableIdSchema),
    supersedes: stableIdSchema.nullable(),
    planning_origin: planningOriginSchema.nullable(),
    links: z.array(manifestLinkSchema),
    acceptance_criteria: z.array(manifestCriterionSchema).min(1),
    contract_hash: hashSchema,
  })
  .strict();
const manifestCapabilitySchema = z
  .object({
    stable_id: stableIdSchema,
    name: nonEmptyTextSchema,
    description: nonEmptyTextSchema,
    aliases: z.array(nonEmptyTextSchema),
    applies_to: applicabilitySchema.nullable(),
    supersedes: stableIdSchema.nullable(),
    stories: z.array(manifestStorySchema),
    contract_hash: hashSchema,
  })
  .strict();
const manifestInputSchema = z
  .object({
    path: nonEmptyTextSchema,
    sha256: hashSchema,
  })
  .strict();
const contractManifestIndexSchema = z
  .object({
    schema_version: z.literal(CONTRACT_MANIFEST_VERSION),
    repository: z
      .object({
        key: stableIdSchema,
      })
      .strict(),
  })
  .strict();
const contractManifestShardSchema = z
  .object({
    input: manifestInputSchema,
    capability: manifestCapabilitySchema,
  })
  .strict();

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function manifestFileDescription(name: string): string {
  return name === CONTRACT_MANIFEST_INDEX_FILE
    ? "the contract manifest index"
    : "a contract manifest capability";
}

function readManifestFile(
  root: string,
  name: string
): ContractManifestSnapshotFile {
  const path = resolve(root, name);
  try {
    return { name, content: readFileSync(path, "utf8") };
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new ContractManifestError(
        `The contract manifest is incomplete: ${manifestFileDescription(name)} '${path}' does not exist. Run 'tieline contract compile .' to regenerate it.`
      );
    }
    throw new ContractManifestError(
      `Cannot read ${manifestFileDescription(name)} '${path}': ${describeError(error)}`
    );
  }
}

const REPORTED_ISSUES = 8;

/**
 * Every failing field, one per entry.
 *
 * Link targets are a union, and a union reports nothing but "Invalid input" at
 * the top: the field that actually failed is inside the branch errors. Those
 * are flattened in, because "links.0 is invalid" does not tell a maintainer
 * which value to go and fix.
 */
function describeIssues(issues: z.ZodIssue[]): string[] {
  return issues.flatMap((issue) => {
    if (issue.code === z.ZodIssueCode.invalid_union) {
      return issue.unionErrors.flatMap((error) => describeIssues(error.issues));
    }
    return [`${issue.path.join(".") || "(root)"}: ${issue.message}`];
  });
}

function parseManifestPart<T>(
  schema: z.ZodType<T>,
  value: unknown,
  description: string,
  path: string
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const reported = [...new Set(describeIssues(result.error.issues))];
  const issues = [
    ...reported.slice(0, REPORTED_ISSUES),
    ...(reported.length > REPORTED_ISSUES
      ? [`(and ${reported.length - REPORTED_ISSUES} more)`]
      : []),
  ].join("; ");
  throw new ContractManifestError(
    `${description} '${path}' is not a valid contract manifest part: ${issues}`
  );
}

/** The file a capability belongs in, or a refusal to name one at all. */
function shardFileName(stableId: string): string {
  if (!SHARD_NAME_PATTERN.test(stableId)) {
    throw new ContractManifestError(
      `Capability stable ID '${stableId}' cannot name a manifest file. Stable IDs must start with a letter or digit and contain only letters, digits, '.', '_', and '-'.`
    );
  }
  const name = `${stableId}${SHARD_EXTENSION}`;
  if (name === CONTRACT_MANIFEST_INDEX_FILE) {
    throw new ContractManifestError(
      `Capability stable ID '${stableId}' collides with the manifest index file '${CONTRACT_MANIFEST_INDEX_FILE}'. Rename the capability.`
    );
  }
  return name;
}

function manifestDirectoryEntries(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(SHARD_EXTENSION))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") {
      throw new ContractManifestError(
        `No compiled contract manifest at '${directory}': the manifest directory does not exist. Run 'tieline contract compile .' to generate it.`
      );
    }
    if (code === "ENOTDIR") {
      throw new ContractManifestError(
        `Contract manifest path '${directory}' is a file. Tieline stores the manifest as a directory holding '${CONTRACT_MANIFEST_INDEX_FILE}' and one file per capability. Remove the file and run 'tieline contract compile .'.`
      );
    }
    throw new ContractManifestError(
      `Cannot read the contract manifest directory '${directory}': ${describeError(error)}`
    );
  }
}

/** How an assembly context words each structural failure. */
interface ManifestAssemblyErrors {
  /** Labels a file in schema-validation failures. */
  fileLabel(name: string): string;
  parseFailure(name: string, cause: string): string;
  missingIndex(): string;
  shardNameMismatch(name: string, stableId: string, expected: string): string;
  duplicateInput(path: string, claimedBy: string, stableId: string): string;
  noCapabilities(): string;
}

/**
 * The one assembly of a manifest from its files, shared by the disk reader and
 * the snapshot parser, which differ only in where the files come from and how
 * their errors are worded.
 */
function assembleContractManifest(
  files: ContractManifestSnapshotFile[],
  errors: ManifestAssemblyErrors
): ContractManifest {
  const parseJson = (file: ContractManifestSnapshotFile): unknown => {
    try {
      return JSON.parse(file.content);
    } catch (error) {
      throw new ContractManifestError(
        errors.parseFailure(file.name, describeError(error))
      );
    }
  };
  const index = files.find(
    (file) => file.name === CONTRACT_MANIFEST_INDEX_FILE
  );
  if (!index) {
    throw new ContractManifestError(errors.missingIndex());
  }
  const parsedIndex = parseManifestPart(
    contractManifestIndexSchema,
    parseJson(index),
    "The contract manifest index",
    errors.fileLabel(index.name)
  );

  const inputs: ManifestInput[] = [];
  const capabilities: ManifestCapability[] = [];
  const claimedInputs = new Map<string, string>();
  const shards = files
    .filter(
      (file) =>
        file.name !== CONTRACT_MANIFEST_INDEX_FILE &&
        file.name.endsWith(SHARD_EXTENSION)
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const file of shards) {
    const shard = parseManifestPart(
      contractManifestShardSchema,
      parseJson(file),
      "The contract manifest capability",
      errors.fileLabel(file.name)
    ) as ContractManifestShard;
    // A file named after something other than the capability it holds means the
    // directory no longer says what it appears to say — a hand edit, a bad
    // merge, or a rename. Reading it would silently accept a capability under
    // the wrong identity.
    const expected = shardFileName(shard.capability.stable_id);
    if (file.name !== expected) {
      throw new ContractManifestError(
        errors.shardNameMismatch(file.name, shard.capability.stable_id, expected)
      );
    }
    const claimedBy = claimedInputs.get(shard.input.path);
    if (claimedBy) {
      throw new ContractManifestError(
        errors.duplicateInput(
          shard.input.path,
          claimedBy,
          shard.capability.stable_id
        )
      );
    }
    claimedInputs.set(shard.input.path, shard.capability.stable_id);
    inputs.push(shard.input);
    capabilities.push(shard.capability);
  }
  // A compilation always writes at least one capability, because a spec
  // directory with no YAML files fails to load. An index with no capabilities
  // beside it is therefore a half-deleted directory, and reading it as an empty
  // contract would quietly tell every caller the repository accepts nothing.
  if (capabilities.length === 0) {
    throw new ContractManifestError(errors.noCapabilities());
  }
  return {
    schema_version: parsedIndex.schema_version,
    repository: parsedIndex.repository,
    inputs: inputs.sort((left, right) => left.path.localeCompare(right.path)),
    capabilities: capabilities.sort((left, right) =>
      left.stable_id.localeCompare(right.stable_id)
    ),
  };
}

/**
 * Reassembles the manifest a compilation wrote. The result is the same object
 * `compileContractManifest` produces for the same inputs — capabilities sorted
 * by stable ID, inputs sorted by path — so serializing it stays deterministic
 * and `manifest_current` keeps comparing like with like.
 */
export function readContractManifest(directory: string): ContractManifest {
  const root = resolve(directory);
  const files = [
    CONTRACT_MANIFEST_INDEX_FILE,
    ...manifestDirectoryEntries(root).filter(
      (name) => name !== CONTRACT_MANIFEST_INDEX_FILE
    ),
  ].map((name) => readManifestFile(root, name));
  return assembleContractManifest(files, {
    fileLabel: (name) => resolve(root, name),
    parseFailure: (name, cause) =>
      `Cannot parse ${manifestFileDescription(name)} '${resolve(root, name)}': ${cause}. Run 'tieline contract compile .' to regenerate it.`,
    missingIndex: () =>
      `The contract manifest is incomplete: the contract manifest index '${resolve(root, CONTRACT_MANIFEST_INDEX_FILE)}' does not exist. Run 'tieline contract compile .' to regenerate it.`,
    shardNameMismatch: (name, stableId, expected) =>
      `Contract manifest file '${resolve(root, name)}' holds capability '${stableId}', which belongs in '${expected}'. Run 'tieline contract compile .' to regenerate the manifest.`,
    duplicateInput: (path, claimedBy, stableId) =>
      `Contract manifest capabilities '${claimedBy}' and '${stableId}' both record spec file '${path}'. Each spec file declares exactly one capability. Run 'tieline contract compile .' to regenerate the manifest.`,
    noCapabilities: () =>
      `The contract manifest at '${root}' has an index but no capabilities. Run 'tieline contract compile .' to regenerate it.`,
  });
}

/** A manifest file from somewhere other than the working tree: its name within the manifest directory and its raw JSON content. */
export interface ContractManifestSnapshotFile {
  name: string;
  content: string;
}

/**
 * Reassembles a manifest from file contents rather than from disk, applying
 * the same structural checks as `readContractManifest`.
 *
 * This exists for readers holding a historical manifest — grading reads the
 * base ref's manifest out of git to learn which contract links the branch
 * added or re-worded. History cannot be recompiled, so unlike the disk
 * reader the errors name the snapshot's origin instead of advising a
 * regeneration: a snapshot failing these checks was never something a
 * compilation wrote, and the caller must surface that rather than guess.
 *
 * `origin` is a human description of where the files came from, e.g.
 * `ref 'main'`.
 */
export function parseContractManifestSnapshot(
  files: ContractManifestSnapshotFile[],
  origin: string
): ContractManifest {
  return assembleContractManifest(files, {
    fileLabel: (name) => `${name} (${origin})`,
    parseFailure: (name, cause) =>
      `Cannot parse the contract manifest file '${name}' at ${origin}: ${cause}`,
    missingIndex: () =>
      `The contract manifest at ${origin} has no '${CONTRACT_MANIFEST_INDEX_FILE}'.`,
    shardNameMismatch: (name, stableId, expected) =>
      `The contract manifest file '${name}' at ${origin} holds capability '${stableId}', which belongs in '${expected}'.`,
    duplicateInput: (path, claimedBy, stableId) =>
      `The contract manifest at ${origin} records spec file '${path}' under capabilities '${claimedBy}' and '${stableId}'. Each spec file declares exactly one capability.`,
    noCapabilities: () =>
      `The contract manifest at ${origin} has an index but no capabilities.`,
  });
}

/**
 * Writes the manifest directory and returns what it did.
 *
 * Compilation stays pure; this is the only place manifest files are created,
 * so the one destructive step — removing the file of a capability the contract
 * no longer declares — happens where the full new file set is known.
 */
export function writeContractManifest(
  directory: string,
  compiled: CompiledContractManifest
): WrittenContractManifest {
  const root = resolve(directory);
  const { manifest, sources } = compiled;
  const contents = new Map<string, string>([
    [CONTRACT_MANIFEST_INDEX_FILE, serializeManifestIndex(manifest)],
  ]);
  for (const capability of manifest.capabilities) {
    const input = sources.get(capability.stable_id);
    if (!input) {
      throw new ContractManifestError(
        `Capability '${capability.stable_id}' has no source spec file, so its manifest file cannot record where it came from.`
      );
    }
    contents.set(
      shardFileName(capability.stable_id),
      serializeManifestShard({ input, capability })
    );
  }

  mkdirSync(root, { recursive: true });
  let bytes = 0;
  for (const [name, content] of contents) {
    writeFileSync(resolve(root, name), content);
    bytes += Buffer.byteLength(content);
  }
  return {
    directory: root,
    files: [...contents.keys()].sort((left, right) => left.localeCompare(right)),
    removed: removeStaleShards(root, new Set(contents.keys())),
    bytes,
  };
}

/**
 * Deletes the files of capabilities this write did not produce.
 *
 * Deliberately narrow: only regular files, only directly inside the manifest
 * directory, only names ending in `.json`, and only names this write did not
 * just create. Directories are never descended into and never removed, symlinks
 * are left alone because `isFile` is false for them, and anything with another
 * extension is not ours to delete.
 */
function removeStaleShards(
  directory: string,
  written: ReadonlySet<string>
): string[] {
  const removed: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(SHARD_EXTENSION)) continue;
    if (written.has(entry.name)) continue;
    unlinkSync(resolve(directory, entry.name));
    removed.push(entry.name);
  }
  return removed.sort((left, right) => left.localeCompare(right));
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizedJson(value));
}

function contractHash(value: unknown): string {
  return sha256(stableJson(value));
}

function reviewedContentHash(
  context: CompileContext,
  link: ContractLink
): string | null {
  const { repositoryKey } = context;
  if (link.target.kind === "help" || link.target.repository !== repositoryKey) {
    return null;
  }

  const measured = context.hashes.measure(link.target.path);
  if (measured.status === "hashed") return measured.hash;
  // The artifact could not be read. Under `omit_hash` that is the finding an
  // advisory command was asked to report, so the link keeps its locator and
  // records no reviewed content rather than stopping the whole compilation.
  if (context.onUnhashableArtifact === "omit_hash") return null;

  if (measured.status === "missing") {
    throw new ContractManifestError(
      `Linked ${link.target.kind} artifact '${link.target.path}' does not exist in repository '${repositoryKey}'.`
    );
  }
  if (measured.status === "not_file") {
    throw new ContractManifestError(
      `Linked ${link.target.kind} artifact '${link.target.path}' is not a file.`
    );
  }

  throw new ContractManifestError(
    `Linked ${link.target.kind} artifact '${link.target.path}' resolves outside the repository.`
  );
}

function compileLinks(
  context: CompileContext,
  links: ContractLink[]
): ManifestLink[] {
  return links
    .map((link) => ({
      relation: link.relation,
      provenance: link.provenance,
      target: link.target,
      reviewed_content_hash: reviewedContentHash(context, link),
    }))
    .sort((left, right) =>
      stableJson([left.relation, left.target]).localeCompare(
        stableJson([right.relation, right.target])
      )
    );
}

function criterionSemantics(criterion: AcceptanceCriterion): unknown {
  return {
    stable_id: criterion.key,
    criterion: criterion.criterion,
    rationale: criterion.rationale ?? null,
    aliases: [...criterion.aliases].sort(),
    applies_to: criterion.applies_to ?? null,
    supersedes: criterion.supersedes ?? null,
    scenarios: criterion.scenarios,
    links: criterion.links,
  };
}

function compileCriterion(
  context: CompileContext,
  criterion: AcceptanceCriterion,
  position: number
): ManifestAcceptanceCriterion {
  return {
    stable_id: criterion.key,
    criterion: criterion.criterion,
    rationale: criterion.rationale ?? null,
    aliases: [...criterion.aliases].sort(),
    applies_to: criterion.applies_to ?? null,
    position,
    supersedes: criterion.supersedes ?? null,
    scenarios: criterion.scenarios.map((scenario, scenarioPosition) => ({
      stable_id: `${criterion.key}-S${scenarioPosition + 1}`,
      position: scenarioPosition,
      ...scenario,
    })),
    links: compileLinks(context, criterion.links),
    contract_hash: contractHash(criterionSemantics(criterion)),
  };
}

function storySemantics(story: AcceptedStory): unknown {
  return {
    stable_id: story.key,
    title: story.title,
    actor: story.actor,
    goal: story.goal,
    benefit: story.benefit,
    lifecycle: story.lifecycle,
    aliases: [...story.aliases].sort(),
    applies_to: story.applies_to ?? null,
    motivated_by: [...story.motivated_by].sort(),
    supersedes: story.supersedes ?? null,
    planning_origin: story.planning_origin ?? null,
    links: story.links,
  };
}

function compileStory(
  context: CompileContext,
  story: AcceptedStory
): ManifestStory {
  return {
    stable_id: story.key,
    title: story.title,
    actor: story.actor,
    goal: story.goal,
    benefit: story.benefit,
    lifecycle: story.lifecycle,
    aliases: [...story.aliases].sort(),
    applies_to: story.applies_to ?? null,
    motivated_by: [...story.motivated_by].sort(),
    supersedes: story.supersedes ?? null,
    planning_origin: story.planning_origin ?? null,
    links: compileLinks(context, story.links),
    acceptance_criteria: story.acceptance_criteria
      .map((criterion, position) =>
        compileCriterion(context, criterion, position)
      )
      .sort((left, right) => left.stable_id.localeCompare(right.stable_id)),
    contract_hash: contractHash(storySemantics(story)),
  };
}

function capabilitySemantics(capability: Capability): unknown {
  return {
    stable_id: capability.key,
    name: capability.name,
    description: capability.description,
    aliases: [...capability.aliases].sort(),
    applies_to: capability.applies_to ?? null,
    supersedes: capability.supersedes ?? null,
  };
}

function compileCapability(
  context: CompileContext,
  capability: Capability
): ManifestCapability {
  return {
    stable_id: capability.key,
    name: capability.name,
    description: capability.description,
    aliases: [...capability.aliases].sort(),
    applies_to: capability.applies_to ?? null,
    supersedes: capability.supersedes ?? null,
    stories: capability.stories
      .map((story) => compileStory(context, story))
      .sort((left, right) => left.stable_id.localeCompare(right.stable_id)),
    contract_hash: contractHash(capabilitySemantics(capability)),
  };
}

/**
 * Compiles the manifest and keeps hold of which spec file produced which
 * capability. Callers that only consume the contract want
 * `compileContractManifest`; writing the manifest needs this.
 */
export function compileContractManifestWithSources(
  options: CompileContractManifestOptions
): CompiledContractManifest {
  const root = resolve(options.repositoryRoot);
  const repositoryKey = options.repositoryKey.trim();
  if (!repositoryKey) throw new ContractManifestError("Repository key cannot be empty.");

  const loaded = loadAcceptedContractWithSources(root, options.specDirectory);
  // One document per source file, one capability per document: the accepted
  // document schema takes a single `capability`, and validation rejects the
  // whole load if any file fails to parse. The manifest layout depends on that
  // pairing, so a load that ever broke it must say so rather than mislabel
  // provenance.
  if (loaded.documents.length !== loaded.sources.length) {
    throw new ContractManifestError(
      `Contract loading returned ${loaded.documents.length} capability document(s) for ${loaded.sources.length} spec file(s). The manifest records one capability per spec file and cannot tell which file produced which capability.`
    );
  }
  const context: CompileContext = {
    hashes: createArtifactHashResolver(root),
    repositoryKey,
    onUnhashableArtifact: options.onUnhashableArtifact ?? "throw",
  };
  const sources = new Map<string, ManifestInput>();
  const capabilities = loaded.documents.map((document, index) => {
    const capability = compileCapability(context, document.capability);
    const source = loaded.sources[index]!;
    const existing = sources.get(capability.stable_id);
    if (existing) {
      throw new ContractManifestError(
        `Capability '${capability.stable_id}' is declared by both '${existing.path}' and '${source.path}'. A capability stable ID identifies exactly one spec file.`
      );
    }
    sources.set(capability.stable_id, {
      path: source.path,
      sha256: sha256(source.content),
    });
    return capability;
  });
  return {
    manifest: {
      schema_version: CONTRACT_MANIFEST_VERSION,
      repository: { key: repositoryKey },
      inputs: [...sources.values()].sort((left, right) =>
        left.path.localeCompare(right.path)
      ),
      capabilities: capabilities.sort((left, right) =>
        left.stable_id.localeCompare(right.stable_id)
      ),
    },
    sources,
  };
}

export function compileContractManifest(
  options: CompileContractManifestOptions
): ContractManifest {
  return compileContractManifestWithSources(options).manifest;
}

/**
 * The whole manifest as one JSON document.
 *
 * This is not the on-disk form — the manifest is stored per capability — but it
 * is the canonical rendering of the in-memory object, and `check` compares two
 * of these to decide whether the committed manifest is current.
 */
export function serializeContractManifest(manifest: ContractManifest): string {
  return serializeManifestJson({
    ...manifest,
    capabilities: manifest.capabilities.map(reviewedCapability),
  });
}

/**
 * Deterministic identity of the complete reviewed manifest assembled from its
 * index and capability shards. The digest is computed when needed instead of
 * being persisted in the shared index, so branch-local contract changes do not
 * create an additional cross-capability conflict surface.
 */
export function manifestDigest(manifest: ContractManifest): string {
  return sha256(serializeContractManifest(manifest));
}

function serializeManifestIndex(manifest: ContractManifest): string {
  return serializeManifestJson({
    schema_version: manifest.schema_version,
    repository: manifest.repository,
  });
}

function serializeManifestShard(shard: ContractManifestShard): string {
  return serializeManifestJson({
    input: shard.input,
    capability: reviewedCapability(shard.capability),
  });
}

function serializeManifestJson(value: unknown): string {
  return `${JSON.stringify(normalizedJson(value), null, 2)}\n`;
}

/**
 * A capability without the runtime freshness measurements `sync` attaches, so
 * reviewed evidence is the only thing that ever reaches disk.
 */
function reviewedCapability(capability: ManifestCapability): ManifestCapability {
  return {
    ...capability,
    stories: capability.stories.map((story) => ({
      ...story,
      links: story.links.map(withoutCurrentContentHash),
      acceptance_criteria: story.acceptance_criteria.map((criterion) => ({
        ...criterion,
        links: criterion.links.map(withoutCurrentContentHash),
      })),
    })),
  };
}

function withoutCurrentContentHash(link: ManifestLink): ManifestLink {
  const reviewed = { ...link };
  delete reviewed.current_content_hash;
  return reviewed;
}
