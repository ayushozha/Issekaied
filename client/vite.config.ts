import { defineConfig } from 'vite';

// The authoritative room (Mac worker) listens on 8787 by default. The browser only
// ever talks to the Vite origin; /ws and /api are proxied so no backend URL or
// credential is embedded in the bundle. Override the dev proxy target with
// ISSEKAIED_BACKEND_URL (shell env, not VITE_-prefixed, never exposed to the page)
// when 8787 is occupied by something else on the machine.
const BACKEND = process.env.ISSEKAIED_BACKEND_URL ?? 'http://localhost:8787';

export default defineConfig({
  publicDir: '../assets',
  server: {
    port: 5173,
    fs: { allow: ['..'] },
    proxy: {
      '/ws': { target: BACKEND, ws: true, changeOrigin: true },
      '/api': { target: BACKEND, changeOrigin: true },
    },
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 6000 },
});
