// Tests for mounting the v2 agent's SSE route into the v1 Express app.
// No database, no model: the router is driven by a fake harness.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { Router } from 'express';
import { createApp } from './app.js';

const repos = {
  postsRepo: { listPosts: async () => [] },
  categorizationsRepo: {},
  draftsRepo: {},
  ragRepo: {},
};

/** Minimal stand-in for the agent's router: streams the frames it is given. */
function fakeAgentRouter(frames) {
  const router = Router();
  router.post('/api/triage', (req, res) => {
    if (!req.body?.ticketId) {
      res.status(400).json({ error: 'ticketId required' });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    for (const [event, data] of frames) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
    res.end();
  });
  return router;
}

describe('POST /api/triage mounting', () => {
  it('answers 503 with how to enable it when no agent is mounted', async () => {
    const res = await request(createApp({ ...repos })).post('/api/triage').send({
      ticketId: 'T-1',
      subject: 'x',
      body: 'y',
    });

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not available/i);
    expect(res.body.detail).toMatch(/agent:build/);
  });

  it('streams agent events as SSE frames when mounted', async () => {
    const app = createApp({
      ...repos,
      agentRouter: fakeAgentRouter([
        ['run_started', { runId: 'r1', provider: 'ollama' }],
        ['tool_result', { step: 1, name: 'search_policies', summary: '2 chunks [chunk-qle-12]' }],
        ['terminal', { state: 'completed', result: { category: 'enrollment' } }],
      ]),
    });

    const res = await request(app)
      .post('/api/triage')
      .send({ ticketId: 'T-1', subject: 'spouse lost job', body: 'can I add her mid-year?' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toContain('event: run_started');
    expect(res.text).toContain('event: terminal');
    expect(res.text.trim().split('\n\n')).toHaveLength(3);
  });

  it('passes the parsed JSON body through to the agent router', async () => {
    const app = createApp({ ...repos, agentRouter: fakeAgentRouter([['terminal', { state: 'completed' }]]) });

    const res = await request(app).post('/api/triage').send({ subject: 'x', body: 'y' });

    expect(res.status).toBe(400);
  });

  it('leaves the v1 routes untouched', async () => {
    const app = createApp({ ...repos, agentRouter: fakeAgentRouter([]) });

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
