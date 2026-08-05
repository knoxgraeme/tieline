import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ZodIssue } from "zod";
import { readSelectorConfig } from "../config.js";
import {
  acceptedContractDocumentSchema,
  type AcceptedContractDocument,
  type ContractLink,
} from "./schema.js";
import {
  CORE_SELECTOR_VOCABULARY,
  createSelectorVocabulary,
  validateSelector,
  type SelectorVocabulary,
} from "./selector.js";

export interface ContractDocumentInput {
  path: string;
  document: unknown;
}

export interface ValidateAcceptedContractOptions {
  /**
   * Kinds this repository allows in link selectors. Defaults to the closed core
   * vocabulary, which is the safe default: an undeclared kind fails loudly
   * rather than silently creating a second identity namespace.
   */
  selectorVocabulary?: SelectorVocabulary;
  /**
   * Repository root to read `.tieline/config.json` from when no vocabulary is
   * supplied. This is how config-declared kinds reach validation: the schema is
   * a static value shared by manifest compilation and cannot carry per-repository
   * configuration, so membership is checked here, at the one layer that can
   * legitimately go and look at the repository.
   */
  repositoryRoot?: string;
}

/**
 * Builds the selector vocabulary for a checkout. A missing or unreadable config
 * yields the core vocabulary rather than an error, because the absence of a
 * `selectors` block is the normal case, not a misconfiguration. A malformed
 * `selectors` block does throw — a repository that tried to declare kinds and
 * got it wrong must not silently fall back to a narrower vocabulary.
 */
export function selectorVocabularyForRepository(
  repositoryRoot: string,
  configPath = ".tieline/config.json"
): SelectorVocabulary {
  let raw: string;
  try {
    raw = readFileSync(resolve(repositoryRoot, configPath), "utf8");
  } catch {
    return CORE_SELECTOR_VOCABULARY;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return CORE_SELECTOR_VOCABULARY;
  }
  return createSelectorVocabulary(readSelectorConfig(parsed).kinds);
}

export interface ValidatedContract {
  documents: AcceptedContractDocument[];
  warnings: string[];
}

interface StableRecord {
  kind: "capability" | "story" | "criterion";
  path: string;
  supersedes?: string;
  criterion?: string;
}

export class ContractValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Contract validation failed:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "ContractValidationError";
    this.issues = issues;
  }
}

function formatZodIssue(path: string, issue: ZodIssue): string {
  const field = issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
  return `${path}${field}: ${issue.message}`;
}

function normalizeSemanticText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function validateRepositoryPath(path: string): string | null {
  if (
    isAbsolute(path) ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.startsWith("\\\\") ||
    path.split(/[\\/]/).includes("..")
  ) {
    return `path '${path}' must be repository-relative and cannot escape the checkout`;
  }
  return null;
}

function validateLink(
  path: string,
  link: ContractLink,
  vocabulary: SelectorVocabulary,
  issues: string[]
): void {
  if (link.target.kind === "help") return;
  const issue = validateRepositoryPath(link.target.path);
  if (issue) issues.push(`${path}: ${issue}`);
  const selector = link.target.selector;
  if (selector === undefined) return;
  // The schema already accepted the shape and canonicalized it; what is left is
  // whether this repository actually uses that kind. Keeping the check closed is
  // the whole point: a typo like `func:` must fail here rather than quietly
  // becoming a second, unreconcilable asset identity.
  const checked = validateSelector(selector, vocabulary);
  if (!checked.ok) {
    issues.push(`${path}: link to '${link.target.path}' has an invalid selector: ${checked.error}`);
  }
}

function linkIdentity(link: ContractLink): string {
  return JSON.stringify([link.relation, link.target]);
}

function validateLinks(
  path: string,
  owner: string,
  links: ContractLink[],
  vocabulary: SelectorVocabulary,
  issues: string[]
): void {
  const seen = new Map<string, ContractLink>();
  for (const link of links) {
    validateLink(path, link, vocabulary, issues);
    const identity = linkIdentity(link);
    const existing = seen.get(identity);
    if (!existing) {
      seen.set(identity, link);
      continue;
    }
    const detail =
      existing.provenance === link.provenance
        ? `with provenance '${link.provenance}' more than once`
        : `with conflicting provenance '${existing.provenance}' and '${link.provenance}'`;
    issues.push(
      `${path}: '${owner}' declares the same '${link.relation}' link target ${detail}`
    );
  }
}

function findSupersessionCycle(
  start: string,
  records: Map<string, StableRecord>
): string[] | null {
  const path: string[] = [];
  const positions = new Map<string, number>();
  let current: string | undefined = start;
  while (current) {
    const seenAt = positions.get(current);
    if (seenAt !== undefined) return [...path.slice(seenAt), current];
    positions.set(current, path.length);
    path.push(current);
    current = records.get(current)?.supersedes;
  }
  return null;
}

export function validateAcceptedContractDocuments(
  inputs: ContractDocumentInput[],
  options: ValidateAcceptedContractOptions = {}
): ValidatedContract {
  const vocabulary =
    options.selectorVocabulary ??
    (options.repositoryRoot
      ? selectorVocabularyForRepository(options.repositoryRoot)
      : CORE_SELECTOR_VOCABULARY);
  const issues: string[] = [];
  const parsedInputs: Array<{ path: string; document: AcceptedContractDocument }> = [];

  for (const input of inputs) {
    const result = acceptedContractDocumentSchema.safeParse(input.document);
    if (!result.success) {
      issues.push(...result.error.issues.map((issue) => formatZodIssue(input.path, issue)));
      continue;
    }
    parsedInputs.push({ path: input.path, document: result.data });
  }

  const documents = parsedInputs.map(({ document }) => document);
  const records = new Map<string, StableRecord>();
  const criteriaByText = new Map<string, { key: string; path: string }>();
  const warnings: string[] = [];

  function addRecord(key: string, record: StableRecord): void {
    const existing = records.get(key);
    if (existing) {
      issues.push(
        `${record.path}: duplicate stable ID '${key}' already used by ${existing.kind} in ${existing.path}`
      );
      return;
    }
    records.set(key, record);
  }

  for (const { path: sourcePath, document } of parsedInputs) {
    const capability = document.capability;
    addRecord(capability.key, {
      kind: "capability",
      path: sourcePath,
      supersedes: capability.supersedes,
    });
    for (const story of capability.stories) {
      addRecord(story.key, {
        kind: "story",
        path: sourcePath,
        supersedes: story.supersedes,
      });
      validateLinks(sourcePath, story.key, story.links, vocabulary, issues);
      for (const criterion of story.acceptance_criteria) {
        addRecord(criterion.key, {
          kind: "criterion",
          path: sourcePath,
          supersedes: criterion.supersedes,
          criterion: criterion.criterion,
        });
        validateLinks(
          sourcePath,
          criterion.key,
          criterion.links,
          vocabulary,
          issues
        );
        const normalized = normalizeSemanticText(criterion.criterion);
        const existing = criteriaByText.get(normalized);
        if (existing && existing.key !== criterion.key) {
          warnings.push(
            `${sourcePath}: '${criterion.key}' has equivalent criterion text to '${existing.key}' in ${existing.path}`
          );
        } else {
          criteriaByText.set(normalized, { key: criterion.key, path: sourcePath });
        }
      }
    }
  }

  for (const [key, record] of records) {
    if (!record.supersedes) continue;
    if (record.supersedes === key) {
      issues.push(`${record.path}: '${key}' cannot supersede itself`);
      continue;
    }
    const target = records.get(record.supersedes);
    if (!target) {
      issues.push(`${record.path}: '${key}' supersedes unknown ${record.kind} '${record.supersedes}'`);
    } else if (target.kind !== record.kind) {
      issues.push(
        `${record.path}: '${key}' cannot supersede ${target.kind} '${record.supersedes}'`
      );
    }
  }

  const reportedCycles = new Set<string>();
  for (const key of records.keys()) {
    const cycle = findSupersessionCycle(key, records);
    if (!cycle) continue;
    const fingerprint = [...new Set(cycle)].sort().join("|");
    if (reportedCycles.has(fingerprint)) continue;
    reportedCycles.add(fingerprint);
    issues.push(`supersession cycle detected: ${cycle.join(" -> ")}`);
  }

  if (issues.length > 0) throw new ContractValidationError(issues);
  return { documents, warnings };
}
