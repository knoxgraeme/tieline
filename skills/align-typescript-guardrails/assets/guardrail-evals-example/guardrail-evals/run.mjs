#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const tests = readdirSync(path.join(root, "tests"))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => path.join(root, "tests", name));

if (tests.length === 0) {
  console.error("No guardrail tests found.");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...tests], {
  stdio: "inherit",
});

process.exit(result.status ?? 1);
