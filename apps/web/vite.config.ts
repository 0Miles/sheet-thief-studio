import { fileURLToPath } from "node:url";

import { alphaTab } from "@coderline/alphatab-vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

// In development Vite serves the page and forwards /api and /collab to the server.
const server = process.env.SERVER_URL ?? "http://localhost:8031";
const proxy = {
  "/api": { target: server, changeOrigin: false },
  "/collab": { target: server, ws: true, changeOrigin: false },
};

// What the server adds to the page of a read-only link in production, where it serves the page
// itself (docs/spec/security.md, section 6): the token is in the URL.
const headers = { "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" };

export default defineConfig({
  plugins: [
    vue(),
    // Build tooling only: bundles alphaTab's workers and copies its font and soundfont into
    // public/. The app itself reaches alphaTab through @studio/score-render (docs/adr/0003).
    alphaTab({ alphaTabSourceDir: fileURLToPath(new URL("../../packages/score-render/node_modules/@coderline/alphatab/dist", import.meta.url)) }),
  ],
  // The icon component that fetches nothing: @karyl-chan/ui imports `@iconify/vue`, which asks
  // api.iconify.design for each icon it is given. The icons are bundled instead (src/icons.ts).
  resolve: { alias: [{ find: new RegExp("^@iconify/vue$"), replacement: "@iconify/vue/offline" }] },
  // @karyl-chan/ui ships .vue/.ts source with module-level state (confirm dialog, toasts):
  // pre-bundling it beside the source files would create two copies of that state in dev.
  optimizeDeps: {
    exclude: ["@karyl-chan/ui"],
    include: ["@karyl-chan/ui > @popperjs/core", "@karyl-chan/ui > nanoid"],
  },
  server: { port: 5183, strictPort: true, proxy, headers },
  preview: { port: 5183, strictPort: true, proxy, headers },
  build: { chunkSizeWarningLimit: 2500 },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
  },
});
