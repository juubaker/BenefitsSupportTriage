import { describe, it, expect } from 'vitest';
import { CATEGORIES, CATEGORY_LABELS, catById, catByLabel } from './categories.js';

describe('CATEGORIES taxonomy', () => {
  it('exports 10 categories', () => {
    expect(CATEGORIES).toHaveLength(10);
  });

  it('every category has the required shape', () => {
    for (const cat of CATEGORIES) {
      expect(cat).toMatchObject({
        id: expect.any(String),
        label: expect.any(String),
        tint: expect.any(String),
        swatch: expect.stringMatching(/^#[0-9a-fA-F]{6}$/),
      });
    }
  });

  it('all category ids are unique', () => {
    const ids = CATEGORIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all category labels are unique', () => {
    const labels = CATEGORIES.map((c) => c.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('CATEGORY_LABELS matches the CATEGORIES list in order', () => {
    expect(CATEGORY_LABELS).toEqual(CATEGORIES.map((c) => c.label));
  });
});

describe('catById', () => {
  it('returns the matching category for a known id', () => {
    expect(catById('life-events')?.label).toBe('Life Events');
    expect(catById('cobra')?.label).toBe('COBRA');
  });

  it('returns undefined for an unknown id', () => {
    expect(catById('not-a-category')).toBeUndefined();
  });
});

describe('catByLabel', () => {
  it('returns the matching category for a known label', () => {
    expect(catByLabel('ACA Compliance')?.id).toBe('aca');
    expect(catByLabel('Vendor Extracts')?.id).toBe('extracts');
  });

  it('is case-sensitive', () => {
    expect(catByLabel('life events')).toBeUndefined();
    expect(catByLabel('Life Events')).toBeDefined();
  });

  it('returns undefined for an unknown label', () => {
    expect(catByLabel('Nope')).toBeUndefined();
  });
});
