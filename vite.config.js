import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';


// https://vite.dev/config/
export default defineConfig({
  exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/rag/**',
    ],
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Forward all /api calls to the Express server on :3001
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
