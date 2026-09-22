import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * The `@wealth/shared` alias points at TypeScript *source*, not a build output.
 * The finance engine is therefore compiled into the client bundle by the same
 * pass that compiles the app - so a change to the maths is live in the browser
 * on the next HMR tick, with no build step between the two packages.
 */
/**
 * GitHub Pages serves a project site from `/<repo>/`, not from the domain root,
 * so every asset URL needs that prefix. It is passed in by the Pages workflow
 * rather than hardcoded, so a fork under a different name builds correctly and
 * every other build (dev, a server deployment) keeps serving from `/`.
 */
const base = process.env.VITE_BASE ?? '/';

export default defineConfig({
  base,
  plugins: [react()],
  resolve: {
    alias: {
      '@wealth/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // Keeps the app on one origin in development, so no CORS and no env var.
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Recharts and React are large and change rarely; splitting them keeps
        // the app chunk small enough to cache-bust on every deploy.
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
        },
      },
    },
  },
});
