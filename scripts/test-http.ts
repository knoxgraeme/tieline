import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { createHttpApp, isAllowedMcpOrigin } from "../src/http.js";

let passed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ok  - ${name}`);
  } catch (error) {
    console.error(`  not ok - ${name}`);
    throw error;
  }
}

console.log("HTTP boundary");
test("defaults to loopback", () => {
  assert.equal(loadConfig({}).httpHost, "127.0.0.1");
});
test("non-browser clients without Origin are allowed", () => {
  assert.equal(isAllowedMcpOrigin(undefined, []), true);
});
test("configured browser Origin is allowed", () => {
  assert.equal(isAllowedMcpOrigin("https://mcp.example.test", ["https://mcp.example.test"]), true);
});
test("unconfigured browser Origin is denied", () => {
  assert.equal(isAllowedMcpOrigin("https://evil.example", ["https://mcp.example.test"]), false);
});
test("health route remains outside MCP origin middleware", () => {
  const stack = (createHttpApp() as unknown as { _router: { stack: Array<{ route?: { path?: string } }> } })
    ._router.stack;
  assert.equal(stack.some((layer) => layer.route?.path === "/health"), true);
});
test("remote bind needs both gateway acknowledgement and origins", () => {
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
test("invalid numeric config fails fast", () => {
  assert.throws(() => loadConfig({ PORT: "banana" }), /Invalid PORT/);
  assert.throws(() => loadConfig({ PORT: "70000" }), /Invalid PORT/);
  assert.throws(() => loadConfig({ FIND_RELATED_MIN_VECTOR_SCORE: "1.1" }), /Invalid/);
  assert.throws(() => loadConfig({ CANDIDATE_POOL_SIZE: "1.5" }), /Invalid/);
});

console.log(`\n${passed} passed, 0 failed`);
