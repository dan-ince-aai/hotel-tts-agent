import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Builds the page (`index.html` → `client.tsx`) into `dist/client`, which `server.ts` serves
 * at `/` and `/admin`. Relative asset paths, so the page works under either.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    target: "es2022",
  },
});
