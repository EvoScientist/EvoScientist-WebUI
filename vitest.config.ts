import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    // Default to `node` for speed; individual specs opt into `jsdom` via
    // `// @vitest-environment jsdom` when they touch `window` / `localStorage`.
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    globals: false,
    clearMocks: true,
    setupFiles: ["./src/test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/lib/**/*.ts"],
      exclude: ["src/lib/**/*.test.ts", "src/lib/server/**"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
