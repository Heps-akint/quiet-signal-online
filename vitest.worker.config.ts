import { fileURLToPath, URL } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@client": fileURLToPath(new URL("./src/client", import.meta.url)),
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
      "@worker": fileURLToPath(new URL("./src/worker", import.meta.url))
    }
  },
  plugins: [
    cloudflareTest({
      main: "src/worker/index.ts",
      wrangler: {
        configPath: "./wrangler.jsonc"
      },
      additionalExports: {
        RoomDurableObject: "DurableObject",
        SecurityGateDurableObject: "DurableObject"
      }
    })
  ],
  test: {
    globals: true,
    include: ["tests/worker/**/*.test.ts"],
    pool: "@cloudflare/vitest-pool-workers"
  }
});
