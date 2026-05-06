// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createAnthropicProvider } from './anthropic.js';

function fakeResponse(text) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: 'text', text }] }),
    text: async () => text,
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

describe('Anthropic provider', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads model env vars with defaults', () => {
    const p1 = createAnthropicProvider({ ANTHROPIC_API_KEY: 'k' });
    expect(p1.triageModel).toMatch(/haiku/);
    expect(p1.draftModel).toMatch(/sonnet/);

    const p2 = createAnthropicProvider({
      ANTHROPIC_API_KEY: 'k',
      ANTHROPIC_MODEL_TRIAGE: 'custom-triage',
      ANTHROPIC_MODEL_DRAFT: 'custom-draft',
    });
    expect(p2.triageModel).toBe('custom-triage');
    expect(p2.draftModel).toBe('custom-draft');
  });

  it('classify posts to /v1/messages with the api key header', async () => {
    fetch.mockResolvedValue(
      fakeResponse('{"category":"Life Events","confidence":0.9,"reasoning":""}')
    );
    const p = createAnthropicProvider({ ANTHROPIC_API_KEY: 'sk-test' });
    const result = await p.classify({ title: 't', body: 'b', categories: ['Life Events'] });
    expect(result).toContain('Life Events');
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('sk-test');
    const sentBody = JSON.parse(init.body);
    expect(sentBody.model).toBe(p.triageModel);
    expect(sentBody.system).toMatch(/triage assistant/i);
  });

  it('draft posts with the draft model and a different system prompt', async () => {
    fetch.mockResolvedValue(fakeResponse('Drafted reply text.'));
    const p = createAnthropicProvider({ ANTHROPIC_API_KEY: 'sk-test' });
    const result = await p.draft({ title: 't', body: 'b' });
    expect(result).toBe('Drafted reply text.');
    const sentBody = JSON.parse(fetch.mock.calls[0][1].body);
    expect(sentBody.model).toBe(p.draftModel);
    expect(sentBody.system).toMatch(/implementation consultant/i);
  });

  it('throws a clear error when ANTHROPIC_API_KEY is missing', async () => {
    const p = createAnthropicProvider({});
    await expect(p.classify({ title: 't', body: 'b', categories: [] })).rejects.toThrow(
      /ANTHROPIC_API_KEY/
    );
  });

  it('surfaces upstream errors with status code', async () => {
    fetch.mockResolvedValue(fakeError(503, 'overloaded'));
    const p = createAnthropicProvider({ ANTHROPIC_API_KEY: 'k' });
    await expect(p.classify({ title: 't', body: 'b', categories: [] })).rejects.toThrow(
      /Anthropic 503/
    );
  });
});
