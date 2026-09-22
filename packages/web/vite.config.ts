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

const llmShim = fileURLToPath(new URL('./src/lib/agent/llmShim.ts', import.meta.url));

/**
 * Lets the agent run in the browser by swapping out the one module that cannot.
 *
 * On the static build there is no server, so the client runs the agent itself -
 * the same orchestrator, the same fourteen tools, the same grounding check. All
 * of it is portable except `agent/llm.ts`, which loads the Anthropic SDK and
 * needs an API key, and a key in a public bundle is a key anyone can read.
 *
 * The swap is keyed on the importer rather than on the specifier alone, so a
 * `./llm.js` anywhere else in the app is untouched. It is a plugin rather than
 * an alias entry because an alias matches the specifier only, and `./llm.js`
 * on its own is far too broad a thing to redirect.
 */
function agentLlmShim() {
  return {
    name: 'agent-llm-shim',
    enforce: 'pre' as const,
    resolveId(source: string, importer?: string) {
      if (source !== './llm.js' || !importer) return null;
      return importer.replace(/\\/g, '/').includes('/server/src/agent/') ? llmShim : null;
    },
  };
}

export default defineConfig({
  base,
  plugins: [agentLlmShim(), react()],
  resolve: {
    alias: {
      '@wealth/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
      // The agent, imported as source like the finance engine, so the browser
      // runs the same orchestrator the server does rather than a second copy.
      '@agent': fileURLToPath(new URL('../server/src/agent', import.meta.url)),
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
