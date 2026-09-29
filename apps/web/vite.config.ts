import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/v1": {
        target: "http://127.0.0.1:18789",
        changeOrigin: true,
      },
      "/api": {
        target: "http://127.0.0.1:3090",
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 3080,
    proxy: {
      "/v1": {
        target: "http://127.0.0.1:18789",
        changeOrigin: true,
      },
      "/api": {
        target: "http://127.0.0.1:3090",
        changeOrigin: true,
      },
    },
  },
});
