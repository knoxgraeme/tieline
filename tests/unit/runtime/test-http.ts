import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../../../src/config.js";
import { createHttpApp, isAllowedMcpOrigin } from "../../../src/http.js";
import { SERVER_VERSION } from "../../../src/server.js";
import { report, test } from "../../support/harness.js";

const packageVersion = (
  JSON.parse(
    readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../package.json"),
      "utf8"
    )
  ) as { version: string }
).version;

console.log("HTTP boundary");
await test("defaults to loopback", () => {
  assert.equal(loadConfig({}).httpHost, "127.0.0.1");
});
await test("non-browser clients without Origin are allowed", () => {
  assert.equal(isAllowedMcpOrigin(undefined, []), true);
});
await test("configured browser Origin is allowed", () => {
  assert.equal(isAllowedMcpOrigin("https://mcp.example.test", ["https://mcp.example.test"]), true);
});
await test("unconfigured browser Origin is denied", () => {
  assert.equal(isAllowedMcpOrigin("https://evil.example", ["https://mcp.example.test"]), false);
});
await test("health route remains outside MCP origin middleware", () => {
  const stack = (createHttpApp() as unknown as { _router: { stack: Array<{ route?: { path?: string } }> } })
    ._router.stack;
  assert.equal(stack.some((layer) => layer.route?.path === "/health"), true);
});
await test("server metadata reports the package version", () => {
  assert.equal(SERVER_VERSION, packageVersion);
});
await test("remote prompt routes contract state through the client workspace", async () => {
  const httpServer = createHttpApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolveReady, rejectReady) => {
    httpServer.once("listening", resolveReady);
    httpServer.once("error", rejectReady);
  });
  const address = httpServer.address() as AddressInfo;
  const client = new Client({ name: "http-prompt-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp`)
  );
  try {
    await client.connect(transport);
    const prompt = await client.getPrompt({ name: "tieline" });
    const promptText = String(
      prompt.messages[0]?.content.type === "text"
        ? prompt.messages[0].content.text
        : ""
    );
    assert.match(promptText, /Contract state: `client_routed`\./);
    assert.match(promptText, /using the client's active workspace/i);
    assert.doesNotMatch(promptText, /Contract state: `setup_required`\./);
  } finally {
    await client.close();
    await new Promise<void>((resolveClosed, rejectClosed) => {
      httpServer.close((error) =>
        error ? rejectClosed(error) : resolveClosed()
      );
    });
  }
});
await test("remote bind needs both gateway acknowledgement and origins", () => {
  assert.throws(() => loadConfig({ HTTP_HOST: "0.0.0.0" }), /Refusing non-loopback/);
  assert.throws(
    () => loadConfig({ HTTP_HOST: "0.0.0.0", HTTP_TRUST_PROXY: "true" }),
    /Refusing non-loopback/
  );
  const config = loadConfig({
    HTTP_HOST: "0.0.0.0",
    HTTP_TRUST_PROXY: "true",
    HTTP_ALLOWED_ORIGINS: "https://mcp.example.test",
  });
  assert.equal(config.httpTrustProxy, true);
});
await test("invalid numeric config fails fast", () => {
  assert.throws(() => loadConfig({ PORT: "banana" }), /Invalid PORT/);
  assert.throws(() => loadConfig({ PORT: "70000" }), /Invalid PORT/);
  assert.throws(() => loadConfig({ CHARACTER_LIMIT: "1.5" }), /Invalid/);
});

report();
