import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 11826,
    proxy: {
      '/api': {
        target: 'https://api.myimg.ai',
        changeOrigin: true,
      },
    },
  },
});
