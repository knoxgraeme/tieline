import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rules = path.join(path.dirname(fileURLToPath(import.meta.url)), "guardrails.rules");

const cases = [
  { command: ["git", "clean", "-n"], decision: null },
  { command: ["git", "clean", "-fd"], decision: "prompt" },
  { command: ["git", "reset", "--hard"], decision: "forbidden" },
  { command: ["npm", "publish"], decision: "prompt" },
  { command: ["npm", "pack"], decision: null },
  { command: ["rm", "-rf", "build"], decision: "forbidden" },
];

for (const fixture of cases) {
  test(`${fixture.command.join(" ")} => ${fixture.decision ?? "no match"}`, () => {
    const result = spawnSync(
      "codex",
      ["execpolicy", "check", "--pretty", "--rules", rules, "--", ...fixture.command],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.decision ?? null, fixture.decision);
  });
}
