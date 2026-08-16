/**
 * Text -> vector embedding, used at both query time and document-write
 * (ingest) time. The provider is selectable via EMBEDDING_PROVIDER so the
 * server is not tied to any single embedding backend:
 *
 *   local         : run the model IN-PROCESS via @huggingface/transformers
 *                   (Transformers.js). Default provider. gte-small, 384-dim, no
 *                   external service and no API key. The @huggingface/transformers
 *                   package is NOT bundled (it pulls ~400MB of native ONNX runtime,
 *                   which bloats server/deploy images), so `local` is an explicit
 *                   opt-in: `npm install @huggingface/transformers`. The model is
 *                   then loaded lazily on first use and cached.
 *   openai        : call any OpenAI-compatible /embeddings endpoint. Point
 *                   EMBEDDING_BASE_URL at OpenAI, or a self-hosted Ollama /
 *                   LM Studio / HF TEI. Keeps the server process lean (no model
 *                   in memory) at the cost of running/paying for an endpoint.
 *   supabase-edge : call a Supabase `generate-embedding` edge function serving
 *                   gte-small. Auto-selected when SUPABASE_URL and
 *                   SUPABASE_ANON_KEY are set.
 *   hash          : deterministic local hashing (384-dim) — DEV/OFFLINE/TESTS
 *                   ONLY, not semantically meaningful.
 *
 * Whatever provider is chosen must be used for BOTH ingest and queries so the
 * stored and query vectors share one space. The public storage contract is
 * fixed at 384 dimensions; changing width requires a migration + full re-embed.
 */

import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { config, EMBEDDING_DIMENSION, EmbeddingProvider } from "./config.js";

export interface Embedder {
  readonly provider: EmbeddingProvider;
  readonly dim: number;
  embed(text: string): Promise<number[]>;
}

// --- Local, in-process (Transformers.js) ------------------------------------

class LocalEmbedder implements Embedder {
  readonly provider = "local" as const;
  constructor(readonly dim: number, private model: string) {}

  // Cached feature-extraction pipeline (loads the model once, then reuses it).
  private extractor: Promise<(text: string, opts: unknown) => Promise<{ data: ArrayLike<number> }>> | null =
    null;

  private getExtractor() {
    if (!this.extractor) {
      // Non-literal specifier so tsc does not require the optional dependency at
      // build time; it is resolved at runtime only when this provider is used.
      const spec: string = "@huggingface/transformers";
      const load = async (): Promise<{ pipeline: (task: string, model: string) => Promise<never> }> => {
        try {
          return (await import(spec)) as { pipeline: (task: string, model: string) => Promise<never> };
        } catch (primaryError) {
          if (!config.localEmbedderRoot) throw primaryError;
          const entry = createRequire(resolve(config.localEmbedderRoot, "package.json")).resolve(spec);
          return (await import(pathToFileURL(entry).href)) as {
            pipeline: (task: string, model: string) => Promise<never>;
          };
        }
      };
      this.extractor = load()
        .then((mod: { pipeline: (task: string, model: string) => Promise<never> }) =>
          mod.pipeline("feature-extraction", this.model)
        )
        .catch((err: unknown) => {
          this.extractor = null;
          throw new Error(
            "EMBEDDING_PROVIDER=local requires the '@huggingface/transformers' package, " +
              "which is NOT installed by default (it pulls ~400MB of native ONNX runtime, " +
              "so it stays out of the base install to keep server/deploy images lean). " +
              "Install it explicitly: `npm install @huggingface/transformers`, " +
              "or switch to a hosted provider (EMBEDDING_PROVIDER=openai / supabase-edge). " +
              `Original error: ${err instanceof Error ? err.message : String(err)}`
          );
        });
    }
    return this.extractor;
  }

  async embed(text: string): Promise<number[]> {
    const extractor = await this.getExtractor();
    // mean-pool + L2-normalize -> a single dim-length sentence embedding, the
    // same recipe as the supabase-edge gte-small provider, so vectors stay aligned.
    const output = await extractor(prepare(text), { pooling: "mean", normalize: true });
    return assertDim(Array.from(output.data as ArrayLike<number>), this.dim);
  }
}

// --- OpenAI-compatible HTTP endpoint ----------------------------------------

export class OpenAIEmbedder implements Embedder {
  readonly provider = "openai" as const;
  constructor(
    readonly dim: number,
    private baseUrl: string,
    private model: string,
    private apiKey?: string,
    // Compatibility switch: only text-embedding-3+ and some compatible
    // endpoints accept `dimensions`; sending it to others makes every call fail.
    private requestDimensions = true
  ) {}

  async embed(text: string): Promise<number[]> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const res = await fetchWithRetry(`${this.baseUrl.replace(/\/+$/, "")}/embeddings`, {
      method: "POST",
      headers,
      // `dimensions` asks OpenAI v3 models for the fixed 384-width contract, but many models/
      // endpoints reject an unknown field — so only send it when explicitly opted
      // in (EMBEDDING_REQUEST_DIMENSIONS). assertDim() still validates the returned length.
      body: JSON.stringify({
        input: prepare(text),
        model: this.model,
        ...(this.requestDimensions ? { dimensions: EMBEDDING_DIMENSION } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(
        `embeddings endpoint failed: ${res.status} ${await safeResponseText(res, [this.apiKey])}`
      );
    }
    const json = (await res.json()) as { data?: { embedding?: number[] }[]; error?: unknown };
    const embedding = json.data?.[0]?.embedding;
    if (!embedding || embedding.length === 0) {
      throw new Error(
        `embeddings endpoint returned no embedding: ${JSON.stringify(json.error ?? json)}`
      );
    }
    return assertDim(embedding, this.dim);
  }
}

// --- Supabase edge function (gte-small) -------------------------------------

class SupabaseEdgeEmbedder implements Embedder {
  readonly provider = "supabase-edge" as const;
  readonly dim = 384;

  constructor(private url: string, private anonKey: string) {}

  async embed(text: string): Promise<number[]> {
    const res = await fetchWithRetry(`${this.url}/functions/v1/generate-embedding`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.anonKey}`,
        apikey: this.anonKey,
      },
      body: JSON.stringify({ input: prepare(text) }),
    });
    if (!res.ok) {
      throw new Error(
        `generate-embedding edge function failed: ${res.status} ${await safeResponseText(res, [this.anonKey])}`
      );
    }
    const json = (await res.json()) as { embedding?: number[]; error?: string };
    if (!json.embedding) {
      throw new Error(`generate-embedding returned no embedding: ${json.error ?? "unknown"}`);
    }
    return assertDim(json.embedding, this.dim);
  }
}

// --- Hash fallback (dev/offline only) ---------------------------------------

/** Deterministic dev/test embedder — not semantically meaningful. */
export class HashEmbedder implements Embedder {
  readonly provider = "hash" as const;
  constructor(readonly dim: number = 384) {}

  async embed(text: string): Promise<number[]> {
    const vec = new Array<number>(this.dim).fill(0);
    const tokens = prepare(text).toLowerCase().match(/[a-z0-9]+/g) || [];
    for (const tok of tokens) {
      vec[fnv1a(tok) % this.dim] += 1;
      vec[fnv1a(tok + "#2") % this.dim] += 0.5;
    }
    return l2normalize(vec);
  }
}

// --- helpers ----------------------------------------------------------------

/** Guard: fail loudly when a provider's vector width doesn't match the
 *  384-dimension storage contract. Turns the opaque Postgres error into an
 *  actionable message naming both lengths. */
export function assertEmbeddingDimension(embedding: number[], dim = EMBEDDING_DIMENSION): number[] {
  if (typeof dim === "number" && dim > 0 && embedding.length !== dim) {
    throw new Error(
      `embedding provider returned ${embedding.length} dimensions; this server requires ${dim}. ` +
        "Use a compatible model/request or perform an explicit vector-column migration and full re-embed."
    );
  }
  return embedding;
}

const assertDim = assertEmbeddingDimension;

function prepare(text: string): string {
  // gte-small truncates ~512 tokens; trim very long inputs cheaply by chars.
  return text.replace(/\s+/g, " ").trim().slice(0, 4000);
}

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function l2normalize(vec: number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return vec.map((v) => v / norm);
}

export interface RetryOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  maxBackoffMs?: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Fetch with bounded transient retry. Authorization values are never logged. */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: RetryOptions = {}
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxAttempts = opts.maxAttempts ?? 3;
  const maxBackoffMs = opts.maxBackoffMs ?? 5_000;
  const random = opts.random ?? Math.random;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`embedding request timed out after ${timeoutMs}ms`)), timeoutMs);
    const upstream = init.signal;
    const abortFromUpstream = () => controller.abort(upstream?.reason);
    upstream?.addEventListener("abort", abortFromUpstream, { once: true });
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      if (!retryable || attempt === maxAttempts) return response;
      const delay = retryDelay(response.headers.get("retry-after"), attempt, maxBackoffMs, random);
      await response.body?.cancel().catch(() => undefined);
      await sleep(delay);
    } catch (error) {
      lastError = error;
      if (upstream?.aborted || attempt === maxAttempts) throw error;
      await sleep(retryDelay(null, attempt, maxBackoffMs, random));
    } finally {
      clearTimeout(timeout);
      upstream?.removeEventListener("abort", abortFromUpstream);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Embedding request failed.");
}

function retryDelay(
  retryAfter: string | null,
  attempt: number,
  maxBackoffMs: number,
  random: () => number
): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const parsed = Number.isFinite(seconds)
      ? seconds * 1000
      : Math.max(0, new Date(retryAfter).getTime() - Date.now());
    if (Number.isFinite(parsed)) return Math.min(Math.max(parsed, 0), maxBackoffMs);
  }
  const exponential = Math.min(250 * 2 ** (attempt - 1), maxBackoffMs);
  return Math.round(exponential * (0.75 + random() * 0.5));
}

export async function safeResponseText(response: Response, secrets: Array<string | undefined>): Promise<string> {
  let text = (await response.text()).slice(0, 1000);
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join("[REDACTED]");
  }
  return text;
}

export async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  fn: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(concurrency, 1), values.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await fn(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

// --- factory ----------------------------------------------------------------

let singleton: Embedder | null = null;

export function getEmbedder(): Embedder {
  if (singleton) return singleton;

  switch (config.embeddingProvider) {
    case "hash":
      singleton = new HashEmbedder(EMBEDDING_DIMENSION);
      return singleton;

    case "openai": {
      const baseUrl = config.embeddingBaseUrl || "https://api.openai.com/v1";
      const model = config.embeddingModel || "text-embedding-3-small";
      singleton = new OpenAIEmbedder(
        EMBEDDING_DIMENSION,
        baseUrl,
        model,
        config.embeddingApiKey,
        config.embeddingRequestDimensions
      );
      return singleton;
    }

    case "supabase-edge": {
      if (!config.supabaseUrl || !config.supabaseAnonKey) {
        throw new Error(
          "EMBEDDING_PROVIDER=supabase-edge requires SUPABASE_URL and SUPABASE_ANON_KEY " +
            "(the generate-embedding edge function endpoint + anon key)."
        );
      }
      singleton = new SupabaseEdgeEmbedder(config.supabaseUrl, config.supabaseAnonKey);
      return singleton;
    }

    case "local": {
      const model = config.embeddingModel || "Xenova/gte-small";
      singleton = new LocalEmbedder(EMBEDDING_DIMENSION, model);
      return singleton;
    }

    default: {
      const exhaustive: never = config.embeddingProvider;
      throw new Error(`Unknown EMBEDDING_PROVIDER: ${String(exhaustive)}`);
    }
  }
}

/** Search remains useful through lexical retrieval when embeddings are optional. */
export async function optionalQueryEmbedding(
  text: string
): Promise<number[] | undefined> {
  try {
    return await getEmbedder().embed(text);
  } catch {
    return undefined;
  }
}

/** Test seam: override the embedder (used by unit tests / smoke runs). */
export function setEmbedder(e: Embedder): void {
  singleton = e;
}
