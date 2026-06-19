import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 開發伺服器把 /api 代理到 Router（預設 localhost:8080）。
// 注意：實際的 WebSocket / 媒體連線是「直接」連到 Router 回傳的 SFU 節點位址
//（如 ws://localhost:8101/ws），不經過這個 proxy。
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
});
