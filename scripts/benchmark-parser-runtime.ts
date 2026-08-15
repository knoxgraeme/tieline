import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { supportedCodeLanguages } from "../src/contract/code-analysis/languages.js";
import { createCodeParserRuntime } from "../src/contract/code-analysis/runtime.js";

function directoryBytes(path: string): number {
  return readdirSync(path, { withFileTypes: true }).reduce((total, entry) => {
    const child = resolve(path, entry.name);
    return total + (entry.isDirectory() ? directoryBytes(child) : statSync(child).size);
  }, 0);
}

const coldProgram = `
  const started = performance.now();
  const { createCodeParserRuntime } = await import('./dist/contract/code-analysis/runtime.js');
  const { supportedCodeLanguages } = await import('./dist/contract/code-analysis/languages.js');
  const runtime = createCodeParserRuntime();
  await Promise.all(supportedCodeLanguages.map((language) => runtime.withParser(language.id, (parser) => {
    const tree = parser.parse(language.smokeSource);
    if (!tree) throw new Error('parse failed');
    tree.delete();
  })));
  process.stdout.write(String(performance.now() - started));
`;
const coldInitializationMs = Array.from({ length: 5 }, () =>
  Number(
    execFileSync(process.execPath, ["--input-type=module", "--eval", coldProgram], {
      encoding: "utf8",
    })
  )
).sort((left, right) => left - right);

const baselineRssBytes = process.memoryUsage().rss;
const runtime = createCodeParserRuntime();
await runtime.initialize();
const warmStarted = performance.now();
for (let iteration = 0; iteration < 25; iteration += 1) {
  for (const language of supportedCodeLanguages) {
    await runtime.withParser(language.id, (parser) => {
      const tree = parser.parse(language.smokeSource);
      assert.ok(tree);
      tree.delete();
    });
  }
}
const warmParseMs = performance.now() - warmStarted;

let active = 0;
let peakConcurrency = 0;
const mixedStarted = performance.now();
await Promise.all(
  Array.from({ length: 24 }, (_, index) =>
    runtime.withParser(supportedCodeLanguages[index % supportedCodeLanguages.length]!.id, async (parser) => {
      active += 1;
      peakConcurrency = Math.max(peakConcurrency, active);
      await new Promise((resolveWaiter) => setTimeout(resolveWaiter, 2));
      const tree = parser.parse("const value = 1;\n");
      assert.ok(tree);
      tree.delete();
      active -= 1;
    })
  )
);
const mixedConcurrentMs = performance.now() - mixedStarted;

const assetBytes = directoryBytes(resolve("assets/parsers/web-tree-sitter-0.26.12"));
const installedParserBytes = assetBytes + directoryBytes(resolve("node_modules/web-tree-sitter"));
const rssBytes = process.memoryUsage().rss;
const medianColdInitializationMs = coldInitializationMs[Math.floor(coldInitializationMs.length / 2)]!;
const worstColdInitializationMs = coldInitializationMs.at(-1)!;

assert.ok(assetBytes <= 8 * 1024 * 1024, `parser assets exceed 8 MiB: ${assetBytes}`);
assert.ok(installedParserBytes <= 13 * 1024 * 1024, `parser footprint exceeds 13 MiB: ${installedParserBytes}`);
assert.ok(medianColdInitializationMs <= 2_000, `median initialization exceeds 2s`);
assert.ok(worstColdInitializationMs <= 4_000, `worst initialization exceeds 4s`);
assert.ok(peakConcurrency <= 4, `parser concurrency exceeded four: ${peakConcurrency}`);

process.stdout.write(
  `${JSON.stringify(
    {
      coldInitializationMs,
      medianColdInitializationMs,
      worstColdInitializationMs,
      warmParseCount: 25 * supportedCodeLanguages.length,
      warmParseMs,
      mixedConcurrentCount: 24,
      mixedConcurrentMs,
      peakConcurrency,
      baselineRssBytes,
      rssBytes,
      rssGrowthBytes: rssBytes - baselineRssBytes,
      assetBytes,
      installedParserBytes,
    },
    null,
    2
  )}\n`
);
