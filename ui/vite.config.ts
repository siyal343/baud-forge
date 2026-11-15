import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replace(/\\/g, '/');
          if (normalized.includes('services/luaSandboxFallback')) {
            return 'lua-sandbox';
          }
          if (normalized.includes('/src/plot/')) {
            return 'plot-engine';
          }
          if (normalized.includes('/node_modules/')) {
            return 'vendor';
          }
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:7717',
        changeOrigin: true,
      },
    },
  },
});
