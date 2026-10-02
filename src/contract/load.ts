import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parse } from "yaml";
import {
  readScreenCatalogSources,
  screenSettingsForRepository,
  type ScreenCatalogSource,
  type ScreenSettings,
} from "./screen-catalog.js";
import { screenLinkSchema } from "./schema.js";
import {
  ContractValidationError,
  duplicateShowsLinkIssue,
  validateAcceptedContractDocuments,
  type ValidatedContract,
} from "./validate.js";

export interface AcceptedContractSource {
  path: string;
  absolutePath: string;
  content: string;
  document: unknown;
}

export interface LoadedAcceptedContract extends ValidatedContract {
  sources: AcceptedContractSource[];
  /**
   * Present only when the repository enabled screens: where its catalog and
   * captures live, and the catalog files `screens` was validated from.
   */
  screenCatalog?: {
    settings: ScreenSettings;
    sources: ScreenCatalogSource[];
  };
}

function yamlFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...yamlFiles(path));
    } else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
      files.push(path);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

/** True when the spec directory holds at least one YAML document. */
export function hasAcceptedContractSources(
  repositoryRoot: string,
  specDirectory = ".tieline/spec"
): boolean {
  const directory = resolve(resolve(repositoryRoot), specDirectory);
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    return false;
  }
  return yamlFiles(directory).length > 0;
}

export function loadAcceptedContractWithSources(
  repositoryRoot: string,
  specDirectory = ".tieline/spec"
): LoadedAcceptedContract {
  const root = resolve(repositoryRoot);
  const directory = resolve(root, specDirectory);
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new ContractValidationError([
      `contract directory '${relative(root, directory) || specDirectory}' does not exist`,
    ]);
  }

  const inputs = yamlFiles(directory).map((path) => {
    const displayPath = relative(root, path);
    const content = readFileSync(path, "utf8");
    try {
      return {
        path: displayPath,
        absolutePath: path,
        content,
        document: parse(content),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ContractValidationError([`${displayPath}: invalid YAML: ${message}`]);
    }
  });

  if (inputs.length === 0) {
    throw new ContractValidationError([
      `contract directory '${relative(root, directory)}' contains no YAML files`,
    ]);
  }
  // The catalog is read only when the repository opted in, so a disabled
  // feature never touches the catalog directory.
  const screenSettings = screenSettingsForRepository(root);
  const catalog = screenSettings
    ? readScreenCatalogSources(root, screenSettings)
    : undefined;
  // A catalog that could not be read in full cannot resolve shows links:
  // report why it could not be read rather than every link as unknown.
  if (catalog && !catalog.complete) throw new ContractValidationError(catalog.issues);
  let validated: ValidatedContract;
  try {
    // Pass the root so selector kinds declared by this repository are part of
    // the vocabulary. Without it validation would silently fall back to the
    // core kinds and reject a kind the repository legitimately declared.
    validated = validateAcceptedContractDocuments(inputs, {
      repositoryRoot: root,
      ...(catalog ? { screenCatalog: catalog.sources } : {}),
    });
  } catch (error) {
    if (catalog?.issues.length && error instanceof ContractValidationError) {
      throw new ContractValidationError([...catalog.issues, ...error.issues]);
    }
    throw error;
  }
  if (catalog?.issues.length) throw new ContractValidationError(catalog.issues);
  return {
    ...validated,
    sources: inputs,
    ...(screenSettings && catalog
      ? { screenCatalog: { settings: screenSettings, sources: catalog.sources } }
      : {}),
  };
}

export function loadAcceptedContract(
  repositoryRoot: string,
  specDirectory = ".tieline/spec"
): ValidatedContract {
  const { documents, warnings, screens } = loadAcceptedContractWithSources(
    repositoryRoot,
    specDirectory
  );
  return screens ? { documents, warnings, screens } : { documents, warnings };
}

/** A `shows` link as the working-tree spec authors it, read leniently. */
export interface DeclaredShowsLink {
  owner_kind: "story" | "acceptance_criterion";
  owner_stable_id: string;
  story_stable_id: string;
  screen_key: string;
  provenance: string;
}

/** What the working-tree spec says about screens, read leniently. */
export interface DeclaredScreenReferences {
  capabilityKeys: Set<string>;
  /** Valid declarations only, each owner's targets once. */
  showsLinks: DeclaredShowsLink[];
  /**
   * `shows` declarations the validator would refuse, worded as it words them:
   * a link that does not match the link schema, or a target an owner names
   * twice. Unknown screens are not among them; resolving those needs the
   * catalog.
   */
  showsIssues: string[];
}

function field(value: unknown, name: string): unknown {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function declaredShowsLinks(
  path: string,
  owner: Omit<DeclaredShowsLink, "screen_key" | "provenance">,
  links: unknown,
  issues: string[]
): DeclaredShowsLink[] {
  if (!Array.isArray(links)) return [];
  const seen = new Map<string, string>();
  return links.flatMap((link: unknown) => {
    // `shows` is only ever a screen link, so any link claiming it must match
    // the screen link schema; that also trims the key as the manifest does.
    if (field(link, "relation") !== "shows") return [];
    const parsed = screenLinkSchema.safeParse(link);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      issues.push(
        `${path}: '${owner.owner_stable_id}' has a 'shows' link that does not validate${
          issue ? `: ${[...issue.path].join(".") || "link"}: ${issue.message}` : ""
        }`
      );
      return [];
    }
    const { provenance, target } = parsed.data;
    const first = seen.get(target.key);
    if (first !== undefined) {
      issues.push(duplicateShowsLinkIssue(path, owner.owner_stable_id, first, provenance));
      return [];
    }
    seen.set(target.key, provenance);
    return [{ ...owner, screen_key: target.key, provenance }];
  });
}

/**
 * Capability keys and `shows` links declared by the spec, read without
 * validating the rest of each document. Screen tooling needs both even while
 * the contract is mid-edit: the importer, to know which capabilities exist
 * when the spec already carries links to screens it is about to create; check,
 * to resolve links the committed manifest does not hold yet, since a link to
 * an unknown screen is exactly what stops the spec from compiling.
 */
export function readDeclaredScreenReferences(
  repositoryRoot: string,
  specDirectory = ".tieline/spec"
): DeclaredScreenReferences {
  const root = resolve(repositoryRoot);
  const directory = resolve(root, specDirectory);
  const references: DeclaredScreenReferences = {
    capabilityKeys: new Set(),
    showsLinks: [],
    showsIssues: [],
  };
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    return references;
  }
  for (const path of yamlFiles(directory)) {
    let document: unknown;
    try {
      document = parse(readFileSync(path, "utf8"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ContractValidationError([
        `${relative(root, path)}: invalid YAML: ${message}`,
      ]);
    }
    // Worded as the validator words its paths.
    const shownPath = relative(root, path);
    const capability = field(document, "capability");
    const capabilityKey = nonEmptyString(field(capability, "key"));
    if (capabilityKey) references.capabilityKeys.add(capabilityKey);
    const stories = field(capability, "stories");
    for (const story of Array.isArray(stories) ? stories : []) {
      const storyKey = nonEmptyString(field(story, "key"));
      // A link's owner is named by its key; an unkeyed story or criterion
      // already stops the spec from compiling, which check reports.
      if (!storyKey) continue;
      references.showsLinks.push(
        ...declaredShowsLinks(
          shownPath,
          {
            owner_kind: "story",
            owner_stable_id: storyKey,
            story_stable_id: storyKey,
          },
          field(story, "links"),
          references.showsIssues
        )
      );
      const criteria = field(story, "acceptance_criteria");
      for (const criterion of Array.isArray(criteria) ? criteria : []) {
        const criterionKey = nonEmptyString(field(criterion, "key"));
        if (!criterionKey) continue;
        references.showsLinks.push(
          ...declaredShowsLinks(
            shownPath,
            {
              owner_kind: "acceptance_criterion",
              owner_stable_id: criterionKey,
              story_stable_id: storyKey,
            },
            field(criterion, "links"),
            references.showsIssues
          )
        );
      }
    }
  }
  return references;
}

/** Capability keys declared by the spec; see `readDeclaredScreenReferences`. */
export function readDeclaredCapabilityKeys(
  repositoryRoot: string,
  specDirectory = ".tieline/spec"
): Set<string> {
  return readDeclaredScreenReferences(repositoryRoot, specDirectory)
    .capabilityKeys;
}
