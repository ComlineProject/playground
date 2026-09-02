import { defineConfig } from "vite";

export default defineConfig({
  // Relative so the build works at any path — GitHub Pages serves it under
  // /<repo>/.
  base: "./",
  build: {
    target: "es2022",
    outDir: "dist",
  },
  worker: {
    format: "es",
  },
});
