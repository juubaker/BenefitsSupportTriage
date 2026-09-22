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
    include: ['**/*.{test,spec}.{js,jsx}'],
    // agent/ and rag/ are separate packages with their own runners; never
    // descend into them (or any nested node_modules) from the root suite.
    exclude: ['**/node_modules/**', '**/dist/**', '.idea', '.git', '.cache', 'agent/**', 'rag/**', 'evals/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/**/*.{js,jsx}', 'server/**/*.js'],
      exclude: [
        'src/main.jsx',
        'src/test/**',
        '**/*.test.{js,jsx}',
        '**/*.spec.{js,jsx}',
      ],
    },
  },
});
