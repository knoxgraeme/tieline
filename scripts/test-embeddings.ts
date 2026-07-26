import {
  assertEmbeddingDimension,
  fetchWithRetry,
  mapWithConcurrency,
  safeResponseText,
} from "../src/embeddings.js";

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  ok  - ${name}`);
  } else {
    failed++;
    console.error(`  FAIL- ${name} ${detail}`);
  }
}

async function withFetch(
  implementation: typeof fetch,
  run: () => Promise<void>
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

async function main(): Promise<void> {
  console.log("retry policy");
  let calls = 0;
  const sleeps: number[] = [];
  await withFetch(async () => {
    calls++;
    return calls === 1
      ? new Response("rate limited", { status: 429, headers: { "retry-after": "1" } })
      : new Response("ok", { status: 200 });
  }, async () => {
    const response = await fetchWithRetry("https://example.invalid", {}, {
      sleep: async (ms) => void sleeps.push(ms),
      random: () => 0,
    });
    check("429 retries then succeeds", response.ok && calls === 2);
    check("Retry-After is honored and bounded", sleeps[0] === 1000, String(sleeps[0]));
  });

  calls = 0;
  await withFetch(async () => {
    calls++;
    return new Response("bad request", { status: 400 });
  }, async () => {
    const response = await fetchWithRetry("https://example.invalid", {});
    check("400 is not retried", response.status === 400 && calls === 1);
  });

  calls = 0;
  await withFetch(async () => {
    calls++;
    if (calls < 3) throw new TypeError("network unavailable");
    return new Response("ok", { status: 200 });
  }, async () => {
    const response = await fetchWithRetry("https://example.invalid", {}, { sleep: async () => {} });
    check("network failures retry within bound", response.ok && calls === 3);
  });

  console.log("timeouts + dimensions");
  await withFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  }), async () => {
    let timedOut = false;
    try {
      await fetchWithRetry("https://example.invalid", {}, {
        timeoutMs: 5,
        maxAttempts: 1,
      });
    } catch {
      timedOut = true;
    }
    check("hung request is aborted", timedOut);
  });

  check("384 dimensions accepted", assertEmbeddingDimension(new Array(384).fill(0)).length === 384);
  let wrongDimensionRejected = false;
  try {
    assertEmbeddingDimension(new Array(383).fill(0));
  } catch {
    wrongDimensionRejected = true;
  }
  check("wrong dimensions rejected", wrongDimensionRejected);

  const secret = "test-secret-token";
  const safeText = await safeResponseText(
    new Response(`${secret}:${"x".repeat(1200)}`),
    [secret]
  );
  check("provider error body redacts credentials", !safeText.includes(secret) && safeText.includes("[REDACTED]"));
  check("provider error body is capped", safeText.length <= 1000);

  console.log("bounded concurrency");
  let active = 0;
  let maxActive = 0;
  const values = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (value) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
    return value * 2;
  });
  check("concurrency ceiling respected", maxActive === 2, String(maxActive));
  check("result order preserved", JSON.stringify(values) === JSON.stringify([2, 4, 6, 8, 10, 12]));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
