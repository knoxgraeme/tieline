import { createHash } from "node:crypto";
import {
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  applicabilitySchema,
  codeTargetSchema,
  helpTargetSchema,
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

export const CONTRACT_MANIFEST_VERSION = 1 as const;

export interface ManifestInput {
  path: string;
  sha256: string;
}

export interface ManifestLink {
  relation: ContractLink["relation"];
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
    commit: string;
  };
  inputs: ManifestInput[];
  capabilities: ManifestCapability[];
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
  commit: string;
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
  repositoryRoot: string
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
        if (!statSync(targetPath).isFile()) {
          result = { status: "not_file" };
        } else {
          const realTarget = realpathSync(targetPath);
          result = !isWithinRoot(realRoot, realTarget)
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
      target: codeTargetSchema,
      reviewed_content_hash: hashSchema.nullable(),
    })
    .strict(),
  z
    .object({
      relation: z.literal("tests"),
      target: testTargetSchema,
      reviewed_content_hash: hashSchema.nullable(),
    })
    .strict(),
  z
    .object({
      relation: z.literal("documents"),
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
const contractManifestSchema = z
  .object({
    schema_version: z.literal(CONTRACT_MANIFEST_VERSION),
    repository: z
      .object({
        key: stableIdSchema,
        commit: nonEmptyTextSchema,
      })
      .strict(),
    inputs: z.array(
      z
        .object({
          path: nonEmptyTextSchema,
          sha256: hashSchema,
        })
        .strict()
    ),
    capabilities: z.array(
      z
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
        .strict()
    ),
  })
  .strict();

export function readContractManifest(path: string): ContractManifest {
  try {
    return contractManifestSchema.parse(
      JSON.parse(readFileSync(path, "utf8"))
    ) as ContractManifest;
  } catch (error) {
    throw new ContractManifestError(
      `Cannot read reviewed contract manifest '${path}': ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export function stableJson(value: unknown): string {
  return JSON.stringify(normalizedJson(value));
}

function contractHash(value: unknown): string {
  return sha256(stableJson(value));
}

function isWithinRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
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

export function compileContractManifest(
  options: CompileContractManifestOptions
): ContractManifest {
  const root = resolve(options.repositoryRoot);
  const repositoryKey = options.repositoryKey.trim();
  const commit = options.commit.trim();
  if (!repositoryKey) throw new ContractManifestError("Repository key cannot be empty.");
  if (!commit) throw new ContractManifestError("Repository commit cannot be empty.");

  const loaded = loadAcceptedContractWithSources(root, options.specDirectory);
  const context: CompileContext = {
    hashes: createArtifactHashResolver(root),
    repositoryKey,
    onUnhashableArtifact: options.onUnhashableArtifact ?? "throw",
  };
  return {
    schema_version: CONTRACT_MANIFEST_VERSION,
    repository: { key: repositoryKey, commit },
    inputs: loaded.sources
      .map((source) => ({ path: source.path, sha256: sha256(source.content) }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    capabilities: loaded.documents
      .map((document) => compileCapability(context, document.capability))
      .sort((left, right) => left.stable_id.localeCompare(right.stable_id)),
  };
}

export function serializeContractManifest(manifest: ContractManifest): string {
  const reviewedManifest = {
    ...manifest,
    capabilities: manifest.capabilities.map((capability) => ({
      ...capability,
      stories: capability.stories.map((story) => ({
        ...story,
        links: story.links.map(withoutCurrentContentHash),
        acceptance_criteria: story.acceptance_criteria.map((criterion) => ({
          ...criterion,
          links: criterion.links.map(withoutCurrentContentHash),
        })),
      })),
    })),
  };
  return `${JSON.stringify(normalizedJson(reviewedManifest), null, 2)}\n`;
}

function withoutCurrentContentHash(link: ManifestLink): ManifestLink {
  const reviewed = { ...link };
  delete reviewed.current_content_hash;
  return reviewed;
}
