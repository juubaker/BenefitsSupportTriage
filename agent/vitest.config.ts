import { defineConfig } from "vitest/config";

// Scoped to the agent sub-package: node environment, TypeScript tests.
// Independent of the repo-root happy-dom/React config.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
  },
});
