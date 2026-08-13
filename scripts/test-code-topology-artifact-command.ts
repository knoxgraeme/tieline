import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCli, type TielineCliIO } from "../src/cli.js";
import { runCodeTopologyArtifactCommand } from "../src/commands/code-topology-artifact.js";
import {
  CODE_TOPOLOGY_ARTIFACT_INDEX,
  CODE_TOPOLOGY_ARTIFACT_MAX_FILE_BYTES,
} from "../src/contract/code-topology-artifact.js";
import { selectGitTopologyRole } from "../src/contract/git-artifact-snapshot.js";
import { readWorkspaceCodeTopologyFiles } from "../src/contract/topology-role-snapshot.js";
import { report, test } from "./lib/harness.js";

const root = mkdtempSync(join(tmpdir(), "tieline-topology-artifact-command-"));
const topologyRoot = join(root, ".tieline/topology");
let output = "";
const io: TielineCliIO = {
  write(message) { output += message; },
  error(message) { throw new Error(message); },
  async question() { throw new Error("topology artifact commands must not prompt"); },
};

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function cli(args: string[]): Promise<{ exit: number; result: Record<string, any> }> {
  output = "";
  const exit = await runCli(args, io, {});
  return { exit, result: JSON.parse(output) as Record<string, any> };
}

function artifactBytes(): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const visit = (directory: string, prefix = ""): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(join(directory, entry.name), name);
      else if (entry.isFile()) files.set(name, readFileSync(join(directory, entry.name)));
    }
  };
  visit(topologyRoot);
  return files;
}

function replaceArtifactBytes(files: ReadonlyMap<string, Buffer>): void {
  rmSync(topologyRoot, { recursive: true, force: true });
  for (const [name, bytes] of files) {
    const path = join(topologyRoot, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
}

try {
  mkdirSync(join(root, ".tieline/spec"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/main.ts"), "export const value = 1;\n");
  writeFileSync(join(root, ".tieline/config.json"), `${JSON.stringify({
    version: 1,
    product: { name: "Artifact fixture", repo_name: "artifact-fixture" },
    repository: { root: "..", source_roots: ["src"], ignore: [] },
    context: { sources: [] },
    runtime: { default_embedding_provider: "hash", default_database_mode: "offline" },
    files: { spec_directory: "spec", manifest: "manifest" },
    created_at: "2026-08-12T00:00:00.000Z",
    updated_at: "2026-08-12T00:00:00.000Z",
  }, null, 2)}\n`);
  writeFileSync(join(root, ".tieline/spec/artifact.yaml"), "version: 1\ncapability:\n  key: ARTIFACT\n  name: Artifact\n  description: Artifact fixture.\n  stories: []\n");
  git(["init", "-q"]);
  git(["config", "user.email", "artifact@example.test"]);
  git(["config", "user.name", "Artifact Test"]);
  git(["add", "."]);
  git(["commit", "-qm", "fixture"]);

  await test("validate reports missing without writing", async () => {
    const before = git(["status", "--short"]);
    const { exit, result } = await cli(["code", "validate", root, "--json"]);
    assert.notEqual(exit, 0);
    assert.equal(result.status, "topology_missing");
    assert.equal(git(["status", "--short"]), before);
  });

  let compiledBytes!: Map<string, Buffer>;
  await test("compile publishes the normal topology authority and validate reports current", async () => {
    const compiled = await cli(["code", "compile", root, "--json"]);
    assert.equal(compiled.exit, 0, JSON.stringify(compiled.result));
    assert.equal(compiled.result.status, "current");
    assert.equal(compiled.result.repository, "artifact-fixture");
    assert.match(compiled.result.generation_identity, /^[a-f0-9]{64}$/);
    assert.match(compiled.result.artifact_digest, /^[a-f0-9]{64}$/);
    assert.match(compiled.result.projection_digest, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(compiled.result.counts).sort(), [
      "dependency_records", "edges", "files", "frontiers", "references", "resolutions", "symbols",
    ]);
    compiledBytes = artifactBytes();
    assert.ok(compiledBytes.has("topology.json"));

    const before = git(["status", "--short"]);
    const validated = await cli(["code", "validate", root, "--json"]);
    assert.equal(validated.exit, 0);
    assert.equal(validated.result.status, "current");
    assert.equal(validated.result.artifact_digest, compiled.result.artifact_digest);
    assert.equal(git(["status", "--short"]), before);
  });

  await test("Git topology selection resolves one commit and needs no manifest", () => {
    const missing = selectGitTopologyRole({
      repositoryRoot: root,
      repository: "artifact-fixture",
      sourceRoots: ["src"],
      ignore: [],
      revision: "HEAD",
    });
    assert.equal(missing.status, "topology_missing_at_revision");

    git(["add", ".tieline/topology"]);
    git(["commit", "-qm", "compiled topology"]);
    const selected = selectGitTopologyRole({
      repositoryRoot: root,
      repository: "artifact-fixture",
      sourceRoots: ["src"],
      ignore: [],
      revision: "HEAD",
    });
    assert.equal(selected.status, "current", selected.status === "current" ? undefined : selected.detail);
    if (selected.status !== "current") return;
    assert.equal(selected.snapshot.queried_revision, git(["rev-parse", "HEAD"]));
    assert.equal(selected.snapshot.source, "git");
    selected.snapshot.dispose();
  });

  await test("unchanged and intent-only compile output is byte-identical", async () => {
    const repeated = await cli(["code", "compile", root, "--json"]);
    assert.equal(repeated.exit, 0);
    assert.equal(repeated.result.status, "current");
    assert.deepEqual(artifactBytes(), compiledBytes);

    writeFileSync(join(root, ".tieline/spec/artifact.yaml"), "version: 1\ncapability:\n  key: ARTIFACT\n  name: Artifact edited\n  description: Intent-only change.\n  stories: []\n");
    const intentOnly = await cli(["code", "compile", root, "--json"]);
    assert.equal(intentOnly.exit, 0);
    assert.equal(intentOnly.result.status, "current");
    assert.deepEqual(artifactBytes(), compiledBytes);
  });

  await test("concurrent compilers serialize publication without changing bytes", async () => {
    const compile = async (): Promise<{ exit: number; result: Record<string, any> }> => {
      let message = "";
      const commandIo: TielineCliIO = {
        write(value) { message += value; },
        error(value) { throw new Error(value); },
        async question() { throw new Error("topology artifact commands must not prompt"); },
      };
      const exit = await runCodeTopologyArtifactCommand(
        "compile",
        { repository: root, json: true },
        commandIo
      );
      return { exit, result: JSON.parse(message) as Record<string, any> };
    };
    const [left, right] = await Promise.all([compile(), compile()]);
    assert.equal(left.exit, 0);
    assert.equal(right.exit, 0);
    assert.equal(left.result.artifact_digest, right.result.artifact_digest);
    assert.deepEqual(artifactBytes(), compiledBytes);
  });

  await test("a reader retries once when publication replaces its captured generation", async () => {
    writeFileSync(join(root, "src/main.ts"), "export const value = 101;\n");
    assert.equal((await cli(["code", "compile", root, "--json"])).exit, 0);
    const nextBytes = artifactBytes();
    const nextIndex = JSON.parse(nextBytes.get(CODE_TOPOLOGY_ARTIFACT_INDEX)!.toString("utf8"));
    writeFileSync(join(root, "src/main.ts"), "export const value = 1;\n");
    replaceArtifactBytes(compiledBytes);
    let indexReads = 0;
    try {
      const read = readWorkspaceCodeTopologyFiles(root, {
        afterIndexRead(attempt) {
          indexReads += 1;
          if (attempt === 0) replaceArtifactBytes(nextBytes);
        },
      });
      assert.equal(read.status, "complete", "detail" in read ? read.detail : undefined);
      if (read.status !== "complete") return;
      assert.equal(indexReads, 2, "the bounded retry rereads the replacement generation once");
      assert.equal(
        JSON.parse(read.files.get(CODE_TOPOLOGY_ARTIFACT_INDEX)!.toString("utf8")).artifact_digest,
        nextIndex.artifact_digest
      );
    } finally {
      replaceArtifactBytes(compiledBytes);
    }
  });

  await test("an oversized workspace index is rejected before its payload is read", () => {
    const indexPath = join(topologyRoot, CODE_TOPOLOGY_ARTIFACT_INDEX);
    const saved = readFileSync(indexPath);
    try {
      truncateSync(indexPath, 2 ** 31);
      const oversized = readWorkspaceCodeTopologyFiles(root);
      assert.deepEqual(oversized, {
        status: "capacity_exceeded",
        detail: "Topology index exceeds the per-file byte limit.",
      });
      assert.ok(2 ** 31 > CODE_TOPOLOGY_ARTIFACT_MAX_FILE_BYTES);
    } finally {
      writeFileSync(indexPath, saved);
    }
  });

  await test("a missing referenced shard is invalid rather than an absent artifact", async () => {
    const index = JSON.parse(readFileSync(join(topologyRoot, "topology.json"), "utf8")) as {
      shards: Array<{ name: string }>;
    };
    const shard = index.shards[0]!.name;
    const path = join(topologyRoot, shard);
    const saved = `${path}.saved`;
    renameSync(path, saved);
    try {
      const invalid = await cli(["code", "validate", root, "--json"]);
      assert.notEqual(invalid.exit, 0);
      assert.equal(invalid.result.status, "topology_invalid");
    } finally {
      renameSync(saved, path);
    }
  });

  await test("validate reports stale source bytes without parsing or writing", async () => {
    writeFileSync(join(root, "src/main.ts"), "export const value = 2;\n");
    const beforeBytes = artifactBytes();
    const beforeStatus = git(["status", "--short"]);
    const { exit, result } = await cli(["code", "validate", root, "--json"]);
    assert.notEqual(exit, 0);
    assert.equal(result.status, "topology_stale");
    assert.deepEqual(artifactBytes(), beforeBytes);
    assert.equal(git(["status", "--short"]), beforeStatus);
  });

  await test("interrupted authority replacement preserves the prior complete artifact", async () => {
    assert.equal((await cli(["code", "compile", root, "--json"])).exit, 0);
    const priorIndex = readFileSync(join(topologyRoot, "topology.json"));
    writeFileSync(join(root, "src/main.ts"), "export const value = 3;\n");
    output = "";
    const exit = await runCodeTopologyArtifactCommand(
      "compile",
      { repository: root, json: true },
      io,
      { beforeAuthorityReplace() { throw new Error("injected replacement interruption"); } }
    );
    assert.notEqual(exit, 0);
    assert.equal(JSON.parse(output).status, "topology_invalid");
    assert.deepEqual(readFileSync(join(topologyRoot, "topology.json")), priorIndex);
    const stale = await cli(["code", "validate", root, "--json"]);
    assert.equal(stale.result.status, "topology_stale");

    const recovered = await cli(["code", "compile", root, "--json"]);
    assert.equal(recovered.exit, 0);
    assert.equal(recovered.result.status, "current");
    const referenced = new Set((JSON.parse(readFileSync(join(topologyRoot, "topology.json"), "utf8")).shards as Array<{ name: string }>).map((entry) => entry.name));
    assert.deepEqual(
      readdirSync(join(topologyRoot, "files")).map((name) => `files/${name}`).sort(),
      [...referenced].sort(),
      "retry removes only schema-named unreferenced shards"
    );
  });

  await test("live lock contention fails closed and a dead stale owner is recovered", async () => {
    const lockPath = join(root, ".tieline/topology.lock");
    const currentOwner = {
      pid: process.pid,
      host: (await import("node:os")).hostname(),
      created_at: new Date(0).toISOString(),
      nonce: "live-owner",
    };
    writeFileSync(lockPath, `${JSON.stringify(currentOwner)}\n`);
    const before = artifactBytes();
    const contended = await cli(["code", "compile", root, "--json"]);
    assert.notEqual(contended.exit, 0);
    assert.equal(contended.result.status, "topology_invalid");
    assert.match(String(contended.result.detail), /owned or contended/i);
    assert.deepEqual(artifactBytes(), before);

    const deadOwner = { ...currentOwner, pid: 2_000_000_000, nonce: "dead-owner" };
    writeFileSync(lockPath, `${JSON.stringify(deadOwner)}\n`);
    utimesSync(lockPath, new Date(0), new Date(0));
    const recovered = await cli(["code", "compile", root, "--json"]);
    assert.equal(recovered.exit, 0);
    assert.equal(recovered.result.status, "current");
  });

  await test("escaping topology symlinks fail closed", async () => {
    const saved = join(root, ".tieline/topology.saved");
    const outside = mkdtempSync(join(tmpdir(), "tieline-topology-outside-"));
    renameSync(topologyRoot, saved);
    symlinkSync(outside, topologyRoot, "dir");
    try {
      const unsafe = await cli(["code", "validate", root, "--json"]);
      assert.notEqual(unsafe.exit, 0);
      assert.equal(unsafe.result.status, "topology_unsafe_path");
    } finally {
      rmSync(topologyRoot, { force: true });
      renameSync(saved, topologyRoot);
      rmSync(outside, { recursive: true, force: true });
    }
  });

  await test("two selected-source mutations return workspace_changed without publication", async () => {
    const before = artifactBytes();
    output = "";
    let mutations = 0;
    const exit = await runCodeTopologyArtifactCommand(
      "compile",
      { repository: root, json: true },
      io,
      {
        afterBuildAttempt(attempt) {
          mutations += 1;
          writeFileSync(join(root, "src/main.ts"), `export const value = ${10 + attempt};\n`);
        },
      }
    );
    assert.equal(mutations, 2);
    assert.notEqual(exit, 0);
    assert.equal(JSON.parse(output).status, "workspace_changed");
    assert.deepEqual(artifactBytes(), before);
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}

report();
