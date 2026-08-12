import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // M3：/api/* 转给本地的识别服务（npm run dev:api，见 server/dev.mjs）
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: false,
        // 识别一次可能要 60s 以上，别让代理提前掐断
        timeout: 180_000,
        proxyTimeout: 180_000,
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
