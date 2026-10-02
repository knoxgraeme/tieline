import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ContractManifest } from "./manifest.js";
import type { ScreenSettings } from "./screen-catalog.js";
import { readBoundedFile } from "./screen-import.js";

/**
 * What hosted screens publish and keep. A hosted site serves each ref's
 * review page and the images it shows; the images are stored once, by digest,
 * in an S3-compatible bucket, and their metadata and the pages live in
 * Postgres. Every bound here is enforced before anything is written.
 */
export const HOSTED_SCREEN_LIMITS = {
  /** Largest image published; the database enforces the same bound. */
  imageBytes: 25 * 1024 * 1024,
  /** Most distinct images one page may show. */
  images: 20_000,
  /** Largest rendered page stored. */
  pageBytes: 16 * 1024 * 1024,
  /** Largest stored manifest. */
  manifestBytes: 16 * 1024 * 1024,
  /** Object storage requests in flight at once. */
  concurrency: 4,
  /**
   * An unreferenced image is deleted only this long after anything last
   * referenced it, so a publish that is still uploading never loses one.
   */
  imageGraceHours: 24,
  /**
   * A closed pull request's page is kept this long, so its images survive
   * until the merge reaches `main`'s sync.
   */
  closedGraceHours: 24,
  /** Most images one prune deletes; the next prune continues. */
  pruneImages: 1_000,
} as const;

export type HostedImageType = "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "image/avif";

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  return bytes.length >= offset + prefix.length && prefix.every((byte, index) => bytes[offset + index] === byte);
}

const ascii = (text: string): number[] => [...text].map((character) => character.charCodeAt(0));

/**
 * The image type `bytes` hold, judged by their signature rather than a file
 * name. SVG is never accepted: an SVG opened directly runs its scripts.
 */
export function sniffImageType(bytes: Uint8Array): HostedImageType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return "image/gif";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";
  if (startsWith(bytes, ascii("ftyp"), 4) && (startsWith(bytes, ascii("avif"), 8) || startsWith(bytes, ascii("avis"), 8))) {
    return "image/avif";
  }
  return null;
}

/** Where an image is stored in the bucket. */
export function hostedImageKey(repositoryKey: string, digest: string): string {
  return `${repositoryKey}/sha256/${digest}`;
}

export interface HostedImageReference {
  digest: string;
  /** The image's path inside the captures directory. */
  path: string;
  /** The screens that show it, sorted. */
  screens: string[];
}

/**
 * Each screen's image digest, by key, for the screens whose catalog entry
 * names a captured file and its digest. Images given by URL are not hosted.
 */
export function screenImageDigests(manifest: ContractManifest): Map<string, string> {
  const digests = new Map<string, string>();
  for (const catalog of manifest.screen_catalogs ?? []) {
    for (const screen of catalog.screens) {
      const image = screen.image;
      if (image && "path" in image && image.sha256 !== undefined) digests.set(screen.stable_id, image.sha256);
    }
  }
  return digests;
}

/** The images a manifest's screens show, once per digest, sorted by digest. */
export function hostedImageReferences(manifest: ContractManifest): HostedImageReference[] {
  const references = new Map<string, HostedImageReference>();
  for (const catalog of manifest.screen_catalogs ?? []) {
    for (const screen of catalog.screens) {
      const image = screen.image;
      if (!image || !("path" in image) || image.sha256 === undefined) continue;
      const reference = references.get(image.sha256) ?? { digest: image.sha256, path: image.path, screens: [] };
      reference.screens.push(screen.stable_id);
      references.set(image.sha256, reference);
    }
  }
  if (references.size > HOSTED_SCREEN_LIMITS.images) {
    throw new Error(
      `The catalog shows ${references.size} distinct images; hosted screens publish at most ${HOSTED_SCREEN_LIMITS.images}.`
    );
  }
  return [...references.values()]
    .map((reference) => ({ ...reference, screens: reference.screens.sort((left, right) => left.localeCompare(right)) }))
    .sort((left, right) => left.digest.localeCompare(right.digest));
}

export interface LocalHostedImage {
  digest: string;
  contentType: HostedImageType;
  bytes: Buffer;
}

export type LocalImageRead =
  | { status: "ok"; image: LocalHostedImage }
  | { status: "missing" | "unusable"; detail: string };

/**
 * Reads a captured image from the captures directory and proves it is the
 * one the catalog names: within the size bound, the same digest, and an
 * image type the site serves. A missing file is ordinary, because screenshots
 * are not committed; whether that matters depends on whether the bucket
 * already holds the image.
 */
export function readLocalHostedImage(settings: ScreenSettings, reference: HostedImageReference): LocalImageRead {
  const path = resolve(settings.capturesDirectory, reference.path);
  if (!existsSync(path)) {
    return { status: "missing", detail: `${settings.capturesPath}/${reference.path} does not exist` };
  }
  let bytes: Buffer;
  try {
    bytes = readBoundedFile(path, HOSTED_SCREEN_LIMITS.imageBytes, "screenshot");
  } catch (error) {
    return { status: "unusable", detail: error instanceof Error ? error.message : String(error) };
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== reference.digest) {
    return {
      status: "unusable",
      detail: `${settings.capturesPath}/${reference.path} is not the image the catalog records (its digest is ${digest}); re-capture it`,
    };
  }
  const contentType = sniffImageType(bytes);
  if (!contentType) {
    return {
      status: "unusable",
      detail: `${settings.capturesPath}/${reference.path} is not a PNG, JPEG, WebP, GIF, or AVIF image; hosted screens never serve SVG or unknown types`,
    };
  }
  return { status: "ok", image: { digest, contentType, bytes } };
}

/**
 * The screens whose image changed between `previous` (each key's latest
 * recorded digest) and `current`, as history rows to add. A screen that
 * disappeared adds nothing; its history stays until retention trims it.
 */
export function changedScreenImages(
  previous: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>
): Array<{ key: string; digest: string }> {
  return [...current]
    .filter(([key, digest]) => previous.get(key) !== digest)
    .map(([key, digest]) => ({ key, digest }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

/** Pull requests are `pr-<number>`; anything else is a branch. */
export type HostedRef = { kind: "pr"; name: string } | { kind: "branch"; name: string };

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/**
 * Parses the ref a publish targets. `main` is never a target: it is published
 * only by `tieline contract sync`, which holds the repository sync role.
 */
export function parseHostedRef(input: { pullRequest?: string | undefined; branch?: string | undefined }): HostedRef {
  if ((input.pullRequest === undefined) === (input.branch === undefined)) {
    throw new Error("Name exactly one of --pull-request <number> or --branch <name>.");
  }
  if (input.pullRequest !== undefined) {
    if (!/^[1-9][0-9]{0,9}$/.test(input.pullRequest)) {
      throw new Error(`--pull-request must be a pull request number, not '${input.pullRequest}'.`);
    }
    return { kind: "pr", name: input.pullRequest };
  }
  const branch = input.branch!;
  if (!BRANCH.test(branch) || /(\.\.|\/\/|\/$|\.lock$)/.test(branch)) {
    throw new Error(`--branch '${branch}' is not a branch name hosted screens accept.`);
  }
  if (branch === "main" || branch === "master") {
    throw new Error(
      `--branch ${branch}: the default branch is published by \`tieline contract sync\`, not by \`screens publish\`.`
    );
  }
  return { kind: "branch", name: branch };
}

/** How the hosted site names a ref in its URL: `pr-123`, or the branch name. */
export function hostedRefLabel(ref: HostedRef): string {
  return ref.kind === "pr" ? `pr-${ref.name}` : ref.name;
}
