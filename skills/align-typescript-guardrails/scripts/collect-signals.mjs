#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.argv[2] || process.cwd());
const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirectories = new Set([
  ".git",
  ".next",
  ".turbo",
  ".yarn",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "vendor",
]);
const sourceExtensions = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const maxSamples = 12;

function read(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function stripJsonComments(text) {
  let output = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        output += char;
      } else {
        output += " ";
      }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        output += "  ";
        index++;
      } else {
        output += char === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
    } else if (char === "/" && next === "/") {
      lineComment = true;
      output += "  ";
      index++;
    } else if (char === "/" && next === "*") {
      blockComment = true;
      output += "  ";
      index++;
    } else {
      output += char;
    }
  }
  return output;
}

function removeTrailingCommas(text) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === ",") {
      let lookahead = index + 1;
      while (lookahead < text.length && /\s/.test(text[lookahead])) lookahead++;
      if (text[lookahead] === "}" || text[lookahead] === "]") continue;
    }
    output += char;
  }
  return output;
}

function parseJsonc(path) {
  const text = read(path);
  if (text === null) return { value: null, error: "unreadable" };
  try {
    return { value: JSON.parse(removeTrailingCommas(stripJsonComments(text))), error: null };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function walk(directory, files = []) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (path === skillRoot || path.startsWith(`${skillRoot}/`)) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walk(path, files);
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function relativePath(path) {
  return relative(root, path).replaceAll("\\", "/") || ".";
}

function firstExisting(candidates) {
  return candidates.filter((candidate) => existsSync(resolve(root, candidate)));
}

function collectPattern(files, expression) {
  const samples = [];
  let count = 0;
  for (const path of files) {
    const text = read(path);
    if (text === null) continue;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      expression.lastIndex = 0;
      if (!expression.test(lines[index])) continue;
      count++;
      if (samples.length < maxSamples) {
        samples.push(`${relativePath(path)}:${index + 1}`);
      }
    }
  }
  return { count, samples };
}

if (!existsSync(root) || !statSync(root).isDirectory()) {
  console.error(`Not a directory: ${root}`);
  process.exit(2);
}

const allFiles = walk(root);
const repositoryFiles = allFiles.map(relativePath);
const sourceFiles = allFiles.filter((path) => sourceExtensions.has(extname(path)) && !path.endsWith(".d.ts"));
const packagePath = resolve(root, "package.json");
const packageResult = parseJsonc(packagePath);
const packageJson = packageResult.value && typeof packageResult.value === "object" ? packageResult.value : {};
const packageManifests = allFiles
  .map(relativePath)
  .filter((path) => basename(path) === "package.json")
  .sort();
const scripts = packageJson.scripts && typeof packageJson.scripts === "object" ? packageJson.scripts : {};
const dependencies = {
  ...(packageJson.dependencies && typeof packageJson.dependencies === "object" ? packageJson.dependencies : {}),
  ...(packageJson.devDependencies && typeof packageJson.devDependencies === "object" ? packageJson.devDependencies : {}),
};

const tsconfigNames = allFiles
  .map(relativePath)
  .filter((path) => /(^|\/)tsconfig[^/]*\.json$/.test(path))
  .sort();
const tsconfigs = tsconfigNames.map((path) => {
  const result = parseJsonc(resolve(root, path));
  const options =
    result.value && typeof result.value === "object" &&
    result.value.compilerOptions && typeof result.value.compilerOptions === "object"
      ? result.value.compilerOptions
      : {};
  return {
    path,
    parse_error: result.error,
    extends: result.value?.extends ?? null,
    include: result.value?.include ?? null,
    exclude: result.value?.exclude ?? null,
    flags: {
      strict: options.strict ?? null,
      noUncheckedIndexedAccess: options.noUncheckedIndexedAccess ?? null,
      exactOptionalPropertyTypes: options.exactOptionalPropertyTypes ?? null,
      noImplicitReturns: options.noImplicitReturns ?? null,
      noFallthroughCasesInSwitch: options.noFallthroughCasesInSwitch ?? null,
      noImplicitOverride: options.noImplicitOverride ?? null,
      useUnknownInCatchVariables: options.useUnknownInCatchVariables ?? null,
      allowJs: options.allowJs ?? null,
      checkJs: options.checkJs ?? null,
      skipLibCheck: options.skipLibCheck ?? null,
    },
  };
});

const eslintConfigs = firstExisting([
  "eslint.config.js", "eslint.config.cjs", "eslint.config.mjs", "eslint.config.ts",
  ".eslintrc", ".eslintrc.cjs", ".eslintrc.js", ".eslintrc.json", ".eslintrc.yml", ".eslintrc.yaml",
]);
const formatterConfigs = firstExisting([
  ".prettierrc", ".prettierrc.cjs", ".prettierrc.js", ".prettierrc.json", ".prettierrc.yml",
  "prettier.config.cjs", "prettier.config.js", "prettier.config.mjs", "biome.json", "biome.jsonc",
]);
const ciFiles = allFiles
  .map(relativePath)
  .filter((path) => path.startsWith(".github/workflows/") || path === ".gitlab-ci.yml" || path.startsWith(".circleci/"))
  .sort();
const ciText = ciFiles.map((path) => read(resolve(root, path)) || "").join("\n");
const dependencyKeys = Object.keys(dependencies);
const agentInstructionFiles = repositoryFiles
  .filter((path) => /(^|\/)AGENTS(?:\.override)?\.md$/.test(path))
  .sort();
const codexHookFiles = repositoryFiles
  .filter((path) => /(^|\/)\.codex\/(?:hooks\.json|hooks\/)/.test(path))
  .sort();
const codexRuleFiles = repositoryFiles
  .filter((path) => /(^|\/)\.codex\/rules\/.*\.rules$/.test(path))
  .sort();
const guardrailEvalFiles = repositoryFiles
  .filter((path) =>
    /(^|\/)(?:guardrail-evals?|guardrails?\/evals?|evals?\/guardrails?)(\/|$)/i.test(path)
  )
  .sort();
const guardrailCommand =
  scripts["test:guardrails"] ?? scripts["guardrails:test"] ?? scripts["eval:guardrails"] ?? null;

const lineCount = sourceFiles.reduce((total, path) => {
  const text = read(path);
  return total + (text === null || text === "" ? 0 : text.split(/\r?\n/).length);
}, 0);

const result = {
  schema_version: 2,
  root,
  note: "Signals are search leads, not compliance verdicts. Verify material findings in context.",
  project: {
    package_name: typeof packageJson.name === "string" ? packageJson.name : null,
    package_json_parse_error: packageResult.error,
    package_manifests: packageManifests,
    workspace_patterns: packageJson.workspaces ?? null,
    source_files: sourceFiles.length,
    source_lines: lineCount,
    node_engine: packageJson.engines?.node ?? null,
    package_manager: packageJson.packageManager ?? null,
    runtime_pins: firstExisting([".nvmrc", ".node-version", ".tool-versions", "mise.toml", "volta.json"]),
    lockfiles: firstExisting(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]),
  },
  commands: {
    check: scripts.check ?? null,
    typecheck: scripts.typecheck ?? scripts["type-check"] ?? null,
    lint: scripts.lint ?? null,
    test: scripts.test ?? null,
    build: scripts.build ?? null,
    format_check: scripts["format:check"] ?? scripts["check:format"] ?? null,
    guardrails: guardrailCommand,
  },
  typescript: {
    configs: tsconfigs,
  },
  lint_and_format: {
    eslint_configs: eslintConfigs,
    formatter_configs: formatterConfigs,
    typescript_eslint_dependency: dependencyKeys.some((key) => key === "typescript-eslint" || key.startsWith("@typescript-eslint/")),
  },
  tests: {
    likely_test_files: sourceFiles.map(relativePath).filter((path) =>
      /(^|\/)(__tests__|test|tests)\//.test(path) ||
      /(^|\/)(test|spec)[-_.][^/]*\.[cm]?[jt]sx?$/.test(path) ||
      /\.(spec|test)\.[cm]?[jt]sx?$/.test(path)
    ).length,
    focused_tests: collectPattern(sourceFiles, /\b(?:describe|it|test)\.only\s*\(/),
    skipped_tests: collectPattern(sourceFiles, /\b(?:describe|it|test)\.skip\s*\(/),
  },
  control_plane: {
    ci_files: ciFiles,
    agent_instruction_files: agentInstructionFiles,
    codex_hook_files: codexHookFiles,
    codex_rule_files: codexRuleFiles,
    codeowners: firstExisting([".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]),
    dependabot: firstExisting([".github/dependabot.yml", ".github/dependabot.yaml"]),
    renovate: firstExisting(["renovate.json", "renovate.json5", ".renovaterc", ".renovaterc.json"]),
    code_scanning_signal: /\b(codeql|semgrep|code-scanning)\b/i.test(ciText),
  },
  guardrail_evaluation: {
    files: guardrailEvalFiles.slice(0, 100),
    file_count: guardrailEvalFiles.length,
    command: guardrailCommand,
    ci_mentions_guardrails:
      /\b(?:test:guardrails|guardrails:test|eval:guardrails)\b/.test(ciText) ||
      (typeof guardrailCommand === "string" && ciText.includes(guardrailCommand)),
    promptfoo_dependency: dependencyKeys.includes("promptfoo"),
  },
  boundary_schema_dependencies: dependencyKeys
    .filter((key) => ["arktype", "io-ts", "joi", "runtypes", "superstruct", "typebox", "valibot", "yup", "zod"].some((name) => key === name || key.includes(name)))
    .sort(),
  code_signals: {
    ts_ignore: collectPattern(sourceFiles, /@ts-ignore\b/),
    ts_expect_error: collectPattern(sourceFiles, /@ts-expect-error\b/),
    eslint_disable: collectPattern(sourceFiles, /eslint-disable/),
    explicit_any_or_any_cast: collectPattern(sourceFiles, /(?:\bas\s+any\b|:\s*any\b|<any>)/),
    double_cast: collectPattern(sourceFiles, /\bas\s+unknown\s+as\b/),
    open_ended_loop: collectPattern(sourceFiles, /\bwhile\s*\(\s*true\s*\)/),
    data_sized_promise_all: collectPattern(sourceFiles, /\bPromise\.all\s*\([^)]*\.map\s*\(/),
    empty_catch_same_line: collectPattern(sourceFiles, /\bcatch(?:\s*\([^)]*\))?\s*\{\s*\}/),
  },
  sensitive_path_signals: allFiles
    .map(relativePath)
    .filter((path) => /(^|\/)(auth|authorization|billing|crypto|migration|migrations|payment|permissions|secrets?|security)(\/|[._-])/i.test(path))
    .slice(0, 100),
};

console.log(JSON.stringify(result, null, 2));
