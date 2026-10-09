/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Vite configuration.
 *
 * `base: './'` emits relative asset URLs so the build works when served from
 * a GitHub Pages project sub-path (https://<user>.github.io/<repo>/) as well
 * as from a domain root, without hard-coding the repository name. The app has
 * no client-side router, so relative paths are sufficient.
 */
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
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
