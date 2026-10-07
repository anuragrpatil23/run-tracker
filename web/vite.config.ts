import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The built app is written into the Python package, which serves it at /app/.
// In development, `npm run dev` serves the app itself and passes /api on to a running `rt view`.
export default defineConfig({
  plugins: [react()],
  base: "/app/",
  build: { outDir: "../runtracker/static/app", emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: { proxy: { "/api": "http://127.0.0.1:8787" }, fs: { allow: [".."] } },
});
