import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 開發伺服器把 /ws 代理到 Pion SFU 信令伺服器（預設 localhost:3000）。
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
