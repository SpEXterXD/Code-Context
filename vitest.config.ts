import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 120000,
    hookTimeout: 120000,
    maxConcurrency: 1,
    fileParallelism: false,
  },
});
