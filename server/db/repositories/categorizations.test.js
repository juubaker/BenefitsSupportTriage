// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { hashContent } from './categorizations.js';

describe('hashContent', () => {
  it('produces a 64-char hex string', () => {
    const h = hashContent('title', 'body');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    expect(hashContent('a', 'b')).toBe(hashContent('a', 'b'));
  });

  it('differs when title differs', () => {
    expect(hashContent('a', 'body')).not.toBe(hashContent('b', 'body'));
  });

  it('differs when body differs', () => {
    expect(hashContent('title', 'a')).not.toBe(hashContent('title', 'b'));
  });

  it('is sensitive to where the boundary falls', () => {
    // hashContent uses "title\n\nbody" — moving content across the boundary
    // must produce different hashes.
    expect(hashContent('title body', '')).not.toBe(hashContent('title', 'body'));
    expect(hashContent('a', 'bc')).not.toBe(hashContent('ab', 'c'));
  });
});
