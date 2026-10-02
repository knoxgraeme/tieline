import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parse } from "yaml";
import {
  readScreenCatalogSources,
  screenSettingsForRepository,
  type ScreenCatalogSource,
  type ScreenSettings,
} from "./screen-catalog.js";
import {
  ContractValidationError,
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
  showsLinks: DeclaredShowsLink[];
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
  owner: Omit<DeclaredShowsLink, "screen_key" | "provenance">,
  links: unknown
): DeclaredShowsLink[] {
  if (!Array.isArray(links)) return [];
  return links.flatMap((link: unknown) => {
    const target = field(link, "target");
    const key = field(target, "key");
    if (
      field(link, "relation") !== "shows" ||
      field(target, "kind") !== "screen" ||
      typeof key !== "string"
    ) {
      return [];
    }
    const provenance = field(link, "provenance");
    return [
      {
        ...owner,
        screen_key: key,
        provenance: typeof provenance === "string" ? provenance : "",
      },
    ];
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
          {
            owner_kind: "story",
            owner_stable_id: storyKey,
            story_stable_id: storyKey,
          },
          field(story, "links")
        )
      );
      const criteria = field(story, "acceptance_criteria");
      for (const criterion of Array.isArray(criteria) ? criteria : []) {
        const criterionKey = nonEmptyString(field(criterion, "key"));
        if (!criterionKey) continue;
        references.showsLinks.push(
          ...declaredShowsLinks(
            {
              owner_kind: "acceptance_criterion",
              owner_stable_id: criterionKey,
              story_stable_id: storyKey,
            },
            field(criterion, "links")
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
