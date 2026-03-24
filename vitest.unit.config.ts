import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@client": fileURLToPath(new URL("./src/client", import.meta.url)),
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
      "@worker": fileURLToPath(new URL("./src/worker", import.meta.url))
    }
  },
  test: {
    environment: "node",
    globals: true,
    include: ["tests/unit/**/*.test.ts"]
  }
});
