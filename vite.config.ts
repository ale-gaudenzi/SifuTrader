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
/**
 * Same-origin Yahoo Finance proxy for `vite` and `vite preview`: the browser
 * calls `/yahoo/v8/finance/chart/...` and the Node server forwards it, so no
 * public CORS proxy is needed when running locally.
 */
const yahooProxy = {
  '/yahoo': {
    target: 'https://query2.finance.yahoo.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/yahoo/, ''),
    headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)' },
  },
};

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  server: { proxy: yahooProxy },
  preview: { proxy: yahooProxy },
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
