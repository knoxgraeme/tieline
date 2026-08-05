import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runCli, type TielineCliIO } from "../src/cli.js";
import {
  buildGoverningCriteriaIndex,
  lookupGoverningCriteria,
  type GoverningCriterion,
} from "../src/contract/governs.js";
import {
  compileContractManifestWithSources,
  writeContractManifest,
  type ContractManifest,
} from "../src/contract/manifest.js";
import { setStore, type KnowledgeStore } from "../src/store.js";
import {
  registerGetGoverningCriteria,
  resolveGoverningCriteria,
} from "../src/tools/governing-criteria.js";
import type { ToolResult } from "../src/tools/shared.js";

for (const key of [
  "DATABASE_URL",
  "DATABASE_URL_WRITE",
  "DATABASE_URL_SYNC",
  "DATABASE_URL_ADMIN",
]) {
  delete process.env[key];
}
const originalTielineWorkspace = process.env.TIELINE_WORKSPACE;
delete process.env.TIELINE_WORKSPACE;

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function workspaceConfig(): string {
  return `${JSON.stringify(
    {
      version: 1,
      product: { name: "Governs fixture", repo_name: "governs-fixture" },
      repository: {
        root: "..",
        source_roots: ["src"],
        ignore: [".git", ".tieline"],
      },
      context: { sources: [] },
      runtime: {
        default_embedding_provider: "hash",
        default_database_mode: "offline",
      },
      files: {
        spec_directory: "spec",
        manifest: "manifest",
        mcp_config: "mcp.json",
      },
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
    },
    null,
    2
  )}\n`;
}

const SPEC = `version: 1
capability:
  key: GOVERNS
  name: Governing criteria lookup
  description: A repository path resolves to the accepted behavior that governs it.
  stories:
    - key: GOVERNS-001
      title: Look up governing criteria
      actor: implementing agent
      goal: know which criteria govern a path before editing it
      benefit: a contradiction is prevented instead of reported afterwards
      lifecycle: production
      links:
        - relation: implements
          target:
            kind: code
            repository: governs-fixture
            path: src/story-only.ts
        - relation: implements
          target:
            kind: code
            repository: governs-fixture
            path: src/shared.ts
      acceptance_criteria:
        - key: GOVERNS-001-AC1
          criterion: Tieline must return the acceptance criterion that links a path.
          links:
            - relation: implements
              target:
                kind: code
                repository: governs-fixture
                path: src/direct.ts
            - relation: implements
              target:
                kind: code
                repository: governs-fixture
                path: src/shared.ts
            - relation: implements
              target:
                kind: code
                repository: other-repository
                path: src/elsewhere.ts
            - relation: documents
              target:
                kind: help
                source: docs
                external_id: governs-guide
        - key: GOVERNS-001-AC2
          criterion: Tieline must return every acceptance criterion that links a path.
          links:
            - relation: implements
              target:
                kind: code
                repository: governs-fixture
                path: src/direct.ts
`;

function createFixture(withManifest: boolean): {
  root: string;
  manifest: ContractManifest;
} {
  const root = mkdtempSync(resolve(tmpdir(), "tieline-governs-"));
  mkdirSync(resolve(root, ".tieline/spec"), { recursive: true });
  mkdirSync(resolve(root, "src"), { recursive: true });
  writeFileSync(resolve(root, ".tieline/config.json"), workspaceConfig());
  writeFileSync(resolve(root, ".tieline/spec/governs.yaml"), SPEC);
  writeFileSync(resolve(root, "src/direct.ts"), "export const direct = 1;\n");
  writeFileSync(resolve(root, "src/shared.ts"), "export const shared = 1;\n");
  writeFileSync(
    resolve(root, "src/story-only.ts"),
    "export const storyOnly = 1;\n"
  );
  writeFileSync(resolve(root, "src/unlinked.ts"), "export const unlinked = 1;\n");
  const compiled = compileContractManifestWithSources({
    repositoryRoot: root,
    repositoryKey: "governs-fixture",
    commit: "governs-fixture-commit",
    specDirectory: ".tieline/spec",
  });
  if (withManifest) {
    writeContractManifest(resolve(root, ".tieline/manifest"), compiled);
  }
  return { root, manifest: compiled.manifest };
}

function scopes(criteria: readonly GoverningCriterion[]): string[] {
  return criteria.map(
    (entry) =>
      `${entry.acceptance_criterion_stable_id} ${entry.link_scope} ${entry.relation}`
  );
}

const cleanup: string[] = [];
try {
  const { root, manifest } = createFixture(true);
  cleanup.push(root);

  const index = buildGoverningCriteriaIndex(manifest);
  assert.deepEqual(scopes(index.get("src/direct.ts") ?? []), [
    "GOVERNS-001-AC1 direct implements",
    "GOVERNS-001-AC2 direct implements",
  ]);
  assert.deepEqual(scopes(index.get("src/story-only.ts") ?? []), [
    "GOVERNS-001-AC1 story_fallback implements",
    "GOVERNS-001-AC2 story_fallback implements",
  ]);
  assert.deepEqual(scopes(index.get("src/shared.ts") ?? []), [
    "GOVERNS-001-AC1 direct implements",
    "GOVERNS-001-AC1 story_fallback implements",
    "GOVERNS-001-AC2 story_fallback implements",
  ]);
  assert.equal(index.has("src/elsewhere.ts"), false);

  const first = index.get("src/shared.ts")?.[0];
  assert.equal(first?.capability_stable_id, "GOVERNS");
  assert.equal(first?.story_stable_id, "GOVERNS-001");
  assert.equal(first?.story_title, "Look up governing criteria");

  const report = lookupGoverningCriteria({
    manifest,
    repositoryRoot: root,
    paths: [
      "src/direct.ts",
      "src/unlinked.ts",
      "src/missing.ts",
      resolve(root, "src/story-only.ts"),
      "src/DIRECT.ts",
    ],
  });
  assert.deepEqual(report.repository, {
    key: "governs-fixture",
    commit: "governs-fixture-commit",
  });
  assert.equal(report.governed_paths, 2);
  assert.equal(report.ungoverned_paths, 3);
  assert.equal(report.results[0]?.status, "governed");
  assert.equal(report.results[0]?.acceptance_criterion_count, 2);
  assert.equal(
    report.results[0]?.answer,
    "2 acceptance criteria govern 'src/direct.ts'."
  );
  assert.equal(report.results[1]?.status, "ungoverned");
  assert.equal(report.results[1]?.exists, true);
  assert.match(report.results[1]?.answer ?? "", /No acceptance criterion governs/);
  assert.equal(report.results[2]?.status, "not_found");
  assert.equal(report.results[2]?.exists, false);
  assert.match(report.results[2]?.answer ?? "", /does not exist/);
  assert.equal(report.results[3]?.path, "src/story-only.ts");
  assert.equal(report.results[3]?.status, "governed");
  // A case-insensitive filesystem must not turn a misspelled governed path
  // into an existing-but-ungoverned answer.
  assert.equal(report.results[4]?.status, "not_found");
  assert.equal(report.results[4]?.exists, false);

  let output = "";
  const io: TielineCliIO = {
    write(message) {
      output += message;
    },
    error(message) {
      throw new Error(message);
    },
    async question() {
      throw new Error("contract governs must not prompt");
    },
  };

  assert.equal(
    await runCli(
      ["contract", "governs", "--repository", root, "src/shared.ts"],
      io,
      {}
    ),
    0
  );
  assert.match(output, /manifest commit governs-fixture-commit/);
  assert.match(output, /GOVERNS-001-AC1 direct implements/);
  assert.match(output, /GOVERNS-001-AC1 story_fallback implements/);

  output = "";
  assert.equal(
    await runCli(
      [
        "contract",
        "governs",
        "--repository",
        root,
        "src/unlinked.ts",
        "src/missing.ts",
        "--json",
      ],
      io,
      {}
    ),
    0
  );
  const cliReport = JSON.parse(output);
  assert.deepEqual(
    cliReport.results.map((entry: { status: string }) => entry.status),
    ["ungoverned", "not_found"]
  );
  assert.equal(cliReport.repository.commit, "governs-fixture-commit");

  const toolSource = readFileSync(
    resolve(projectRoot, "src/tools/governing-criteria.ts"),
    "utf8"
  );
  assert.doesNotMatch(toolSource, /get(Read|Evidence|Planning)?Store\s*\(/);
  setStore(
    new Proxy(
      {},
      {
        get(_target, property) {
          throw new Error(
            `get_governing_criteria must not use the knowledge store (accessed '${String(property)}')`
          );
        },
      }
    ) as unknown as KnowledgeStore
  );

  const registered: {
    name: string;
    config: { description: string; annotations?: Record<string, unknown> };
    handler: (input: { paths: string[] }) => Promise<ToolResult>;
  }[] = [];
  const fakeServer = {
    registerTool(
      name: string,
      config: { description: string; annotations?: Record<string, unknown> },
      handler: (input: { paths: string[] }) => Promise<ToolResult>
    ) {
      registered.push({ name, config, handler });
    },
  } as unknown as McpServer;

  registerGetGoverningCriteria(fakeServer);
  const tool = registered[0];
  assert.equal(tool?.name, "get_governing_criteria");
  assert.equal(tool?.config.annotations?.readOnlyHint, true);
  assert.match(tool?.config.description ?? "", /what is true/i);
  assert.match(tool?.config.description ?? "", /search_knowledge/);
  assert.match(tool?.config.description ?? "", /what is related/i);
  assert.match(tool?.config.description ?? "", /no database/i);

  const previousCwd = process.cwd();
  let handlerResult: ToolResult;
  try {
    process.chdir(resolve(root, "src"));
    handlerResult = await tool!.handler({
      paths: ["src/shared.ts", "src/unlinked.ts"],
    });
  } finally {
    process.chdir(previousCwd);
  }
  assert.notEqual(handlerResult.isError, true);
  const structured = handlerResult.structuredContent as {
    repository: { commit: string };
    results: Array<{ status: string; criteria: GoverningCriterion[] }>;
    note?: string;
  };
  assert.equal(structured.repository.commit, "governs-fixture-commit");
  assert.equal(structured.results[0]?.status, "governed");
  assert.equal(structured.results[1]?.status, "ungoverned");
  assert.match(structured.note ?? "", /governed by no acceptance criterion/);

  const resolved = resolveGoverningCriteria({
    paths: ["src/direct.ts"],
    cwd: root,
  });
  assert.equal(resolved.status, "resolved");

  const stray = mkdtempSync(resolve(tmpdir(), "tieline-governs-nowork-"));
  cleanup.push(stray);
  const withoutWorkspace = resolveGoverningCriteria({
    paths: ["src/direct.ts"],
    cwd: stray,
  });
  assert.equal(withoutWorkspace.status, "no_workspace");
  assert.match(
    withoutWorkspace.status === "no_workspace"
      ? withoutWorkspace.message
      : "",
    /No Tieline workspace was found[\s\S]*tieline init/
  );

  const { root: withoutManifest } = createFixture(false);
  cleanup.push(withoutManifest);
  const unreadable = resolveGoverningCriteria({
    paths: ["src/direct.ts"],
    cwd: withoutManifest,
  });
  assert.equal(unreadable.status, "no_manifest");
  assert.match(
    unreadable.status === "no_manifest" ? unreadable.message : "",
    /manifest[\s\S]*missing or unreadable[\s\S]*contract compile/
  );

  let strayResult: ToolResult;
  try {
    process.chdir(stray);
    strayResult = await tool!.handler({ paths: ["src/direct.ts"] });
  } finally {
    process.chdir(previousCwd);
  }
  assert.equal(strayResult.isError, true);
  assert.match(strayResult.content[0]?.text ?? "", /No Tieline workspace/);

  let configuredWorkspaceResult: ToolResult;
  process.env.TIELINE_WORKSPACE = root;
  try {
    process.chdir(stray);
    configuredWorkspaceResult = await tool!.handler({
      paths: ["src/direct.ts"],
    });
  } finally {
    process.chdir(previousCwd);
  }
  assert.notEqual(configuredWorkspaceResult.isError, true);
  assert.equal(
    (configuredWorkspaceResult.structuredContent as {
      repository: { commit: string };
    }).repository.commit,
    "governs-fixture-commit"
  );
} finally {
  if (originalTielineWorkspace === undefined) {
    delete process.env.TIELINE_WORKSPACE;
  } else {
    process.env.TIELINE_WORKSPACE = originalTielineWorkspace;
  }
  for (const path of cleanup) {
    rmSync(path, { recursive: true, force: true });
  }
}

console.log("governs tests passed");
