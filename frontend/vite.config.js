import { defineConfig } from "vite";

export default defineConfig({
  // GitHub Pages deploys to /<repo-name>/
  base: "/fluxer-chat/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
