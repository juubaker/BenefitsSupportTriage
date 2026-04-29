// Global test setup. Loaded by vitest.config.js for every test file.
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeAll, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// Server tests deliberately exercise error paths that log via console.error.
// Silence those logs so the test output stays readable. Real errors that
// surface via `expect(...).toThrow()` etc. are still asserted on directly.
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

// Unmount React trees and clear the body between tests so no DOM bleed.
afterEach(() => {
  cleanup();
});
