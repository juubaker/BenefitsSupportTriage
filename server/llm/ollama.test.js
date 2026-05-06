// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createOllamaProvider } from './ollama.js';

function fakeOllamaResponse(content) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ message: { role: 'assistant', content } }),
    text: async () => JSON.stringify({ message: { content } }),
  };
}

function fakeError(status, body) {
  return {
    ok: false,
    status,
    json: async () => ({ error: body }),
    text: async () => body,
  };
}

describe('Ollama provider', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses default host and model when env is empty', () => {
    const p = createOllamaProvider({});
    expect(p.name).toBe('ollama');
    expect(p.triageModel).toBeTruthy();
    expect(p.draftModel).toBeTruthy();
  });

  it('honors OLLAMA_HOST and OLLAMA_MODEL env vars', () => {
    const p = createOllamaProvider({
      OLLAMA_HOST: 'http://my-host:11434',
      OLLAMA_MODEL_TRIAGE: 'llama3.2:3b',
      OLLAMA_MODEL_DRAFT: 'qwen2.5:14b',
    });
    expect(p.triageModel).toBe('llama3.2:3b');
    expect(p.draftModel).toBe('qwen2.5:14b');
  });

  it('classify posts to /api/chat with format:json and low temperature', async () => {
    fetch.mockResolvedValue(
      fakeOllamaResponse('{"category":"Life Events","confidence":0.9,"reasoning":"r"}')
    );
    const p = createOllamaProvider({ OLLAMA_HOST: 'http://localhost:11434' });
    await p.classify({ title: 't', body: 'b', categories: ['Life Events'] });

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('http://localhost:11434/api/chat');
    const sent = JSON.parse(init.body);
    expect(sent.format).toBe('json');
    expect(sent.options.temperature).toBe(0.1);
    expect(sent.stream).toBe(false);
    // System + user as separate messages, OpenAI-style
    expect(sent.messages).toHaveLength(2);
    expect(sent.messages[0].role).toBe('system');
    expect(sent.messages[1].role).toBe('user');
  });

  it('draft does NOT use json format and uses higher temperature', async () => {
    fetch.mockResolvedValue(fakeOllamaResponse('Draft reply'));
    const p = createOllamaProvider({});
    await p.draft({ title: 't', body: 'b' });

    const sent = JSON.parse(fetch.mock.calls[0][1].body);
    expect(sent.format).toBeUndefined();
    expect(sent.options.temperature).toBeGreaterThan(0.1);
  });

  it('strips trailing slashes from OLLAMA_HOST', async () => {
    fetch.mockResolvedValue(fakeOllamaResponse('reply'));
    const p = createOllamaProvider({ OLLAMA_HOST: 'http://localhost:11434/' });
    await p.draft({ title: 't', body: 'b' });
    expect(fetch.mock.calls[0][0]).toBe('http://localhost:11434/api/chat');
  });

  it('returns the message content', async () => {
    fetch.mockResolvedValue(fakeOllamaResponse('hello world'));
    const p = createOllamaProvider({});
    const r = await p.draft({ title: 't', body: 'b' });
    expect(r).toBe('hello world');
  });

  it('surfaces a clear error when Ollama is unreachable', async () => {
    fetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const p = createOllamaProvider({ OLLAMA_HOST: 'http://localhost:11434' });
    await expect(p.draft({ title: 't', body: 'b' })).rejects.toThrow(/Ollama unreachable/);
    await expect(p.draft({ title: 't', body: 'b' })).rejects.toThrow(/ollama runtime running/i);
  });

  it('surfaces a model-not-pulled error with a helpful pull command', async () => {
    fetch.mockResolvedValue(fakeError(404, 'model "qwen2.5:7b" not found, try pulling it first'));
    const p = createOllamaProvider({ OLLAMA_MODEL_TRIAGE: 'qwen2.5:7b' });
    await expect(
      p.classify({ title: 't', body: 'b', categories: [] })
    ).rejects.toThrow(/ollama pull qwen2\.5:7b/);
  });

  it('surfaces other upstream errors with status code', async () => {
    fetch.mockResolvedValue(fakeError(500, 'internal error'));
    const p = createOllamaProvider({});
    await expect(
      p.classify({ title: 't', body: 'b', categories: [] })
    ).rejects.toThrow(/Ollama 500/);
  });
});
