import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCli, type TielineCliIO } from "../../../src/cli.js";
import {
  CODE_TOPOLOGY_CACHE_MAX_ENTRIES,
  CODE_TOPOLOGY_IGNORE_CONTENT,
  runCodeTopologyArtifactCommand,
} from "../../../src/commands/code-topology-artifact.js";
import { workspaceFromConfig } from "../../../src/tieline/workspace.js";
import { report, test } from "../../support/harness.js";

console.log("Cached code topology lifecycle");

const roots: string[] = [];
const cacheRelative = ".tieline/topology/cache";
const legacyRelative = ".tieline/topology/graph.json";
let output = "";
const io: TielineCliIO = {
  write(message) { output += message; },
  error(message) { throw new Error(message); },
  async question() { throw new Error("topology cache commands must not prompt"); },
};

type CliResult = { exit: number; result: Record<string, unknown> };

async function cli(args: string[]): Promise<CliResult> {
  output = "";
  const exit = await runCli(args, io, {});
  return { exit, result: JSON.parse(output) as Record<string, unknown> };
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function configJson(topologyMode?: "committed" | "cached"): string {
  return `${JSON.stringify({
    version: 1,
    product: { name: "Cache fixture", repo_name: "cache-fixture" },
    repository: { root: "..", source_roots: ["src"], ignore: [".git", ".tieline"] },
    context: { sources: [] },
    runtime: { default_embedding_provider: "hash", default_database_mode: "offline" },
    files: { spec_directory: "spec", manifest: "manifest" },
    ...(topologyMode ? { topology_mode: topologyMode } : {}),
    created_at: "2026-10-13T00:00:00.000Z",
    updated_at: "2026-10-13T00:00:00.000Z",
  }, null, 2)}\n`;
}

const spec = `version: 1
capability:
  key: CACHE
  name: Cached topology
  description: Derived topology follows the exact snapshot being inspected.
  stories:
    - key: CACHE-001
      title: Consumer depends on target
      actor: implementing agent
      goal: see impact of target changes
      benefit: affected behavior can be reviewed
      lifecycle: production
      acceptance_criteria:
        - key: CACHE-001-AC1
          criterion: The consumer must return the target value.
          links:
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: cache-fixture
                path: src/consumer.ts
                selector: function:consumer
`;

function repository(prefix: string, topologyMode?: "committed" | "cached"): string {
  const root = mkdtempSync(join(tmpdir(), `tieline-topology-cache-${prefix}-`));
  roots.push(root);
  write(root, ".tieline/config.json", configJson(topologyMode));
  write(root, ".tieline/spec/cache.yaml", spec);
  write(root, "src/target.ts", "export function target() { return 1; }\n");
  write(root, "src/consumer.ts", 'import { target } from "./target";\nexport function consumer() { return target(); }\n');
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "cache@example.test"]);
  git(root, ["config", "user.name", "Cache Test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  return root;
}

function commitAll(root: string, message: string): void {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", message]);
}

function cacheEntries(root: string): string[] {
  const directory = join(root, cacheRelative);
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}

function cacheEntry(root: string, digest: unknown): string {
  assert.equal(typeof digest, "string");
  return join(root, cacheRelative, `${String(digest)}.json`);
}

function digestOf(result: Record<string, unknown>): string {
  const digest = result.selected_input_digest;
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`expected selected_input_digest in ${JSON.stringify(result)}`);
  }
  return digest;
}

interface Graph {
  symbols: Array<{ identity: string; file_path: string }>;
  edges: Array<{ source_symbol_identity: string; target_symbol_identity: string }>;
  frontiers: Array<{ file_path: string; module_specifier: string | null; status: string }>;
}

function graphAt(root: string, digest: string): Graph {
  return JSON.parse(readFileSync(cacheEntry(root, digest), "utf8")) as Graph;
}

function hasEdge(graph: Graph, from: string, to: string): boolean {
  const files = new Map(graph.symbols.map((symbol) => [symbol.identity, symbol.file_path]));
  return graph.edges.some((edge) =>
    files.get(edge.source_symbol_identity) === from &&
    files.get(edge.target_symbol_identity) === to
  );
}

function frontierStatus(graph: Graph, from: string, specifier: string): string | null {
  return graph.frontiers.find((frontier) =>
    frontier.file_path === from && frontier.module_specifier === specifier
  )?.status ?? null;
}

function mtimes(root: string): string {
  return cacheEntries(root)
    .map((name) => `${name}:${lstatSync(join(root, cacheRelative, name)).mtimeMs}`)
    .join("\n");
}

try {
  const plain = repository("plain");
  assert.equal((await cli(["contract", "compile", plain, "--json"])).exit, 0);
  let plainDigest = "";

  await test("an absent topology_mode compiles into the ignored cache, not graph.json", async () => {
    const compiled = await cli(["code", "compile", plain, "--json"]);
    assert.equal(compiled.exit, 0, JSON.stringify(compiled.result));
    assert.equal(compiled.result.status, "current");
    plainDigest = digestOf(compiled.result);
    assert.deepEqual(cacheEntries(plain), [`${plainDigest}.json`]);
    assert.equal(existsSync(join(plain, legacyRelative)), false);
    assert.equal(
      readFileSync(join(plain, ".tieline/topology/.gitignore"), "utf8"),
      CODE_TOPOLOGY_IGNORE_CONTENT
    );
    assert.equal(
      git(plain, ["status", "--porcelain", "--untracked-files=all", "--", ".tieline/topology"]),
      "?? .tieline/topology/.gitignore",
      "only the shared ignore rule is visible to Git"
    );
    const validated = await cli(["code", "validate", plain, "--json"]);
    assert.equal(validated.exit, 0);
    assert.equal(validated.result.status, "current");
    assert.equal(validated.result.artifact_digest, compiled.result.artifact_digest);
    assert.equal(validated.result.notices, undefined);
  });

  await test("an edited workspace misses the cache instead of reading an old graph", async () => {
    const source = readFileSync(join(plain, "src/consumer.ts"), "utf8");
    write(plain, "src/consumer.ts", `${source}// edited\n`);
    try {
      const missing = await cli(["code", "validate", plain, "--json"]);
      assert.equal(missing.exit, 1);
      assert.equal(missing.result.status, "topology_missing");
      assert.notEqual(digestOf(missing.result), plainDigest);
      assert.match(String(missing.result.detail), /tieline code compile \./);
    } finally {
      write(plain, "src/consumer.ts", source);
    }
    const restored = await cli(["code", "validate", plain, "--json"]);
    assert.equal(restored.result.status, "current", "reverting the edit selects the cached entry again");
  });

  await test("validate, trace, and blast radius never write the cache", async () => {
    const before = mtimes(plain);
    assert.equal((await cli(["code", "validate", plain, "--json"])).exit, 0);
    const traced = await cli([
      "code", "trace", "--repository", plain, "--path", "src/consumer.ts",
      "--direction", "dependencies", "--json",
    ]);
    assert.equal(traced.result.status, "complete", JSON.stringify(traced.result));
    const blast = await cli([
      "code", "blast-radius", "--repository", plain,
      "--changed", "src/target.ts", "--json",
    ]);
    assert.equal(blast.result.status, "complete", JSON.stringify(blast.result));
    assert.equal(mtimes(plain), before);
  });

  await test("tampered, relabeled, incompatible, unsafe, and oversized entries stay visible", async () => {
    const entry = cacheEntry(plain, plainDigest);
    const bytes = readFileSync(entry);
    const graph = JSON.parse(bytes.toString("utf8")) as Record<string, unknown> & {
      counts: { files: number };
      producer: { version: number };
    };
    const expectStatus = async (status: string): Promise<void> => {
      const validated = await cli(["code", "validate", plain, "--json"]);
      assert.equal(validated.exit, 1);
      assert.equal(validated.result.status, status, JSON.stringify(validated.result));
      assert.equal(validated.result.selected_input_digest, plainDigest);
    };
    try {
      writeFileSync(entry, Buffer.concat([bytes, Buffer.from(" ")]));
      await expectStatus("topology_invalid");
      writeFileSync(entry, `${JSON.stringify({ ...graph, counts: { ...graph.counts, files: graph.counts.files + 1 } })}\n`);
      await expectStatus("topology_invalid");
      writeFileSync(entry, `${JSON.stringify({ ...graph, producer: { ...graph.producer, version: graph.producer.version + 1 } })}\n`);
      await expectStatus("topology_incompatible");
      rmSync(entry);
      const outside = join(mkdtempSync(join(tmpdir(), "tieline-cache-outside-")), "graph.json");
      roots.push(dirname(outside));
      writeFileSync(outside, bytes);
      symlinkSync(outside, entry);
      await expectStatus("topology_unsafe_path");
      rmSync(entry);
      writeFileSync(entry, bytes);
      truncateSync(entry, 2 ** 31);
      await expectStatus("topology_capacity_exceeded");
    } finally {
      rmSync(entry, { force: true });
      writeFileSync(entry, bytes);
    }

    const source = readFileSync(join(plain, "src/consumer.ts"), "utf8");
    write(plain, "src/consumer.ts", `${source}// relabeled\n`);
    try {
      const missing = await cli(["code", "validate", plain, "--json"]);
      const relabeled = cacheEntry(plain, digestOf(missing.result));
      writeFileSync(relabeled, bytes);
      const stale = await cli(["code", "validate", plain, "--json"]);
      assert.equal(stale.result.status, "topology_stale", "an entry never answers for a different snapshot");
      rmSync(relabeled);
    } finally {
      write(plain, "src/consumer.ts", source);
    }

    writeFileSync(entry, Buffer.concat([bytes, Buffer.from(" ")]));
    const repaired = await cli(["code", "compile", plain, "--json"]);
    assert.equal(repaired.result.status, "current");
    assert.deepEqual(readFileSync(entry), bytes, "an explicit compile repairs a damaged entry");
  });

  await test("a symlinked cache directory fails closed", async () => {
    const cacheRoot = join(plain, cacheRelative);
    const saved = `${cacheRoot}.saved`;
    const outside = mkdtempSync(join(tmpdir(), "tieline-cache-dir-outside-"));
    roots.push(outside);
    execFileSync("mv", [cacheRoot, saved]);
    symlinkSync(outside, cacheRoot, "dir");
    try {
      const unsafe = await cli(["code", "validate", plain, "--json"]);
      assert.equal(unsafe.result.status, "topology_unsafe_path");
      const compile = await cli(["code", "compile", plain, "--json"]);
      assert.equal(compile.result.status, "topology_unsafe_path");
      assert.deepEqual(readdirSync(outside), []);
    } finally {
      rmSync(cacheRoot, { force: true });
      execFileSync("mv", [saved, cacheRoot]);
    }
  });

  await test("concurrent cached compiles serialize onto one entry", async () => {
    const compile = async (): Promise<CliResult> => {
      let message = "";
      const commandIo: TielineCliIO = { ...io, write(value) { message += value; } };
      const exit = await runCodeTopologyArtifactCommand("compile", { repository: plain, json: true }, commandIo);
      return { exit, result: JSON.parse(message) as Record<string, unknown> };
    };
    const [left, right] = await Promise.all([compile(), compile()]);
    assert.equal(left.result.status, "current");
    assert.equal(right.result.status, "current");
    assert.deepEqual(cacheEntries(plain), [`${plainDigest}.json`]);
  });

  await test("untrack in a cache-only repository stages just the ignore rule, then is a no-op", async () => {
    const first = await cli(["code", "untrack", plain, "--json"]);
    assert.equal(first.exit, 0, JSON.stringify(first.result));
    assert.equal(first.result.status, "untracked");
    assert.deepEqual(first.result.staged, [".tieline/topology/.gitignore"]);
    assert.equal(first.result.removed_from_index, false);
    assert.equal(git(plain, ["diff", "--cached", "--name-only", "--", ".tieline/topology"]), ".tieline/topology/.gitignore");
    const second = await cli(["code", "untrack", plain, "--json"]);
    assert.equal(second.result.status, "unchanged");
    assert.deepEqual(second.result.staged, []);
    assert.deepEqual(cacheEntries(plain), [`${plainDigest}.json`], "untrack keeps cache entries");
  });

  await test("committed mode reproduces the conflict that cached mode removes", async () => {
    const root = repository("committed-conflict", "committed");
    write(root, "src/deploy.ts", 'export function deploy() { return "deploy"; }\n');
    write(root, "src/quality.ts", 'export function quality() { return "quality"; }\n');
    assert.equal((await cli(["code", "compile", root, "--json"])).exit, 0);
    commitAll(root, "base");
    git(root, ["checkout", "-q", "-b", "left"]);
    write(root, "src/deploy.ts", 'export function deploy() { return "deploy"; }\nexport function rollback() { return 1; }\n');
    assert.equal((await cli(["code", "compile", root, "--json"])).exit, 0);
    commitAll(root, "left");
    git(root, ["checkout", "-q", "-b", "right", "main"]);
    write(root, "src/quality.ts", 'export function quality() { return "quality"; }\nexport function lint() { return 1; }\n');
    assert.equal((await cli(["code", "compile", root, "--json"])).exit, 0);
    commitAll(root, "right");
    const merge = spawnSync("git", ["merge", "--no-edit", "-q", "left"], { cwd: root, encoding: "utf8" });
    assert.notEqual(merge.status, 0);
    assert.equal(
      git(root, ["diff", "--name-only", "--diff-filter=U"]),
      legacyRelative,
      "independent source edits conflict only on the shared generated graph"
    );
  });

  await test("independent branches merge cleanly in both orders and compile to one fresh graph", async () => {
    const root = repository("merge");
    write(root, "tsconfig.json", '{"compilerOptions":{"baseUrl":".","paths":{"@lib/*":["src/lib-a/*"]}}}\n');
    write(root, "src/lib-a/util.ts", 'export function util() { return "a"; }\n');
    write(root, "src/lib-b/util.ts", 'export function util() { return "b"; }\n');
    write(root, "src/old.ts", "export function old() { return 0; }\n");
    write(root, "src/deploy.ts", 'export function deploy() { return "deploy"; }\n');
    write(root, "src/quality.ts", 'export function quality() { return "quality"; }\n');
    assert.equal((await cli(["contract", "compile", root, "--json"])).exit, 0);
    assert.equal((await cli(["code", "compile", root, "--json"])).exit, 0);
    commitAll(root, "base");
    assert.equal(
      git(root, ["ls-files", "--", ".tieline/topology"]),
      ".tieline/topology/.gitignore",
      "only the ignore rule is committed"
    );

    git(root, ["checkout", "-q", "-b", "left"]);
    write(root, "src/deploy.ts", 'export function deploy() { return "deploy"; }\nexport function rollback() { return "rollback"; }\n');
    write(root, "src/report.ts", 'import { helper } from "./helpers";\nexport function report() { return helper(); }\n');
    write(root, "src/feature.ts", 'import { util } from "@lib/util";\nexport function feature() { return util(); }\n');
    write(root, "src/legacy-user.ts", 'import { old } from "./old";\nexport function legacyUser() { return old(); }\n');
    const left = await cli(["code", "compile", root, "--json"]);
    assert.equal(left.result.status, "current");
    const leftGraph = graphAt(root, digestOf(left.result));
    commitAll(root, "left");

    git(root, ["checkout", "-q", "-b", "right", "main"]);
    write(root, "src/quality.ts", 'export function quality() { return "quality"; }\nexport function lint() { return "lint"; }\n');
    write(root, "src/helpers.ts", "export function helper() { return 42; }\n");
    write(root, "tsconfig.json", '{"compilerOptions":{"baseUrl":".","paths":{"@lib/*":["src/lib-b/*"]}}}\n');
    rmSync(join(root, "src/old.ts"));
    const right = await cli(["code", "compile", root, "--json"]);
    assert.equal(right.result.status, "current");
    const rightGraph = graphAt(root, digestOf(right.result));
    commitAll(root, "right");

    const merged: string[] = [];
    for (const [ours, theirs] of [["left", "right"], ["right", "left"]] as const) {
      git(root, ["checkout", "-q", "-b", `merge-${ours}-${theirs}`, ours]);
      const merge = spawnSync("git", ["merge", "--no-edit", "-q", theirs], { cwd: root, encoding: "utf8" });
      assert.equal(merge.status, 0, `merge ${ours} <- ${theirs}: ${merge.stdout}${merge.stderr}`);
      assert.equal(git(root, ["diff", "--name-only", "--diff-filter=U"]), "");
      rmSync(join(root, cacheRelative), { recursive: true, force: true });
      const compiled = await cli(["code", "compile", root, "--json"]);
      assert.equal(compiled.result.status, "current", JSON.stringify(compiled.result));
      merged.push(digestOf(compiled.result));
      merged.push(readFileSync(cacheEntry(root, digestOf(compiled.result)), "utf8"));
    }
    assert.equal(merged[0], merged[2], "both merge orders select the same inputs");
    assert.equal(merged[1], merged[3], "both merge orders compile byte-identical graphs");

    const mergedGraph = JSON.parse(merged[1]!) as Graph;
    assert.equal(hasEdge(leftGraph, "src/report.ts", "src/helpers.ts"), false);
    assert.equal(hasEdge(rightGraph, "src/report.ts", "src/helpers.ts"), false);
    assert.equal(hasEdge(mergedGraph, "src/report.ts", "src/helpers.ts"), true, "an added target resolves another branch's import");
    assert.equal(hasEdge(leftGraph, "src/feature.ts", "src/lib-a/util.ts"), true);
    assert.equal(hasEdge(mergedGraph, "src/feature.ts", "src/lib-a/util.ts"), false);
    assert.equal(hasEdge(mergedGraph, "src/feature.ts", "src/lib-b/util.ts"), true, "a resolver configuration change re-resolves another branch's import");
    assert.equal(hasEdge(leftGraph, "src/legacy-user.ts", "src/old.ts"), true);
    assert.equal(frontierStatus(mergedGraph, "src/legacy-user.ts", "./old"), "unresolved", "a deleted target leaves a visible frontier");

    const revision = await cli(["code", "compile", root, "--revision", "merge-left-right", "--json"]);
    assert.equal(revision.result.status, "current", JSON.stringify(revision.result));
    assert.equal(revision.result.queried_revision, git(root, ["rev-parse", "merge-left-right"]));
    assert.equal(digestOf(revision.result), merged[0], "an immutable revision and its checkout share one cache key");
    assert.equal(readFileSync(cacheEntry(root, merged[0]), "utf8"), merged[1]);
  });

  await test("base comparisons require an explicit revision compile and then read the cache", async () => {
    const root = repository("base");
    assert.equal((await cli(["contract", "compile", root, "--json"])).exit, 0);
    commitAll(root, "base");
    const base = git(root, ["rev-parse", "HEAD"]);
    git(root, ["checkout", "-q", "-b", "feature"]);
    write(root, "src/target.ts", "export function target() { return 2; }\n");
    assert.equal((await cli(["code", "compile", root, "--json"])).exit, 0);
    const blastArgs = ["code", "blast-radius", "--repository", root, "--base", "main", "--json"];

    const missing = await cli(blastArgs);
    assert.equal(missing.result.status, "topology_missing_at_revision");
    assert.match(String(missing.result.detail), new RegExp(`tieline code compile \\. --revision ${base}`));

    const compiled = await cli(["code", "compile", root, "--revision", "main", "--json"]);
    assert.equal(compiled.exit, 0, JSON.stringify(compiled.result));
    assert.equal(compiled.result.queried_revision, base);
    const blast = await cli(blastArgs);
    assert.equal(blast.result.status, "complete", JSON.stringify(blast.result));
    const traced = await cli([
      "code", "trace", "--repository", root, "--revision", "main",
      "--path", "src/consumer.ts", "--direction", "dependencies", "--json",
    ]);
    assert.equal(traced.result.status, "complete", JSON.stringify(traced.result));

    await assert.rejects(
      cli(["code", "compile", root, "--revision", "--upload-pack=x", "--json"]),
      /Expected a Git revision/
    );
    const unknown = await cli(["code", "compile", root, "--revision", "no-such-ref", "--json"]);
    assert.equal(unknown.result.status, "topology_invalid");
  });

  await test("explicit committed mode keeps its lifecycle and ignores the cache", async () => {
    const root = repository("committed-isolation");
    assert.equal((await cli(["code", "compile", root, "--json"])).exit, 0);
    const consumer = readFileSync(join(root, "src/consumer.ts"), "utf8");
    write(root, "src/consumer.ts", `${consumer}// cached snapshot\n`);
    assert.equal((await cli(["code", "compile", root, "--json"])).exit, 0);
    write(root, ".tieline/config.json", configJson("committed"));
    write(root, "src/consumer.ts", consumer);
    assert.equal((await cli(["code", "compile", root, "--json"])).exit, 0);
    assert.ok(existsSync(join(root, legacyRelative)), "committed mode publishes graph.json");
    write(root, "src/consumer.ts", `${consumer}// cached snapshot\n`);
    const stale = await cli(["code", "validate", root, "--json"]);
    assert.equal(stale.result.status, "topology_stale", "a matching cache entry does not hide a stale committed graph");
    await assert.rejects(
      cli(["code", "compile", root, "--revision", "HEAD", "--json"]),
      /requires topology_mode "cached"/
    );
    await assert.rejects(cli(["code", "untrack", root, "--json"]), /explicitly selects committed topology/);
  });

  await test("a legacy committed graph answers only while current, then untrack moves it to the cache", async () => {
    const root = repository("legacy");
    write(root, ".tieline/config.json", configJson("committed"));
    assert.equal((await cli(["contract", "compile", root, "--json"])).exit, 0);
    assert.equal((await cli(["code", "compile", root, "--json"])).exit, 0);
    write(root, ".tieline/config.json", configJson());
    commitAll(root, "legacy repository on the new default");
    const legacyBytes = readFileSync(join(root, legacyRelative));
    const head = git(root, ["rev-parse", "HEAD"]);

    const current = await cli(["code", "validate", root, "--json"]);
    assert.equal(current.result.status, "current", "upgrading breaks no read while the legacy graph is current");
    assert.deepEqual(cacheEntries(root), []);
    assert.match(JSON.stringify(current.result.notices), /tieline code untrack/);
    const traced = await cli([
      "code", "trace", "--repository", root, "--revision", "HEAD",
      "--path", "src/consumer.ts", "--direction", "dependencies", "--json",
    ]);
    assert.equal(traced.result.status, "complete", "historical committed graphs stay readable");

    const consumer = readFileSync(join(root, "src/consumer.ts"), "utf8");
    write(root, "src/consumer.ts", `${consumer}// edited after upgrade\n`);
    const ignored = await cli(["code", "validate", root, "--json"]);
    assert.equal(ignored.result.status, "topology_missing", "a stale legacy graph is never served");
    assert.match(String(ignored.result.detail), /legacy .* not current/);
    assert.equal((await cli(["code", "compile", root, "--json"])).exit, 0);
    assert.deepEqual(readFileSync(join(root, legacyRelative)), legacyBytes, "cached compiles never update the legacy graph");
    write(root, "src/consumer.ts", consumer);
    rmSync(join(root, cacheRelative), { recursive: true, force: true });

    git(root, ["checkout", "-q", "-b", "older-tieline"]);
    write(root, ".tieline/config.json", configJson("committed"));
    write(root, "src/target.ts", "export function target() { return 3; }\n");
    assert.equal((await cli(["code", "compile", root, "--json"])).exit, 0);
    write(root, ".tieline/config.json", configJson());
    commitAll(root, "branch from a developer still committing topology");
    git(root, ["checkout", "-q", "main"]);

    const untracked = await cli(["code", "untrack", root, "--json"]);
    assert.equal(untracked.exit, 0, JSON.stringify(untracked.result));
    assert.equal(untracked.result.status, "untracked");
    assert.equal(untracked.result.seeded_cache, true);
    assert.equal(untracked.result.removed_from_index, true);
    assert.equal(existsSync(join(root, legacyRelative)), false);
    assert.equal(git(root, ["rev-parse", "HEAD"]), head, "untrack never commits");
    assert.equal(
      git(root, ["diff", "--cached", "--name-status"]),
      "A\t.tieline/topology/.gitignore\nD\t.tieline/topology/graph.json"
    );
    const seeded = await cli(["code", "validate", root, "--json"]);
    assert.equal(seeded.result.status, "current");
    assert.equal(seeded.result.notices, undefined);
    assert.deepEqual(readFileSync(cacheEntry(root, seeded.result.selected_input_digest)), legacyBytes, "the cache is seeded without a compile");
    const again = await cli(["code", "untrack", root, "--json"]);
    assert.equal(again.exit, 0);
    assert.equal(again.result.status, "unchanged");
    git(root, ["commit", "-qm", "stop tracking derived topology"]);

    writeFileSync(join(root, legacyRelative), legacyBytes);
    git(root, ["add", "-A"]);
    assert.equal(git(root, ["status", "--porcelain"]), "", "an older compiler's graph.json cannot be added by accident");
    rmSync(join(root, legacyRelative));

    git(root, ["checkout", "-q", "older-tieline"]);
    const merge = spawnSync("git", ["merge", "--no-edit", "-q", "main"], { cwd: root, encoding: "utf8" });
    assert.notEqual(merge.status, 0, "a branch that kept modifying graph.json conflicts once");
    assert.equal(git(root, ["diff", "--name-only", "--diff-filter=U"]), legacyRelative);
    const healed = await cli(["code", "untrack", root, "--json"]);
    assert.equal(healed.exit, 0, JSON.stringify(healed.result));
    assert.equal(git(root, ["diff", "--name-only", "--diff-filter=U"]), "");
    git(root, ["commit", "-qm", "merge main", "--no-edit"]);
    assert.equal(git(root, ["ls-tree", "-r", "--name-only", "HEAD", "--", ".tieline/topology"]), ".tieline/topology/.gitignore");
  });

  await test("writers bound the cache and keep the most recent entries", async () => {
    const root = repository("eviction");
    const digests: string[] = [];
    for (let index = 0; index <= CODE_TOPOLOGY_CACHE_MAX_ENTRIES; index += 1) {
      write(root, "src/target.ts", `export function target() { return ${index}; }\n`);
      const compiled = await cli(["code", "compile", root, "--json"]);
      assert.equal(compiled.result.status, "current");
      const digest = digestOf(compiled.result);
      digests.push(digest);
      const time = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
      utimesSync(cacheEntry(root, digest), time, time);
    }
    assert.equal(cacheEntries(root).length, CODE_TOPOLOGY_CACHE_MAX_ENTRIES);
    assert.equal(existsSync(cacheEntry(root, digests[0])), false, "the oldest entry is evicted");
    assert.equal(existsSync(cacheEntry(root, digests.at(-1))), true);
  });

  await test("the configuration accepts only known topology modes", () => {
    const root = mkdtempSync(join(tmpdir(), "tieline-topology-mode-"));
    roots.push(root);
    write(root, ".tieline/config.json", configJson().replace('"files"', '"topology_mode": "remote",\n  "files"'));
    assert.throws(() => workspaceFromConfig(join(root, ".tieline/config.json")), /topology_mode|invalid/i);
    write(root, ".tieline/config.json", configJson("cached"));
    assert.equal(workspaceFromConfig(join(root, ".tieline/config.json")).config.topology_mode, "cached");
  });
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

report();
