import { describe, expect, it, vi } from "vitest";
import { isTransient, withRetry } from "../src/providers/with-retry.js";
import type { ChatRequest, ProviderAdapter, ProviderTurn } from "../src/types.js";

const TURN: ProviderTurn = {
  text: "ok",
  toolCalls: [],
  stopReason: "end_turn",
  usage: {
    provider: "anthropic",
    model: "fake-model",
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
};

const REQ: ChatRequest = {
  system: "s",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
  maxTokens: 64,
  temperature: 0,
};

/** Fails with `errors` in order, then succeeds. */
function flaky(errors: unknown[], name = "anthropic"): ProviderAdapter & { calls: number } {
  const queue = [...errors];
  return {
    name: name as ProviderAdapter["name"],
    model: "fake-model",
    calls: 0,
    async chat(): Promise<ProviderTurn> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).calls += 1;
      const next = queue.shift();
      if (next) throw next;
      return TURN;
    },
  } as ProviderAdapter & { calls: number };
}

const noSleep = async (): Promise<void> => {};

function statusErr(status: number, message = `HTTP ${status}`): Error {
  return Object.assign(new Error(message), { status });
}

function terminated(): Error {
  // What a dropped Anthropic stream actually looks like: undici's TypeError
  // with a cause of the same word, which is what the nightly logged.
  return Object.assign(new Error("terminated"), { cause: new Error("terminated") });
}

describe("isTransient", () => {
  it("treats a cut stream as transient", () => {
    expect(isTransient(terminated())).toBe(true);
    expect(isTransient(new Error("socket hang up"))).toBe(true);
    expect(isTransient(new Error("fetch failed"))).toBe(true);
    expect(isTransient(Object.assign(new Error("read"), { code: "ECONNRESET" }))).toBe(true);
  });

  it("treats rate limits and overload as transient", () => {
    for (const s of [408, 429, 500, 502, 503, 504, 529]) {
      expect(isTransient(statusErr(s))).toBe(true);
    }
  });

  it("refuses to retry what will fail identically forever", () => {
    for (const s of [400, 401, 403, 404, 413, 422]) {
      expect(isTransient(statusErr(s))).toBe(false);
    }
  });

  it("does not retry an empty credit balance", () => {
    // The 400 that cost weeks of silent fallback. Backoff would only delay it.
    const err = statusErr(400, 'Your credit balance is too low to access the Anthropic API');
    expect(isTransient(err)).toBe(false);
  });

  it("does not retry a provider that is not running", () => {
    // ECONNREFUSED means start Ollama, not try again.
    expect(isTransient(Object.assign(new Error("connect"), { code: "ECONNREFUSED" }))).toBe(false);
    expect(isTransient(Object.assign(new Error("dns"), { code: "ENOTFOUND" }))).toBe(false);
  });

  it("does not retry an abort, even though it surfaces as `terminated`", () => {
    // Our own abort propagates into undici with the same message as a genuine
    // upstream drop, so the name is checked before the text.
    const abort = Object.assign(new Error("terminated"), { name: "AbortError" });
    expect(isTransient(abort)).toBe(false);
    expect(isTransient(Object.assign(new Error("x"), { code: "ABORT_ERR" }))).toBe(false);
  });

  it("assumes an unknown 4xx stays broken and an unknown 5xx does not", () => {
    expect(isTransient(statusErr(418))).toBe(false);
    expect(isTransient(statusErr(599))).toBe(true);
  });
});

describe("withRetry", () => {
  it("retries a cut stream and returns the eventual success", async () => {
    const inner = flaky([terminated(), terminated()]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const turn = await withRetry(inner, { sleep: noSleep }).chat(REQ);
    warn.mockRestore();

    expect(turn).toEqual(TURN);
    expect(inner.calls).toBe(3);
  });

  it("gives up after the configured attempts and throws the last error", async () => {
    const inner = flaky([terminated(), terminated(), terminated()]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(withRetry(inner, { sleep: noSleep }).chat(REQ)).rejects.toThrow("terminated");
    warn.mockRestore();
    expect(inner.calls).toBe(3);
  });

  it("fails a permanent error on the first attempt", async () => {
    const inner = flaky([statusErr(401, "invalid x-api-key")]);
    await expect(withRetry(inner, { sleep: noSleep }).chat(REQ)).rejects.toThrow("invalid x-api-key");
    expect(inner.calls).toBe(1);
  });

  it("backs off exponentially, with jitter inside the window", async () => {
    const delays: number[] = [];
    const inner = flaky([statusErr(529), statusErr(529)]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await withRetry(inner, {
      baseDelayMs: 1000,
      sleep: async (ms) => {
        delays.push(ms);
      },
    }).chat(REQ);
    warn.mockRestore();

    expect(delays).toHaveLength(2);
    // Half the window plus jitter: [500, 1000] then [1000, 2000].
    expect(delays[0]).toBeGreaterThanOrEqual(500);
    expect(delays[0]).toBeLessThanOrEqual(1000);
    expect(delays[1]).toBeGreaterThanOrEqual(1000);
    expect(delays[1]).toBeLessThanOrEqual(2000);
  });

  it("honours Retry-After in seconds over its own backoff", async () => {
    const delays: number[] = [];
    const err = Object.assign(statusErr(429), { headers: { "retry-after": "7" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await withRetry(flaky([err]), {
      baseDelayMs: 1000,
      sleep: async (ms) => {
        delays.push(ms);
      },
    }).chat(REQ);
    warn.mockRestore();
    expect(delays).toEqual([7000]);
  });

  it("reads Retry-After from a Headers object too", async () => {
    const delays: number[] = [];
    const err = Object.assign(statusErr(429), { headers: new Headers({ "retry-after": "3" }) });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await withRetry(flaky([err]), {
      sleep: async (ms) => {
        delays.push(ms);
      },
    }).chat(REQ);
    warn.mockRestore();
    expect(delays).toEqual([3000]);
  });

  it("stops retrying once the caller has aborted", async () => {
    // A client that disconnected during the backoff gets no further attempts
    // made on its behalf.
    const controller = new AbortController();
    const inner: ProviderAdapter & { calls: number } = {
      name: "anthropic",
      model: "fake-model",
      calls: 0,
      async chat(): Promise<ProviderTurn> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this as any).calls += 1;
        controller.abort();
        throw terminated();
      },
    } as ProviderAdapter & { calls: number };

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      withRetry(inner, { sleep: noSleep }).chat({ ...REQ, signal: controller.signal }),
    ).rejects.toThrow("terminated");
    warn.mockRestore();
    expect(inner.calls).toBe(1);
  });

  it("passes the delta callback through on every attempt", async () => {
    const seen: string[] = [];
    const inner: ProviderAdapter & { calls: number } = {
      name: "ollama",
      model: "fake-model",
      calls: 0,
      async chat(_req, onDelta): Promise<ProviderTurn> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this as any).calls += 1;
        onDelta?.("tick");
        if ((this as { calls: number }).calls < 2) throw terminated();
        return TURN;
      },
    } as ProviderAdapter & { calls: number };

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await withRetry(inner, { sleep: noSleep }).chat(REQ, (t) => seen.push(t));
    warn.mockRestore();
    expect(seen).toEqual(["tick", "tick"]);
  });

  it("keeps the wrapped provider's identity, so failover and logs are unchanged", () => {
    const wrapped = withRetry(flaky([]), { sleep: noSleep });
    expect(wrapped.name).toBe("anthropic");
    expect(wrapped.model).toBe("fake-model");
  });

  it("attempts=1 disables retrying", async () => {
    const inner = flaky([terminated()]);
    await expect(
      withRetry(inner, { attempts: 1, sleep: noSleep }).chat(REQ),
    ).rejects.toThrow("terminated");
    expect(inner.calls).toBe(1);
  });

  it("reports each retry through onRetry", async () => {
    const seen: number[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await withRetry(flaky([terminated()]), {
      sleep: noSleep,
      onRetry: ({ attempt }) => seen.push(attempt),
    }).chat(REQ);
    warn.mockRestore();
    expect(seen).toEqual([1]);
  });
});
