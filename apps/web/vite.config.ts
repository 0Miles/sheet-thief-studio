import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

// In development Vite serves the page and forwards /api and /collab to the server.
const server = process.env.SERVER_URL ?? "http://localhost:8031";

export default defineConfig({
  plugins: [vue()],
  // @karyl-chan/ui ships .vue/.ts source with module-level state (confirm dialog, toasts):
  // pre-bundling it beside the source files would create two copies of that state in dev.
  optimizeDeps: {
    exclude: ["@karyl-chan/ui"],
    include: ["@karyl-chan/ui > @popperjs/core", "@karyl-chan/ui > nanoid"],
  },
  server: {
    port: 5183,
    proxy: {
      "/api": { target: server, changeOrigin: false },
      "/collab": { target: server, ws: true, changeOrigin: false },
    },
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
  },
});
