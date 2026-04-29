import { describe, it, expect } from 'vitest';
import { SEED_POSTS } from './seedPosts.js';
import { CATEGORIES } from '../lib/categories.js';

const VALID_IDS = new Set(CATEGORIES.map((c) => c.id));

describe('SEED_POSTS', () => {
  it('exports a non-empty array', () => {
    expect(Array.isArray(SEED_POSTS)).toBe(true);
    expect(SEED_POSTS.length).toBeGreaterThan(0);
  });

  it('every post has the required base fields', () => {
    for (const p of SEED_POSTS) {
      expect(p.id, `post is missing id`).toBeTruthy();
      expect(p.title, `${p.id} is missing title`).toBeTruthy();
      expect(p.body, `${p.id} is missing body`).toBeTruthy();
      expect(p.author, `${p.id} is missing author`).toBeTruthy();
      expect(p.source, `${p.id} is missing source`).toBeTruthy();
      expect(p.posted, `${p.id} is missing posted date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(['answered', 'open']).toContain(p.status);
    }
  });

  it('post IDs are unique', () => {
    const ids = SEED_POSTS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('answered posts have an answer and answeredBy field', () => {
    const answered = SEED_POSTS.filter((p) => p.status === 'answered');
    expect(answered.length).toBeGreaterThan(0);
    for (const p of answered) {
      expect(p.answer, `${p.id} is answered but has no answer`).toBeTruthy();
      expect(p.answeredBy, `${p.id} is answered but has no answeredBy`).toBeTruthy();
    }
  });

  it('open posts have no answer field', () => {
    const open = SEED_POSTS.filter((p) => p.status === 'open');
    expect(open.length).toBeGreaterThan(0);
    for (const p of open) {
      expect(p.answer, `${p.id} is open but has an answer`).toBeUndefined();
    }
  });

  it('all seedCategory references are valid category ids', () => {
    for (const p of SEED_POSTS) {
      if (p.seedCategory) {
        expect(VALID_IDS.has(p.seedCategory), `${p.id} has invalid seedCategory: ${p.seedCategory}`).toBe(true);
      }
    }
  });

  it('answered posts are pre-categorized via seedCategory', () => {
    for (const p of SEED_POSTS.filter((x) => x.status === 'answered')) {
      expect(p.seedCategory, `${p.id} is answered but has no seedCategory`).toBeTruthy();
    }
  });
});
