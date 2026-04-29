import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { categorizePost, draftResponse, getHealth, listPosts } from './api.js';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('api client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('listPosts', () => {
    it('GETs /api/posts and returns the parsed body', async () => {
      fetch.mockResolvedValue(jsonResponse({ posts: [{ id: 'CC-1' }] }));
      const r = await listPosts();
      expect(r).toEqual({ posts: [{ id: 'CC-1' }] });
      expect(fetch).toHaveBeenCalledWith('/api/posts');
    });

    it('throws with the server error on non-2xx', async () => {
      fetch.mockResolvedValue(jsonResponse({ error: 'db down' }, { ok: false, status: 500 }));
      await expect(listPosts()).rejects.toThrow(/db down/);
    });
  });

  describe('categorizePost', () => {
    it('POSTs JSON with postId to /api/categorize and returns the parsed response', async () => {
      const expected = { category: 'Life Events', confidence: 0.9, reasoning: 'x' };
      fetch.mockResolvedValue(jsonResponse(expected));

      const result = await categorizePost({ postId: 'CC-1', title: 'T', body: 'B' });

      expect(result).toEqual(expected);
      expect(fetch).toHaveBeenCalledWith('/api/categorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: 'CC-1', title: 'T', body: 'B' }),
      });
    });

    it('throws with the server error message on non-2xx responses', async () => {
      fetch.mockResolvedValue(
        jsonResponse({ error: 'title and body are required' }, { ok: false, status: 400 })
      );
      await expect(categorizePost({ title: '', body: '' })).rejects.toThrow(
        /title and body are required/
      );
    });

    it('handles non-JSON error bodies gracefully', async () => {
      fetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error('not json');
        },
        text: async () => 'plain text error',
      });
      await expect(categorizePost({ title: 'a', body: 'b' })).rejects.toThrow(/plain text error/);
    });
  });

  describe('draftResponse', () => {
    it('POSTs to /api/draft with postId and returns the response', async () => {
      fetch.mockResolvedValue(jsonResponse({ draft: 'Try X.' }));
      const result = await draftResponse({ postId: 'CC-1', title: 'T', body: 'B' });
      expect(result).toEqual({ draft: 'Try X.' });
      expect(fetch.mock.calls[0][0]).toBe('/api/draft');
      expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ postId: 'CC-1' });
    });

    it('throws on a 500', async () => {
      fetch.mockResolvedValue(jsonResponse({ error: 'boom' }, { ok: false, status: 500 }));
      await expect(draftResponse({ title: 't', body: 'b' })).rejects.toThrow(/boom/);
    });
  });

  describe('getHealth', () => {
    it('GETs /api/health and returns the body', async () => {
      fetch.mockResolvedValue(jsonResponse({ ok: true, keyConfigured: true }));
      const r = await getHealth();
      expect(r.ok).toBe(true);
      expect(fetch).toHaveBeenCalledWith('/api/health');
    });

    it('throws when health is not ok', async () => {
      fetch.mockResolvedValue(jsonResponse({}, { ok: false, status: 503 }));
      await expect(getHealth()).rejects.toThrow(/Health check failed/);
    });
  });
});
