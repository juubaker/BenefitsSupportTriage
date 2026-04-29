// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp, extractJson, CATEGORIES } from './app.js';

// Helpers --------------------------------------------------------------------

function fakeAnthropicResponse(text) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: 'text', text }] }),
    text: async () => text,
  };
}

function fakeAnthropicError(status = 500, body = 'upstream error') {
  return {
    ok: false,
    status,
    json: async () => ({ error: body }),
    text: async () => body,
  };
}

/** Build a fresh set of in-memory mock repos for each test. */
function makeMockRepos() {
  const cache = new Map(); // key: hash + '::' + model
  const recordedCats = [];
  const recordedDrafts = [];
  const fakePosts = [
    {
      id: 'CC-1',
      title: 'Test post',
      body: 'Body text',
      status: 'open',
      source: 'Test',
      author: 'a@b.com',
      postedAt: '2026-04-01',
      answer: null,
      answeredBy: null,
      seedCategoryId: null,
      category: null,
      confidence: null,
      reasoning: null,
      draft: null,
    },
  ];

  return {
    postsRepo: {
      listPosts: vi.fn(async () => fakePosts),
      getPost: vi.fn(async (id) => fakePosts.find((p) => p.id === id) ?? null),
      upsertPost: vi.fn(async () => {}),
    },
    categorizationsRepo: {
      hashContent: vi.fn((title, body) => `hash(${title}|${body})`),
      findCached: vi.fn(async ({ contentHash, model }) => cache.get(`${contentHash}::${model}`) ?? null),
      recordCategorization: vi.fn(async (row) => {
        recordedCats.push(row);
        cache.set(`${row.contentHash}::${row.model}`, {
          ...row,
          createdAt: new Date(),
        });
        return row;
      }),
      listForPost: vi.fn(async () => []),
      // Expose the inner state for assertions
      _recorded: recordedCats,
      _cache: cache,
    },
    draftsRepo: {
      recordDraft: vi.fn(async (row) => {
        recordedDrafts.push(row);
        return row;
      }),
      getLatestDraft: vi.fn(async () => null),
      _recorded: recordedDrafts,
    },
  };
}

// ----------------------------------------------------------------------------

describe('extractJson', () => {
  it('parses a clean JSON object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it('strips ```json fences', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('strips bare ``` fences', () => {
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('extracts a JSON object embedded in prose', () => {
    expect(extractJson('Sure! Here is your data: {"a":1, "b":"hi"} hope that helps')).toEqual({
      a: 1,
      b: 'hi',
    });
  });
  it('throws when no object is present', () => {
    expect(() => extractJson('no json here')).toThrow(/No JSON object/);
  });
});

describe('GET /api/health', () => {
  let app;
  let repos;
  beforeEach(() => {
    repos = makeMockRepos();
    app = createApp(repos);
  });

  it('reports ok and reflects whether the API key is configured', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, keyConfigured: true });
    expect(res.body.triageModel).toBeTruthy();
    expect(res.body.draftModel).toBeTruthy();
  });

  it('reports keyConfigured: false when env is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const res = await request(app).get('/api/health');
    expect(res.body.keyConfigured).toBe(false);
  });
});

describe('GET /api/posts', () => {
  let app;
  let repos;
  beforeEach(() => {
    repos = makeMockRepos();
    app = createApp(repos);
  });

  it('returns the list from the repository', async () => {
    const res = await request(app).get('/api/posts');
    expect(res.status).toBe(200);
    expect(res.body.posts).toHaveLength(1);
    expect(res.body.posts[0].id).toBe('CC-1');
    expect(repos.postsRepo.listPosts).toHaveBeenCalledOnce();
  });

  it('returns 500 when the repo throws', async () => {
    repos.postsRepo.listPosts.mockRejectedValue(new Error('db down'));
    const res = await request(app).get('/api/posts');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/db down/);
  });
});

describe('POST /api/categorize', () => {
  let app;
  let repos;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    repos = makeMockRepos();
    app = createApp(repos);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns 400 when title or body is missing', async () => {
    const r1 = await request(app).post('/api/categorize').send({ body: 'x' });
    expect(r1.status).toBe(400);
    const r2 = await request(app).post('/api/categorize').send({ title: 'x' });
    expect(r2.status).toBe(400);
    const r3 = await request(app).post('/api/categorize').send({});
    expect(r3.status).toBe(400);
  });

  it('returns the categorization on a valid model response and persists it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeAnthropicResponse('{"category":"Life Events","confidence":0.92,"reasoning":"Birth event."}')
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await request(app).post('/api/categorize').send({
      postId: 'CC-1',
      title: 'Birth life event not opening enrollment window',
      body: 'Customer reports that adding a newborn does not open enrollment.',
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      category: 'Life Events',
      confidence: 0.92,
      reasoning: 'Birth event.',
      cached: false,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    // Persisted to the repo
    expect(repos.categorizationsRepo.recordCategorization).toHaveBeenCalledOnce();
    expect(repos.categorizationsRepo._recorded[0]).toMatchObject({
      postId: 'CC-1',
      category: 'Life Events',
      confidence: 0.92,
    });
  });

  it('returns the cached result without calling Anthropic on a cache hit', async () => {
    // Pre-seed the cache
    await repos.categorizationsRepo.recordCategorization({
      postId: 'CC-other',
      contentHash: 'hash(t|b)',
      category: 'Open Enrollment',
      confidence: 0.88,
      reasoning: 'cached',
      model: 'claude-haiku-4-5-20251001',
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await request(app)
      .post('/api/categorize')
      .send({ postId: 'CC-1', title: 't', body: 'b' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      category: 'Open Enrollment',
      confidence: 0.88,
      cached: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clamps confidence to [0, 1]', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        fakeAnthropicResponse('{"category":"Life Events","confidence":1.7,"reasoning":""}')
      )
    );
    const res = await request(app)
      .post('/api/categorize')
      .send({ title: 't', body: 'b' });
    expect(res.body.confidence).toBe(1);
  });

  it('rejects categories that are not in the taxonomy with 422', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        fakeAnthropicResponse('{"category":"Made-Up Category","confidence":0.9,"reasoning":""}')
      )
    );
    const res = await request(app)
      .post('/api/categorize')
      .send({ title: 't', body: 'b' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/outside the taxonomy/);
    // Off-taxonomy rejections must NOT be persisted
    expect(repos.categorizationsRepo.recordCategorization).not.toHaveBeenCalled();
  });

  it('returns 500 when the Anthropic API fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeAnthropicError(503, 'overloaded')));
    const res = await request(app).post('/api/categorize').send({ title: 't', body: 'b' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Anthropic 503/);
  });

  it('does not persist when postId is omitted (e.g. for a one-off classification)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        fakeAnthropicResponse('{"category":"COBRA","confidence":0.7,"reasoning":""}')
      )
    );
    await request(app).post('/api/categorize').send({ title: 't', body: 'b' });
    expect(repos.categorizationsRepo.recordCategorization).not.toHaveBeenCalled();
  });
});

describe('POST /api/draft', () => {
  let app;
  let repos;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    repos = makeMockRepos();
    app = createApp(repos);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns 400 on missing fields', async () => {
    const res = await request(app).post('/api/draft').send({ title: 'x' });
    expect(res.status).toBe(400);
  });

  it('returns the trimmed draft text and persists it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(fakeAnthropicResponse('  Check the Life Event Reason.  '))
    );
    const res = await request(app)
      .post('/api/draft')
      .send({ postId: 'CC-1', title: 'Birth LE', body: 'Detect works, window does not open.' });
    expect(res.status).toBe(200);
    expect(res.body.draft).toBe('Check the Life Event Reason.');
    expect(repos.draftsRepo.recordDraft).toHaveBeenCalledOnce();
    expect(repos.draftsRepo._recorded[0].content).toBe('Check the Life Event Reason.');
  });

  it('does not persist when postId is omitted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(fakeAnthropicResponse('text'))
    );
    await request(app).post('/api/draft').send({ title: 't', body: 'b' });
    expect(repos.draftsRepo.recordDraft).not.toHaveBeenCalled();
  });

  it('returns 500 when the upstream call fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeAnthropicError(500, 'boom')));
    const res = await request(app).post('/api/draft').send({ title: 't', body: 'b' });
    expect(res.status).toBe(500);
  });
});

describe('CATEGORIES taxonomy export', () => {
  it('contains exactly 10 categories', () => {
    expect(CATEGORIES).toHaveLength(10);
  });

  it('includes the core HCM Benefits domains', () => {
    expect(CATEGORIES).toContain('Life Events');
    expect(CATEGORIES).toContain('Open Enrollment');
    expect(CATEGORIES).toContain('COBRA');
    expect(CATEGORIES).toContain('ACA Compliance');
  });
});
