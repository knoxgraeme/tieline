import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const hookDirectory = path.dirname(fileURLToPath(import.meta.url));
const hook = path.join(hookDirectory, "pre-tool-use.mjs");
const hookConfiguration = path.join(hookDirectory, "..", "hooks.json");

function runHook(patch) {
  const event = {
    hook_event_name: "PreToolUse",
    tool_input: { command: patch },
  };
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify(event),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  return result.stdout === "" ? {} : JSON.parse(result.stdout);
}

const cases = [
  {
    name: "allows an ordinary patch",
    patch: "+const value = 1;",
    decision: null,
    context: false,
  },
  {
    name: "denies @ts-ignore",
    patch: "+// @ts-ignore",
    decision: "deny",
    context: false,
  },
  {
    name: "denies a focused test",
    patch: "+test.only(\"focused\", () => {});",
    decision: "deny",
    context: false,
  },
  {
    name: "denies a described broad eslint-disable",
    patch: "+/* eslint-disable -- generated legacy */",
    decision: "deny",
    context: false,
  },
  {
    name: "allows a described eslint-disable with named rules",
    patch: "+/* eslint-disable no-console -- CLI output is intentional */",
    decision: null,
    context: false,
  },
  {
    name: "advises on a skipped test without denying it",
    patch: "+test.skip(\"quarantined\", () => {});",
    decision: null,
    context: true,
  },
  {
    name: "advises on a protected control-plane edit",
    patch: "*** Update File: tsconfig.json\n+  \"strict\": true",
    decision: null,
    context: true,
  },
];

for (const fixture of cases) {
  test(fixture.name, () => {
    const result = runHook(fixture.patch).hookSpecificOutput ?? {};
    assert.equal(result.permissionDecision ?? null, fixture.decision);
    assert.equal(Boolean(result.additionalContext), fixture.context);
  });
}

test("matches only the apply_patch payload shape the hook parses", () => {
  const configuration = JSON.parse(readFileSync(hookConfiguration, "utf8"));
  const matcher = configuration.hooks.PreToolUse[0].matcher;

  assert.equal(matcher, "^apply_patch$");
  assert.match("apply_patch", new RegExp(matcher));
  assert.doesNotMatch("Edit", new RegExp(matcher));
  assert.doesNotMatch("Write", new RegExp(matcher));
});
