import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/server.ts", "src/client.ts"],
  format: "cjs",
  target: "node12",
  copy: [
    "package.json",
    {
      from: "public/**",
      to: "dist/",
      flatten: false,
    },
  ],
});
