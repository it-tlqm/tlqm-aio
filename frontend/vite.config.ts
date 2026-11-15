import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    cors: false,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4100',
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyRequest, request) => {
            // Only the explicitly trusted development origin is translated.
            if (request.headers.origin === 'http://127.0.0.1:5173')
              proxyRequest.setHeader('origin', 'http://127.0.0.1:4100');
          });
        },
      },
    },
  },
  build: { outDir: 'dist', sourcemap: false, assetsInlineLimit: 0 },
});
