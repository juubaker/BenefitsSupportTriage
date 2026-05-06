// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createProvider, createProviders, SUPPORTED_PROVIDERS } from './index.js';

describe('createProvider', () => {
  it('lists both anthropic and ollama as supported', () => {
    expect(SUPPORTED_PROVIDERS).toContain('anthropic');
    expect(SUPPORTED_PROVIDERS).toContain('ollama');
  });

  it('honors the explicit name parameter', () => {
    const a = createProvider('anthropic', { ANTHROPIC_API_KEY: 'k' });
    expect(a.name).toBe('anthropic');
    const o = createProvider('ollama', {});
    expect(o.name).toBe('ollama');
  });

  it('falls back to LLM_PROVIDER env when no name is passed', () => {
    const o = createProvider(undefined, { LLM_PROVIDER: 'ollama' });
    expect(o.name).toBe('ollama');
  });

  it('defaults to anthropic when nothing is configured', () => {
    const a = createProvider(undefined, {});
    expect(a.name).toBe('anthropic');
  });

  it('is case-insensitive', () => {
    expect(createProvider('OLLAMA', {}).name).toBe('ollama');
    expect(createProvider(undefined, { LLM_PROVIDER: 'Anthropic' }).name).toBe('anthropic');
  });

  it('throws on an unknown provider with a helpful message', () => {
    expect(() => createProvider('grok', {})).toThrow(/Unknown LLM provider/);
    expect(() => createProvider('grok', {})).toThrow(/anthropic/);
    expect(() => createProvider('grok', {})).toThrow(/ollama/);
  });

  it('exposes triageModel and draftModel on every provider', () => {
    const a = createProvider('anthropic', { ANTHROPIC_API_KEY: 'k' });
    expect(a.triageModel).toBeTruthy();
    expect(a.draftModel).toBeTruthy();
    const o = createProvider('ollama', {});
    expect(o.triageModel).toBeTruthy();
    expect(o.draftModel).toBeTruthy();
  });

  it('exposes classify and draft as functions on every provider', () => {
    const a = createProvider('anthropic', { ANTHROPIC_API_KEY: 'k' });
    expect(typeof a.classify).toBe('function');
    expect(typeof a.draft).toBe('function');
    const o = createProvider('ollama', {});
    expect(typeof o.classify).toBe('function');
    expect(typeof o.draft).toBe('function');
  });
});

describe('createProviders (per-route)', () => {
  it('returns { triage, draft } both implementing LLMProvider', () => {
    const { triage, draft } = createProviders({ ANTHROPIC_API_KEY: 'k' });
    for (const p of [triage, draft]) {
      expect(p.name).toBeTruthy();
      expect(typeof p.classify).toBe('function');
      expect(typeof p.draft).toBe('function');
      expect(p.triageModel).toBeTruthy();
      expect(p.draftModel).toBeTruthy();
    }
  });

  it('defaults both routes to anthropic when nothing is configured', () => {
    const { triage, draft } = createProviders({ ANTHROPIC_API_KEY: 'k' });
    expect(triage.name).toBe('anthropic');
    expect(draft.name).toBe('anthropic');
  });

  it('LLM_PROVIDER sets both routes when no per-route override is given', () => {
    const { triage, draft } = createProviders({ LLM_PROVIDER: 'ollama' });
    expect(triage.name).toBe('ollama');
    expect(draft.name).toBe('ollama');
  });

  it('LLM_PROVIDER_TRIAGE overrides only the triage provider', () => {
    const { triage, draft } = createProviders({
      LLM_PROVIDER: 'anthropic',
      LLM_PROVIDER_TRIAGE: 'ollama',
      ANTHROPIC_API_KEY: 'k',
    });
    expect(triage.name).toBe('ollama');
    expect(draft.name).toBe('anthropic');
  });

  it('LLM_PROVIDER_DRAFT overrides only the draft provider', () => {
    const { triage, draft } = createProviders({
      LLM_PROVIDER: 'ollama',
      LLM_PROVIDER_DRAFT: 'anthropic',
      ANTHROPIC_API_KEY: 'k',
    });
    expect(triage.name).toBe('ollama');
    expect(draft.name).toBe('anthropic');
  });

  it('both per-route overrides win over LLM_PROVIDER', () => {
    const { triage, draft } = createProviders({
      LLM_PROVIDER: 'anthropic',
      LLM_PROVIDER_TRIAGE: 'ollama',
      LLM_PROVIDER_DRAFT: 'anthropic',
      ANTHROPIC_API_KEY: 'k',
    });
    expect(triage.name).toBe('ollama');
    expect(draft.name).toBe('anthropic');
  });

  it('reuses the same adapter instance when both resolve to the same provider', () => {
    const { triage, draft } = createProviders({ LLM_PROVIDER: 'ollama' });
    expect(triage).toBe(draft); // identity, not just equality — saves a duplicate factory call
  });

  it('builds two distinct instances when triage and draft differ', () => {
    const { triage, draft } = createProviders({
      LLM_PROVIDER_TRIAGE: 'ollama',
      LLM_PROVIDER_DRAFT: 'anthropic',
      ANTHROPIC_API_KEY: 'k',
    });
    expect(triage).not.toBe(draft);
  });

  it('throws when an override names an unknown provider', () => {
    expect(() =>
      createProviders({ LLM_PROVIDER_TRIAGE: 'grok', ANTHROPIC_API_KEY: 'k' })
    ).toThrow(/Unknown LLM provider "grok"/);
  });

  it('is case-insensitive on overrides', () => {
    const { triage } = createProviders({
      LLM_PROVIDER_TRIAGE: 'OLLAMA',
      ANTHROPIC_API_KEY: 'k',
    });
    expect(triage.name).toBe('ollama');
  });
});
