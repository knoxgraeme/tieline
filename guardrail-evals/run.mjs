#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { cases } from "./cases.mjs";
import { gradePatch } from "./graders/grade-patch.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const requiredCategories = [
  "agent-instructions",
  "ci",
  "package-scripts",
  "source-validation",
  "typescript-config",
];
const requiredKinds = ["bypass", "legitimate", "violation"];

function percentage(numerator, denominator) {
  return denominator === 0 ? "n/a" : `${Math.round((numerator / denominator) * 100)}%`;
}

async function gradeOne(testCase) {
  const patch = await readFile(path.join(root, testCase.fixture), "utf8");
  const start = performance.now();
  const result = gradePatch(patch);
  const latencyMs = performance.now() - start;

  assert.equal(result.pass, testCase.expectedPass);
  assert.deepEqual(result.violations, [...testCase.expectedViolations].sort());
  return { ...testCase, result, latencyMs };
}

async function runFixtureSuite() {
  assert.equal(new Set(cases.map((testCase) => testCase.id)).size, cases.length);
  assert.deepEqual(
    [...new Set(cases.map((testCase) => testCase.category))].sort(),
    requiredCategories,
  );
  for (const category of requiredCategories) {
    const categoryCases = cases.filter((testCase) => testCase.category === category);
    assert.deepEqual(
      categoryCases.map((testCase) => testCase.kind).sort(),
      requiredKinds,
    );
    for (const testCase of categoryCases) {
      assert.equal(testCase.expectedPass, testCase.kind === "legitimate");
    }
  }

  const results = [];
  let failures = 0;

  for (const testCase of cases) {
    try {
      const result = await gradeOne(testCase);
      results.push(result);
      console.log(`PASS ${testCase.id} (${result.latencyMs.toFixed(2)} ms)`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${testCase.id}`);
      console.error(error instanceof Error ? error.message : String(error));
    }
  }

  const unsafe = results.filter((result) => result.kind !== "legitimate");
  const legitimate = results.filter((result) => result.kind === "legitimate");
  const caught = unsafe.filter((result) => !result.result.pass).length;
  const safelyAccepted = legitimate.filter((result) => result.result.pass).length;
  const bypasses = results.filter(
    (result) => result.kind === "bypass" && result.result.pass,
  ).length;
  const falsePositives = legitimate.filter((result) => !result.result.pass).length;
  const totalLatencyMs = results.reduce((sum, result) => sum + result.latencyMs, 0);

  console.log("");
  console.log(`Cases: ${results.length}/${cases.length} passed`);
  console.log(`Violation catch rate: ${percentage(caught, unsafe.length)}`);
  console.log(
    `Safe-task completion rate: ${percentage(safelyAccepted, legitimate.length)}`,
  );
  console.log(`Bypass rate: ${percentage(bypasses, results.filter((result) => result.kind === "bypass").length)}`);
  console.log(`False-positive rate: ${percentage(falsePositives, legitimate.length)}`);
  console.log(`Grader latency: ${totalLatencyMs.toFixed(2)} ms total`);
  console.log(
    "Scope: fixture self-test only; grade a supplied final diff with --patch <diff-file> or --stdin.",
  );

  if (failures > 0 || results.length !== cases.length) process.exitCode = 1;
}

async function gradeExternalPatch(patchPath) {
  const patch = await readFile(path.resolve(process.cwd(), patchPath), "utf8");
  gradeExternalDiff(patch);
}

function gradeExternalDiff(patch) {
  const result = gradePatch(patch);
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) process.exitCode = 1;
}

const patchFlag = process.argv.indexOf("--patch");
const stdinFlag = process.argv.includes("--stdin");
if (patchFlag >= 0 && stdinFlag) {
  console.error("Use either --patch <diff-file> or --stdin, not both.");
  process.exitCode = 2;
} else if (patchFlag >= 0) {
  const patchPath = process.argv[patchFlag + 1];
  if (!patchPath) {
    console.error("Usage: node guardrail-evals/run.mjs --patch <diff-file>");
    process.exitCode = 2;
  } else {
    await gradeExternalPatch(patchPath);
  }
} else if (stdinFlag) {
  process.stdin.setEncoding("utf8");
  let patch = "";
  for await (const chunk of process.stdin) patch += chunk;
  gradeExternalDiff(patch);
} else {
  await runFixtureSuite();
}
