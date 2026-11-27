import { describe, expect, it } from "vitest";
import {
  createEmbedClient,
  createEmbedder,
  DEFAULT_DIMENSIONS,
  readEmbedConfig,
  toVectorLiteral,
} from "../src/index.js";

const WIDTH = DEFAULT_DIMENSIONS;
const vec = (fill = 0.1, n = WIDTH): number[] => Array.from({ length: n }, () => fill);

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function errJson(status: number, text = "nope"): Response {
  return { ok: false, status, text: async () => text } as unknown as Response;
}

/** Records every call so the request shape can be asserted. */
function recordingFetch(responses: Response[]): typeof fetch & { calls: { url: string; body: unknown }[] } {
  const queue = [...responses];
  const calls: { url: string; body: unknown }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "null")) });
    const next = queue.shift();
    if (!next) throw new Error("no response queued");
    return next;
  }) as unknown as typeof fetch & { calls: typeof calls };
  impl.calls = calls;
  return impl;
}

describe("readEmbedConfig", () => {
  it("defaults to local Ollama at the corpus width", () => {
    const c = readEmbedConfig({} as NodeJS.ProcessEnv);
    expect(c.provider).toBe("ollama");
    expect(c.dimensions).toBe(768);
    expect(c.ollamaModel).toBe("nomic-embed-text");
    expect(c.ollamaUrl).toBe("http://localhost:11434");
  });

  it("honours EMBED_DIM, the name the corpus was ingested under", () => {
    expect(readEmbedConfig({ EMBED_DIM: "1024" } as NodeJS.ProcessEnv).dimensions).toBe(1024);
  });

  it("refuses a provider it cannot serve", () => {
    expect(() => readEmbedConfig({ EMBED_PROVIDER: "openai" } as NodeJS.ProcessEnv)).toThrow(
      /must be "ollama" or "voyage"/,
    );
  });

  it("refuses a nonsense dimension rather than embedding at it", () => {
    expect(() => readEmbedConfig({ EMBED_DIM: "wide" } as NodeJS.ProcessEnv)).toThrow(/positive integer/);
    expect(() => readEmbedConfig({ EMBED_DIM: "0" } as NodeJS.ProcessEnv)).toThrow(/positive integer/);
  });
});

describe("ollama", () => {
  it("posts prompt and model to /api/embeddings", async () => {
    const f = recordingFetch([okJson({ embedding: vec() })]);
    const embed = createEmbedder({ fetchImpl: f, config: { provider: "ollama" } });
    await embed("spouse lost her job");

    expect(f.calls[0].url).toBe("http://localhost:11434/api/embeddings");
    expect(f.calls[0].body).toEqual({ model: "nomic-embed-text", prompt: "spouse lost her job" });
  });

  it("batches sequentially, one call per text", async () => {
    // Deliberate: ingest runs against one local Ollama, and firing every chunk
    // at once makes it slower rather than faster.
    const f = recordingFetch([okJson({ embedding: vec() }), okJson({ embedding: vec(0.2) })]);
    const { embedBatch } = createEmbedClient({ fetchImpl: f, config: { provider: "ollama" } });
    const out = await embedBatch(["a", "b"]);

    expect(out).toHaveLength(2);
    expect(f.calls.map((c) => (c.body as { prompt: string }).prompt)).toEqual(["a", "b"]);
  });

  it("surfaces the HTTP status and body", async () => {
    const embed = createEmbedder({ fetchImpl: recordingFetch([errJson(500, "boom")]) });
    await expect(embed("x")).rejects.toThrow(/Ollama embed failed \(500\): boom/);
  });

  it("rejects a response with no embedding array", async () => {
    const embed = createEmbedder({ fetchImpl: recordingFetch([okJson({})]) });
    await expect(embed("x")).rejects.toThrow(/no embedding array/);
  });
});

describe("width validation", () => {
  it("refuses a vector of the wrong width, naming the model", async () => {
    // The failure this exists for: pgvector does not error usefully on a
    // mismatch, so a model swap without a re-ingest returns wrong neighbours.
    const embed = createEmbedder({
      fetchImpl: recordingFetch([
        okJson({ embedding: vec(0.1, 1024) }),
        okJson({ embedding: vec(0.1, 1024) }),
      ]),
    });
    await expect(embed("x")).rejects.toThrow(/width 1024 does not match corpus width 768/);
    await expect(embed("x")).rejects.toThrow(/nomic-embed-text/);
  });

  it("applies to batches as well as single calls", async () => {
    const f = recordingFetch([okJson({ embedding: vec(0.1, 512) })]);
    const { embedBatch } = createEmbedClient({ fetchImpl: f });
    await expect(embedBatch(["a"])).rejects.toThrow(/does not match corpus width/);
  });

  it("accepts a configured width other than the default", async () => {
    const embed = createEmbedder({
      fetchImpl: recordingFetch([okJson({ embedding: vec(0.1, 1024) })]),
      config: { dimensions: 1024 },
    });
    await expect(embed("x")).resolves.toHaveLength(1024);
  });
});

describe("voyage", () => {
  const voyage = { provider: "voyage" as const, voyageApiKey: "vk-test" };

  it("sends one request for a batch and keeps the order", async () => {
    const f = recordingFetch([
      okJson({ data: [{ embedding: vec(0.1) }, { embedding: vec(0.2) }] }),
    ]);
    const { embedBatch } = createEmbedClient({ fetchImpl: f, config: voyage });
    const out = await embedBatch(["a", "b"]);

    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe("https://api.voyageai.com/v1/embeddings");
    expect(f.calls[0].body).toEqual({ input: ["a", "b"], model: "voyage-3" });
    expect(out[0][0]).toBe(0.1);
    expect(out[1][0]).toBe(0.2);
  });

  it("refuses without a key instead of sending an unauthorized request", async () => {
    const embed = createEmbedder({
      fetchImpl: recordingFetch([]),
      config: { provider: "voyage", voyageApiKey: undefined },
    });
    await expect(embed("x")).rejects.toThrow(/requires VOYAGE_API_KEY/);
  });

  it("refuses a short response rather than misaligning vectors with texts", async () => {
    // Two texts, one vector back: silently zipping these would attach the
    // wrong vector to the second chunk for the life of the corpus.
    const f = recordingFetch([okJson({ data: [{ embedding: vec() }] })]);
    const { embedBatch } = createEmbedClient({ fetchImpl: f, config: voyage });
    await expect(embedBatch(["a", "b"])).rejects.toThrow(/returned 1 vectors for 2 texts/);
  });

  it("rejects a response with no data array", async () => {
    const embed = createEmbedder({ fetchImpl: recordingFetch([okJson({})]), config: voyage });
    await expect(embed("x")).rejects.toThrow(/no data array/);
  });
});

describe("edges", () => {
  it("an empty batch makes no request", async () => {
    const f = recordingFetch([]);
    const { embedBatch } = createEmbedClient({ fetchImpl: f });
    expect(await embedBatch([])).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });

  it("toVectorLiteral renders pgvector's form", () => {
    expect(toVectorLiteral([0.1, 0.2, -0.3])).toBe("[0.1,0.2,-0.3]");
    expect(toVectorLiteral([])).toBe("[]");
  });

  it("exposes the resolved config, so a caller can log what it used", () => {
    const { config } = createEmbedClient({ config: { ollamaModel: "mxbai-embed-large" } });
    expect(config.ollamaModel).toBe("mxbai-embed-large");
    expect(config.dimensions).toBe(WIDTH);
  });
});
