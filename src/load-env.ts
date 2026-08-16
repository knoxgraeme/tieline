/**
 * Minimal .env loader (no dependency). Side-effecting: import this FIRST, before
 * anything that reads config, so process.env is populated. Existing env vars
 * (e.g. those set by the MCP host) always win over the file.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const path = resolve(process.cwd(), ".env");
if (existsSync(path)) {
  const text = readFileSync(path, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
