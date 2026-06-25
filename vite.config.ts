import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Dep-optimizer cache off the shared node_modules volume. Default is
  // node_modules/.vite, but that volume is persistent: a SIGKILL mid-optimize
  // (e.g. `compose down`) leaves a corrupt cache the next `up` inherits (504
  // Outdated Optimize Dep -> blank SPA). In dev compose this maps to a tmpfs so
  // the cache is ephemeral and fresh per container start. Does not affect the
  // production build (outDir stays dist/client).
  cacheDir: '/tmp/vite',
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
    watch: {
      // Windows host -> Linux container bind mount drops inotify events, so the
      // file watcher never sees edits and HMR never fires. Poll instead.
      usePolling: true,
      interval: 100,
    },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
});
