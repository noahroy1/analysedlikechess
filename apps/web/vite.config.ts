import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        // The Worker under `wrangler dev` (apps/api); API_PROXY_TARGET points elsewhere (http://127.0.0.1:8787 is the old Node server).
        target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8790',
        changeOrigin: true,
        // The proxy leaves the browser's side of a stream open when the server restarts mid-response
        // (node --watch), so live progress would go silent. End it too, and the page reconnects.
        configure: (proxy) =>
          proxy.on('proxyRes', (proxyRes, _req, res) =>
            proxyRes.on('close', () => {
              if (!res.writableEnded) res.destroy();
            }),
          ),
      },
    },
  },
});
