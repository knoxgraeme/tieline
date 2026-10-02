import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

/**
 * Opening a FIFO for reading blocks until something writes to it, before the
 * descriptor can be checked. Opened non-blocking, it opens at once and is
 * refused as not a file; a regular file reads the same either way.
 */
const READ_FLAGS =
  process.platform === "win32"
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NONBLOCK;

const CHUNK_BYTES = 64 * 1024;

export type BoundedRead =
  | { status: "read"; bytes: Buffer }
  /** `size`: the size reported, or the bytes read once they passed the bound. */
  | { status: "too_large"; size: number }
  | { status: "not_file" };

/**
 * Reads a regular file of at most `maxBytes` bytes through one descriptor.
 * The bound is checked against the size the descriptor reports and again
 * against the bytes actually read, so a file that grows or is replaced after
 * someone else measured it cannot be read past the bound. A failure to open
 * the file is thrown, with its cause.
 */
export function readFileWithin(path: string, maxBytes: number): BoundedRead {
  const descriptor = openSync(path, READ_FLAGS);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) return { status: "not_file" };
    if (stat.size > maxBytes) return { status: "too_large", size: stat.size };
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, maxBytes + 1));
    let total = 0;
    for (;;) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      total += read;
      if (total > maxBytes) return { status: "too_large", size: total };
      chunks.push(Buffer.from(buffer.subarray(0, read)));
    }
    return { status: "read", bytes: Buffer.concat(chunks) };
  } finally {
    closeSync(descriptor);
  }
}
