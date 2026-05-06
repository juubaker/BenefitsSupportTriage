// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp, extractJson, CATEGORIES } from './app.js';

// ---- Mock factories --------------------------------------------------------

function makeMockRepos() {
  const cache = new Map();
  const recordedCats = [];
  const recordedDrafts = [];
  const fakePosts = [
    {
      id: 'CC-1', title: 'Test post', body: 'Body text', status: 'open',
      source: 'Test', author: 'a@b.com', postedAt: '2026-04-01',
      answer: null, answeredBy: null, seedCategoryId: null,
      category: null, confidence: null, reasoning: null, draft: null,
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
      findCached: vi.fn(async ({ contentHash, model }) =>
        cache.get(`${contentHash}::${model}`) ?? null
      ),
      recordCategorization: vi.fn(async (row) => {
        recordedCats.push(row);
        cache.set(`${row.contentHash}::${row.model}`, { ...row, createdAt: new Date() });
        return row;
      }),
      listForPost: vi.fn(async () => []),
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

/** A fake LLMProvider that returns canned responses. */
function makeFakeProvider({
  name = 'fake',
  triageModel = 'fake-triage-v1',
  draftModel = 'fake-draft-v1',
  classifyResponse = '{"category":"Life Events","confidence":0.9,"reasoning":"r"}',
  draftResponse = '  Drafted reply.  ',
  classifyImpl,
  draftImpl,
} = {}) {
  return {
    name,
    triageModel,
    draftModel,
    classify: vi.fn(classifyImpl ?? (async () => classifyResponse)),
    draft: vi.fn(draftImpl ?? (async () => draftResponse)),
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
    expect(extractJson('Sure! Here: {"a":1, "b":"hi"} done')).toEqual({ a: 1, b: 'hi' });
  });
  it('throws when no object is present', () => {
    expect(() => extractJson('no json')).toThrow(/No JSON object/);
  });
});

describe('GET /api/health', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('reports both routes\u2019 active providers and models', async () => {
    const app = createApp({
      ...makeMockRepos(),
      llmProvider: makeFakeProvider({ name: 'fake', triageModel: 'a', draftModel: 'b' }),
    });
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      triage: { provider: 'fake', model: 'a' },
      draft: { provider: 'fake', model: 'b' },
    });
  });

  it('reports different providers per route when configured that way', async () => {
    const app = createApp({
      ...makeMockRepos(),
      providers: {
        triage: makeFakeProvider({ name: 'ollama', triageModel: 'qwen2.5:7b', draftModel: 'unused' }),
        draft: makeFakeProvider({ name: 'anthropic', triageModel: 'unused', draftModel: 'claude-sonnet-4-6' }),
      },
    });
    const res = await request(app).get('/api/health');
    expect(res.body.triage).toEqual({ provider: 'ollama', model: 'qwen2.5:7b' });
    expect(res.body.draft).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
  });

  it('reports anthropicKeyConfigured independently of which providers are active', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const app = createApp({
      ...makeMockRepos(),
      llmProvider: makeFakeProvider({ name: 'ollama' }),
    });
    const res = await request(app).get('/api/health');
    expect(res.body.anthropicKeyConfigured).toBe(false);
    expect(res.body.triage.provider).toBe('ollama');
  });
});

describe('GET /api/posts', () => {
  it('returns the list from the repository', async () => {
    const repos = makeMockRepos();
    const app = createApp({ ...repos, llmProvider: makeFakeProvider() });
    const res = await request(app).get('/api/posts');
    expect(res.status).toBe(200);
    expect(res.body.posts).toHaveLength(1);
    expect(repos.postsRepo.listPosts).toHaveBeenCalledOnce();
  });

  it('returns 500 when the repo throws', async () => {
    const repos = makeMockRepos();
    repos.postsRepo.listPosts.mockRejectedValue(new Error('db down'));
    const app = createApp({ ...repos, llmProvider: makeFakeProvider() });
    const res = await request(app).get('/api/posts');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/db down/);
  });
});

describe('POST /api/categorize', () => {
  let repos;
  let provider;
  let app;

  beforeEach(() => {
    repos = makeMockRepos();
    provider = makeFakeProvider();
    app = createApp({ ...repos, llmProvider: provider });
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

  it('returns the categorization on a valid response and persists with prefixed model', async () => {
    const res = await request(app).post('/api/categorize').send({
      postId: 'CC-1',
      title: 'Birth life event not opening enrollment window',
      body: 'Customer reports newborn flow not opening enrollment.',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      category: 'Life Events',
      confidence: 0.9,
      reasoning: 'r',
      provider: 'fake',
      cached: false,
    });
    expect(provider.classify).toHaveBeenCalledOnce();
    // Model is stored as "<provider>:<model>" so a provider swap invalidates cache
    expect(repos.categorizationsRepo._recorded[0].model).toBe('fake:fake-triage-v1');
  });

  it('returns the cached result without calling the provider on a cache hit', async () => {
    // Pre-seed cache with the exact provider:model key the route will use
    await repos.categorizationsRepo.recordCategorization({
      postId: 'CC-other',
      contentHash: 'hash(t|b)',
      category: 'Open Enrollment',
      confidence: 0.88,
      reasoning: 'cached',
      model: 'fake:fake-triage-v1',
    });
    provider.classify.mockClear();

    const res = await request(app).post('/api/categorize').send({
      postId: 'CC-1',
      title: 't',
      body: 'b',
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      category: 'Open Enrollment',
      confidence: 0.88,
      cached: true,
      provider: 'fake',
    });
    expect(provider.classify).not.toHaveBeenCalled();
  });

  it('cache miss when the provider key changes (swap invalidation)', async () => {
    // Pre-seed cache under a different provider
    await repos.categorizationsRepo.recordCategorization({
      postId: 'CC-other',
      contentHash: 'hash(t|b)',
      category: 'Open Enrollment',
      confidence: 0.88,
      reasoning: 'cached under anthropic',
      model: 'anthropic:claude-haiku-4-5-20251001',
    });
    provider.classify.mockClear();

    const res = await request(app)
      .post('/api/categorize')
      .send({ postId: 'CC-1', title: 't', body: 'b' });

    // Cache miss → provider was called → response came from the LLM, not cache
    expect(provider.classify).toHaveBeenCalledOnce();
    expect(res.body.cached).toBe(false);
  });

  it('clamps confidence to [0, 1]', async () => {
    const localProvider = makeFakeProvider({
      classifyResponse: '{"category":"Life Events","confidence":1.7,"reasoning":""}',
    });
    const localApp = createApp({ ...makeMockRepos(), llmProvider: localProvider });
    const res = await request(localApp).post('/api/categorize').send({ title: 't', body: 'b' });
    expect(res.body.confidence).toBe(1);
  });

  it('rejects categories that are not in the taxonomy with 422', async () => {
    const localProvider = makeFakeProvider({
      classifyResponse: '{"category":"Made-Up","confidence":0.9,"reasoning":""}',
    });
    const localRepos = makeMockRepos();
    const localApp = createApp({ ...localRepos, llmProvider: localProvider });

    const res = await request(localApp).post('/api/categorize').send({ title: 't', body: 'b' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/outside the taxonomy/);
    // Off-taxonomy must NOT be persisted
    expect(localRepos.categorizationsRepo.recordCategorization).not.toHaveBeenCalled();
  });

  it('returns 500 when the provider fails (e.g. ollama unreachable)', async () => {
    const localProvider = makeFakeProvider({
      classifyImpl: async () => {
        throw new Error('Ollama unreachable at http://localhost:11434.');
      },
    });
    const localApp = createApp({ ...makeMockRepos(), llmProvider: localProvider });
    const res = await request(localApp).post('/api/categorize').send({ title: 't', body: 'b' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Ollama unreachable/);
  });

  it('does not persist when postId is omitted', async () => {
    await request(app).post('/api/categorize').send({ title: 't', body: 'b' });
    expect(repos.categorizationsRepo.recordCategorization).not.toHaveBeenCalled();
  });
});

describe('POST /api/draft', () => {
  let repos;
  let provider;
  let app;

  beforeEach(() => {
    repos = makeMockRepos();
    provider = makeFakeProvider();
    app = createApp({ ...repos, llmProvider: provider });
  });

  it('returns 400 on missing fields', async () => {
    const res = await request(app).post('/api/draft').send({ title: 'x' });
    expect(res.status).toBe(400);
  });

  it('returns the trimmed draft text and persists with prefixed model', async () => {
    const res = await request(app).post('/api/draft').send({
      postId: 'CC-1',
      title: 'Birth LE',
      body: 'Detect works, window does not open.',
    });
    expect(res.status).toBe(200);
    expect(res.body.draft).toBe('Drafted reply.');
    expect(res.body.provider).toBe('fake');
    expect(repos.draftsRepo._recorded[0]).toMatchObject({
      content: 'Drafted reply.',
      model: 'fake:fake-draft-v1',
    });
  });

  it('does not persist when postId is omitted', async () => {
    await request(app).post('/api/draft').send({ title: 't', body: 'b' });
    expect(repos.draftsRepo.recordDraft).not.toHaveBeenCalled();
  });

  it('returns 500 when the provider fails', async () => {
    const localProvider = makeFakeProvider({
      draftImpl: async () => {
        throw new Error('boom');
      },
    });
    const localApp = createApp({ ...makeMockRepos(), llmProvider: localProvider });
    const res = await request(localApp).post('/api/draft').send({ title: 't', body: 'b' });
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

describe('per-route provider routing', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('/api/categorize calls only the triage provider', async () => {
    const triage = makeFakeProvider({ name: 'ollama', triageModel: 'qwen2.5:7b' });
    const draft = makeFakeProvider({ name: 'anthropic', draftModel: 'claude-sonnet-4-6' });
    const app = createApp({ ...makeMockRepos(), providers: { triage, draft } });

    await request(app).post('/api/categorize').send({ title: 't', body: 'b' });

    expect(triage.classify).toHaveBeenCalledOnce();
    expect(draft.classify).not.toHaveBeenCalled();
    expect(draft.draft).not.toHaveBeenCalled();
  });

  it('/api/draft calls only the draft provider', async () => {
    const triage = makeFakeProvider({ name: 'ollama', triageModel: 'qwen2.5:7b' });
    const draft = makeFakeProvider({ name: 'anthropic', draftModel: 'claude-sonnet-4-6' });
    const app = createApp({ ...makeMockRepos(), providers: { triage, draft } });

    await request(app).post('/api/draft').send({ title: 't', body: 'b' });

    expect(draft.draft).toHaveBeenCalledOnce();
    expect(triage.classify).not.toHaveBeenCalled();
    expect(triage.draft).not.toHaveBeenCalled();
  });

  it('persists categorization with the triage provider:model key', async () => {
    const repos = makeMockRepos();
    const triage = makeFakeProvider({ name: 'ollama', triageModel: 'qwen2.5:7b' });
    const draft = makeFakeProvider({ name: 'anthropic', draftModel: 'claude-sonnet-4-6' });
    const app = createApp({ ...repos, providers: { triage, draft } });

    await request(app)
      .post('/api/categorize')
      .send({ postId: 'CC-1', title: 't', body: 'b' });

    expect(repos.categorizationsRepo._recorded[0].model).toBe('ollama:qwen2.5:7b');
  });

  it('persists drafts with the draft provider:model key', async () => {
    const repos = makeMockRepos();
    const triage = makeFakeProvider({ name: 'ollama', triageModel: 'qwen2.5:7b' });
    const draft = makeFakeProvider({ name: 'anthropic', draftModel: 'claude-sonnet-4-6' });
    const app = createApp({ ...repos, providers: { triage, draft } });

    await request(app)
      .post('/api/draft')
      .send({ postId: 'CC-1', title: 't', body: 'b' });

    expect(repos.draftsRepo._recorded[0].model).toBe('anthropic:claude-sonnet-4-6');
  });

  it('cache lookup uses triage provider key, not draft', async () => {
    const repos = makeMockRepos();
    // Pre-seed cache under draft's would-be key — should NOT hit
    await repos.categorizationsRepo.recordCategorization({
      postId: 'CC-other',
      contentHash: 'hash(t|b)',
      category: 'Open Enrollment',
      confidence: 0.88,
      reasoning: 'wrong-cache',
      model: 'anthropic:claude-sonnet-4-6',
    });
    // Pre-seed under triage's actual key — SHOULD hit
    await repos.categorizationsRepo.recordCategorization({
      postId: 'CC-other',
      contentHash: 'hash(t|b)',
      category: 'Life Events',
      confidence: 0.92,
      reasoning: 'right-cache',
      model: 'ollama:qwen2.5:7b',
    });
    const triage = makeFakeProvider({ name: 'ollama', triageModel: 'qwen2.5:7b' });
    const draft = makeFakeProvider({ name: 'anthropic', draftModel: 'claude-sonnet-4-6' });
    const app = createApp({ ...repos, providers: { triage, draft } });

    const res = await request(app)
      .post('/api/categorize')
      .send({ postId: 'CC-1', title: 't', body: 'b' });

    expect(res.body.cached).toBe(true);
    expect(res.body.category).toBe('Life Events');
    expect(res.body.reasoning).toBe('right-cache');
    expect(triage.classify).not.toHaveBeenCalled();
  });
});
