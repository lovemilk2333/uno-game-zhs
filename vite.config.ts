import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 3000,
    open: true,
  },
  test: {
    globals: true,
    setupFiles: ["./test/setup.js"],
    fileParallelism: false,
    sequence: { concurrent: false },
    // Use the dev server for Playwright tests
    poolOptions: {
      threads: 1,
      minThreads: 1,
      maxThreads: 1,
    },
  },
});
