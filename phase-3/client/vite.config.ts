import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 開發伺服器把 WebSocket 路徑 /ws 代理到信令伺服器（預設 localhost:3000），
// 這樣前端就能用同源的 `ws://<vite-host>/ws` 連線，免去跨來源設定。
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
      },
    },
  },
});
