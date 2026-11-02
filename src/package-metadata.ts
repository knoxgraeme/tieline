import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface TiepointPackageMetadata {
  name: string;
  version: string;
}

const packageMetadata = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../package.json"),
    "utf8"
  )
) as Partial<TiepointPackageMetadata>;

if (
  typeof packageMetadata.name !== "string" ||
  typeof packageMetadata.version !== "string"
) {
  throw new Error("Tiepoint package metadata is missing its name or version.");
}

export const TIEPOINT_PACKAGE_NAME = packageMetadata.name;
export const TIEPOINT_VERSION = packageMetadata.version;
export const TIEPOINT_PACKAGE_SPEC =
  `${TIEPOINT_PACKAGE_NAME}@${TIEPOINT_VERSION}`;
