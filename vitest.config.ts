import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ["./test/setup.js"],
    fileParallelism: false,
    sequence: { concurrent: true },
    maxConcurrency: 16,
  },
});