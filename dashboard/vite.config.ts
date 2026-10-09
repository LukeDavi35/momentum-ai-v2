import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: false },
  server: { port: 5173, proxy: { "/api": "http://localhost:8080", "/oauth": "http://localhost:8080", "/healthz": "http://localhost:8080" } },
});
