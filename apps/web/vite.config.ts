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
    // Vite 默认只放行 localhost；局域网 IP 访问时，构建产物里的
    // crossorigin 脚本会因缺少 ACAO 头而静默失败，导致整页空白。
    cors: true,
    proxy,
  },
  preview: {
    host: "0.0.0.0",
    port: 3080,
    allowedHosts: true,
    cors: true,
    proxy,
  },
});
