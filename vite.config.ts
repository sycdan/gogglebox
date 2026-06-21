import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // host: true binds 0.0.0.0 so the dev-compose proof container can reach it
    host: true,
    // LAN-first dev server: accept any Host header (e.g. `client` from the proof
    // container, or a LAN hostname/IP). Vite 5 otherwise blocks unknown hosts.
    allowedHosts: true,
    port: 5173,
    strictPort: true,
    proxy: {
      // VITE_API_PROXY points at the server service inside dev compose;
      // falls back to localhost for plain host `npm run dev`.
      '/api': process.env.VITE_API_PROXY ?? 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
});
