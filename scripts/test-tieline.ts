import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { runCli, type TielineCliIO } from "../src/cli.js";
import { parseDraft, toImportPayload } from "../src/authoring/schema.js";
import { resolveEmbeddingProvider, runDatabasePreflight } from "../src/tieline/preflight.js";
import {
  loadWorkspaceProfile,
  profilePath,
  readWorkspaceProfile,
} from "../src/tieline/profile.js";
import { configureWorkspaceRuntime } from "../src/tieline/setup.js";
import { getTielineStatus, type TielineStatus } from "../src/tieline/status.js";
import {
  findTielineWorkspace,
  resolveWorkspaceRepo,
  validateWorkspaceEmbeddingProvider,
  validateWorkspaceImport,
} from "../src/tieline/workspace.js";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (error) {
    console.error(`  not ok - ${name}`);
    throw error;
  }
}

function testIo(): { io: TielineCliIO; output: string[] } {
  const messages: string[] = [];
  return {
    output: messages,
    io: {
      write: (message) => messages.push(message),
      error: (message) => messages.push(message),
      question: async () => {
        throw new Error("Unexpected interactive prompt in non-interactive test.");
      },
    },
  };
}

function answeringIo(answers: string[]): { io: TielineCliIO; output: string[] } {
  const output: string[] = [];
  const queue = [...answers];
  return {
    output,
    io: {
      write: (message) => output.push(message),
      error: (message) => output.push(message),
      question: async (message) => {
        output.push(message);
        const answer = queue.shift();
        if (answer === undefined) throw new Error(`No test answer remains for: ${message}`);
        return answer;
      },
    },
  };
}

const root = mkdtempSync(resolve(tmpdir(), "tieline-cli-"));
try {
  const configHome = resolve(root, "user-config");
  const target = resolve(root, "Acme Product");
  mkdirSync(resolve(target, "src"), { recursive: true });
  mkdirSync(resolve(target, ".git"));
  writeFileSync(resolve(target, "src/share.ts"), "export const share = true;\n");
  writeFileSync(resolve(root, "outside.ts"), "export const outside = true;\n");
  symlinkSync(resolve(root, "outside.ts"), resolve(target, "src/outside-link.ts"));
  writeFileSync(resolve(target, "package.json"), JSON.stringify({ name: "@acme/product" }));

  await test("tieline init creates a complete local workspace without secrets", async () => {
    const { io, output } = testIo();
    const code = await runCli(
      [
        "init",
        target,
        "--yes",
        "--product",
        "Acme",
        "--repo-name",
        "Acme Web",
        "--description",
        "A client collaboration product.",
        "--context",
        "https://acme.example/features",
      ],
      io,
      { EMBEDDING_PROVIDER: "hash", TIELINE_CONFIG_HOME: configHome }
    );
    assert.equal(code, 0);
    assert.match(output.join(""), /Created .*\.tieline/);
    const workspace = findTielineWorkspace(target);
    assert.ok(workspace);
    assert.equal(workspace.config.product.repo_name, "acme-web");
    assert.equal(workspace.config.repository.root, "..");
    assert.deepEqual(workspace.config.repository.source_roots, ["src"]);
    assert.equal(workspace.config.context.sources[1]?.allow_external_fetch, true);
    assert.equal("DATABASE_URL" in JSON.parse(readFileSync(workspace.configPath, "utf8")), false);
    assert.match(readFileSync(workspace.handoffPath, "utf8"), /Marketing establishes/);
    assert.match(readFileSync(workspace.contextPath, "utf8"), /^status: draft$/m);
    assert.deepEqual(JSON.parse(readFileSync(workspace.mcpConfigPath, "utf8")), {
      mcpServers: {
        tieline: {
          command: "tieline",
          args: ["serve"],
          env: { TIELINE_WORKSPACE: target },
        },
      },
    });
    const stored = readWorkspaceProfile(workspace, { TIELINE_CONFIG_HOME: configHome });
    assert.ok(stored);
    assert.equal(stored.profile.env.EMBEDDING_PROVIDER, "hash");
    if (process.platform !== "win32") assert.equal(statSync(stored.path).mode & 0o777, 0o600);
  });

  await test("workspace profiles auto-load without overriding explicit environment values", () => {
    const workspace = findTielineWorkspace(target)!;
    const stored = readWorkspaceProfile(workspace, { TIELINE_CONFIG_HOME: configHome });
    assert.ok(stored);
    const env: NodeJS.ProcessEnv = {
      TIELINE_CONFIG_HOME: configHome,
      EMBEDDING_PROVIDER: "openai",
    };
    const loaded = loadWorkspaceProfile(target, env);
    assert.ok(loaded);
    assert.equal(env.EMBEDDING_PROVIDER, "openai");
    assert.equal(loaded.loaded.includes("EMBEDDING_PROVIDER"), false);
    assert.equal(stored.path, profilePath(workspace.config.runtime.profile_id!, env));
  });

  await test("guided init can complete a fully offline onboarding without external mutations", async () => {
    const guided = resolve(root, "Guided Product");
    mkdirSync(resolve(guided, "src"), { recursive: true });
    const { io, output } = answeringIo([
      "Guided Product",
      "guided-product",
      "A test product.",
      "",
      "src",
      "3",
      "4",
      "1",
      "y",
    ]);
    assert.equal(
      await runCli(
        ["init", guided],
        io,
        { TIELINE_CONFIG_HOME: configHome, DATABASE_URL_INGEST: "not-a-database-url" }
      ),
      0
    );
    const workspace = findTielineWorkspace(guided)!;
    assert.equal(workspace.config.runtime.database_mode, "offline");
    assert.equal(workspace.config.runtime.embedding_provider, "hash");
    assert.equal(workspace.config.runtime.approval_mode, "production");
    assert.match(output.join(""), /database=offline, embedding=hash, approval=production/);
    assert.equal(
      readWorkspaceProfile(workspace, { TIELINE_CONFIG_HOME: configHome })?.profile.env.DATABASE_URL_INGEST,
      undefined
    );
  });

  await test("local database setup migrates before storing least-privilege role URLs", async () => {
    const workspace = findTielineWorkspace(resolve(root, "Guided Product"))!;
    const calls: string[] = [];
    const env: NodeJS.ProcessEnv = { TIELINE_CONFIG_HOME: configHome };
    await configureWorkspaceRuntime({
      workspace,
      databaseMode: "local",
      embeddingProvider: "hash",
      approvalMode: "production",
      installLocalEmbedder: false,
      skipMigrate: false,
      env,
      io: { write: () => undefined },
      dependencies: {
        startLocalDatabase: async () => {
          calls.push("start");
          return {
            ownerUrl: "postgresql://owner:private@127.0.0.1:5432/tieline",
            container: "tieline-postgres-test",
          };
        },
        migrateDatabase: async () => {
          calls.push("migrate");
        },
        provisionLocalRoles: async () => {
          calls.push("roles");
          return {
            DATABASE_URL: "postgresql://reader:private@127.0.0.1:5432/tieline",
            DATABASE_URL_INGEST: "postgresql://owner:private@127.0.0.1:5432/tieline",
            DATABASE_URL_WRITE: "postgresql://writer:private@127.0.0.1:5432/tieline",
            DATABASE_URL_APPROVAL: "postgresql://approver:private@127.0.0.1:5432/tieline",
          };
        },
      },
    });
    assert.deepEqual(calls, ["start", "migrate", "roles"]);
    assert.equal(findTielineWorkspace(workspace.root)!.config.runtime.database_mode, "local");
    assert.match(
      readWorkspaceProfile(workspace, env)!.profile.env.DATABASE_URL_WRITE,
      /^postgresql:\/\/writer:/
    );
  });

  await test("existing database onboarding stores credentials only in the private profile", async () => {
    const connected = resolve(root, "Connected Product");
    mkdirSync(resolve(connected, "src"), { recursive: true });
    const urls = {
      DATABASE_URL: "postgresql://reader:secret@db.example/tieline",
      DATABASE_URL_INGEST: "postgresql://owner:secret@db.example/tieline",
      DATABASE_URL_WRITE: "postgresql://writer:secret@db.example/tieline",
      DATABASE_URL_APPROVAL: "postgresql://approver:secret@db.example/tieline",
    };
    const { io } = testIo();
    assert.equal(
      await runCli(
        [
          "init",
          connected,
          "--yes",
          "--database",
          "existing",
          "--embedding",
          "hash",
          "--skip-migrate",
        ],
        io,
        { ...urls, TIELINE_CONFIG_HOME: configHome }
      ),
      0
    );
    const workspace = findTielineWorkspace(connected)!;
    const workspaceText = [
      workspace.configPath,
      workspace.contextPath,
      workspace.coveragePath,
      workspace.draftPath,
      workspace.handoffPath,
      workspace.mcpConfigPath,
    ].map((path) => readFileSync(path, "utf8")).join("\n");
    assert.doesNotMatch(workspaceText, /postgresql:\/\//);
    assert.doesNotMatch(workspaceText, /secret/);
    const stored = readWorkspaceProfile(workspace, { TIELINE_CONFIG_HOME: configHome });
    assert.equal(stored?.profile.env.DATABASE_URL_WRITE, urls.DATABASE_URL_WRITE);
    assert.equal(workspace.config.runtime.database_mode, "existing");
    assert.ok(workspace.config.runtime.setup_completed_at);
  });

  await test("offline preflight is optional and invalid providers fail early", async () => {
    assert.deepEqual(await runDatabasePreflight({}), []);
    assert.equal(
      (await runDatabasePreflight({ DATABASE_URL_INGEST: "not-a-database-url" }))[0]?.status,
      "warning"
    );
    assert.equal(resolveEmbeddingProvider({ SUPABASE_URL: "x", SUPABASE_ANON_KEY: "y" }), "supabase-edge");
    assert.throws(() => resolveEmbeddingProvider({ EMBEDDING_PROVIDER: "unknown" }), /Invalid/);
  });

  await test("rerunning init resumes instead of overwriting human work", async () => {
    const workspace = findTielineWorkspace(target)!;
    writeFileSync(workspace.contextPath, `${readFileSync(workspace.contextPath, "utf8")}\nHuman edit.\n`);
    const { io, output } = testIo();
    const code = await runCli(
      ["init", target, "--yes", "--product", "Ignored"],
      io,
      { TIELINE_CONFIG_HOME: configHome }
    );
    assert.equal(code, 0);
    assert.match(output.join(""), /already initialized/);
    assert.match(readFileSync(workspace.contextPath, "utf8"), /Human edit/);
  });

  await test("context approval is explicit, checksummed, and becomes stale after edits", async () => {
    const { io } = testIo();
    assert.equal(await runCli(["context", "approve", target, "--yes"], io, {}), 0);
    let workspace = findTielineWorkspace(target)!;
    assert.equal(getTielineStatus(workspace).context.status, "approved");
    assert.match(workspace.config.context.approved_checksum ?? "", /^[a-f0-9]{64}$/);
    writeFileSync(workspace.contextPath, `${readFileSync(workspace.contextPath, "utf8")}\nChanged after approval.\n`);
    workspace = findTielineWorkspace(target)!;
    assert.equal(getTielineStatus(workspace).context.status, "stale");
    assert.equal(await runCli(["context", "approve", target, "--yes"], io, {}), 0);
    assert.equal(getTielineStatus(findTielineWorkspace(target)!).context.status, "approved");
  });

  await test("draft status is pinned to the approved product context", () => {
    const workspace = findTielineWorkspace(target)!;
    const checksum = workspace.config.context.approved_checksum!;
    const draft = parseDraft({
      version: 1,
      mode: "backfill",
      repo: "acme-web",
      product_context_checksum: checksum,
      sections: [{ section_key: "sharing", section_name: "Sharing" }],
      stories: [
        {
          story_key: null,
          section_key: "sharing",
          title: "Share work with a client",
          story_text: "As a creator, I want to share work with my client.",
          status: "production",
          entity_slugs: ["sharing", "client"],
          code_paths: ["src/share.ts"],
          _review: { id: "d-0001", state: "pending", comment: "" },
        },
      ],
    });
    writeFileSync(workspace.draftPath, `${JSON.stringify(draft, null, 2)}\n`);
    writeFileSync(
      workspace.coveragePath,
      `${JSON.stringify({
        version: 1,
        status: "complete",
        repo: "acme-web",
        product_context_checksum: checksum,
        areas_examined: ["sharing"],
        uncertain_areas: [],
      }, null, 2)}\n`
    );
    let status = getTielineStatus(workspace);
    assert.equal(status.draft.product_context_current, true);
    assert.equal(status.draft.pending, 1);
    draft.stories[0]._review.state = "approved";
    writeFileSync(workspace.draftPath, `${JSON.stringify(draft, null, 2)}\n`);
    status = getTielineStatus(workspace);
    assert.equal(status.draft.approved, 1);
  });

  await test("Tieline import validation enforces repo identity, approval, checksum, and real paths", () => {
    const workspace = findTielineWorkspace(target)!;
    const draft = parseDraft(JSON.parse(readFileSync(workspace.draftPath, "utf8")));
    const payload = toImportPayload(draft);
    assert.doesNotThrow(() => validateWorkspaceImport(workspace, payload));
    const coverage = JSON.parse(readFileSync(workspace.coveragePath, "utf8")) as Record<string, unknown>;
    writeFileSync(workspace.coveragePath, `${JSON.stringify({ ...coverage, status: "in_progress" }, null, 2)}\n`);
    assert.throws(() => validateWorkspaceImport(workspace, payload), /coverage is not complete/i);
    writeFileSync(workspace.coveragePath, `${JSON.stringify(coverage, null, 2)}\n`);
    assert.throws(
      () => validateWorkspaceImport(workspace, { ...payload, import_source: "wrong-repo" }),
      /configured repository/
    );
    assert.throws(
      () =>
        validateWorkspaceImport(workspace, {
          ...payload,
          stories: payload.stories.map((story) => ({ ...story, code_paths: ["src/missing.ts"] })),
        }),
      /invalid code path/
    );
    assert.throws(
      () =>
        validateWorkspaceImport(workspace, {
          ...payload,
          stories: payload.stories.map((story) => ({ ...story, code_paths: ["src/outside-link.ts"] })),
        }),
      /invalid code path/
    );
    assert.equal(resolveWorkspaceRepo(workspace), "acme-web");
    assert.throws(() => resolveWorkspaceRepo(workspace, "other"), /conflicts/);
    assert.doesNotThrow(() => validateWorkspaceEmbeddingProvider(workspace, "hash"));
    assert.throws(() => validateWorkspaceEmbeddingProvider(workspace, "local"), /differs/);
  });

  await test("status supports machine-readable output", async () => {
    const { io, output } = testIo();
    assert.equal(await runCli(["status", target, "--json"], io, {}), 0);
    const status = JSON.parse(output.join("")) as { initialized: boolean; draft: { approved: number } };
    assert.equal(status.initialized, true);
    assert.equal(status.draft.approved, 1);
  });

  await test("status distinguishes a current import report from a changed draft", () => {
    const workspace = findTielineWorkspace(target)!;
    const draftBody = readFileSync(workspace.draftPath, "utf8");
    const sourceChecksum = createHash("sha256").update(draftBody).digest("hex");
    writeFileSync(
      `${workspace.draftPath}.import-report.json`,
      `${JSON.stringify({ status: "complete", source_checksum: sourceChecksum })}\n`
    );
    assert.equal(getTielineStatus(workspace).import.current, true);
    writeFileSync(workspace.draftPath, `${draftBody}\n`);
    assert.equal(getTielineStatus(workspace).import.current, false);
  });

  // Sharded drafting gets its own repository so merge writes cannot disturb the
  // draft/import-report state the tests above depend on.
  const shardTarget = resolve(root, "sharded-product");
  mkdirSync(resolve(shardTarget, "src"), { recursive: true });
  writeFileSync(resolve(shardTarget, "src/invite.ts"), "export const invite = true;\n");
  writeFileSync(resolve(shardTarget, "src/billing.ts"), "export const billing = true;\n");

  function shardBody(
    checksum: string,
    section: { key: string; name: string },
    story: { id: string; title: string; path: string }
  ): string {
    return `${JSON.stringify(
      {
        version: 1,
        mode: "backfill",
        repo: "sharded-product",
        product_context_checksum: checksum,
        sections: [{ section_key: section.key, section_name: section.name }],
        stories: [
          {
            story_key: null,
            section_key: section.key,
            title: story.title,
            story_text: `As a member, I want to ${story.title.toLowerCase()}.`,
            status: "production",
            code_paths: [story.path],
            _review: { id: story.id, state: "pending", comment: "" },
          },
        ],
      },
      null,
      2
    )}\n`;
  }

  await test("merge namespaces shard review ids so two shards can both mint d-0001", async () => {
    const { io } = testIo();
    await runCli(["init", shardTarget, "--yes"], io, {
      EMBEDDING_PROVIDER: "hash",
      TIELINE_CONFIG_HOME: configHome,
    });
    await runCli(["context", "approve", shardTarget, "--yes"], io, {});
    const workspace = findTielineWorkspace(shardTarget)!;
    const checksum = workspace.config.context.approved_checksum!;
    assert.equal(statSync(workspace.draftsDirPath).isDirectory(), true);
    writeFileSync(
      resolve(workspace.draftsDirPath, "sharing.draft.json"),
      shardBody(checksum, { key: "sharing", name: "Sharing" }, {
        id: "d-0001",
        title: "Invite a teammate",
        path: "src/invite.ts",
      })
    );
    writeFileSync(
      resolve(workspace.draftsDirPath, "billing.draft.json"),
      shardBody(checksum, { key: "billing", name: "Billing" }, {
        id: "d-0001",
        title: "View an invoice",
        path: "src/billing.ts",
      })
    );

    const before = getTielineStatus(findTielineWorkspace(shardTarget)!);
    assert.equal(before.shards.count, 2);
    assert.equal(before.shards.merged, false);
    assert.match(before.next_action, /tieline merge/);

    const merged = testIo();
    assert.equal(await runCli(["merge", shardTarget, "--json"], merged.io, {}), 0);
    const result = JSON.parse(merged.output.join("")) as {
      merge: { stories: number; sections: number };
      status: TielineStatus;
    };
    assert.equal(result.merge.stories, 2);
    assert.equal(result.merge.sections, 2);
    assert.equal(result.status.shards.merged, true);
    const draft = parseDraft(JSON.parse(readFileSync(findTielineWorkspace(shardTarget)!.draftPath, "utf8")));
    assert.deepEqual(
      draft.stories.map((story) => story._review.id).sort(),
      ["billing/d-0001", "sharing/d-0001"]
    );
    // Review ids become import refs for keyless stories: the namespacing has to
    // survive into the payload or the second story collides with the first.
    assert.deepEqual(
      toImportPayload(draft, { include: "not-rejected" }).stories.map((story) => story.import_ref).sort(),
      ["billing/d-0001", "sharing/d-0001"]
    );
  });

  await test("re-merging preserves human review decisions and is idempotent", async () => {
    const workspace = findTielineWorkspace(shardTarget)!;
    const draft = parseDraft(JSON.parse(readFileSync(workspace.draftPath, "utf8")));
    const approvedId = draft.stories[0]._review.id;
    draft.stories[0]._review.state = "approved";
    draft.stories[0]._review.comment = "verified against the route";
    writeFileSync(workspace.draftPath, `${JSON.stringify(draft, null, 2)}\n`);

    const { io } = testIo();
    assert.equal(await runCli(["merge", shardTarget], io, {}), 0);
    const remerged = parseDraft(JSON.parse(readFileSync(workspace.draftPath, "utf8")));
    const kept = remerged.stories.find((story) => story._review.id === approvedId)!;
    assert.equal(kept._review.state, "approved");
    assert.equal(kept._review.comment, "verified against the route");
    assert.equal(remerged.stories.length, 2);
  });

  await test("merge refuses to silently drop reviewed stories without --prune", async () => {
    const workspace = findTielineWorkspace(shardTarget)!;
    const shard = resolve(workspace.draftsDirPath, "billing.draft.json");
    const saved = readFileSync(shard, "utf8");
    rmSync(shard);
    const { io } = testIo();
    await assert.rejects(() => runCli(["merge", shardTarget], io, {}), /no longer produced by any shard/);
    assert.equal(parseDraft(JSON.parse(readFileSync(workspace.draftPath, "utf8"))).stories.length, 2);
    assert.equal(await runCli(["merge", shardTarget, "--prune"], io, {}), 0);
    assert.equal(parseDraft(JSON.parse(readFileSync(workspace.draftPath, "utf8"))).stories.length, 1);
    writeFileSync(shard, saved);
    assert.equal(await runCli(["merge", shardTarget], io, {}), 0);
  });

  await test("merge rejects conflicting section definitions across shards", async () => {
    const workspace = findTielineWorkspace(shardTarget)!;
    const conflicting = resolve(workspace.draftsDirPath, "billing-alt.draft.json");
    writeFileSync(
      conflicting,
      shardBody(workspace.config.context.approved_checksum!, { key: "billing", name: "Invoicing" }, {
        id: "d-0009",
        title: "Download an invoice",
        path: "src/billing.ts",
      })
    );
    const { io } = testIo();
    await assert.rejects(() => runCli(["merge", shardTarget], io, {}), /defined differently in shards/);
    rmSync(conflicting);
  });

  await test("a half-written shard blocks merge but never crashes status", async () => {
    const workspace = findTielineWorkspace(shardTarget)!;
    const partial = resolve(workspace.draftsDirPath, "partial.draft.json");
    writeFileSync(partial, '{"version":1,"sections":[');
    const status = getTielineStatus(findTielineWorkspace(shardTarget)!);
    assert.equal(status.shards.unreadable, 1);
    assert.equal(status.shards.count, 2);
    assert.match(status.next_action, /unreadable draft shard/);
    const { io } = testIo();
    await assert.rejects(() => runCli(["merge", shardTarget], io, {}), /could not be read/);
    rmSync(partial);
  });

  await test("compiled tieline binary routes commands end to end", () => {
    const result = spawnSync(process.execPath, [resolve("dist/cli.js"), "status", target, "--json"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(result.stdout) as { repo: string; context: { status: string } };
    assert.equal(status.repo, "acme-web");
    assert.equal(status.context.status, "approved");
  });

  if (process.platform !== "win32") {
    await test("npm-style symlinked tieline bin executes instead of exiting silently", () => {
      const bin = resolve(root, "tieline-bin");
      symlinkSync(resolve("dist/cli.js"), bin);
      const result = spawnSync(bin, ["status", target, "--json"], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.equal((JSON.parse(result.stdout) as { repo: string }).repo, "acme-web");
    });
  }

  console.log(`\n${passed} passed, 0 failed`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
