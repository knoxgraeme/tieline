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
  buildPathCriteriaIndex,
  lookupPathCriteria,
  type PathCriterion,
} from "../src/contract/path-criteria.js";
import {
  compileContractManifestWithSources,
  manifestDigest,
  writeContractManifest,
  type ContractManifest,
} from "../src/contract/manifest.js";
import { repositoryEntryKindExactly } from "../src/contract/paths.js";
import { setStore, type KnowledgeStore } from "../src/store.js";
import {
  registerGetPathCriteria,
  resolvePathCriteria,
} from "../src/tools/path-criteria.js";
import type { ToolResult } from "../src/tools/shared.js";
import { tielineConfigJson } from "./lib/fixtures.js";

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
  return tielineConfigJson({
    name: "Path criteria fixture",
    repoName: "path-criteria-fixture",
    ignore: [".git", ".tieline"],
    specDirectory: "spec",
  });
}

const SPEC = `version: 1
capability:
  key: PATH-CRITERIA
  name: Path criteria lookup
  description: A repository path resolves to the acceptance criteria that apply to it.
  stories:
    - key: PATH-CRITERIA-001
      title: Look up path criteria
      actor: implementing agent
      goal: know which criteria apply to a path before editing it
      benefit: a contradiction is prevented instead of reported afterwards
      lifecycle: production
      links:
        - relation: implements
          provenance: authored
          target:
            kind: code
            repository: path-criteria-fixture
            path: src/story-only.ts
        - relation: implements
          provenance: authored
          target:
            kind: code
            repository: path-criteria-fixture
            path: src/shared.ts
      acceptance_criteria:
        - key: PATH-CRITERIA-001-AC1
          criterion: Tieline must return the acceptance criterion that links a path.
          links:
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: path-criteria-fixture
                path: src/direct.ts
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: path-criteria-fixture
                path: src/direct.ts
                selector: function:direct
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: path-criteria-fixture
                path: src/direct.ts
                selector: const:direct
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: path-criteria-fixture
                path: src/shared.ts
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: other-repository
                path: src/elsewhere.ts
            - relation: documents
              provenance: authored
              target:
                kind: help
                source: docs
                external_id: path-criteria-guide
        - key: PATH-CRITERIA-001-AC2
          criterion: Tieline must return every acceptance criterion that links a path.
          links:
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: path-criteria-fixture
                path: src/direct.ts
            - relation: tests
              provenance: authored
              target:
                kind: test
                repository: path-criteria-fixture
                path: src/direct.test.ts
                selector: function:direct
                framework_hint: node-test
`;

const OTHER_SPEC = `version: 1
capability:
  key: OTHER-CAPABILITY
  name: Unqueried contract content
  description: Contract content outside the queried path still contributes to manifest identity.
  stories:
    - key: OTHER-CAPABILITY-001
      title: Keep exact reads attributable
      actor: implementing agent
      goal: identify the complete reviewed contract behind an exact read
      benefit: changes outside one lookup remain visible in its manifest identity
      lifecycle: production
      acceptance_criteria:
        - key: OTHER-CAPABILITY-001-AC1
          criterion: Tieline must include the first unqueried contract statement in manifest identity.
`;

function createFixture(withManifest: boolean): {
  root: string;
  manifest: ContractManifest;
} {
  const root = mkdtempSync(resolve(tmpdir(), "tieline-path-criteria-"));
  mkdirSync(resolve(root, ".tieline/spec"), { recursive: true });
  mkdirSync(resolve(root, "src"), { recursive: true });
  writeFileSync(resolve(root, ".tieline/config.json"), workspaceConfig());
  writeFileSync(resolve(root, ".tieline/spec/path-criteria.yaml"), SPEC);
  writeFileSync(resolve(root, ".tieline/spec/other.yaml"), OTHER_SPEC);
  writeFileSync(resolve(root, "src/direct.ts"), "export const direct = 1;\n");
  writeFileSync(
    resolve(root, "src/direct.test.ts"),
    "export function direct() {}\n"
  );
  writeFileSync(resolve(root, "src/shared.ts"), "export const shared = 1;\n");
  writeFileSync(
    resolve(root, "src/story-only.ts"),
    "export const storyOnly = 1;\n"
  );
  writeFileSync(
    resolve(root, "src/no-criteria.ts"),
    "export const noCriteria = 1;\n"
  );
  const compiled = compileContractManifestWithSources({
    repositoryRoot: root,
    repositoryKey: "path-criteria-fixture",
    specDirectory: ".tieline/spec",
  });
  if (withManifest) {
    writeContractManifest(resolve(root, ".tieline/manifest"), compiled);
  }
  return { root, manifest: compiled.manifest };
}

function scopes(criteria: readonly PathCriterion[]): string[] {
  return criteria.map(
    (entry) =>
      `${entry.acceptance_criterion_stable_id} ${entry.link_scope} ${entry.relation}`
  );
}

const cleanup: string[] = [];
try {
  const { root, manifest } = createFixture(true);
  cleanup.push(root);

  assert.equal(
    repositoryEntryKindExactly(root, "src/missing.ts", {
      stat() {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      readdir() {
        throw new Error("readdir must not run after a missing stat");
      },
    }),
    "missing"
  );
  assert.throws(
    () =>
      repositoryEntryKindExactly(root, "src/direct.ts", {
        stat() {
          throw Object.assign(new Error("permission denied"), {
            code: "EACCES",
          });
        },
        readdir() {
          return ["src"];
        },
      }),
    /Could not inspect repository path 'src\/direct\.ts'.*EACCES/
  );
  assert.throws(
    () =>
      repositoryEntryKindExactly(root, "src/direct.ts", {
        stat() {
          return { isFile: () => true };
        },
        readdir() {
          throw Object.assign(new Error("I/O failure"), { code: "EIO" });
        },
      }),
    /Could not inspect repository path 'src\/direct\.ts'.*EIO/
  );

  const index = buildPathCriteriaIndex(manifest);
  assert.deepEqual(scopes(index.get("src/direct.ts") ?? []), [
    "PATH-CRITERIA-001-AC1 direct implements",
    "PATH-CRITERIA-001-AC1 direct implements",
    "PATH-CRITERIA-001-AC1 direct implements",
    "PATH-CRITERIA-001-AC2 direct implements",
  ]);
  assert.deepEqual(scopes(index.get("src/story-only.ts") ?? []), [
    "PATH-CRITERIA-001-AC1 story_fallback implements",
    "PATH-CRITERIA-001-AC2 story_fallback implements",
  ]);
  assert.deepEqual(scopes(index.get("src/shared.ts") ?? []), [
    "PATH-CRITERIA-001-AC1 direct implements",
    "PATH-CRITERIA-001-AC1 story_fallback implements",
    "PATH-CRITERIA-001-AC2 story_fallback implements",
  ]);
  assert.equal(index.has("src/elsewhere.ts"), false);

  const first = index.get("src/shared.ts")?.[0];
  assert.equal(first?.capability_stable_id, "PATH-CRITERIA");
  assert.equal(first?.story_stable_id, "PATH-CRITERIA-001");
  assert.equal(first?.story_title, "Look up path criteria");
  assert.equal(first?.provenance, "authored");
  assert.deepEqual(
    (index.get("src/direct.ts") ?? []).map((criterion) => ({
      target_kind: criterion.target_kind,
      repository: criterion.repository,
      path: criterion.path,
      selector: criterion.selector,
      framework_hint: criterion.framework_hint,
    })),
    [
      {
        target_kind: "code",
        repository: "path-criteria-fixture",
        path: "src/direct.ts",
        selector: null,
        framework_hint: null,
      },
      {
        target_kind: "code",
        repository: "path-criteria-fixture",
        path: "src/direct.ts",
        selector: "const:direct",
        framework_hint: null,
      },
      {
        target_kind: "code",
        repository: "path-criteria-fixture",
        path: "src/direct.ts",
        selector: "function:direct",
        framework_hint: null,
      },
      {
        target_kind: "code",
        repository: "path-criteria-fixture",
        path: "src/direct.ts",
        selector: null,
        framework_hint: null,
      },
    ]
  );
  assert.deepEqual(index.get("src/direct.test.ts")?.[0], {
    path: "src/direct.test.ts",
    target_kind: "test",
    repository: "path-criteria-fixture",
    selector: "function:direct",
    framework_hint: "node-test",
    capability_stable_id: "PATH-CRITERIA",
    story_stable_id: "PATH-CRITERIA-001",
    story_title: "Look up path criteria",
    acceptance_criterion_stable_id: "PATH-CRITERIA-001-AC2",
    criterion: "Tieline must return every acceptance criterion that links a path.",
    relation: "tests",
    provenance: "authored",
    link_scope: "direct",
  });

  const report = lookupPathCriteria({
    manifest,
    repositoryRoot: root,
    paths: [
      "src/direct.ts",
      "src/no-criteria.ts",
      "src/missing.ts",
      resolve(root, "src/story-only.ts"),
      "src/DIRECT.ts",
    ],
  });
  assert.deepEqual(report.repository, { key: "path-criteria-fixture" });
  assert.equal(report.manifest_digest, manifestDigest(manifest));
  assert.equal(report.has_criteria_paths, 2);
  assert.equal(report.no_criteria_paths, 1);
  assert.equal(report.not_found_paths, 2);
  assert.equal(report.results[0]?.status, "has_criteria");
  assert.equal(report.results[0]?.acceptance_criterion_count, 2);
  assert.equal(
    report.results[0]?.answer,
    "2 acceptance criteria apply to 'src/direct.ts'."
  );
  assert.equal(report.results[1]?.status, "no_criteria");
  assert.equal(report.results[1]?.exists, true);
  assert.match(
    report.results[1]?.answer ?? "",
    /No acceptance criteria apply/
  );
  assert.equal(report.results[2]?.status, "not_found");
  assert.equal(report.results[2]?.exists, false);
  assert.match(report.results[2]?.answer ?? "", /does not exist/);
  assert.equal(report.results[3]?.path, "src/story-only.ts");
  assert.equal(report.results[3]?.status, "has_criteria");
  // A case-insensitive filesystem must not turn a misspelled path with criteria
  // into an existing path with no criteria.
  assert.equal(report.results[4]?.status, "not_found");
  assert.equal(report.results[4]?.exists, false);

  writeFileSync(
    resolve(root, ".tieline/spec/other.yaml"),
    OTHER_SPEC.replace("first unqueried", "changed unqueried")
  );
  const changedManifest = compileContractManifestWithSources({
    repositoryRoot: root,
    repositoryKey: "path-criteria-fixture",
    specDirectory: ".tieline/spec",
  }).manifest;
  const changedReport = lookupPathCriteria({
    manifest: changedManifest,
    repositoryRoot: root,
    paths: ["src/direct.ts"],
  });
  assert.notEqual(
    changedReport.manifest_digest,
    report.manifest_digest,
    "an unqueried capability still changes the complete manifest identity"
  );
  assert.deepEqual(
    changedReport.results[0]?.criteria.map(
      (criterion) => criterion.acceptance_criterion_stable_id
    ),
    report.results[0]?.criteria.map(
      (criterion) => criterion.acceptance_criterion_stable_id
    ),
    "changing unqueried content does not change the path lookup itself"
  );

  let output = "";
  const io: TielineCliIO = {
    write(message) {
      output += message;
    },
    error(message) {
      throw new Error(message);
    },
    async question() {
      throw new Error("contract criteria must not prompt");
    },
  };

  assert.equal(
    await runCli(
      ["contract", "criteria", "--repository", root, "src/shared.ts"],
      io,
      {}
    ),
    0
  );
  assert.match(output, new RegExp(`manifest ${manifestDigest(manifest)}`));
  assert.match(output, /PATH-CRITERIA-001-AC1 direct implements/);
  assert.match(output, /PATH-CRITERIA-001-AC1 story_fallback implements/);

  output = "";
  assert.equal(
    await runCli(
      [
        "contract",
        "criteria",
        "--repository",
        root,
        "src/no-criteria.ts",
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
    ["no_criteria", "not_found"]
  );
  assert.deepEqual(cliReport.repository, { key: "path-criteria-fixture" });
  assert.equal(cliReport.manifest_digest, manifestDigest(manifest));

  const toolSource = readFileSync(
    resolve(projectRoot, "src/tools/path-criteria.ts"),
    "utf8"
  );
  assert.doesNotMatch(toolSource, /get(Read|Evidence|Planning)?Store\s*\(/);
  setStore(
    new Proxy(
      {},
      {
        get(_target, property) {
          throw new Error(
            `get_path_criteria must not use the knowledge store (accessed '${String(property)}')`
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

  registerGetPathCriteria(fakeServer);
  const tool = registered[0];
  assert.equal(tool?.name, "get_path_criteria");
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
      paths: ["src/shared.ts", "src/no-criteria.ts", "src/missing.ts"],
    });
  } finally {
    process.chdir(previousCwd);
  }
  assert.notEqual(handlerResult.isError, true);
  const structured = handlerResult.structuredContent as {
    repository: { key: string };
    manifest_digest: string;
    has_criteria_paths: number;
    no_criteria_paths: number;
    not_found_paths: number;
    results: Array<{ status: string; criteria: PathCriterion[] }>;
    note?: string;
  };
  assert.deepEqual(structured.repository, { key: "path-criteria-fixture" });
  assert.equal(structured.manifest_digest, manifestDigest(manifest));
  assert.equal(structured.has_criteria_paths, 1);
  assert.equal(structured.no_criteria_paths, 1);
  assert.equal(structured.not_found_paths, 1);
  assert.equal(structured.results[0]?.status, "has_criteria");
  assert.equal(structured.results[1]?.status, "no_criteria");
  assert.equal(structured.results[2]?.status, "not_found");
  assert.match(structured.note ?? "", /1 existing path has no acceptance criteria/);
  assert.match(structured.note ?? "", /1 requested path was not found/);

  const resolved = resolvePathCriteria({
    paths: ["src/direct.ts"],
    cwd: root,
  });
  assert.equal(resolved.status, "resolved");

  const stray = mkdtempSync(resolve(tmpdir(), "tieline-path-criteria-nowork-"));
  cleanup.push(stray);
  const withoutWorkspace = resolvePathCriteria({
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
  const unreadable = resolvePathCriteria({
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
      manifest_digest: string;
    }).manifest_digest,
    manifestDigest(manifest)
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

console.log("path criteria tests passed");
