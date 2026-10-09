import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const proxy = {
  "/v1": {
    target: "http://127.0.0.1:18789",
    changeOrigin: true,
  },
  "/api": {
    target: "http://127.0.0.1:3090",
    changeOrigin: true,
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts: true,
    proxy,
  },
  preview: {
    host: "0.0.0.0",
    port: 3080,
    allowedHosts: true,
    proxy,
  },
});
