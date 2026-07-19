import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiProxy = {
  "/api": { target: "http://127.0.0.1:4100", changeOrigin: true },
  "/health": { target: "http://127.0.0.1:4100", changeOrigin: true }
};

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4173,
    proxy: apiProxy
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    proxy: apiProxy
  },
  build: { outDir: "dist", sourcemap: true }
});
