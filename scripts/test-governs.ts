import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  buildGoverningCriteriaIndex,
  lookupGoverningCriteria,
  type GoverningCriterion,
} from "../src/contract/governs.js";
import { computeRepositoryMappingCoverage } from "../src/contract/coverage.js";
import {
  compileContractManifest,
  serializeContractManifest,
  type ContractManifest,
} from "../src/contract/manifest.js";
import {
  registerGetGoverningCriteria,
  resolveGoverningCriteria,
} from "../src/tools/governing-criteria.js";
import type { ToolResult } from "../src/tools/shared.js";
import { setStore, type KnowledgeStore } from "../src/store.js";
import { runCli, type TielineCliIO } from "../src/cli.js";

// Every scenario below must hold with no database reachable at all.
for (const key of [
  "DATABASE_URL",
  "DATABASE_URL_WRITE",
  "DATABASE_URL_SYNC",
  "DATABASE_URL_ADMIN",
]) {
  delete process.env[key];
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function workspaceConfig(repoName: string): string {
  return `${JSON.stringify(
    {
      version: 1,
      product: { name: "Governs fixture", repo_name: repoName },
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
        manifest: "manifest.json",
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
            - relation: tests
              target:
                kind: test
                repository: governs-fixture
                path: scripts/governs.test.ts
                framework_hint: custom-script
        - key: GOVERNS-001-AC2
          criterion: Tieline must return every acceptance criterion that links a path.
          links:
            - relation: implements
              target:
                kind: code
                repository: governs-fixture
                path: src/direct.ts
`;

function createFixture(options: { withManifest: boolean }): {
  root: string;
  manifest: ContractManifest;
} {
  const root = mkdtempSync(resolve(tmpdir(), "tieline-governs-"));
  mkdirSync(resolve(root, ".tieline/spec"), { recursive: true });
  mkdirSync(resolve(root, "src"), { recursive: true });
  mkdirSync(resolve(root, "scripts"), { recursive: true });
  writeFileSync(resolve(root, ".tieline/config.json"), workspaceConfig("governs-fixture"));
  writeFileSync(resolve(root, ".tieline/spec/governs.yaml"), SPEC);
  writeFileSync(resolve(root, "src/direct.ts"), "export const direct = 1;\n");
  writeFileSync(resolve(root, "src/shared.ts"), "export const shared = 1;\n");
  writeFileSync(resolve(root, "src/story-only.ts"), "export const storyOnly = 1;\n");
  writeFileSync(resolve(root, "src/unlinked.ts"), "export const unlinked = 1;\n");
  writeFileSync(resolve(root, "scripts/governs.test.ts"), "assert(direct);\n");
  const manifest = compileContractManifest({
    repositoryRoot: root,
    repositoryKey: "governs-fixture",
    commit: "governs-fixture-commit",
    specDirectory: ".tieline/spec",
  });
  if (options.withManifest) {
    writeFileSync(
      resolve(root, ".tieline/manifest.json"),
      serializeContractManifest(manifest)
    );
  }
  return { root, manifest };
}

function scopes(criteria: GoverningCriterion[]): string[] {
  return criteria.map(
    (entry) =>
      `${entry.acceptance_criterion_stable_id} ${entry.link_scope} ${entry.relation}`
  );
}

const cleanup: string[] = [];
try {
  const { root, manifest } = createFixture({ withManifest: true });
  cleanup.push(root);

  // --- U1: the index -------------------------------------------------------
  const index = buildGoverningCriteriaIndex(manifest);

  // A path linked from an Acceptance Criterion is a direct answer.
  assert.deepEqual(scopes([...(index.get("src/direct.ts") ?? [])]), [
    "GOVERNS-001-AC1 direct implements",
    "GOVERNS-001-AC2 direct implements",
  ]);

  // A path linked only at Story level falls back onto every AC of that Story.
  assert.deepEqual(scopes([...(index.get("src/story-only.ts") ?? [])]), [
    "GOVERNS-001-AC1 story_fallback implements",
    "GOVERNS-001-AC2 story_fallback implements",
  ]);

  // Both scopes on one path stay distinct rather than collapsing.
  assert.deepEqual(scopes([...(index.get("src/shared.ts") ?? [])]), [
    "GOVERNS-001-AC1 direct implements",
    "GOVERNS-001-AC1 story_fallback implements",
    "GOVERNS-001-AC2 story_fallback implements",
  ]);

  // `tests` links are governance too; help links have no path and never appear.
  assert.deepEqual(scopes([...(index.get("scripts/governs.test.ts") ?? [])]), [
    "GOVERNS-001-AC1 direct tests",
  ]);
  const everyEntry = [...index.values()].flatMap((entries) => [...entries]);
  assert.ok(
    everyEntry.every((entry) =>
      ["implements", "enforces", "tests"].includes(entry.relation)
    ),
    "a help `documents` link must never enter the index"
  );
  assert.ok(
    everyEntry.every((entry) => !entry.path.includes("governs-guide")),
    "help identifiers must never be indexed as repository paths"
  );

  // A link that targets a different repository is excluded.
  assert.equal(index.has("src/elsewhere.ts"), false);

  // Story metadata travels with each entry.
  const shared = [...(index.get("src/shared.ts") ?? [])][0] as GoverningCriterion;
  assert.equal(shared.capability_stable_id, "GOVERNS");
  assert.equal(shared.story_stable_id, "GOVERNS-001");
  assert.equal(shared.story_title, "Look up governing criteria");
  assert.equal(
    shared.criterion,
    "Tieline must return the acceptance criterion that links a path."
  );

  // --- Coverage regression: same walk, same mapped set ---------------------
  assert.deepEqual(
    computeRepositoryMappingCoverage(manifest, {
      repositoryRoot: root,
      sourceRoots: ["src"],
      ignore: [".git", ".tieline"],
    }),
    {
      status: "measured",
      source_roots: ["src"],
      eligible_files: 4,
      mapped_files: 3,
      unmapped_files: ["src/unlinked.ts"],
      excluded_files: 0,
      percentage: 75,
    }
  );

  // --- U1/U2: lookup semantics --------------------------------------------
  const report = lookupGoverningCriteria({
    manifest,
    repositoryRoot: root,
    paths: ["src/direct.ts", "src/unlinked.ts", "src/missing.ts", "src/elsewhere.ts"],
  });
  assert.equal(report.repository.commit, "governs-fixture-commit");
  assert.equal(report.governed_paths, 1);
  assert.equal(report.ungoverned_paths, 3);
  assert.equal(report.results.length, 4);

  assert.equal(report.results[0].status, "governed");
  assert.equal(report.results[0].acceptance_criterion_count, 2);
  assert.equal(
    report.results[0].answer,
    "2 acceptance criteria govern 'src/direct.ts'."
  );

  // An existing but unlinked path is an explicit finding, not an empty list.
  assert.equal(report.results[1].status, "ungoverned");
  assert.equal(report.results[1].exists, true);
  assert.equal(
    report.results[1].answer,
    "No acceptance criterion governs 'src/unlinked.ts'. The path exists in the repository but no contract link targets it."
  );

  // A path that does not exist is distinguishable from one that is ungoverned.
  assert.equal(report.results[2].status, "not_found");
  assert.equal(report.results[2].exists, false);
  assert.equal(
    report.results[2].answer,
    "No acceptance criterion governs 'src/missing.ts', and the path does not exist in the repository."
  );
  assert.notEqual(report.results[1].status, report.results[2].status);
  assert.notEqual(report.results[1].answer, report.results[2].answer);

  // A path owned by another repository reads as unknown here, never as governed.
  assert.equal(report.results[3].status, "not_found");
  assert.deepEqual(report.results[3].criteria, []);

  // Path normalization: platform separators, './' prefixes, and absolute paths
  // all resolve to the same repository-relative key.
  const separatorForm = join("src", "direct.ts");
  const normalized = lookupGoverningCriteria({
    manifest,
    repositoryRoot: root,
    paths: [separatorForm, `.${sep}${separatorForm}`, resolve(root, separatorForm)],
  });
  for (const result of normalized.results) {
    assert.equal(result.path, "src/direct.ts");
    assert.equal(result.status, "governed");
    assert.deepEqual(scopes(result.criteria), scopes(report.results[0].criteria));
  }
  assert.equal(normalized.results[2].requested_path, resolve(root, separatorForm));

  // --- U2: the CLI action --------------------------------------------------
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

  output = "";
  assert.equal(
    await runCli(
      ["contract", "governs", "--repository", root, "src/shared.ts"],
      io,
      {}
    ),
    0
  );
  assert.match(output, /at manifest commit governs-fixture-commit/);
  assert.match(output, /GOVERNS-001-AC1 direct implements/);
  assert.match(output, /GOVERNS-001-AC1 story_fallback implements/);
  assert.match(output, /GOVERNS-001-AC2 story_fallback implements/);

  output = "";
  assert.equal(
    await runCli(
      ["contract", "governs", "--repository", root, "src/unlinked.ts"],
      io,
      {}
    ),
    0
  );
  assert.match(output, /ungoverned {2}No acceptance criterion governs/);

  // Multiple paths in one invocation each get their own result, and the JSON
  // shape carries the manifest commit that answered.
  output = "";
  assert.equal(
    await runCli(
      [
        "contract",
        "governs",
        "--repository",
        root,
        "src/direct.ts",
        "src/unlinked.ts",
        "src/missing.ts",
        "--json",
      ],
      io,
      {}
    ),
    0
  );
  assert.deepEqual(JSON.parse(output), {
    repository: { key: "governs-fixture", commit: "governs-fixture-commit" },
    governed_paths: 1,
    ungoverned_paths: 2,
    results: [
      {
        requested_path: "src/direct.ts",
        path: "src/direct.ts",
        status: "governed",
        exists: true,
        acceptance_criterion_count: 2,
        answer: "2 acceptance criteria govern 'src/direct.ts'.",
        criteria: [
          {
            path: "src/direct.ts",
            capability_stable_id: "GOVERNS",
            story_stable_id: "GOVERNS-001",
            story_title: "Look up governing criteria",
            acceptance_criterion_stable_id: "GOVERNS-001-AC1",
            criterion:
              "Tieline must return the acceptance criterion that links a path.",
            relation: "implements",
            link_scope: "direct",
          },
          {
            path: "src/direct.ts",
            capability_stable_id: "GOVERNS",
            story_stable_id: "GOVERNS-001",
            story_title: "Look up governing criteria",
            acceptance_criterion_stable_id: "GOVERNS-001-AC2",
            criterion:
              "Tieline must return every acceptance criterion that links a path.",
            relation: "implements",
            link_scope: "direct",
          },
        ],
      },
      {
        requested_path: "src/unlinked.ts",
        path: "src/unlinked.ts",
        status: "ungoverned",
        exists: true,
        acceptance_criterion_count: 0,
        answer:
          "No acceptance criterion governs 'src/unlinked.ts'. The path exists in the repository but no contract link targets it.",
        criteria: [],
      },
      {
        requested_path: "src/missing.ts",
        path: "src/missing.ts",
        status: "not_found",
        exists: false,
        acceptance_criterion_count: 0,
        answer:
          "No acceptance criterion governs 'src/missing.ts', and the path does not exist in the repository.",
        criteria: [],
      },
    ],
  });

  await assert.rejects(
    runCli(["contract", "governs", "--repository", root], io, {}),
    /missing required argument/i
  );

  // --- U3: the MCP tool ----------------------------------------------------
  // The tool module must not reach for the knowledge store at all.
  const toolSource = readFileSync(
    resolve(repositoryRoot, "src/tools/governing-criteria.ts"),
    "utf8"
  );
  assert.doesNotMatch(toolSource, /get(Read|Evidence|Planning)?Store\s*\(/);

  // Any use of the store — during registration or during the call — throws.
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
  assert.equal(registered.length, 1);
  const tool = registered[0];
  assert.equal(tool.name, "get_governing_criteria");
  assert.equal(tool.config.annotations?.readOnlyHint, true);
  // The description has to separate this lookup from ranked search, because
  // both surfaces accept a path.
  assert.match(tool.config.description, /search_knowledge/);
  assert.match(tool.config.description, /No database/i);
  assert.match(tool.config.description, /link_scope/);

  // The handler resolves the workspace lazily from the process directory.
  const previousCwd = process.cwd();
  let handlerResult: ToolResult;
  try {
    process.chdir(resolve(root, "src"));
    handlerResult = await tool.handler({
      paths: ["src/shared.ts", "src/unlinked.ts"],
    });
  } finally {
    process.chdir(previousCwd);
  }
  assert.notEqual(handlerResult.isError, true);
  const structured = handlerResult.structuredContent as {
    repository: { key: string; commit: string };
    governed_paths: number;
    ungoverned_paths: number;
    results: { path: string; status: string; criteria: GoverningCriterion[] }[];
    note?: string;
  };
  assert.equal(structured.repository.commit, "governs-fixture-commit");
  assert.equal(structured.governed_paths, 1);
  assert.equal(structured.results[0].status, "governed");
  assert.deepEqual(scopes(structured.results[0].criteria), [
    "GOVERNS-001-AC1 direct implements",
    "GOVERNS-001-AC1 story_fallback implements",
    "GOVERNS-001-AC2 story_fallback implements",
  ]);
  assert.equal(structured.results[1].status, "ungoverned");
  assert.match(structured.note ?? "", /governed by no acceptance criterion/);

  // The same answer without a server, proving no database is involved.
  const resolved = resolveGoverningCriteria({
    paths: ["src/direct.ts"],
    cwd: root,
  });
  assert.equal(resolved.status, "resolved");

  // No workspace: a clear, actionable message instead of an obscure throw.
  const stray = mkdtempSync(resolve(tmpdir(), "tieline-governs-nowork-"));
  cleanup.push(stray);
  const withoutWorkspace = resolveGoverningCriteria({
    paths: ["src/direct.ts"],
    cwd: stray,
  });
  assert.equal(withoutWorkspace.status, "no_workspace");
  assert.match(
    withoutWorkspace.status === "no_workspace" ? withoutWorkspace.message : "",
    /No Tieline workspace was found[\s\S]*tieline init/
  );

  // Missing manifest: named path plus the command that produces it.
  const { root: withoutManifest } = createFixture({ withManifest: false });
  cleanup.push(withoutManifest);
  const unreadable = resolveGoverningCriteria({
    paths: ["src/direct.ts"],
    cwd: withoutManifest,
  });
  assert.equal(unreadable.status, "no_manifest");
  assert.match(
    unreadable.status === "no_manifest" ? unreadable.message : "",
    /manifest[\s\S]*missing or unreadable[\s\S]*tieline contract compile/
  );

  // Both failure modes surface through the tool as an error result, not a throw.
  const strayCwd = process.cwd();
  let strayResult: ToolResult;
  try {
    process.chdir(stray);
    strayResult = await tool.handler({ paths: ["src/direct.ts"] });
  } finally {
    process.chdir(strayCwd);
  }
  assert.equal(strayResult.isError, true);
  assert.match(strayResult.content[0].text, /No Tieline workspace was found/);
} finally {
  for (const path of cleanup) {
    rmSync(path, { recursive: true, force: true });
  }
}

console.log("governs tests passed");
