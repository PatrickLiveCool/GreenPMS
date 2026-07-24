import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const webPort = Number(process.env.WEB_PORT ?? 4173);
const apiTarget = process.env.API_PROXY_TARGET ?? "http://127.0.0.1:4100";
const apiProxy = {
  "/api": { target: apiTarget, changeOrigin: true },
  "/health": { target: apiTarget, changeOrigin: true }
};

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: webPort,
    proxy: apiProxy
  },
  preview: {
    host: "127.0.0.1",
    port: webPort,
    proxy: apiProxy
  },
  build: { outDir: "dist", sourcemap: true }
});
