import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      // Consume shared types/schemas from source; no separate build step in dev.
      "@clawdesk/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)),
    },
  },
  server: {
    // PORT lets a second dev server run beside the usual one.
    port: Number(process.env.PORT) || 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", ws: true },
    },
  },
});
