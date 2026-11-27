import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// One config to rule them all. Component tests run in happy-dom (the default).
// Server tests opt into the node environment with a `// @vitest-environment node`
// pragma at the top of the file.
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: ['./src/test/setup.js'],
    css: false,
    // .ts included so the MCP server (TypeScript, and untested until now) can
    // be covered here. agent/ and rag/ are excluded below, so their own .ts
    // suites are not pulled in.
    include: ['**/*.{test,spec}.{js,jsx,ts,tsx}'],
    // agent/, rag/ and packages/* are separate workspaces with their own
    // runners; never descend into them (or any nested node_modules) from the
    // root suite, or their tests run twice and are counted twice.
    exclude: ['**/node_modules/**', '**/dist/**', '.idea', '.git', '.cache', 'agent/**', 'rag/**', 'packages/**', 'evals/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/**/*.{js,jsx,ts}', 'server/**/*.js'],
      exclude: [
        'src/main.jsx',
        'src/test/**',
        '**/*.test.{js,jsx,ts}',
        '**/*.spec.{js,jsx,ts}',
      ],
    },
  },
});
