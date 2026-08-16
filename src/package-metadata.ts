import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface TielinePackageMetadata {
  name: string;
  version: string;
}

const packageMetadata = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../package.json"),
    "utf8"
  )
) as Partial<TielinePackageMetadata>;

if (
  typeof packageMetadata.name !== "string" ||
  typeof packageMetadata.version !== "string"
) {
  throw new Error("Tieline package metadata is missing its name or version.");
}

export const TIELINE_PACKAGE_NAME = packageMetadata.name;
export const TIELINE_VERSION = packageMetadata.version;
export const TIELINE_PACKAGE_SPEC =
  `${TIELINE_PACKAGE_NAME}@${TIELINE_VERSION}`;
