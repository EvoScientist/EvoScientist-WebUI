import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

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
      // Widen beyond src/lib so component + hook tests actually get counted.
      // Server-only helpers and generated stubs are out of scope.
      include: [
        "src/lib/**/*.ts",
        "src/app/hooks/**/*.ts",
        "src/app/components/**/*.tsx",
        "src/providers/**/*.tsx",
      ],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.test.tsx",
        "src/lib/server/**",
        "src/test/**",
      ],
    },
  },
  resolve: {
    alias: {
      // Not __dirname: Vite's native config loader (planned as the default)
      // doesn't provide it, and import.meta.dirname needs Node 20.11.
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
