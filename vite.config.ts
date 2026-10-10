/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { cloudflare } from '@cloudflare/vite-plugin';

/**
 * Vite configuration.
 *
 * `base: './'` emits relative asset URLs so the build works when served from
 * a sub-path as well as from a domain root, without hard-coding either. The
 * app has no client-side router, so relative paths are sufficient.
 *
 * The Cloudflare plugin runs the dev server and the build against the Worker
 * described in `wrangler.jsonc`, so `npm run dev` matches production. It is
 * left out under Vitest, which runs in plain Node and cannot share its server.
 */
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), ...(process.env.VITEST ? [] : [cloudflare()])],
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1024,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
