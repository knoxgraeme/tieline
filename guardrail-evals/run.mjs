#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { cases } from "./cases.mjs";
import {
  gradePatch,
  isTypeScriptConfigPath,
  parsePatch,
} from "./graders/grade-patch.mjs";

const root = import.meta.dirname;
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
      [...new Set(categoryCases.map((testCase) => testCase.kind))].sort(),
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

async function gradeExternalPatch(patchPath, refs) {
  const patch = await readFile(path.resolve(process.cwd(), patchPath), "utf8");
  gradeExternalDiff(patch, loadFileContents(patch, refs));
}

function gradeExternalDiff(patch, fileContents = new Map()) {
  if (patch.trim() === "") {
    throw new Error("Refusing to grade an empty diff.");
  }
  const result = gradePatch(patch, { fileContents });
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) process.exitCode = 1;
}

function flagValue(argv, name) {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}

function resolveCommit(ref, flag) {
  if (!ref || ref.startsWith("--")) {
    throw new Error(`${flag} requires a Git ref.`);
  }
  const commit = execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!/^[0-9a-f]{40,64}$/i.test(commit)) {
    throw new Error(`${flag} did not resolve to a commit.`);
  }
  return commit;
}

function changedTypeScriptConfigs(patch) {
  const paths = new Set();
  for (const file of parsePatch(patch)) {
    for (const pathname of [file.oldPath, file.path]) {
      if (isTypeScriptConfigPath(pathname)) paths.add(pathname);
    }
  }
  return paths;
}

function readCommitFile(commit, pathname) {
  try {
    return execFileSync("git", ["show", `${commit}:${pathname}`], {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (showError) {
    try {
      execFileSync("git", ["cat-file", "-e", `${commit}:${pathname}`], {
        stdio: "ignore",
      });
    } catch {
      return undefined;
    }
    throw showError;
  }
}

function loadFileContents(patch, { baseRef, headRef }) {
  if (!baseRef && !headRef) return new Map();
  if (!baseRef || !headRef) {
    throw new Error("Use --base-ref and --head-ref together.");
  }

  const baseCommit = resolveCommit(baseRef, "--base-ref");
  const headCommit = resolveCommit(headRef, "--head-ref");
  return new Map(
    [...changedTypeScriptConfigs(patch)].map((pathname) => [
      pathname,
      {
        before: readCommitFile(baseCommit, pathname),
        after: readCommitFile(headCommit, pathname),
      },
    ]),
  );
}

const argv = process.argv.slice(2);
const patchFlag = argv.indexOf("--patch");
const stdinFlag = argv.includes("--stdin");
const refs = {
  baseRef: flagValue(argv, "--base-ref"),
  headRef: flagValue(argv, "--head-ref"),
};
if (patchFlag >= 0 && stdinFlag) {
  console.error("Use either --patch <diff-file> or --stdin, not both.");
  process.exitCode = 2;
} else if (patchFlag >= 0) {
  const patchPath = argv[patchFlag + 1];
  if (!patchPath) {
    console.error("Usage: node guardrail-evals/run.mjs --patch <diff-file>");
    process.exitCode = 2;
  } else {
    try {
      await gradeExternalPatch(patchPath, refs);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    }
  }
} else if (stdinFlag) {
  process.stdin.setEncoding("utf8");
  let patch = "";
  for await (const chunk of process.stdin) patch += chunk;
  try {
    gradeExternalDiff(patch, loadFileContents(patch, refs));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
} else {
  await runFixtureSuite();
}
