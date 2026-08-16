import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

export const parserCompatibilitySet = "web-tree-sitter-0.26.12";

export type SupportedCodeLanguage =
  | "javascript"
  | "jsx"
  | "typescript"
  | "tsx"
  | "python"
  | "rust"
  | "sql";

export type ParserArtifactKey =
  | "runtime"
  | "javascript"
  | "typescript"
  | "tsx"
  | "python"
  | "rust"
  | "sql";

export interface SupportedCodeLanguageDefinition {
  id: SupportedCodeLanguage;
  artifact: Exclude<ParserArtifactKey, "runtime">;
  extensions: readonly string[];
  smokeSource: string;
}

export const supportedCodeLanguages: readonly SupportedCodeLanguageDefinition[] = [
  {
    id: "javascript",
    artifact: "javascript",
    extensions: [".js", ".mjs", ".cjs"],
    smokeSource: "export function ready() { return true; }\n",
  },
  {
    id: "jsx",
    artifact: "javascript",
    extensions: [".jsx"],
    smokeSource: "export function Ready() { return <span>ready</span>; }\n",
  },
  {
    id: "typescript",
    artifact: "typescript",
    extensions: [".ts", ".mts", ".cts"],
    smokeSource: "export function ready(value: boolean): boolean { return value; }\n",
  },
  {
    id: "tsx",
    artifact: "tsx",
    extensions: [".tsx"],
    smokeSource: "export function Ready(): JSX.Element { return <span>ready</span>; }\n",
  },
  {
    id: "python",
    artifact: "python",
    extensions: [".py", ".pyi"],
    smokeSource: "def ready() -> bool:\n    return True\n",
  },
  {
    id: "rust",
    artifact: "rust",
    extensions: [".rs"],
    smokeSource: "pub fn ready() -> bool { true }\n",
  },
  {
    id: "sql",
    artifact: "sql",
    extensions: [".sql"],
    smokeSource: "create table ready (id integer primary key);\n",
  },
] as const;

const languagesById = new Map(supportedCodeLanguages.map((language) => [language.id, language]));
const languagesByExtension = new Map(
  supportedCodeLanguages.flatMap((language) =>
    language.extensions.map((extension) => [extension, language.id] as const)
  )
);

export function languageForPath(path: string): SupportedCodeLanguage | undefined {
  return languagesByExtension.get(extname(path).toLowerCase());
}

export function codeLanguageDefinition(id: SupportedCodeLanguage): SupportedCodeLanguageDefinition {
  const definition = languagesById.get(id);
  if (!definition) {
    throw new Error(`Unsupported code language: ${id}`);
  }
  return definition;
}

export interface ParserArtifactManifest {
  file: string;
  sha256: string;
  abi: number | null;
  provenance: ParserArtifactProvenance;
}

export type ParserArtifactProvenance =
  | {
      kind: "npm";
      package: string;
      version: string;
      tarball_url: string;
      tarball_integrity: string;
    }
  | {
      kind: "source_build";
      project: string;
      version: string;
      revision: string;
      archive_url: string;
      archive_sha256: string;
      build_tool: string;
      build_sdk: string;
    };

export interface ParserCompatibilityManifest {
  schema_version: 2;
  compatibility_set: string;
  abi: { minimum: number; maximum: number };
  artifacts: Record<ParserArtifactKey, ParserArtifactManifest>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isParserArtifactProvenance(value: unknown): value is ParserArtifactProvenance {
  if (!isRecord(value)) return false;
  if (value.kind === "npm") {
    return (
      isNonEmptyString(value.package) &&
      isNonEmptyString(value.version) &&
      isNonEmptyString(value.tarball_url) &&
      /^sha512-[A-Za-z0-9+/]+=*$/.test(String(value.tarball_integrity))
    );
  }
  if (value.kind === "source_build") {
    return (
      isNonEmptyString(value.project) &&
      isNonEmptyString(value.version) &&
      isNonEmptyString(value.revision) &&
      isNonEmptyString(value.archive_url) &&
      /^[a-f0-9]{64}$/.test(String(value.archive_sha256)) &&
      isNonEmptyString(value.build_tool) &&
      isNonEmptyString(value.build_sdk)
    );
  }
  return false;
}

export async function readParserCompatibilityManifest(
  assetRoot: string
): Promise<ParserCompatibilityManifest> {
  const manifestPath = resolve(assetRoot, "manifest.json");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read parser compatibility manifest at ${manifestPath}`, {
      cause: error,
    });
  }
  if (
    !isRecord(value) ||
    value.schema_version !== 2 ||
    value.compatibility_set !== parserCompatibilitySet ||
    !isRecord(value.abi) ||
    !Number.isInteger(value.abi.minimum) ||
    !Number.isInteger(value.abi.maximum) ||
    !isRecord(value.artifacts)
  ) {
    throw new Error(`Invalid parser compatibility manifest at ${manifestPath}`);
  }
  for (const key of [
    "runtime",
    "javascript",
    "typescript",
    "tsx",
    "python",
    "rust",
    "sql",
  ] as const) {
    const artifact = value.artifacts[key];
    if (
      !isRecord(artifact) ||
      typeof artifact.file !== "string" ||
      typeof artifact.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      !(artifact.abi === null || Number.isInteger(artifact.abi)) ||
      !isParserArtifactProvenance(artifact.provenance)
    ) {
      throw new Error(`Invalid parser artifact '${key}' in ${manifestPath}`);
    }
  }
  return value as unknown as ParserCompatibilityManifest;
}
