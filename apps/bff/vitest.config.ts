import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Workspace packages are consumed from source in tests, like in `tsx --conditions=source`.
export default defineConfig({
  resolve: {
    alias: {
      "@clawdesk/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)),
      "@clawdesk/templates": fileURLToPath(new URL("../../packages/templates/src/index.ts", import.meta.url)),
    },
  },
  test: { include: ["test/**/*.test.ts"] },
});
