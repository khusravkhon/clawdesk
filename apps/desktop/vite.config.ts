import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// The launcher's own screens (servers, install wizard). Tauri serves them from dist/ in the app;
// the panel itself always comes from the server.
export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "es2022" },
});
