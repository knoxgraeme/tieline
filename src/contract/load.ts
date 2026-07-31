import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parse } from "yaml";
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
  return {
    ...validateAcceptedContractDocuments(inputs),
    sources: inputs,
  };
}

export function loadAcceptedContract(
  repositoryRoot: string,
  specDirectory = ".tieline/spec"
): ValidatedContract {
  const { documents, warnings } = loadAcceptedContractWithSources(
    repositoryRoot,
    specDirectory
  );
  return { documents, warnings };
}
