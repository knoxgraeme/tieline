import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runCli, type TielineCliIO } from "../src/cli.js";
import { FakeCodeTopologyStore } from "../src/adapters/fakes/fake-code-topology-store.js";
import { setCodeTopologyStore } from "../src/code-topology-store.js";
import {
  buildCommittedTopologyGeneration,
  persistCommittedTopologyGeneration,
} from "../src/contract/topology-generation.js";
import { createServer } from "../src/server.js";
import {
  codeTopologyGenerationIdentity,
  codeTopologySelectedInputDigest,
} from "../src/domain/code-topology-store.js";
import { report, test } from "./lib/harness.js";

const fixtureRoot = mkdtempSync(resolve(tmpdir(), "tieline-code-command-"));
mkdirSync(resolve(fixtureRoot, ".tieline/spec"), { recursive: true });
mkdirSync(resolve(fixtureRoot, "src"), { recursive: true });
writeFileSync(resolve(fixtureRoot, "src/target.ts"), "export function target() { return 1; }\n");
writeFileSync(resolve(fixtureRoot, ":literal.ts"), "export const literal = true;\n");
writeFileSync(
  resolve(fixtureRoot, "src/consumer.ts"),
  'import { target } from "./target";\nexport function consumer() { return target(); }\n'
);
execFileSync("git", ["init", "-q"], { cwd: fixtureRoot });
execFileSync("git", ["add", "."], { cwd: fixtureRoot });
execFileSync(
  "git",
  ["-c", "user.name=Tieline Test", "-c", "user.email=test@tieline.invalid", "commit", "-qm", "fixture"],
  { cwd: fixtureRoot }
);
writeFileSync(
  resolve(fixtureRoot, ".tieline/config.json"),
  `${JSON.stringify({
    version: 1,
    product: { name: "Topology fixture", repo_name: "topology-fixture" },
    repository: { root: "..", source_roots: ["src"], ignore: [] },
    context: { sources: [] },
    runtime: { default_embedding_provider: "hash", default_database_mode: "offline" },
    files: { spec_directory: "spec", manifest: "manifest" },
    created_at: "2026-08-10T00:00:00.000Z",
    updated_at: "2026-08-10T00:00:00.000Z",
  }, null, 2)}\n`
);
writeFileSync(
  resolve(fixtureRoot, ".tieline/spec/topology.yaml"),
  `version: 1
capability:
  key: TOPOLOGY
  name: Code topology
  description: Agents inspect derived code relationships without conflating authored intent.
  stories:
    - key: TOPOLOGY-001
      title: Inspect dependency impact
      actor: implementing agent
      goal: trace derived code dependencies
      benefit: affected authored behavior can be reviewed
      lifecycle: production
      acceptance_criteria:
        - key: TOPOLOGY-001-AC1
          criterion: Tieline must report a consumer as potentially impacted when its imported target changes.
          links:
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: topology-fixture
                path: src/target.ts
                selector: function:target
            - relation: tests
              provenance: authored
              target:
                kind: test
                repository: topology-fixture
                path: ':literal.ts'
`
);

let output = "";
const io: TielineCliIO = {
  write(message) { output += message; },
  error(message) { throw new Error(message); },
  async question() { throw new Error("code topology commands must not prompt"); },
};

async function cli(args: string[], expectedExit = 0): Promise<Record<string, unknown>> {
  output = "";
  assert.equal(await runCli(args, io, {}), expectedExit);
  return JSON.parse(output) as Record<string, unknown>;
}

console.log("Code topology command and MCP parity");

try {
  await test("compile fixture manifest", async () => {
    await cli(["contract", "compile", fixtureRoot, "--repo", "topology-fixture", "--json"]);
  });

  await test("compile the explicit repository topology artifact", async () => {
    const compiled = await cli(["code", "compile", fixtureRoot, "--json"]);
    assert.equal(compiled.status, "current");
    execFileSync("git", ["add", "."], { cwd: fixtureRoot });
    execFileSync(
      "git",
      ["-c", "user.name=Tieline Test", "-c", "user.email=test@tieline.invalid", "commit", "-qm", "compiled artifacts"],
      { cwd: fixtureRoot }
    );
  });

  const traceArgs = [
    "code", "trace", "--repository", fixtureRoot, "--repo", "topology-fixture",
    "--path", "./src/consumer.ts",
    "--direction", "dependencies", "--depth", "2", "--nodes", "10",
    "--edges", "20", "--paths", "10", "--json",
  ];
  let cliTrace: Record<string, unknown>;
  await test("CLI dependency trace returns bounded derived paths", async () => {
    cliTrace = await cli(traceArgs);
    assert.equal(cliTrace.status, "complete");
    assert.equal(cliTrace.direction, "dependencies");
    assert.equal((cliTrace.truncation as { truncated: boolean }).truncated, false);
    assert.ok((cliTrace.paths as unknown[]).length > 0);
    assert.ok(
      (cliTrace.paths as Array<{ relationship: string }>).every(
        (path) => path.relationship === "derived_code_dependency"
      )
    );
  });

  await test("stale artifact reads fail without repairing or rewriting", async () => {
    const sourcePath = resolve(fixtureRoot, "src/consumer.ts");
    const artifactPath = resolve(fixtureRoot, ".tieline/topology/topology.json");
    const source = readFileSync(sourcePath, "utf8");
    const artifact = readFileSync(artifactPath);
    writeFileSync(sourcePath, `${source}// selected input changed\n`);
    try {
      const stale = await cli(traceArgs, 1);
      assert.equal(stale.status, "topology_stale");
      assert.deepEqual(readFileSync(artifactPath), artifact);
    } finally {
      writeFileSync(sourcePath, source);
    }
  });

  await test("an exact Git revision traces successfully from a dirty worktree without rewriting artifacts", async () => {
    const sourcePath = resolve(fixtureRoot, "src/consumer.ts");
    const artifactPath = resolve(fixtureRoot, ".tieline/topology/topology.json");
    const source = readFileSync(sourcePath, "utf8");
    const artifact = readFileSync(artifactPath);
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixtureRoot,
      encoding: "utf8",
    }).trim();
    writeFileSync(sourcePath, `${source}// dirty worktree must not affect an exact revision\n`);
    try {
      const traced = await cli([
        "code", "trace", "--repository", fixtureRoot, "--repo", "topology-fixture",
        "--revision", "HEAD", "--path", "src/consumer.ts",
        "--direction", "dependencies", "--json",
      ]);
      assert.equal(traced.status, "complete");
      const provenance = traced.topology_provenance as {
        source: string;
        queried_revision: string;
        generation_identity: string;
        artifact_digest: string;
      };
      assert.equal(provenance.source, "git");
      assert.equal(provenance.queried_revision, commit);
      assert.match(provenance.generation_identity, /^[a-f0-9]{64}$/);
      assert.match(provenance.artifact_digest, /^[a-f0-9]{64}$/);
      assert.deepEqual(readFileSync(artifactPath), artifact);
    } finally {
      writeFileSync(sourcePath, source);
    }
  });

  await test("trace ignores manifest health while blast fails the current contract role", async () => {
    const manifest = resolve(fixtureRoot, ".tieline/manifest");
    const hidden = resolve(fixtureRoot, ".tieline/manifest.hidden");
    renameSync(manifest, hidden);
    try {
      const traced = await cli(traceArgs);
      assert.equal(traced.status, "complete");
      const blast = await cli([
        "code", "blast-radius", "--repository", fixtureRoot, "--repo", "topology-fixture",
        "--changed", "src/consumer.ts", "--json",
      ], 1);
      assert.equal(blast.status, "current_manifest_missing");
    } finally {
      renameSync(hidden, manifest);
    }
  });

  await test("CLI text renders the same bounded trace semantics", async () => {
    output = "";
    assert.equal(await runCli(traceArgs.filter((arg) => arg !== "--json"), io, {}), 0);
    assert.match(output, /Code dependency trace: complete/);
    assert.match(output, /Relationship: derived_code_dependency/);
    assert.match(output, /Truncated: false/);
  });

  await test("transport limit overrides cannot bypass domain truncation", async () => {
    const limited = await cli([
      "code", "trace", "--repository", fixtureRoot, "--repo", "topology-fixture",
      "--path", "src/consumer.ts", "--direction", "dependencies",
      "--nodes", "1", "--json",
    ]);
    assert.equal(limited.status, "complete");
    assert.equal((limited.visited as unknown[]).length, 1);
    assert.equal(
      (limited.truncation as { nodes: { truncated: boolean } }).nodes.truncated,
      true
    );
  });

  let cliBlast: Record<string, unknown>;
  await test("CLI blast radius keeps advisory AC authority separate", async () => {
    cliBlast = await cli([
      "code", "blast-radius", "--repository", fixtureRoot, "--repo", "topology-fixture",
      "--changed", "src/consumer.ts", "--direction", "dependencies", "--json",
    ]);
    assert.equal(cliBlast.status, "complete");
    assert.equal(cliBlast.impact, "may_be_impacted");
    const impacts = cliBlast.intent_impacts as Array<{
      acceptance_criterion_stable_id: string;
      relationship: string;
      semantic_support: string;
    }>;
    assert.ok(impacts.some((impact) => impact.acceptance_criterion_stable_id === "TOPOLOGY-001-AC1"));
    assert.ok(impacts.every((impact) => impact.relationship === "contract_coupling"));
    assert.ok(impacts.every((impact) => impact.semantic_support === "not_assessed"));
  });

  await test("Git base reads manifest evidence through literal top-level pathspecs", async () => {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixtureRoot,
      encoding: "utf8",
    }).trim();
    const result = await cli([
      "code", "blast-radius", "--repository", fixtureRoot, "--repo", "topology-fixture",
      "--base", "HEAD", "--json",
    ]);
    assert.equal(result.status, "complete");
    const topology = result.topology_provenance as {
      base: { queried_revision: string };
      current: { source: string };
    };
    const contract = result.contract_provenance as {
      base: { queried_revision: string };
      current: { source: string };
    };
    assert.equal(topology.base.queried_revision, commit);
    assert.equal(contract.base.queried_revision, commit);
    assert.equal(topology.current.source, "workspace");
    assert.equal(contract.current.source, "workspace");
  });

  await test("pre-bootstrap Git topology is a named immutable-revision outcome", async () => {
    const result = await cli([
      "code", "trace", "--repository", fixtureRoot, "--repo", "topology-fixture",
      "--revision", "HEAD~1", "--path", "src/consumer.ts", "--json",
    ], 1);
    assert.equal(result.status, "topology_missing_at_revision");
    assert.doesNotMatch(String(result.detail), /compile/i);
  });

  await test("CLI rejects a blast request without exactly one change source", async () => {
    await assert.rejects(
      runCli([
        "code", "blast-radius", "--repository", fixtureRoot, "--repo", "topology-fixture", "--json",
      ], io, {}),
      /exactly one/i
    );
  });

  await test("an invalid Git base is a named source-unavailable outcome", async () => {
    const invalidBase = await cli([
      "code", "blast-radius", "--repository", fixtureRoot, "--repo", "topology-fixture",
      "--base", "refs/heads/does-not-exist", "--json",
    ], 1);
    assert.equal(invalidBase.status, "topology_invalid");
    assert.match(String(invalidBase.detail), /does-not-exist|unknown revision|ambiguous argument/i);
  });

  await test("MCP structured results exactly match CLI domain results", async () => {
    const originalWorkspace = process.env.TIELINE_WORKSPACE;
    process.env.TIELINE_WORKSPACE = fixtureRoot;
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "topology-parity", version: "0.0.0" });
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      for (const name of ["trace_code_dependencies", "analyze_code_blast_radius"]) {
        const tool = tools.tools.find((candidate) => candidate.name === name)!;
        assert.deepEqual(tool.annotations, {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        });
        assert.ok(tool.outputSchema);
      }
      assert.match(client.getInstructions() ?? "", /derived_code_dependency/);
      assert.match(client.getInstructions() ?? "", /never claim implementation satisfies/i);

      const trace = await client.callTool({
        name: "trace_code_dependencies",
        arguments: {
          repository: "topology-fixture",
          path: "./src/consumer.ts",
          direction: "dependencies",
          generation_role: "current",
          depth: 2,
          nodes: 10,
          edges: 20,
          paths: 10,
        },
      });
      assert.notEqual(trace.isError, true);
      assert.deepEqual(trace.structuredContent, cliTrace!);

      const blast = await client.callTool({
        name: "analyze_code_blast_radius",
        arguments: {
          repository: "topology-fixture",
          changed: [{ path: "src/consumer.ts" }],
          direction: "dependencies",
        },
      });
      assert.notEqual(blast.isError, true);
      assert.deepEqual(blast.structuredContent, cliBlast!);

      const sourcePath = resolve(fixtureRoot, "src/consumer.ts");
      const source = readFileSync(sourcePath, "utf8");
      writeFileSync(sourcePath, `${source}// stale for parity\n`);
      try {
        const staleCli = await cli(traceArgs, 1);
        const staleMcp = await client.callTool({
          name: "trace_code_dependencies",
          arguments: {
            repository: "topology-fixture",
            path: "./src/consumer.ts",
            direction: "dependencies",
            generation_role: "current",
            depth: 2,
            nodes: 10,
            edges: 20,
            paths: 10,
          },
        });
        assert.notEqual(staleMcp.isError, true);
        assert.deepEqual(staleMcp.structuredContent, staleCli);
      } finally {
        writeFileSync(sourcePath, source);
      }
    } finally {
      await client.close();
      await server.close();
      if (originalWorkspace === undefined) delete process.env.TIELINE_WORKSPACE;
      else process.env.TIELINE_WORKSPACE = originalWorkspace;
    }
  });

  await test("shared command seam canonicalizes and rejects exact locators", async () => {
    const normalized = await cli([
      "code", "trace", "--repository", fixtureRoot, "--repo", "topology-fixture",
      "--path", "./src/target.ts", "--selector", " Function : target ", "--json",
    ]);
    assert.equal(normalized.status, "complete");
    assert.deepEqual(
      (normalized.start as { locator: { path: string; selector: string } }).locator,
      {
        repository: "topology-fixture",
        kind: "code",
        path: "src/target.ts",
        selector: "function:target",
        framework_hint: null,
      }
    );
    await assert.rejects(
      runCli([
        "code", "trace", "--repository", fixtureRoot, "--repo", "topology-fixture",
        "--path", "../outside.ts", "--json",
      ], io, {}),
      /inside the repository/i
    );
    await assert.rejects(
      runCli([
        "code", "trace", "--repository", fixtureRoot, "--repo", "topology-fixture",
        "--path", "src/target.ts", "--selector", "function:target()", "--json",
      ], io, {}),
      /bare symbol/i
    );
  });

  await test("hosted trace reads an explicit persisted generation without a workspace", async () => {
    const built = await buildCommittedTopologyGeneration({
      repositoryRoot: fixtureRoot,
      repository: "topology-fixture",
      sourceRoots: ["src"],
      ignore: [],
      revision: "HEAD",
    });
    assert.equal(built.status, "complete");
    if (built.status !== "complete") throw new Error(built.detail);
    const store = new FakeCodeTopologyStore();
    await persistCommittedTopologyGeneration({
      store,
      result: built,
      expectedPreviousGenerationIdentity: null,
    });
    setCodeTopologyStore(store);
    const previousCwd = process.cwd();
    const originalWorkspace = process.env.TIELINE_WORKSPACE;
    const empty = mkdtempSync(resolve(tmpdir(), "tieline-hosted-topology-"));
    try {
      delete process.env.TIELINE_WORKSPACE;
      process.chdir(empty);
      output = "";
      assert.equal(await runCli([
        "code", "trace", "--repo", "topology-fixture", "--generation",
        built.generation.header.identity, "--path", "src/consumer.ts", "--json",
      ], io, { DATABASE_URL: "postgres://configured-for-fake" }), 0);
      const hosted = JSON.parse(output) as Record<string, unknown>;
      assert.equal(hosted.status, "complete");
      assert.equal(hosted.generation_identity, built.generation.header.identity);

      output = "";
      assert.equal(await runCli([
        "code", "trace", "--repo", "topology-fixture", "--revision", "HEAD",
        "--path", "src/consumer.ts", "--json",
      ], io, { DATABASE_URL: "postgres://configured-for-fake" }), 1);
      const revisionWithoutWorkspace = JSON.parse(output) as Record<string, unknown>;
      assert.equal(revisionWithoutWorkspace.status, "source_unavailable");
      assert.match(String(revisionWithoutWorkspace.detail), /requires a readable local workspace/);

      const incompatible = structuredClone(built.generation);
      incompatible.header.parser_compatibility_digest = "0".repeat(64);
      incompatible.header.revision = codeTopologySelectedInputDigest(incompatible.header);
      incompatible.header.identity = codeTopologyGenerationIdentity(incompatible.header);
      for (const edge of incompatible.edges) {
        edge.source.generation_identity = incompatible.header.identity;
        edge.target.generation_identity = incompatible.header.identity;
      }
      const incompatibleStore = new FakeCodeTopologyStore();
      await persistCommittedTopologyGeneration({
        store: incompatibleStore,
        result: { ...built, generation: incompatible },
        expectedPreviousGenerationIdentity: null,
      });
      setCodeTopologyStore(incompatibleStore);
      output = "";
      assert.equal(await runCli([
        "code", "trace", "--repo", "topology-fixture", "--generation",
        incompatible.header.identity, "--path", "src/consumer.ts", "--json",
      ], io, { DATABASE_URL: "postgres://configured-for-fake" }), 1);
      const incompatibleResult = JSON.parse(output) as Record<string, unknown>;
      assert.equal(incompatibleResult.status, "incompatible_generation");
      assert.match(String(incompatibleResult.detail), /incompatible parser, resolver, schema, or fact policy/);
    } finally {
      process.chdir(previousCwd);
      rmSync(empty, { recursive: true, force: true });
      if (originalWorkspace === undefined) delete process.env.TIELINE_WORKSPACE;
      else process.env.TIELINE_WORKSPACE = originalWorkspace;
    }
  });

  await test("a caller-supplied repository mismatch is explicit", async () => {
    const mismatch = await cli([
      "code", "trace", "--repository", fixtureRoot, "--repo", "different-repository",
      "--path", "src/consumer.ts", "--json",
    ], 1);
    assert.equal(mismatch.status, "repository_mismatch");
    assert.match(String(mismatch.detail), /declares repository 'topology-fixture'/);
  });

  await test("no workspace and no database is an explicit unavailable state", async () => {
    const previousCwd = process.cwd();
    const originalWorkspace = process.env.TIELINE_WORKSPACE;
    const empty = mkdtempSync(resolve(tmpdir(), "tieline-no-workspace-"));
    try {
      delete process.env.TIELINE_WORKSPACE;
      process.chdir(empty);
      const result = await cli([
        "code", "trace", "--repo", "hosted-repository", "--path", "src/missing.ts", "--json",
      ], 1);
      assert.equal(result.status, "no_workspace");
      assert.match(String(result.detail), /DATABASE_URL is not configured/);
    } finally {
      process.chdir(previousCwd);
      rmSync(empty, { recursive: true, force: true });
      if (originalWorkspace === undefined) delete process.env.TIELINE_WORKSPACE;
      else process.env.TIELINE_WORKSPACE = originalWorkspace;
    }
  });
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

report();
