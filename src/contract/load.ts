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

/**
 * Capability keys declared by the spec, read without validating the rest of
 * each document. The screen importer needs to know which capabilities exist
 * even while the contract is mid-edit — for example when it already carries
 * `shows` links to screens the import is about to create.
 */
export function readDeclaredCapabilityKeys(
  repositoryRoot: string,
  specDirectory = ".tieline/spec"
): Set<string> {
  const root = resolve(repositoryRoot);
  const directory = resolve(root, specDirectory);
  const keys = new Set<string>();
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return keys;
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
    const capability =
      document !== null && typeof document === "object"
        ? (document as { capability?: unknown }).capability
        : undefined;
    const key =
      capability !== null && typeof capability === "object"
        ? (capability as { key?: unknown }).key
        : undefined;
    if (typeof key === "string" && key.trim().length > 0) keys.add(key.trim());
  }
  return keys;
}
