import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
  { command: ["npm", "run", "deploy:production"], decision: "prompt" },
  {
    command: ["npm", "run", "migrate:production", "--", "--confirm"],
    decision: "prompt",
  },
  { command: ["npm", "run", "migrate:test"], decision: null },
  { command: ["rm", "-rf", "build"], decision: "forbidden" },
];

const rulesText = readFileSync(rules, "utf8");
const ruleBlocks = rulesText.split(/^prefix_rule\(/m).slice(1);
const codexAvailable =
  spawnSync("codex", ["--version"], { encoding: "utf8" }).status === 0;

for (const fixture of cases) {
  test(`${fixture.command.join(" ")} is declared as a policy fixture`, () => {
    const command = JSON.stringify(fixture.command.join(" "));
    const block = ruleBlocks.find((candidate) => candidate.includes(command));
    assert.ok(block, `missing declared fixture ${command}`);
    if (fixture.decision === null) {
      assert.match(block, /not_match\s*=\s*\[/);
    } else {
      assert.match(block, new RegExp(`decision\\s*=\\s*"${fixture.decision}"`));
    }
  });
}

for (const fixture of cases) {
  test(
    `${fixture.command.join(" ")} => ${fixture.decision ?? "no match"}`,
    { skip: codexAvailable ? false : "Codex CLI is not installed" },
    () => {
    const result = spawnSync(
      "codex",
      ["execpolicy", "check", "--pretty", "--rules", rules, "--", ...fixture.command],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.decision ?? null, fixture.decision);
    },
  );
}
