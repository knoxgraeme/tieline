import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { gradePatch } from "../graders/grade-patch.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const casesDirectory = path.resolve(testDirectory, "../cases");

for (const filename of (await readdir(casesDirectory)).filter((name) => name.endsWith(".json"))) {
  const casePath = path.resolve(casesDirectory, filename);
  const testCase = JSON.parse(await readFile(casePath, "utf8"));

  for (const sample of testCase.samples) {
    test(`${testCase.id}: ${path.basename(sample.path)}`, async () => {
      const patchPath = path.resolve(casesDirectory, sample.path);
      const patch = await readFile(patchPath, "utf8");
      const result = gradePatch(patch, testCase);

      assert.equal(result.pass, sample.expectedPass);
      assert.deepEqual(result.violations.sort(), [...sample.expectedViolations].sort());
    });
  }
}
