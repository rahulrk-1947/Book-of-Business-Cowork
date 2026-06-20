import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { resolve } from 'node:path';

// Browser edition: the whole app — UI, accounting engine, SQLite (WASM) — in one HTML file.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  resolve: {
    alias: {
      'node:fs': resolve(__dirname, 'src/web/shims/node-fs.ts'),
      'node:path': resolve(__dirname, 'src/web/shims/node-path.ts'),
      'node:module': resolve(__dirname, 'src/web/shims/node-module.ts'),
      'node:crypto': resolve(__dirname, 'src/web/shims/node-crypto.ts'),
    },
  },
  build: {
    outDir: 'dist-web',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'web.html'),
      // Classic script, not an ES module: runs everywhere file:// pages do,
      // including stricter corporate browsers (and jsdom for boot tests).
      output: { format: 'iife', inlineDynamicImports: true },
    },
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 10_000,
  },
});
