import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

// The dev server proxies the engine, so the browser sees one origin and the same
// code works when Tauri serves the built files without a proxy.
export default defineConfig({
  plugins: [solid()],
  server: {
    port: 5180,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:7717',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
})
