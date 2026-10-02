/**
 * Opt-in browser test for screen capture: `npm run test:screens:browser`.
 *
 * It runs the built `tieline` CLI against a synthetic Acme Notes app with real
 * Playwright and Chromium, so it needs a browser (`npx playwright install
 * chromium`, or the official Playwright Docker image) and is deliberately not
 * part of `npm run check`. It proves what the unit tests can only fake: that
 * `tieline/playwright` loads in both CommonJS and ESM test projects, that the
 * reporter loads by path, that two captures of an unchanged app are
 * byte-identical, and that `--verify` catches a real copy change.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { report, test } from "../support/harness.js";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const fixture = resolve(repository, "tests/fixtures/screens-browser");
const cli = resolve(repository, "dist/cli.js");
const KEYS = ["notes-list", "notes-list-empty", "notes-share-denied"];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

if (!existsSync(cli)) {
  throw new Error("Build Tieline first: npm run build (npm run test:screens:browser does).");
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolvePort(address.port) : reject(new Error("no port"))));
    });
  });
}

interface Workspace {
  root: string;
  port: number;
}

/** A disposable git repository holding the fixture app, wired to this checkout. */
async function workspace(moduleType: "commonjs" | "module"): Promise<Workspace> {
  const root = mkdtempSync(join(tmpdir(), `tieline-screens-browser-${moduleType}-`));
  cpSync(fixture, root, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "acme-notes", private: true, type: moduleType }, null, 2)}\n`
  );
  // The app installs Tieline and its own Playwright; link both from this checkout.
  mkdirSync(join(root, "node_modules/@playwright"), { recursive: true });
  symlinkSync(repository, join(root, "node_modules/tieline"), "dir");
  symlinkSync(resolve(repository, "node_modules/@playwright/test"), join(root, "node_modules/@playwright/test"), "dir");
  writeFileSync(join(root, ".gitignore"), "node_modules/\ntest-results/\n");
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "-c", "user.name=Tieline Test", "-c", "user.email=test@example.test", "commit", "-qm", "Acme Notes");
  return { root, port: await freePort() };
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
}

function commit(ws: Workspace, message: string): void {
  git(ws.root, "add", "-A");
  git(ws.root, "-c", "user.name=Tieline Test", "-c", "user.email=test@example.test", "commit", "-qm", message);
}

function tieline(ws: Workspace, ...args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: ws.root,
    encoding: "utf8",
    env: { ...process.env, ACME_NOTES_PORT: String(ws.port), TIELINE_CAPTURE_IMAGE: "" },
    timeout: 5 * 60_000,
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function json(result: { status: number; stdout: string; stderr: string }, expectedStatus: number): Record<string, unknown> {
  assert.equal(result.status, expectedStatus, `exit ${result.status}\n${result.stderr}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

const workspaces: Workspace[] = [];

for (const moduleType of ["commonjs", "module"] as const) {
  console.log(`screens capture in a real browser (${moduleType} test project)`);
  const ws = await workspace(moduleType);
  workspaces.push(ws);

  await test("captures every screen with the app's own Playwright tests", () => {
    const result = json(tieline(ws, "screens", "capture", "--all", "--json"), 0);
    assert.deepEqual(
      (result.screens as Array<{ key: string; status: string }>).map((screen) => [screen.key, screen.status]),
      KEYS.map((key) => [key, "new"])
    );
    for (const key of KEYS) {
      const image = readFileSync(join(ws.root, ".tieline/captures", `${key}.png`));
      assert.ok(image.subarray(0, 8).equals(PNG_SIGNATURE), key);
      const text = readFileSync(join(ws.root, ".tieline/screen-text", `${key}.yml`), "utf8");
      assert.match(text, /- heading/, key);
    }
    assert.match(readFileSync(join(ws.root, ".tieline/screen-text/notes-share-denied.yml"), "utf8"), /Only editors can share this note/);
    const catalog = readFileSync(join(ws.root, ".tieline/screens/NOTES.yaml"), "utf8");
    assert.match(catalog, /    capture:\n      fingerprint: [a-f0-9]{64}\n      text_sha256: [a-f0-9]{64}\n      test: e2e\/notes\.screens\.ts\n/);
    const compiled = tieline(ws, "contract", "compile", ws.root);
    assert.equal(compiled.status, 0, compiled.stderr);
    commit(ws, "capture screens");
  });

  await test("accounts for every screen, page, and UI acceptance criterion", () => {
    const audit = json(tieline(ws, "screens", "audit", "--strict", "--json"), 0) as {
      strict: { passed: boolean; failures: string[] };
      pages: { checked: number; unclaimed: string[] };
    };
    assert.deepEqual(audit.strict, { passed: true, failures: [] });
    assert.deepEqual(audit.pages, { status: "complete", detail: null, checked: 3, unclaimed: [] });
  });

  await test("verifies an unchanged app against a fresh capture", () => {
    const result = json(tieline(ws, "screens", "capture", "--all", "--verify", "--json"), 0);
    assert.equal(result.passed, true);
    assert.equal(result.verified, 3);
  });

  await test("selects, fails verification for, and re-captures a copy change", () => {
    const page = join(ws.root, "app/notes.html");
    writeFileSync(page, readFileSync(page, "utf8").replace("<h1>Your notes</h1>", "<h1>My notes</h1>"));
    const selection = json(tieline(ws, "screens", "capture", "--changed", "--base", "HEAD", "--dry-run", "--json"), 0);
    assert.deepEqual((selection.selection as { screens: unknown }).screens, [
      {
        key: "notes-list",
        capability: "NOTES",
        reasons: [{ rule: "path", pattern: "app/notes.html", path: "app/notes.html" }],
        omitted_reasons: 0,
      },
    ]);
    const failed = json(tieline(ws, "screens", "capture", "--changed", "--base", "HEAD", "--verify", "--json"), 1);
    assert.deepEqual(failed.mismatches, [{ key: "notes-list", causes: ["image", "text"] }]);
    assert.equal(failed.fix, "tieline screens capture --changed --base HEAD");

    const recaptured = json(tieline(ws, "screens", "capture", "--changed", "--base", "HEAD", "--json"), 0);
    assert.deepEqual(recaptured.screens, [{ key: "notes-list", status: "updated", aspects: ["image", "text"] }]);
    assert.match(readFileSync(join(ws.root, ".tieline/screen-text/notes-list.yml"), "utf8"), /My notes/);
    assert.equal(json(tieline(ws, "screens", "capture", "--changed", "--base", "HEAD", "--verify", "--json"), 0).passed, true);
  });

  await test("fails the run, writing nothing, when a scene is not tagged for its screen", () => {
    commit(ws, "re-capture");
    const scene = join(ws.root, "e2e/notes.screens.ts");
    writeFileSync(scene, readFileSync(scene, "utf8").replace('tielineSnapshot(page, "notes-list-empty")', 'tielineSnapshot(page, "notes-list")'));
    const before = readFileSync(join(ws.root, ".tieline/screens/NOTES.yaml"), "utf8");
    const result = tieline(ws, "screens", "capture", "--screen", "notes-list-empty");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /test\(s\) or run step\(s\) failed, so nothing was written/);
    assert.match(result.stderr, /not tagged @screen:notes-list/);
    assert.equal(readFileSync(join(ws.root, ".tieline/screens/NOTES.yaml"), "utf8"), before);
  });
}

for (const ws of workspaces) rmSync(ws.root, { recursive: true, force: true });
report();
